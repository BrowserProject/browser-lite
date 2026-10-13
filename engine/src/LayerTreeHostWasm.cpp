#include "config.h"
#include "LayerTreeHostWasm.h"

#include "GpuRaster.h"
#include "WebView.h"
#include <WebCore/CoordinatedImageBackingStore.h>
#include <WebCore/Damage.h>
#include <WebCore/GraphicsLayerCoordinated.h>
#include <WebCore/NativeImage.h>
#include <WebCore/PlatformDisplay.h>
#include <EGL/egl.h>
#include "GLDisplay.h"
#include <WebCore/SkiaCompositingLayer.h>
#include <WebCore/SkiaPaintingEngine.h>
#include <skia/core/SkCanvas.h>
#include <skia/core/SkSurface.h>
#include <skia/gpu/ganesh/GrDirectContext.h>
#include <wtf/MainThread.h>
#include <wtf/RunLoop.h>

namespace WebCore {
// Patch in PlatformDisplaySkia.cpp: unser GrDirectContext fuer den Compositor
void setSkiaGrContextForWasm(GrDirectContext*);
}

namespace BrowserLite {

using namespace WebCore;

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
    auto* context = Gpu::context();
    if (!context || !ensureSharedDisplay())
        return false;
    // SkiaCompositingLayer holt den Kontext ueber PlatformDisplay
    setSkiaGrContextForWasm(context);
    return context;
}

LayerTreeHostWasm::LayerTreeHostWasm(WebView& view)
    : m_view(view)
    , m_viewId(view.id())
    , m_rootLayer(CoordinatedPlatformLayer::create())
{
    {
        Locker locker { m_rootLayer->lock() };
        m_rootLayer->setAnchorPoint(FloatPoint3D(0, 0, 0));
        m_rootLayer->setSize(FloatSize(view.size()));
    }
    // Kacheln malt die CPU (PlatformDisplay hat keinen GL-Kontext fuer
    // Hintergrund-Threads), der Proxy wird nur fuer DDL gebraucht
    m_paintingEngine = SkiaPaintingEngine::create(Gpu::context()->threadSafeProxy());
}

LayerTreeHostWasm::~LayerTreeHostWasm()
{
    // Malende Threads duerfen uns danach nicht mehr erreichen
    for (auto& layer : m_layers) {
        layer->waitUntilPaintingComplete();
        layer->invalidateClient();
    }
    Gpu::Scope scope;
    m_rootLayer->invalidateTarget();
    for (auto& layer : m_layers)
        layer->invalidateTarget();
    for (auto& layer : m_layersToRemove)
        layer->invalidateTarget();
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
        Locker locker { m_rootLayer->lock() };
        m_rootLayer->setChildren(WTF::move(children));
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

void LayerTreeHostWasm::sizeDidChange()
{
    m_pendingResize = true;
}

bool LayerTreeHostWasm::flush()
{
    if (std::exchange(m_pendingResize, false) && m_view) {
        Locker locker { m_rootLayer->lock() };
        m_rootLayer->setSize(FloatSize(m_view->size()));
        m_compositionRequired = true;
    }

    for (auto& layer : m_layers)
        layer->flushPendingState();

    if (std::exchange(m_layersChanged, false) || std::exchange(m_compositionRequired, false))
        m_reasons.add(CompositionReason::RenderingUpdate);

    // Bilder, die nur noch hier gehalten werden, freigeben
    m_imageBackingStores.removeIf([](auto& entry) {
        return entry.value->hasOneRef();
    });

    return !m_reasons.isEmpty();
}

bool LayerTreeHostWasm::composite(SkSurface& surface, float deviceScaleFactor)
{
    auto reasons = std::exchange(m_reasons, { });
    if (reasons.isEmpty())
        reasons.add(CompositionReason::RenderingUpdate);

    for (auto& layer : std::exchange(m_layersToRemove, { }))
        layer->invalidateTarget();

    m_rootLayer->flushPositionChanges(reasons, true);
    for (auto& layer : m_layers)
        layer->flushPositionChanges(reasons, true);

    Vector<Ref<CoordinatedPlatformLayer>, 16> layersWithTileUpdates;
    m_rootLayer->flushCompositingState(reasons, true);
    for (auto& layer : m_layers) {
        layer->flushCompositingState(reasons, true);
        if (layer->hasPendingBackingStoreTileUpdates())
            layersWithTileUpdates.append(layer);
    }
    for (auto& layer : layersWithTileUpdates)
        layer->processPendingBackingStoreTileUpdates();

    auto& rootLayer = m_rootLayer->ensureSkiaTarget();
    TransformationMatrix matrix;
    matrix.scale(deviceScaleFactor);
    rootLayer.setTransform(matrix);

    // Ohne Schadens-Verfolgung: jedes Mal das ganze Bild (auf der GPU billig)
    auto* canvas = surface.getCanvas();
    std::optional<Damage> frameDamage;
    canvas->save();
    bool hasRunningAnimations = rootLayer.paint(*canvas, frameDamage, std::nullopt, SK_ColorWHITE);
    canvas->restore();

    if (hasRunningAnimations)
        requestComposition(CompositionReason::Animation);
    return hasRunningAnimations;
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
    m_layers.add(layer);
    m_layersToRemove.remove(layer);
    m_layersChanged = true;
}

void LayerTreeHostWasm::detachLayer(CoordinatedPlatformLayer& layer)
{
    m_layers.remove(layer);
    m_layersToRemove.add(layer);
    m_layersChanged = true;
}

void LayerTreeHostWasm::requestComposition(CompositionReason reason)
{
    if (!isMainThread()) {
        callOnMainThread([viewId = m_viewId, reason] {
            if (auto* view = WebView::fromID(viewId)) {
                if (auto* host = view->layerTreeHost())
                    host->requestComposition(reason);
            }
        });
        return;
    }
    m_reasons.add(reason);
    if (m_view)
        m_view->requestComposite();
}

RunLoop* LayerTreeHostWasm::compositingRunLoop() const
{
    return &RunLoop::mainSingleton();
}

int LayerTreeHostWasm::maxTextureSize() const
{
    auto* context = Gpu::context();
    return context ? context->maxTextureSize() : 4096;
}

void LayerTreeHostWasm::didPaintTile()
{
    // Kommt aus den Mal-Threads. Die letzte fertige Kachel weckt den Compositor.
    if (--m_pendingTiles)
        return;
    callOnMainThread([viewId = m_viewId] {
        if (auto* view = WebView::fromID(viewId))
            view->requestComposite();
    });
}

Ref<GraphicsLayer> LayerTreeHostWasm::createGraphicsLayer(GraphicsLayer::Type layerType, GraphicsLayerClient& client)
{
    return adoptRef(*new GraphicsLayerCoordinated(layerType, client, CoordinatedPlatformLayer::create(*this)));
}

} // namespace BrowserLite
