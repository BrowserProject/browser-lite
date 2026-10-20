// Compositing with layers (Coordinated Graphics), after WebKit2 (LayerTreeHost,
// CoordinatedSceneState, ThreadedCompositor).
//
// WebCore splits the page into layers (GraphicsLayerCoordinated). Every layer
// paints its tiles itself (SkiaPaintingEngine, CPU in background threads). The
// compositor thread (Compositor.h) composites the tiles with Skia on the GPU
// (SkiaCompositingLayer) and shows the frame. Animations of transform/opacity
// keep running there even while the engine thread is busy with the page's JS.
//
// Flow per frame: the engine thread does the rendering update and flush(), the
// compositor takes the new state on the next frame (rAF in its worker) once
// all tiles are painted, and reports "done" back. Only then the next rendering
// update comes.
#pragma once

#include "PinchZoom.h"
#include <WebCore/CoordinatedCompositionReason.h>
#include <WebCore/CoordinatedPlatformLayer.h>
#include <WebCore/GraphicsLayerFactory.h>
#include <WebCore/IntSize.h>
#include <atomic>
#include <optional>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/Lock.h>
#include <wtf/MonotonicTime.h>
#include <wtf/OptionSet.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/ThreadSafeRefCounted.h>
#include <wtf/WeakPtr.h>

namespace WebCore {
class CoordinatedImageBackingStore;
class GraphicsLayer;
class NativeImage;
class SkiaPaintingEngine;
}

namespace BrowserLite {

class WebView;

// Shared state of engine and compositor thread (like CoordinatedSceneState)
class CompositorScene final : public ThreadSafeRefCounted<CompositorScene> {
public:
    static Ref<CompositorScene> create(int viewId) { return adoptRef(*new CompositorScene(viewId)); }
    // From any thread: state of the view while it paints with layers
    static RefPtr<CompositorScene> forView(int viewId);

    const int viewId;
    const Ref<WebCore::CoordinatedPlatformLayer> rootLayer;

    // Taking the layer state (flushPendingState) and reading it
    // (flushPositionChanges) never at the same time: engine, scrolling and compositor thread
    Lock stateLock;

    Lock lock;
    HashSet<Ref<WebCore::CoordinatedPlatformLayer>> pendingLayers WTF_GUARDED_BY_LOCK(lock);
    bool hasPendingLayers WTF_GUARDED_BY_LOCK(lock) { false };
    HashSet<Ref<WebCore::CoordinatedPlatformLayer>> pendingLayersToRemove WTF_GUARDED_BY_LOCK(lock);
    WebCore::IntSize pixelSize WTF_GUARDED_BY_LOCK(lock);
    float deviceScaleFactor WTF_GUARDED_BY_LOCK(lock) { 1 };
    OptionSet<WebCore::CompositionReason> reasons WTF_GUARDED_BY_LOCK(lock);
    bool frameScheduled WTF_GUARDED_BY_LOCK(lock) { false };
    // A rendering update waits for tiles (since when): the last finished tile
    // schedules the next frame
    bool waitingForTiles WTF_GUARDED_BY_LOCK(lock) { false };
    MonotonicTime tilesWaitStart WTF_GUARDED_BY_LOCK(lock);
    bool notifyEngine WTF_GUARDED_BY_LOCK(lock) { false };
    // Report "first paint" with this state (WebView::firstPaintShown)
    bool firstPaint WTF_GUARDED_BY_LOCK(lock) { false };
    // This state has a new video frame in its tiles (tests/perf, Measurements.h)
    bool newVideoFrame WTF_GUARDED_BY_LOCK(lock) { false };
    bool invalidated WTF_GUARDED_BY_LOCK(lock) { false };
    // Hidden view (WebView::setVisible): no frames, what is pending comes when shown
    bool hidden WTF_GUARDED_BY_LOCK(lock) { false };
    // Next frame even without new content (tick for the scrolling thread)
    bool scrollingTick WTF_GUARDED_BY_LOCK(lock) { false };
    std::atomic<unsigned> pendingTiles { 0 };
    // View of the last rendering update (pinch zoom): the layer the main frame
    // moves for scrolling, and the last gesture taken over
    PinchViewport pendingViewport WTF_GUARDED_BY_LOCK(lock);
    RefPtr<WebCore::CoordinatedPlatformLayer> pendingScrollLayer WTF_GUARDED_BY_LOCK(lock);
    unsigned pendingPinchCommit WTF_GUARDED_BY_LOCK(lock) { 0 };

    // What is visible right now (the scroll position comes from the layer)
    PinchViewport viewport WTF_GUARDED_BY_LOCK(lock);
    RefPtr<WebCore::CoordinatedPlatformLayer> scrollLayer WTF_GUARDED_BY_LOCK(lock);
    // Target of the gesture until a rendering update shows it
    std::optional<PinchZoom> pinchZoom WTF_GUARDED_BY_LOCK(lock);
    bool pinchActive WTF_GUARDED_BY_LOCK(lock) { false };
    unsigned pinchCommit WTF_GUARDED_BY_LOCK(lock) { 0 };
    // Target for the engine thread while it has not picked it up yet
    struct PinchRequest {
        float scale;
        WebCore::FloatPoint scrollPosition;
        unsigned commit;
    };
    std::optional<PinchRequest> pinchRequest WTF_GUARDED_BY_LOCK(lock);

    // Only on the compositor thread
    HashSet<Ref<WebCore::CoordinatedPlatformLayer>> committedLayers;

    // From any thread, the host calls directly: pinch gesture. The target goes
    // from here to the engine thread, so later host input (clicks) only arrives
    // there after the takeover.
    void pinch(PinchPhase, float factor, WebCore::FloatPoint focus);
    // From any thread: the wheel (DOM deltas) moves the scaled view while a
    // gesture runs or the engine thread does not show it yet.
    // false = no gesture, the wheel goes to the scrolling thread as usual
    bool scrollPinch(WebCore::FloatSize delta);

    // From any thread: composite on the next compositor frame
    void requestComposition(WebCore::CompositionReason);
    void scheduleFrameLocked() WTF_REQUIRES_LOCK(lock);
    // From any thread: tick the scrolling thread on the next frame
    // (ScrollingWasm.h), even if nothing new needs compositing
    void requestScrollingTick();
    void setHidden(bool);

private:
    explicit CompositorScene(int viewId);
    void commitPinchLocked() WTF_REQUIRES_LOCK(lock);
};

class LayerTreeHostWasm final : public WebCore::GraphicsLayerFactory, public WebCore::CoordinatedPlatformLayer::Client {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(LayerTreeHostWasm);
public:
    explicit LayerTreeHostWasm(WebView&);
    ~LayerTreeHostWasm();

    // Only with the compositor thread (Compositor.h)
    static bool isAvailable();

    void setRootCompositingLayer(WebCore::GraphicsLayer*);
    void setViewOverlayRootLayer(WebCore::GraphicsLayer*);
    void sizeDidChange(WebCore::IntSize pixelSize, float deviceScaleFactor);

    // After page->finalizeRenderingUpdate(): layer state to the compositor.
    // firstPaint: it reports WebView::firstPaintShown with the frame that shows
    // this state
    void flush(bool firstPaint = false);
    // The last rendering update is not shown yet
    bool isWaitingForCompositor() const { return m_waitingForCompositor; }
    // From the compositor (engine thread)
    void didComposite() { m_waitingForCompositor = false; }
    // Show everything again (e.g. new canvas)
    void forceRepaint();
    // Hidden, the compositor does not composite the view (no animations either)
    void setVisible(bool visible) { m_scene->setHidden(!visible); }
    // The view keeps painting without layers: nothing through the compositor anymore
    void detachScene();
    // The engine thread took over the target of a pinch gesture
    void didApplyPinch(unsigned commit);

private:
    void updateRootLayer();

    // CoordinatedPlatformLayer::Client
    WebCore::SkiaPaintingEngine& paintingEngine() const override { return *m_paintingEngine; }
    Ref<WebCore::CoordinatedImageBackingStore> imageBackingStore(Ref<WebCore::NativeImage>&&) override;
    void attachLayer(WebCore::CoordinatedPlatformLayer&) override;
    void detachLayer(WebCore::CoordinatedPlatformLayer&) override;
    void notifyCompositionRequired() override;
    bool isCompositionRequiredOrOngoing() const override { return m_compositionRequired || m_waitingForCompositor; }
    void requestComposition(WebCore::CompositionReason) override;
    RunLoop* compositingRunLoop() const override;
    int maxTextureSize() const override { return 4096; }
    void willPaintTile() override { ++m_scene->pendingTiles; }
    void didPaintTile() override;

    // GraphicsLayerFactory
    Ref<WebCore::GraphicsLayer> createGraphicsLayer(WebCore::GraphicsLayer::Type, WebCore::GraphicsLayerClient&) override;

    void flushLayerStates();

    WeakPtr<WebView> m_view;
    Ref<CompositorScene> m_scene;
    // Also read by the scrolling thread (requestComposition)
    Lock m_layersLock;
    HashSet<Ref<WebCore::CoordinatedPlatformLayer>> m_layers WTF_GUARDED_BY_LOCK(m_layersLock);
    HashSet<Ref<WebCore::CoordinatedPlatformLayer>> m_layersToRemove;
    WebCore::GraphicsLayer* m_rootCompositingLayer { nullptr };
    WebCore::GraphicsLayer* m_overlayCompositingLayer { nullptr };
    std::unique_ptr<WebCore::SkiaPaintingEngine> m_paintingEngine;
    HashMap<uint64_t, Ref<WebCore::CoordinatedImageBackingStore>> m_imageBackingStores;
    bool m_compositionRequired { false };
    bool m_layersChanged { false };
    bool m_waitingForCompositor { false };
    unsigned m_pinchCommit { 0 };
    // The scrolling thread moved layers
    std::atomic<bool> m_compositionRequiredInScrollingThread { false };
};

} // namespace BrowserLite
