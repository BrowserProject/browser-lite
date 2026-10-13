#include "config.h"
#include "LayerTreeHostWasm.h"

#include "Compositor.h"
#include "Engine.h"
#include "GpuRaster.h"
#include "ScrollingWasm.h"
#include "WebView.h"
#include <EGL/egl.h>
#include "GLDisplay.h"
#include <WebCore/CoordinatedImageBackingStore.h>
#include <WebCore/Damage.h>
#include <WebCore/GraphicsLayerCoordinated.h>
#include <WebCore/NativeImage.h>
#include <WebCore/PlatformDisplay.h>
#include <WebCore/ScrollingThread.h>
#include <WebCore/SkiaCompositingLayer.h>
#include <WebCore/SkiaPaintingEngine.h>
#include <emscripten/emscripten.h>
#include <skia/core/SkCanvas.h>
#include <skia/core/SkSurface.h>
#include <skia/gpu/ganesh/GrDirectContext.h>
#include <wtf/RunLoop.h>
#include <wtf/Scope.h>

namespace BrowserLite {

using namespace WebCore;

// ------------------------------------------------------------ Compositor-Thread

// Naechstes Bild im Worker des Compositors (rAF, sonst 16 ms)
EM_JS(void, bl_compositor_request_frame, (void* scene), {
    var run = function () { Module._bl_compositor_frame(scene); };
    if (typeof requestAnimationFrame === "function")
        requestAnimationFrame(run);
    else
        setTimeout(run, 16);
});

static void compositeScene(CompositorScene& scene)
{
    ASSERT(Compositor::isCompositorThread());
    // Takt fuer den Scroll-Thread: er wendet neue Scroll-Positionen an, wenn
    // der Engine-Thread nicht rechtzeitig ein Rendering-Update macht, und fuehrt
    // Scroll-Animationen weiter. Laeuft eine, braucht es auch das naechste Bild.
    bool keepTicking = Scrolling::displayDidRefresh(scene.viewId);
    auto tickAgain = makeScopeExit([&] {
        if (keepTicking)
            scene.requestScrollingTick();
    });
    OptionSet<CompositionReason> reasons;
    bool notify = false;
    IntSize pixelSize;
    float deviceScaleFactor = 1;
    HashSet<Ref<CoordinatedPlatformLayer>> layersToRemove;
    {
        Locker locker { scene.lock };
        scene.frameScheduled = false;
        scene.scrollingTick = false;
        if (scene.invalidated) {
            keepTicking = false;
            return;
        }
        // Das Rendering-Update erst zeigen, wenn alle Kacheln gemalt sind
        // (die letzte fertige Kachel plant das naechste Bild ein). Aber nur
        // kurz: Animationen und Scrollen sollen nicht stehen bleiben, wenn das
        // Malen dauert (langsame Maschine), dann lieber mit den alten Kacheln.
        if (scene.reasons.contains(CompositionReason::RenderingUpdate) && scene.pendingTiles.load()) {
            auto now = MonotonicTime::now();
            if (!scene.tilesWaitStart)
                scene.tilesWaitStart = now;
            if (now - scene.tilesWaitStart < 100_ms) {
                scene.waitingForTiles = true;
                // Im naechsten Bild nochmal schauen
                scene.scheduleFrameLocked();
                return;
            }
            debugLog("Compositor: Kacheln brauchen ueber 100 ms, Bild ohne sie");
        }
        scene.waitingForTiles = false;
        scene.tilesWaitStart = { };
        reasons = std::exchange(scene.reasons, { });
        notify = std::exchange(scene.notifyEngine, false);
        layersToRemove = std::exchange(scene.pendingLayersToRemove, { });
        if (std::exchange(scene.hasPendingLayers, false))
            scene.committedLayers = std::exchange(scene.pendingLayers, { });
        pixelSize = scene.pixelSize;
        deviceScaleFactor = scene.deviceScaleFactor;
    }

    auto notifyEngine = [&] {
        if (!notify)
            return;
        runOnEngineThread([viewId = scene.viewId] {
            if (auto* view = WebView::fromID(viewId))
                view->didComposite();
        });
    };

    Gpu::Scope scope;
    for (auto& layer : layersToRemove)
        layer->invalidateTarget();
    layersToRemove.clear();

    auto* grContext = Gpu::context();
    if (!scope || !grContext || Compositor::isLost() || reasons.isEmpty()) {
        notifyEngine();
        return;
    }

    {
        Locker stateLocker { scene.stateLock };
        scene.rootLayer->flushPositionChanges(reasons, true);
        for (auto& layer : scene.committedLayers)
            layer->flushPositionChanges(reasons, true);
    }

    Vector<Ref<CoordinatedPlatformLayer>, 16> layersWithTileUpdates;
    scene.rootLayer->flushCompositingState(reasons, true);
    for (auto& layer : scene.committedLayers) {
        layer->flushCompositingState(reasons, true);
        if (layer->hasPendingBackingStoreTileUpdates())
            layersWithTileUpdates.append(layer);
    }
    for (auto& layer : layersWithTileUpdates)
        layer->processPendingBackingStoreTileUpdates();

    // Ohne Canvas (noch nicht da) nur den Stand uebernehmen
    auto surface = Gpu::framebufferSurface(scene.viewId, pixelSize.width(), pixelSize.height());
    if (!surface) {
        notifyEngine();
        return;
    }

    auto& rootLayer = scene.rootLayer->ensureSkiaTarget();
    TransformationMatrix matrix;
    matrix.scale(deviceScaleFactor);
    rootLayer.setTransform(matrix);

    // Ohne Schadens-Verfolgung: jedes Mal das ganze Bild (auf der GPU billig)
    auto* canvas = surface->getCanvas();
    std::optional<Damage> frameDamage;
    canvas->save();
    bool hasRunningAnimations = rootLayer.paint(*canvas, frameDamage, std::nullopt, SK_ColorWHITE);
    canvas->restore();
    grContext->flushAndSubmit(surface.get());
    Gpu::showFramebuffer(scene.viewId);

    if (hasRunningAnimations)
        scene.requestComposition(CompositionReason::Animation);
    notifyEngine();
}

extern "C" EMSCRIPTEN_KEEPALIVE void bl_compositor_frame(CompositorScene* scenePointer)
{
    // Die Referenz aus scheduleFrameLocked()
    Ref scene = adoptRef(*scenePointer);
    compositeScene(scene);
}

// ------------------------------------------------------------ CompositorScene

CompositorScene::CompositorScene(int viewId)
    : viewId(viewId)
    , rootLayer(CoordinatedPlatformLayer::create())
{
}

void CompositorScene::requestComposition(CompositionReason reason)
{
    Locker locker { lock };
    reasons.add(reason);
    scheduleFrameLocked();
}

void CompositorScene::requestScrollingTick()
{
    Locker locker { lock };
    scrollingTick = true;
    scheduleFrameLocked();
}

void CompositorScene::scheduleFrameLocked()
{
    if (frameScheduled || invalidated)
        return;
    frameScheduled = true;
    Compositor::dispatch([scene = Ref { *this }]() mutable {
        bl_compositor_request_frame(&scene.leakRef());
    });
}

// ------------------------------------------------------------ Engine-Thread

// WebCore fragt den Compositor-Kontext ueber PlatformDisplay::sharedDisplay()
// ab. Einen echten EGL-Kontext gibt es nicht (skiaGLContext() ist auf PORT=Wasm
// immer nullptr), das Display braucht nur Emscriptens EGL-Ersatz.
class PlatformDisplayWasm final : public PlatformDisplay {
public:
    explicit PlatformDisplayWasm(Ref<GLDisplay>&& display)
        : PlatformDisplay(WTF::move(display))
    {
    }

private:
    Type type() const final { return Type::Surfaceless; }
};

static bool ensureSharedDisplay()
{
    if (PlatformDisplay::sharedDisplayIfExists())
        return true;
    auto display = GLDisplay::create(eglGetDisplay(EGL_DEFAULT_DISPLAY));
    if (!display)
        return false;
    PlatformDisplay::setSharedDisplay(makeUnique<PlatformDisplayWasm>(display.releaseNonNull()));
    return true;
}

bool LayerTreeHostWasm::isAvailable()
{
    return Compositor::isRunning() && !Compositor::isLost() && ensureSharedDisplay();
}

LayerTreeHostWasm::LayerTreeHostWasm(WebView& view)
    : m_view(view)
    , m_scene(CompositorScene::create(view.id()))
{
    {
        Locker locker { m_scene->rootLayer->lock() };
        m_scene->rootLayer->setAnchorPoint(FloatPoint3D(0, 0, 0));
        m_scene->rootLayer->setSize(FloatSize(view.size()));
    }
    {
        Locker locker { m_scene->lock };
        m_scene->pixelSize = view.pixelSize();
        m_scene->deviceScaleFactor = view.deviceScaleFactor();
    }
    Scrolling::setScene(view.id(), m_scene.ptr());
    // Kacheln malt die CPU (PlatformDisplay hat keinen GL-Kontext fuer
    // Hintergrund-Threads), den Proxy braucht nur DDL
    m_paintingEngine = SkiaPaintingEngine::create(nullptr);
}

LayerTreeHostWasm::~LayerTreeHostWasm()
{
    Scrolling::setScene(m_scene->viewId, nullptr);
    // Malende Threads duerfen uns danach nicht mehr erreichen
    HashSet<Ref<CoordinatedPlatformLayer>> layers;
    {
        Locker locker { m_layersLock };
        layers = WTF::move(m_layers);
    }
    for (auto& layer : layers) {
        layer->waitUntilPaintingComplete();
        layer->invalidateClient();
    }
    layers.addAll(std::exchange(m_layersToRemove, { }));
    {
        Locker locker { m_scene->lock };
        m_scene->invalidated = true;
        layers.addAll(std::exchange(m_scene->pendingLayers, { }));
        layers.addAll(std::exchange(m_scene->pendingLayersToRemove, { }));
    }
    // Die Ziele (Texturen) gehoeren dem Compositor-Thread
    Compositor::dispatch([scene = m_scene.copyRef(), layers = WTF::move(layers)]() mutable {
        Gpu::Scope scope;
        for (auto& layer : layers)
            layer->invalidateTarget();
        for (auto& layer : std::exchange(scene->committedLayers, { }))
            layer->invalidateTarget();
        scene->rootLayer->invalidateTarget();
    });
}

void LayerTreeHostWasm::updateRootLayer()
{
    Vector<Ref<CoordinatedPlatformLayer>> children;
    if (m_rootCompositingLayer) {
        children.append(downcast<GraphicsLayerCoordinated>(m_rootCompositingLayer)->coordinatedPlatformLayer());
        if (m_overlayCompositingLayer)
            children.append(downcast<GraphicsLayerCoordinated>(m_overlayCompositingLayer)->coordinatedPlatformLayer());
    }
    {
        Locker locker { m_scene->rootLayer->lock() };
        m_scene->rootLayer->setChildren(WTF::move(children));
    }
    m_layersChanged = true;
}

void LayerTreeHostWasm::setRootCompositingLayer(GraphicsLayer* layer)
{
    if (m_rootCompositingLayer == layer)
        return;
    m_rootCompositingLayer = layer;
    updateRootLayer();
}

void LayerTreeHostWasm::setViewOverlayRootLayer(GraphicsLayer* layer)
{
    if (m_overlayCompositingLayer == layer)
        return;
    m_overlayCompositingLayer = layer;
    updateRootLayer();
}

void LayerTreeHostWasm::sizeDidChange(IntSize pixelSize, float deviceScaleFactor)
{
    if (m_view) {
        Locker locker { m_scene->rootLayer->lock() };
        m_scene->rootLayer->setSize(FloatSize(m_view->size()));
    }
    {
        Locker locker { m_scene->lock };
        m_scene->pixelSize = pixelSize;
        m_scene->deviceScaleFactor = deviceScaleFactor;
    }
    m_compositionRequired = true;
}

void LayerTreeHostWasm::forceRepaint()
{
    m_scene->requestComposition(CompositionReason::Animation);
}

void LayerTreeHostWasm::flushLayerStates()
{
    Locker stateLocker { m_scene->stateLock };
    Locker layersLocker { m_layersLock };
    for (auto& layer : m_layers)
        layer->flushPendingState();
}

void LayerTreeHostWasm::flush()
{
    flushLayerStates();

    if (std::exchange(m_layersChanged, false)) {
        Locker locker { m_scene->lock };
        {
            Locker layersLocker { m_layersLock };
            m_scene->pendingLayers = m_layers;
        }
        m_scene->hasPendingLayers = true;
        m_scene->pendingLayersToRemove.addAll(std::exchange(m_layersToRemove, { }));
        m_compositionRequired = true;
    }

    // Bilder, die nur noch hier gehalten werden, freigeben
    m_imageBackingStores.removeIf([](auto& entry) {
        return entry.value->hasOneRef();
    });

    if (!std::exchange(m_compositionRequired, false))
        return;
    m_waitingForCompositor = true;
    Locker locker { m_scene->lock };
    m_scene->reasons.add(CompositionReason::RenderingUpdate);
    m_scene->notifyEngine = true;
    m_scene->scheduleFrameLocked();
}

Ref<CoordinatedImageBackingStore> LayerTreeHostWasm::imageBackingStore(Ref<NativeImage>&& nativeImage)
{
    auto nativeImageID = nativeImage->uniqueID();
    return m_imageBackingStores.ensure(nativeImageID, [&] {
        return CoordinatedImageBackingStore::create(WTF::move(nativeImage));
    }).iterator->value;
}

void LayerTreeHostWasm::attachLayer(CoordinatedPlatformLayer& layer)
{
    {
        Locker locker { m_layersLock };
        m_layers.add(layer);
    }
    m_layersToRemove.remove(layer);
    m_layersChanged = true;
}

void LayerTreeHostWasm::detachLayer(CoordinatedPlatformLayer& layer)
{
    {
        Locker locker { m_layersLock };
        m_layers.remove(layer);
    }
    m_layersToRemove.add(layer);
    m_layersChanged = true;
}

void LayerTreeHostWasm::notifyCompositionRequired()
{
#if ENABLE(SCROLLING_THREAD)
    if (ScrollingThread::isCurrentThread()) {
        m_compositionRequiredInScrollingThread = true;
        return;
    }
#endif
    m_compositionRequired = true;
}

void LayerTreeHostWasm::requestComposition(CompositionReason reason)
{
#if ENABLE(SCROLLING_THREAD)
    // Wie WebKit2: der Scroll-Thread hat Ebenen verschoben, den neuen Stand
    // gleich hier uebernehmen (der Engine-Thread ist vielleicht blockiert)
    if (ScrollingThread::isCurrentThread()) {
        flushLayerStates();
        if (!m_compositionRequiredInScrollingThread.exchange(false))
            return;
    }
#endif
    m_scene->requestComposition(reason);
}

RunLoop* LayerTreeHostWasm::compositingRunLoop() const
{
    return &RunLoop::mainSingleton();
}

void LayerTreeHostWasm::didPaintTile()
{
    // Kommt aus den Mal-Threads. Die letzte fertige Kachel weckt den Compositor.
    if (--m_scene->pendingTiles)
        return;
    Locker locker { m_scene->lock };
    if (!std::exchange(m_scene->waitingForTiles, false))
        return;
    m_scene->scheduleFrameLocked();
}

Ref<GraphicsLayer> LayerTreeHostWasm::createGraphicsLayer(GraphicsLayer::Type layerType, GraphicsLayerClient& client)
{
    return adoptRef(*new GraphicsLayerCoordinated(layerType, client, CoordinatedPlatformLayer::create(*this)));
}

} // namespace BrowserLite
