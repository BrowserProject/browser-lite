// WebView: eine Seite (Tab) mit eigener WebCore::Page, Rendering in einen
// Pixel-Buffer und Eingabe-Events.
#pragma once

#include "PinchZoom.h"
#include <WebCore/DragActions.h>
#include <WebCore/IntRect.h>
#include <WebCore/IntSize.h>
#include <WebCore/LayoutMilestone.h>
#include <WebCore/PlatformWheelEvent.h>
#include <WebCore/ScrollingCoordinatorTypes.h>
#include <WebCore/Region.h>
#include <WebCore/WasmPlatform.h>
#include <skia/core/SkRefCnt.h>
#include <wtf/CheckedRef.h>
#include <wtf/CompletionHandler.h>
#include <wtf/RefCounted.h>
#include <wtf/RefPtr.h>
#include <wtf/URL.h>
#include <wtf/Vector.h>
#include <wtf/WeakPtr.h>
#include <wtf/text/WTFString.h>

class SkSurface;

namespace WebCore {
enum class PointerLockRequestResult : uint8_t;
class FileChooser;
class GraphicsLayer;
class GraphicsLayerFactory;
class LocalFrame;
class LocalFrameView;
class Page;
class ScrollingCoordinator;
}

namespace BrowserLite {

class LayerTreeHostWasm;

class WebView : public RefCounted<WebView>, public CanMakeWeakPtr<WebView> {
public:
    static Ref<WebView> create(int id, WebCore::IntSize, float deviceScaleFactor);
    // Offene Views gehoeren der Engine, bis close() sie wieder freigibt
    static WebView& open(int id, WebCore::IntSize, float deviceScaleFactor);
    // Neuer Tab, den die Engine selber oeffnet (window.open, target=_blank,
    // clients.openWindow): ID ab 2^20 (die Oberflaeche zaehlt ab 1), die
    // Oberflaeche bekommt "newview". openerId 0 = ohne Tab dahinter
    static WebView& openFromEngine(int openerId, WebCore::IntSize, float deviceScaleFactor);
    static void close(int id);
    ~WebView();

    static WebView* fromID(int);
    static void forEach(const Function<void(WebView&)>&);
    void setDarkAppearance(bool);

    // Einstellungen der Oberflaeche fuer alle Tabs (bl_set_preferences), nur im Engine-Thread
    enum class Preference : uint8_t {
        NoJavaScript = 1 << 0,
        NoImages = 1 << 1,
        GlobalPrivacyControl = 1 << 2,
    };
    static void setPreferences(OptionSet<Preference>);
    static OptionSet<Preference> preferences();

    int id() const { return m_id; }
    void exitFullscreen();

    WebCore::Page& page() { return *m_page; }
    WebCore::LocalFrame* mainFrame() const;
    WebCore::LocalFrameView* mainFrameView() const;

    // Laden
    void loadURL(const String&);
    void loadHTML(const String& html, const String& baseURL);
    void goBack();
    // Verlauf des Tabs wieder einsetzen und den aktuellen Eintrag laden:
    // {"entries":[{"url":..,"title":..}],"index":n}
    void restoreHistory(const String&);
    void goForward();
    void reload();
    void stop();
    String currentURL() const;
    String title() const;

    // Groesse in CSS-Pixeln, deviceScaleFactor fuer HiDPI
    void resize(WebCore::IntSize, float deviceScaleFactor);
    WebCore::IntSize size() const { return m_size; }
    float deviceScaleFactor() const { return m_deviceScaleFactor; }

    // Rendering
    void addDamage(const WebCore::IntRect&);
    void scrollDamage(const WebCore::IntSize& delta, const WebCore::IntRect& rectToScroll, const WebCore::IntRect& clipRect);
    void scheduleRenderingUpdate();
    // Rendering-Update (rAF, Style, Layout) und neu malen was kaputt ist.
    // Gibt true zurueck, wenn sich Pixel geaendert haben.
    bool renderFrame(WebCore::IntRect* dirtyOut = nullptr);
    void framePresented() { m_frameInFlight = false; }
    bool frameInFlight() const { return m_frameInFlight; }
    void presentIfNeeded();
    // Die Oberflaeche hat das Canvas an den Engine-Worker gegeben: alles neu zeigen
    void canvasAttached();

    // Compositing mit Ebenen (LayerTreeHostWasm.h), mit GPU, ausser BL_COMPOSITING=0
    bool isCompositing() const { return m_compositing; }
    LayerTreeHostWasm* layerTreeHost() const { return m_compositing ? m_layerTreeHost.get() : nullptr; }
    WebCore::GraphicsLayerFactory* graphicsLayerFactory() const;
    void attachRootGraphicsLayer(WebCore::GraphicsLayer*);
    void attachViewOverlayGraphicsLayer(WebCore::GraphicsLayer*);
    // Ebenen neu zusammensetzen (ohne Rendering-Update)
    void requestComposite();
    // Vom Compositor-Thread: das letzte Rendering-Update ist gezeigt
    void didComposite();
    void compositorLost();
    // Von jedem Thread: das erste Bild nach dem ersten sichtbaren Layout ist zu sehen
    static void firstPaintShown(int id);
    // GPU des Engine-Workers verloren oder wieder da (GpuRaster.cpp)
    void gpuLost() { dropGpuSurface(); }
    // true, wenn der View wieder auf der GPU malt
    bool gpuRestored();

    const uint8_t* pixels() const { return m_pixels.span().data(); }
    WebCore::IntSize pixelSize() const { return m_pixelSize; }

    // Eingabe (Koordinaten in CSS-Pixeln relativ zur View)
    void mouseEvent(int type, int button, double x, double y, int clickCount, int modifiers, double movementX = 0, double movementY = 0);
    void wheelEvent(double x, double y, double deltaX, double deltaY, int modifiers);
    // Drag & Drop: aus der Seite (DragClient) und aus dem Host (bl_drag,
    // phase 0 = ueber der Seite, 1 = verlassen, 2 = ablegen; data als JSON)
    void startPageDrag(Ref<WebCore::WasmPlatform::DragContent>&&, OptionSet<WebCore::DragOperation> sourceOperations);
    void hostDrag(int phase, double x, double y, int modifiers, const String& data);
    void cancelDrag();
    static WebCore::PlatformWheelEvent makeWheelEvent(double x, double y, double deltaX, double deltaY, int modifiers);
    // Auch vom Scroll-Thread (ScrollingWasm.cpp), mit den Schritten, die noch fehlen
    void dispatchWheelEvent(const WebCore::PlatformWheelEvent&, OptionSet<WebCore::WheelEventProcessingSteps>);
    // Strg + Rad: nur das DOM-Event, kein Scrollen. Mit cancelable meldet die
    // Engine "wheel-result", ob die Seite preventDefault gerufen hat
    void zoomWheelEvent(const WebCore::PlatformWheelEvent&, bool cancelable);
    // ChromeClient: Scrollen im eigenen Thread, wenn mit Ebenen
    RefPtr<WebCore::ScrollingCoordinator> createScrollingCoordinator(WebCore::Page&) const;
#if ENABLE(POINTER_LOCK)
    void requestPointerLock(CompletionHandler<void(WebCore::PointerLockRequestResult)>&&);
    void requestPointerUnlock();
    // Antwort/Ende vom Host: false = nicht bekommen oder verloren (Esc)
    void pointerLockResult(bool locked);
#endif
    void touchEvent(int type, const String& pointsJSON, int modifiers);
    bool keyEvent(int type, const String& key, const String& code, const String& text, int keyCode, bool repeat, int modifiers);
    void insertText(const String&);
    // Texteingabe mit Vorschau (IME, tote Tasten): unterstrichener Text in der Seite
    void setComposition(const String&, unsigned selectionStart, unsigned selectionEnd);
    void confirmComposition(const String&);
    // Rechtsklick: zuerst das contextmenu-Event der Seite, dann (wenn die Seite
    // es nicht abfaengt) Infos fuer das Menue der Oberflaeche
    void contextMenu(double x, double y);
    // Editor-Befehl wie "Copy", "Paste", "SelectAll"
    void executeCommand(const String&);
    void setFocused(bool);
    // Hintergrund-Tab oder Tab des Host verdeckt: die Seite ist versteckt
    // (visibilityState, kein rAF, Timer gedrosselt) und malt nicht
    void setVisible(bool);
    // Seite spielt Ton: versteckt werden ihre Timer nicht gedrosselt (wie Chrome)
    void setAudible(bool);
    void focusInitial(bool forward);
    void setZoom(float);
    // Pinch-Zoom (PinchZoom.h): nur die Ansicht skalieren, Layout bleibt.
    // pinch() nur ohne Compositor, sonst macht die Geste der Compositor-Thread
    // und uebergibt am Ende mit setPageScale() (commit fuer LayerTreeHostWasm)
    void pinch(PinchPhase, float factor, WebCore::FloatPoint focus);
    void setPageScale(float scale, WebCore::FloatPoint scrollPosition, unsigned pinchCommit = 0);
    PinchViewport pinchViewport() const;
    void find(const String&, bool backwards, bool again);
    void stopFind();

    // Fuer die Clients
    void didStartLoading();
    // Die naechste Fehlerseite (ErrorPage.cpp) ist wegen eines ungueltigen Zertifikats
    void willCommitErrorPage(bool certificate) { m_errorPageCertificate = certificate; }
    void didCommitLoad();
    // Anker, pushState/replaceState, popstate: neue Adresse ohne neues Dokument
    void didNavigateWithinPage();
    void didFinishLoading();
    // Abgebrochen (Stopp, neue Navigation, Download): kein Fehler, nicht fertig
    void didStopLoading();
    void didReachLayoutMilestone(OptionSet<WebCore::LayoutMilestone>);
    void didFailLoading(const String& url, const String& description);
    void didChangeTitle(const String&);
    void didChangeProgress(double);
    void didChangeCursor(const String& cssCursor);
    void didReceiveConsoleMessage(int level, const String& message, const String& source, unsigned line);
    bool isLoading() const { return m_isLoading; }

    // <input type=file>: die Oberflaeche zeigt den Dateidialog, schreibt die
    // Dateien ins virtuelle Dateisystem und ruft dann chooseFiles() auf
    void openFileChooser(WebCore::FileChooser&);
    void chooseFiles(const Vector<String>& paths);

private:
    struct DragSession {
        Ref<WebCore::WasmPlatform::DragContent> content;
        bool fromPage { false };
        OptionSet<WebCore::DragOperation> sourceOperations;
        std::optional<WebCore::DragOperation> operation;
        WebCore::IntPoint lastPoint;
    };
    void updateDrag(WebCore::IntPoint, int modifiers);
    void endDrag(WebCore::IntPoint, bool drop, int modifiers);
    std::optional<DragSession> m_drag;
    std::optional<PinchZoom> m_pinch;

    WebView(int id, WebCore::IntSize, float deviceScaleFactor);
    void createSurface();
    void notifyNavigationState();

    int m_id;
    WebCore::IntSize m_size;
    float m_deviceScaleFactor { 1 };
    WebCore::IntSize m_pixelSize;
    RefPtr<WebCore::Page> m_page;

    Vector<uint8_t> m_pixels;
    sk_sp<SkSurface> m_surface;
    // GPU-Rastern (GpuRaster.h): Zielflaeche als Textur, sonst m_surface auf der CPU
    sk_sp<SkSurface> m_gpuSurface;
    bool m_canvasAttached { false };
    void createGpuSurfaceIfPossible();
    void dropGpuSurface();
    std::unique_ptr<LayerTreeHostWasm> m_layerTreeHost;
    bool m_compositing { false };
    bool m_repaintAfterCompositingStopped { false };
    bool renderCompositedFrame(WebCore::IntRect* dirtyOut);
    void stopCompositing();
    WebCore::Region m_damage;
    // Scrollen: Pixel verschieben statt neu malen. Wird erst beim naechsten
    // Bild ausgefuehrt, weil die Oberflaeche vorher noch das alte Bild kopiert.
    struct PendingScroll {
        WebCore::IntSize delta;
        WebCore::IntRect area;
    };
    Vector<PendingScroll> m_pendingScrolls;
    void applyPendingScrolls(WebCore::IntRect& presented);
    bool m_renderingUpdateRequested { false };
    // Ein Bild ist gewuenscht; versteckt fragt erst setVisible(true) den Host
    bool m_frameRequested { false };
    void requestFrame();
    bool m_visible { true };
    bool m_audible { false };
    void updateActivityState();
    bool m_frameInFlight { false };
    bool m_needsFullPresent { false };
    bool m_compositedFrameMissed { false };
    // Erstes Bild nach dem ersten sichtbaren Layout einer Seite (Ereignis
    // "first-paint"): das naechste Rendering-Update traegt es, mit Ebenen
    // meldet es der Compositor-Thread mit dem Bild, das es zeigt
    enum class FirstPaint : uint8_t { None, WaitingForLayout, WaitingForUpdate };
    FirstPaint m_firstPaint { FirstPaint::None };
    bool m_errorPageCertificate { false };
    void loadFavicon();

    bool m_isLoading { false };
    URL m_faviconURL;
    RefPtr<WebCore::FileChooser> m_fileChooser;
#if ENABLE(POINTER_LOCK)
    CompletionHandler<void(WebCore::PointerLockRequestResult)> m_pointerLockHandler;
#endif
};

} // namespace BrowserLite
