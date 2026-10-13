// Compositing mit Ebenen (Coordinated Graphics), nach WebKit2 (LayerTreeHost,
// CoordinatedSceneState, ThreadedCompositor).
//
// WebCore teilt die Seite in Ebenen (GraphicsLayerCoordinated). Jede Ebene
// malt ihre Kacheln selber (SkiaPaintingEngine, CPU in Hintergrund-Threads).
// Der Compositor-Thread (Compositor.h) setzt die Kacheln mit Skia auf der GPU
// zusammen (SkiaCompositingLayer) und zeigt das Bild. Animationen von
// transform/opacity laufen dort weiter, auch wenn der Engine-Thread mit dem JS
// der Seite beschaeftigt ist.
//
// Ablauf pro Bild: Engine-Thread macht das Rendering-Update und flush(), der
// Compositor uebernimmt den neuen Stand beim naechsten Bild (rAF in seinem
// Worker), sobald alle Kacheln gemalt sind, und meldet "fertig" zurueck. Erst
// dann kommt das naechste Rendering-Update.
#pragma once

#include <WebCore/CoordinatedCompositionReason.h>
#include <WebCore/CoordinatedPlatformLayer.h>
#include <WebCore/GraphicsLayerFactory.h>
#include <WebCore/IntSize.h>
#include <atomic>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/Lock.h>
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

// Gemeinsamer Stand von Engine- und Compositor-Thread (wie CoordinatedSceneState)
class CompositorScene final : public ThreadSafeRefCounted<CompositorScene> {
public:
    static Ref<CompositorScene> create(int viewId) { return adoptRef(*new CompositorScene(viewId)); }

    const int viewId;
    const Ref<WebCore::CoordinatedPlatformLayer> rootLayer;

    // Stand der Ebenen uebernehmen (flushPendingState) und lesen
    // (flushPositionChanges) nie gleichzeitig: Engine-, Scroll- und Compositor-Thread
    Lock stateLock;

    Lock lock;
    HashSet<Ref<WebCore::CoordinatedPlatformLayer>> pendingLayers WTF_GUARDED_BY_LOCK(lock);
    bool hasPendingLayers WTF_GUARDED_BY_LOCK(lock) { false };
    HashSet<Ref<WebCore::CoordinatedPlatformLayer>> pendingLayersToRemove WTF_GUARDED_BY_LOCK(lock);
    WebCore::IntSize pixelSize WTF_GUARDED_BY_LOCK(lock);
    float deviceScaleFactor WTF_GUARDED_BY_LOCK(lock) { 1 };
    OptionSet<WebCore::CompositionReason> reasons WTF_GUARDED_BY_LOCK(lock);
    bool frameScheduled WTF_GUARDED_BY_LOCK(lock) { false };
    bool waitingForTiles WTF_GUARDED_BY_LOCK(lock) { false };
    bool notifyEngine WTF_GUARDED_BY_LOCK(lock) { false };
    bool invalidated WTF_GUARDED_BY_LOCK(lock) { false };
    // Naechstes Bild auch ohne neuen Inhalt (Takt fuer den Scroll-Thread)
    bool scrollingTick WTF_GUARDED_BY_LOCK(lock) { false };
    std::atomic<unsigned> pendingTiles { 0 };

    // Nur auf dem Compositor-Thread
    HashSet<Ref<WebCore::CoordinatedPlatformLayer>> committedLayers;

    // Von jedem Thread: beim naechsten Bild des Compositors zusammensetzen
    void requestComposition(WebCore::CompositionReason);
    void scheduleFrameLocked() WTF_REQUIRES_LOCK(lock);
    // Von jedem Thread: beim naechsten Bild den Scroll-Thread takten
    // (ScrollingWasm.h), auch wenn nichts neu zusammenzusetzen ist
    void requestScrollingTick();

private:
    explicit CompositorScene(int viewId);
};

class LayerTreeHostWasm final : public WebCore::GraphicsLayerFactory, public WebCore::CoordinatedPlatformLayer::Client {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(LayerTreeHostWasm);
public:
    explicit LayerTreeHostWasm(WebView&);
    ~LayerTreeHostWasm();

    // Nur mit Compositor-Thread (Compositor.h)
    static bool isAvailable();

    void setRootCompositingLayer(WebCore::GraphicsLayer*);
    void setViewOverlayRootLayer(WebCore::GraphicsLayer*);
    void sizeDidChange(WebCore::IntSize pixelSize, float deviceScaleFactor);

    // Nach page->finalizeRenderingUpdate(): Stand der Ebenen an den Compositor
    void flush();
    // Das letzte Rendering-Update ist noch nicht gezeigt
    bool isWaitingForCompositor() const { return m_waitingForCompositor; }
    // Vom Compositor (Engine-Thread)
    void didComposite() { m_waitingForCompositor = false; }
    // Alles neu zeigen (z.B. neues Canvas)
    void forceRepaint();

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
    // Auch vom Scroll-Thread gelesen (requestComposition)
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
    // Der Scroll-Thread hat Ebenen verschoben
    std::atomic<bool> m_compositionRequiredInScrollingThread { false };
};

} // namespace BrowserLite
