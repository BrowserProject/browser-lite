// Compositing mit Ebenen (Coordinated Graphics), vereinfacht nach WebKit2
// (LayerTreeHost, CoordinatedSceneState, ThreadedCompositor).
//
// WebCore teilt die Seite in Ebenen (GraphicsLayerCoordinated). Jede Ebene
// malt ihre Kacheln selber (SkiaPaintingEngine, CPU in Hintergrund-Threads),
// der Compositor setzt die Kacheln mit Skia auf der GPU zusammen
// (SkiaCompositingLayer). Animationen von transform/opacity und Scrollen
// brauchen so kein neues Malen, nur ein neues Zusammensetzen.
//
// Anders als in WebKit2 laeuft hier alles im Engine-Thread: erst das
// Rendering-Update (flush), dann sofort das Zusammensetzen ins GPU-Ziel des
// Views. Nur das Malen der Kacheln laeuft parallel.
#pragma once

#include <WebCore/CoordinatedCompositionReason.h>
#include <WebCore/CoordinatedPlatformLayer.h>
#include <WebCore/GraphicsLayerFactory.h>
#include <atomic>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/OptionSet.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/WeakPtr.h>

class SkSurface;

namespace WebCore {
class CoordinatedImageBackingStore;
class GraphicsLayer;
class NativeImage;
class SkiaPaintingEngine;
}

namespace BrowserLite {

class WebView;

class LayerTreeHostWasm final : public WebCore::GraphicsLayerFactory, public WebCore::CoordinatedPlatformLayer::Client {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(LayerTreeHostWasm);
public:
    explicit LayerTreeHostWasm(WebView&);
    ~LayerTreeHostWasm();

    // Nur mit GPU (Gpu::context()) moeglich
    static bool isAvailable();

    void setRootCompositingLayer(WebCore::GraphicsLayer*);
    void setViewOverlayRootLayer(WebCore::GraphicsLayer*);
    bool hasRootLayer() const { return m_rootCompositingLayer; }
    void sizeDidChange();

    // Nach page->finalizeRenderingUpdate(): Zustand der Ebenen uebernehmen.
    // true, wenn ein neues Zusammensetzen noetig ist.
    bool flush();
    bool needsComposition() const { return !m_reasons.isEmpty(); }
    bool hasPendingRenderingUpdate() const { return m_reasons.contains(WebCore::CompositionReason::RenderingUpdate); }
    // Kacheln werden noch gemalt: mit dem Zusammensetzen warten
    bool isWaitingForTiles() const { return m_pendingTiles.load(); }

    // Setzt die Ebenen ins GPU-Ziel (braucht einen Gpu::Scope). Gibt true
    // zurueck, wenn noch Animationen laufen.
    bool composite(SkSurface&, float deviceScaleFactor);

private:
    void updateRootLayer();

    // CoordinatedPlatformLayer::Client
    WebCore::SkiaPaintingEngine& paintingEngine() const override { return *m_paintingEngine; }
    Ref<WebCore::CoordinatedImageBackingStore> imageBackingStore(Ref<WebCore::NativeImage>&&) override;
    void attachLayer(WebCore::CoordinatedPlatformLayer&) override;
    void detachLayer(WebCore::CoordinatedPlatformLayer&) override;
    void notifyCompositionRequired() override { m_compositionRequired = true; }
    bool isCompositionRequiredOrOngoing() const override { return m_compositionRequired || !m_reasons.isEmpty(); }
    void requestComposition(WebCore::CompositionReason) override;
    RunLoop* compositingRunLoop() const override;
    int maxTextureSize() const override;
    void willPaintTile() override { ++m_pendingTiles; }
    void didPaintTile() override;

    // GraphicsLayerFactory
    Ref<WebCore::GraphicsLayer> createGraphicsLayer(WebCore::GraphicsLayer::Type, WebCore::GraphicsLayerClient&) override;

    WeakPtr<WebView> m_view;
    int m_viewId;
    Ref<WebCore::CoordinatedPlatformLayer> m_rootLayer;
    HashSet<Ref<WebCore::CoordinatedPlatformLayer>> m_layers;
    HashSet<Ref<WebCore::CoordinatedPlatformLayer>> m_layersToRemove;
    WebCore::GraphicsLayer* m_rootCompositingLayer { nullptr };
    WebCore::GraphicsLayer* m_overlayCompositingLayer { nullptr };
    std::unique_ptr<WebCore::SkiaPaintingEngine> m_paintingEngine;
    HashMap<uint64_t, Ref<WebCore::CoordinatedImageBackingStore>> m_imageBackingStores;
    OptionSet<WebCore::CompositionReason> m_reasons;
    bool m_compositionRequired { false };
    bool m_layersChanged { false };
    bool m_pendingResize { false };
    std::atomic<unsigned> m_pendingTiles { 0 };
};

} // namespace BrowserLite
