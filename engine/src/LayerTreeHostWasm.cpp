#include "config.h"
#include "LayerTreeHostWasm.h"

#include "Compositor.h"
#include "Engine.h"
#include "EngineConfig.h"
#include "GpuRaster.h"
#include "ScrollingWasm.h"
#include "WebView.h"
#include <EGL/egl.h>
#include "GLDisplay.h"
#include <WebCore/CoordinatedImageBackingStore.h>
#include <WebCore/Damage.h>
#include <WebCore/GraphicsLayerCoordinated.h>
#include <WebCore/LocalFrameView.h>
#include <WebCore/NativeImage.h>
#include <WebCore/Page.h>
#include <WebCore/PlatformDisplay.h>
#include <WebCore/ScrollingThread.h>
#include <WebCore/Settings.h>
#include <WebCore/SkiaCompositingLayer.h>
#include <WebCore/SkiaPaintingEngine.h>
#include <emscripten/emscripten.h>
#include <skia/core/SkCanvas.h>
#include <skia/core/SkSurface.h>
#include <skia/gpu/ganesh/GrDirectContext.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>
#include <wtf/Scope.h>

namespace BrowserLite {

using namespace WebCore;

// ------------------------------------------------------------ Compositor thread

// Next frame in the compositor's worker (rAF, otherwise 16 ms)
EM_JS(void, bl_compositor_request_frame, (void* scene), {
    var run = function () { Module._bl__compositor_frame(scene); };
    if (typeof requestAnimationFrame === "function")
        requestAnimationFrame(run);
    else
        setTimeout(run, 16);
});

// Frames put on screen by all views (bl_frames_shown_for_testing)
static std::atomic<unsigned> s_framesShown { 0 };

static void compositeScene(CompositorScene& scene)
{
    ASSERT(Compositor::isCompositorThread());
    // Tick for the scrolling thread: it applies new scroll positions when the
    // engine thread does not do a rendering update in time, and continues
    // scroll animations. If one runs, the next frame is needed too.
    bool keepTicking = Scrolling::displayDidRefresh(scene.viewId);
    auto tickAgain = makeScopeExit([&] {
        if (keepTicking)
            scene.requestScrollingTick();
    });
    OptionSet<CompositionReason> reasons;
    bool notify = false;
    bool firstPaint = false;
    bool repaintAll = false;
    IntSize pixelSize;
    float deviceScaleFactor = 1;
    HashSet<Ref<CoordinatedPlatformLayer>> layersToRemove;
    RefPtr<CoordinatedPlatformLayer> scrollLayer;
    bool pinching = false;
    {
        Locker locker { scene.lock };
        scene.frameScheduled = false;
        scene.scrollingTick = false;
        if (scene.invalidated) {
            keepTicking = false;
            return;
        }
        // Only show the rendering update when all its tiles are painted (the
        // last finished tile schedules the next frame), like WPE. Until then no
        // frame: animations and scrolling wait as long as the painting takes
        // (#220). The upload would wait for them anyway (patch 0025), but
        // blocking this thread, without ticks for the scrolling thread.
        if (scene.reasons.contains(CompositionReason::RenderingUpdate) && scene.pendingTiles.load()) {
            scene.waitingForTiles = true;
            // Look again in the next frame
            scene.scheduleFrameLocked();
            return;
        }
        scene.waitingForTiles = false;
        reasons = std::exchange(scene.reasons, { });
        notify = std::exchange(scene.notifyEngine, false);
        // Report the first paint with the rendering update that brings it: its
        // tiles are in the frame
        if (reasons.contains(CompositionReason::RenderingUpdate)) {
            firstPaint = std::exchange(scene.firstPaint, false);
        }
        repaintAll = std::exchange(scene.repaintAll, false);
        layersToRemove = std::exchange(scene.pendingLayersToRemove, { });
        if (std::exchange(scene.hasPendingLayers, false))
            scene.committedLayers = std::exchange(scene.pendingLayers, { });
        if (reasons.contains(CompositionReason::RenderingUpdate)) {
            scene.viewport = { scene.pendingViewport.scale, scene.viewport.scrollPosition, scene.pendingViewport.documentRect, scene.pendingViewport.visibleSize };
            scene.scrollLayer = scene.pendingScrollLayer;
            // The engine thread shows the target of the gesture itself now
            if (scene.pinchZoom && !scene.pinchActive && scene.pendingPinchCommit >= scene.pinchCommit)
                scene.pinchZoom = std::nullopt;
        }
        scrollLayer = scene.scrollLayer;
        pinching = !!scene.pinchZoom;
        pixelSize = scene.pixelSize;
        deviceScaleFactor = scene.deviceScaleFactor;
    }
    // During a gesture read the scroll position from the layers every frame
    if (pinching && !reasons.isEmpty())
        reasons.add(CompositionReason::AsyncScrolling);

    auto notifyEngine = [&] {
        if (!notify)
            return;
        runOnEngineThread([viewId = scene.viewId] {
            if (auto* view = WebView::fromID(viewId))
                view->didComposite();
        });
    };
    // A frame that shows nothing (no GPU, no canvas yet) leaves the first paint and its rendering
    // update to the next frame, which the arriving canvas schedules (forceRepaint)
    auto skipFrame = [&] {
        if (firstPaint) {
            Locker locker { scene.lock };
            scene.firstPaint = true;
            scene.reasons.add(CompositionReason::RenderingUpdate);
        }
        notifyEngine();
    };

    Gpu::Scope scope;
    for (auto& layer : layersToRemove)
        layer->invalidateTarget();
    layersToRemove.clear();

    auto* grContext = Gpu::context();
    if (!scope || !grContext || Compositor::isLost() || reasons.isEmpty()) {
        skipFrame();
        return;
    }

    std::optional<FloatPoint> shownScrollPosition;
    {
        Locker stateLocker { scene.stateLock };
        scene.rootLayer->flushPositionChanges(reasons, true);
        for (auto& layer : scene.committedLayers)
            layer->flushPositionChanges(reasons, true);
        // Positions are now as shown (otherwise the same as in the last frame)
        if (scrollLayer && reasons.containsAny({ CompositionReason::RenderingUpdate, CompositionReason::AsyncScrolling })) {
            Locker locker { scrollLayer->lock() };
            auto position = scrollLayer->position();
            shownScrollPosition = FloatPoint { -position.x(), -position.y() };
        }
    }
    // Pinch gesture: scale and move the shown tiles until the engine thread
    // took over the target
    std::optional<PinchViewport> shown;
    std::optional<PinchViewport> target;
    {
        Locker locker { scene.lock };
        if (shownScrollPosition)
            scene.viewport.scrollPosition = *shownScrollPosition;
        if (scene.pinchZoom) {
            shown = scene.viewport;
            target = scene.pinchZoom->target();
        }
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

    // Without a canvas (not there yet) only take the state
    auto surface = Gpu::framebufferSurface(scene.viewId, pixelSize.width(), pixelSize.height());
    if (!surface) {
        skipFrame();
        return;
    }

    auto& rootLayer = scene.rootLayer->ensureSkiaTarget();
    TransformationMatrix matrix;
    matrix.scale(deviceScaleFactor);
    if (target) {
        float factor = target->scale / shown->scale;
        matrix.translate(factor * shown->scrollPosition.x() - target->scrollPosition.x(), factor * shown->scrollPosition.y() - target->scrollPosition.y());
        matrix.scale(factor);
    }
    rootLayer.setTransform(matrix);

    // Damage tracking (#220): paint() collects what changed first. A frame
    // without a change is neither composited nor shown, the canvas keeps the
    // last one; a change composites the whole view into the framebuffer, which
    // is new every frame. A new size (new canvas) and forceRepaint() show the
    // whole view.
    repaintAll |= pixelSize != scene.shownSize;
    std::optional<Damage> frameDamage;
    if (scene.damageMode)
        frameDamage.emplace(pixelSize, *scene.damageMode);
    // BL_DAMAGE=0 (reference of tests/core/damage-test.mjs): every frame is
    // composited and shown
    bool skipUnchanged = engineConfig().skipUnchangedFrames;
    auto* canvas = surface->getCanvas();
    canvas->save();
    auto drawsWholeTarget = frameDamage && skipUnchanged && !repaintAll ? SkiaCompositingLayer::DrawsWholeTarget::Yes : SkiaCompositingLayer::DrawsWholeTarget::No;
    bool hasRunningAnimations = rootLayer.paint(*canvas, frameDamage, std::nullopt, SK_ColorWHITE, drawsWholeTarget);
    canvas->restore();
    bool changed = repaintAll || !frameDamage || !frameDamage->isEmpty();
    grContext->flushAndSubmit(surface.get());
    if (changed || !skipUnchanged) {
        Gpu::showFramebuffer(scene.viewId);
        scene.shownSize = pixelSize;
        s_framesShown.fetch_add(1, std::memory_order_relaxed);
    }
    if (firstPaint)
        WebView::firstPaintShown(scene.viewId);

    if (hasRunningAnimations)
        scene.requestComposition(CompositionReason::Animation);
    notifyEngine();
}

extern "C" EMSCRIPTEN_KEEPALIVE void bl__compositor_frame(CompositorScene* scenePointer)
{
    // The reference from scheduleFrameLocked()
    Ref scene = adoptRef(*scenePointer);
    compositeScene(scene);
}

void CompositorScene::pinch(PinchPhase phase, float factor, FloatPoint focus)
{
    Locker locker { lock };
    switch (phase) {
    case PinchPhase::Begin:
        if (!scrollLayer)
            return;
        // If the engine thread does not show the last gesture yet, continue from its target
        pinchZoom.emplace(pinchZoom ? pinchZoom->target() : viewport, focus);
        pinchActive = true;
        return;
    case PinchPhase::Update:
        if (!pinchActive)
            return;
        pinchZoom->update(factor, focus);
        break;
    case PinchPhase::End:
    case PinchPhase::Cancel:
        if (!pinchActive)
            return;
        pinchActive = false;
        if (phase == PinchPhase::Cancel)
            pinchZoom->cancel();
        commitPinchLocked();
        break;
    }
    reasons.add(CompositionReason::AsyncScrolling);
    scheduleFrameLocked();
}

bool CompositorScene::scrollPinch(FloatSize delta)
{
    Locker locker { lock };
    if (!pinchZoom)
        return false;
    pinchZoom->scrollBy(delta);
    if (!pinchActive)
        commitPinchLocked();
    reasons.add(CompositionReason::AsyncScrolling);
    scheduleFrameLocked();
    return true;
}

// After the gesture the engine thread takes over the target (tiles are
// repainted sharp, the page gets the visualViewport events). If a new target
// arrives before that, it only takes the last one.
void CompositorScene::commitPinchLocked()
{
    bool scheduled = pinchRequest.has_value();
    pinchRequest = PinchRequest { pinchZoom->target().scale, pinchZoom->target().scrollPosition, ++pinchCommit };
    if (scheduled)
        return;
    runOnEngineThread([scene = Ref { *this }] {
        std::optional<PinchRequest> request;
        {
            Locker locker { scene->lock };
            request = std::exchange(scene->pinchRequest, std::nullopt);
        }
        auto* view = WebView::fromID(scene->viewId);
        if (request && view)
            view->setPageScale(request->scale, request->scrollPosition, request->commit);
    });
}

// ------------------------------------------------------------ CompositorScene

static Lock s_scenesLock;

static HashMap<int, RefPtr<CompositorScene>>& scenes() WTF_REQUIRES_LOCK(s_scenesLock)
{
    static NeverDestroyed<HashMap<int, RefPtr<CompositorScene>>> map;
    return map;
}

RefPtr<CompositorScene> CompositorScene::forView(int viewId)
{
    Locker locker { s_scenesLock };
    return scenes().get(viewId);
}

CompositorScene::CompositorScene(int viewId, std::optional<Damage::Mode> damageMode)
    : viewId(viewId)
    , rootLayer(CoordinatedPlatformLayer::create())
    , damageMode(damageMode)
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

void CompositorScene::setHidden(bool value)
{
    Locker locker { lock };
    hidden = value;
    if (!hidden && (!reasons.isEmpty() || scrollingTick || notifyEngine))
        scheduleFrameLocked();
}

void CompositorScene::scheduleFrameLocked()
{
    if (frameScheduled || invalidated || hidden)
        return;
    frameScheduled = true;
    Compositor::dispatch([scene = Ref { *this }]() mutable {
        bl_compositor_request_frame(&scene.leakRef());
    });
}

// ------------------------------------------------------------ Engine thread

// WebCore asks for the compositor context through PlatformDisplay::sharedDisplay().
// There is no real EGL context (skiaGLContext() is always nullptr on PORT=Wasm),
// the display only needs Emscripten's EGL replacement.
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

// Like WPE (LayerTreeHost): the damage settings of the page
static std::optional<Damage::Mode> frameDamageMode(const Settings& settings)
{
    if (!settings.propagateDamagingInformation() || !settings.useDamagingInformationForCompositing())
        return std::nullopt;
    return settings.unifyDamagedRegions() ? Damage::Mode::BoundingBox : Damage::Mode::Rectangles;
}

LayerTreeHostWasm::LayerTreeHostWasm(WebView& view)
    : m_view(view)
    , m_scene(CompositorScene::create(view.id(), frameDamageMode(view.page().settings())))
    , m_damagePropagation(view.page().settings().propagateDamagingInformation())
{
    m_scene->rootLayer->setDamagePropagationEnabled(m_damagePropagation);
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
    {
        Locker locker { s_scenesLock };
        scenes().set(view.id(), m_scene.ptr());
    }
    // The CPU paints tiles (PlatformDisplay has no GL context for background
    // threads), only DDL needs the proxy
    m_paintingEngine = SkiaPaintingEngine::create(nullptr);
}

LayerTreeHostWasm::~LayerTreeHostWasm()
{
    detachScene();
    // Painting threads must not reach us anymore afterwards
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
        m_scene->pendingScrollLayer = nullptr;
        m_scene->scrollLayer = nullptr;
    }
    // The targets (textures) belong to the compositor thread
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
    Locker locker { m_scene->lock };
    m_scene->repaintAll = true;
    m_scene->reasons.add(CompositionReason::Animation);
    m_scene->scheduleFrameLocked();
}

void LayerTreeHostWasm::detachScene()
{
    Locker locker { s_scenesLock };
    if (scenes().get(m_scene->viewId) == m_scene.ptr())
        scenes().remove(m_scene->viewId);
}

void LayerTreeHostWasm::didApplyPinch(unsigned commit)
{
    m_pinchCommit = commit;
    m_compositionRequired = true;
}

void LayerTreeHostWasm::flushLayerStates()
{
    Locker stateLocker { m_scene->stateLock };
    Locker layersLocker { m_layersLock };
    for (auto& layer : m_layers)
        layer->flushPendingState();
}

void LayerTreeHostWasm::flush(bool firstPaint)
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

    // Release images that are only held here
    m_imageBackingStores.removeIf([](auto& entry) {
        return entry.value->hasOneRef();
    });

    if (!std::exchange(m_compositionRequired, false))
        return;
    m_waitingForCompositor = true;
    RefPtr<CoordinatedPlatformLayer> scrollLayer;
    PinchViewport viewport;
    if (m_view) {
        viewport = m_view->pinchViewport();
        auto* frameView = m_view->mainFrameView();
        if (auto* layer = frameView ? frameView->graphicsLayerForScrolledContents() : nullptr)
            scrollLayer = &downcast<GraphicsLayerCoordinated>(*layer).coordinatedPlatformLayer();
    }
    Locker locker { m_scene->lock };
    m_scene->pendingViewport = viewport;
    m_scene->pendingScrollLayer = WTF::move(scrollLayer);
    m_scene->pendingPinchCommit = m_pinchCommit;
    m_scene->reasons.add(CompositionReason::RenderingUpdate);
    m_scene->notifyEngine = true;
    m_scene->firstPaint |= firstPaint;
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
    layer.setDamagePropagationEnabled(m_damagePropagation);
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
    // Like WebKit2: the scrolling thread moved layers, take the new state right
    // here (the engine thread may be blocked)
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
    // Comes from the painting threads. The last finished tile wakes the compositor.
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

// For tests, only with BL_TEST_HOOKS=1 (-1 otherwise): frames put on screen
// so far (tests/core/damage-test.mjs)
extern "C" EMSCRIPTEN_KEEPALIVE int bl_frames_shown_for_testing()
{
    if (!BrowserLite::engineConfig().testHooks)
        return -1;
    return static_cast<int>(BrowserLite::s_framesShown.load(std::memory_order_relaxed));
}
