// WebView: one page (view) with its own WebCore::Page, rendering into a pixel
// buffer and input events.
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
#include <wtf/Deque.h>
#include <wtf/Function.h>
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
    // Open views belong to the engine until close() releases them again
    static WebView& open(int id, WebCore::IntSize, float deviceScaleFactor);
    // New view the engine opens itself (window.open, target=_blank,
    // clients.openWindow): ID from 2^20 on (the host counts from 1), the host
    // gets "new-view". openerId 0 = without a view behind it
    static WebView& openFromEngine(int openerId, WebCore::IntSize, float deviceScaleFactor);
    static void close(int id);
    ~WebView();

    static WebView* fromID(int);
    // Not closed yet; after close() a dialog of its page may still hold the view
    bool isOpen() const;
    static void forEach(const Function<void(WebView&)>&);
    void setDarkAppearance(bool);

    // Host settings for all views (bl_set_preferences), only on the engine thread
    enum class Preference : uint8_t {
        NoJavaScript = 1 << 0,
        NoImages = 1 << 1,
        GlobalPrivacyControl = 1 << 2,
        SaveData = 1 << 3,
    };
    static void setPreferences(OptionSet<Preference>);
    static OptionSet<Preference> preferences();

    int id() const { return m_id; }
    void exitFullscreen();

    WebCore::Page& page() { return *m_page; }
    WebCore::LocalFrame* mainFrame() const;
    WebCore::LocalFrameView* mainFrameView() const;

    // Loading
    void loadURL(const String&);
    void loadHTML(const String& html, const String& baseURL);
    void goBack();
    // Puts the view's history back and loads the current entry:
    // {"entries":[{"url":..,"title":..}],"index":n}
    void restoreHistory(const String&);
    void goForward();
    void reload();
    void stop();
    String currentURL() const;
    String title() const;

    // Size in CSS pixels, deviceScaleFactor for HiDPI
    void resize(WebCore::IntSize, float deviceScaleFactor);
    WebCore::IntSize size() const { return m_size; }
    float deviceScaleFactor() const { return m_deviceScaleFactor; }

    // Rendering
    void addDamage(const WebCore::IntRect&);
    void scrollDamage(const WebCore::IntSize& delta, const WebCore::IntRect& rectToScroll, const WebCore::IntRect& clipRect);
    void scheduleRenderingUpdate();
    // Link under the mouse (ChromeClient): a press on it connects to its origin ahead
    void setHoveredLink(const String& link) { m_hoveredLink = link; }
    // Rendering update (rAF, style, layout) and repaint what is damaged.
    // Returns true if pixels changed.
    bool renderFrame(WebCore::IntRect* dirtyOut = nullptr);
    void framePresented() { m_frameInFlight = false; }
    bool frameInFlight() const { return m_frameInFlight; }
    void presentIfNeeded();
    // The host gave the canvas to the engine worker: show everything again
    void canvasAttached();

    // Compositing with layers (LayerTreeHostWasm.h), with GPU, unless BL_COMPOSITING=0
    bool isCompositing() const { return m_compositing; }
    LayerTreeHostWasm* layerTreeHost() const { return m_compositing ? m_layerTreeHost.get() : nullptr; }
    WebCore::GraphicsLayerFactory* graphicsLayerFactory() const;
    void attachRootGraphicsLayer(WebCore::GraphicsLayer*);
    void attachViewOverlayGraphicsLayer(WebCore::GraphicsLayer*);
    // Composite the layers again (without a rendering update)
    void requestComposite();
    // From the compositor thread: the last rendering update is shown
    void didComposite();
    void compositorLost();
    // From any thread: the first frame after the first visible layout is shown
    static void firstPaintShown(int id);
    // GPU of the engine worker lost or back (GpuRaster.cpp)
    void gpuLost() { dropGpuSurface(); }
    // true if the view paints on the GPU again
    bool gpuRestored();

    const uint8_t* pixels() const { return m_pixels.span().data(); }
    WebCore::IntSize pixelSize() const { return m_pixelSize; }

    // Input (coordinates in CSS pixels relative to the view)
    void mouseEvent(int type, int button, double x, double y, int clickCount, int modifiers, double movementX = 0, double movementY = 0);
    void wheelEvent(double x, double y, double deltaX, double deltaY, int modifiers);
    // Drag and drop: from the page (DragClient) and from the host (bl_drag,
    // phase 0 = over the page, 1 = left, 2 = drop; data as JSON)
    void startPageDrag(Ref<WebCore::WasmPlatform::DragContent>&&, OptionSet<WebCore::DragOperation> sourceOperations);
    void hostDrag(int phase, double x, double y, int modifiers, const String& data);
    void cancelDrag();
    static WebCore::PlatformWheelEvent makeWheelEvent(double x, double y, double deltaX, double deltaY, int modifiers);
    // Also from the scrolling thread (ScrollingWasm.cpp), with the steps still missing
    void dispatchWheelEvent(const WebCore::PlatformWheelEvent&, OptionSet<WebCore::WheelEventProcessingSteps>);
    // Ctrl + wheel: only the DOM event, no scrolling. With cancelable the
    // engine reports "wheel-result", whether the page called preventDefault
    void zoomWheelEvent(const WebCore::PlatformWheelEvent&, bool cancelable);
    // ChromeClient: scrolling in its own thread when with layers
    RefPtr<WebCore::ScrollingCoordinator> createScrollingCoordinator(WebCore::Page&) const;
#if ENABLE(POINTER_LOCK)
    void requestPointerLock(CompletionHandler<void(WebCore::PointerLockRequestResult)>&&);
    void requestPointerUnlock();
    // Answer/end from the host: false = not granted or lost (Esc)
    void pointerLockResult(bool locked);
#endif
    void touchEvent(int type, const String& pointsJSON, int modifiers);
    bool keyEvent(int type, const String& key, const String& code, const String& text, int keyCode, bool repeat, int modifiers);
    void insertText(const String&);
    // Text input with preview (IME, dead keys): underlined text in the page
    void setComposition(const String&, unsigned selectionStart, unsigned selectionEnd);
    void confirmComposition(const String&);
    // Right click: first the page's contextmenu event, then (if the page does
    // not handle it) information for the host's menu
    void contextMenu(double x, double y);
    // Editor command like "Copy", "Paste", "SelectAll"
    void executeCommand(const String&);
    void setFocused(bool);
    // Background view or host tab hidden: the page is hidden
    // (visibilityState, no rAF, timers throttled) and does not paint
    void setVisible(bool);
    // The page plays sound: hidden, its timers are not throttled (like Chrome)
    void setAudible(bool);
    void focusInitial(bool forward);
    void setZoom(float);
    // Pinch zoom (PinchZoom.h): only scale the view, the layout stays. pinch()
    // only without the compositor, otherwise the compositor thread does the
    // gesture and hands over at the end with setPageScale() (commit for LayerTreeHostWasm)
    void pinch(PinchPhase, float factor, WebCore::FloatPoint focus);
    void setPageScale(float scale, WebCore::FloatPoint scrollPosition, unsigned pinchCommit = 0);
    PinchViewport pinchViewport() const;
    void find(const String&, bool backwards, bool again);
    void stopFind();

    // A dialog of this view's page group is open (Clients.cpp, #258): its
    // script waits, so the view drops input, holds back commands and makes no
    // rendering update (the last frame stays) until unblockAfterDialog()
    void blockForDialog() { ++m_dialogBlocks; }
    void unblockAfterDialog();
    bool isBlockedByDialog() const { return m_dialogBlocks; }
    // A command of the host: runs now, while blocked afterwards in order
    void runWhenNotBlocked(Function<void(WebView&)>&&);

    // For the clients
    void didStartLoading();
    // The next error page (ErrorPage.cpp) is because of an invalid certificate
    void willCommitErrorPage(bool certificate) { m_errorPageCertificate = certificate; }
    void didCommitLoad();
    // Anchor, pushState/replaceState, popstate: new address without a new document
    void didNavigateWithinPage();
    void didFinishLoading();
    // Cancelled (stop, new navigation, download): no error, not finished
    void didStopLoading();
    void didReachLayoutMilestone(OptionSet<WebCore::LayoutMilestone>);
    void didFailLoading(const String& url, const String& description);
    void didChangeTitle(const String&);
    void didChangeProgress(double);
    void didChangeCursor(const String& cssCursor);
    void didReceiveConsoleMessage(int level, const String& message, const String& source, unsigned line);
    bool isLoading() const { return m_isLoading; }

    // <input type=file>: the host shows the file dialog, writes the files into
    // the virtual file system and then calls chooseFiles()
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
    unsigned m_dialogBlocks { 0 };
    Deque<Function<void(WebView&)>> m_heldCommands;
    void runHeldCommands();
    WebCore::IntSize m_size;
    float m_deviceScaleFactor { 1 };
    WebCore::IntSize m_pixelSize;
    RefPtr<WebCore::Page> m_page;

    Vector<uint8_t> m_pixels;
    sk_sp<SkSurface> m_surface;
    // GPU rasterization (GpuRaster.h): target surface as texture, otherwise m_surface on the CPU
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
    // Scrolling: move pixels instead of repainting. Only done with the next
    // frame, because the host still copies the old frame before.
    struct PendingScroll {
        WebCore::IntSize delta;
        WebCore::IntRect area;
    };
    Vector<PendingScroll> m_pendingScrolls;
    void applyPendingScrolls(WebCore::IntRect& presented);
    bool m_renderingUpdateRequested { false };
    // A frame is wanted; hidden, only setVisible(true) asks the host
    bool m_frameRequested { false };
    void requestFrame();
    bool m_visible { true };
    bool m_audible { false };
    void updateActivityState();
    bool m_frameInFlight { false };
    bool m_needsFullPresent { false };
    bool m_compositedFrameMissed { false };
    // A visible view that wants a rendering update but gets none for 2 s asks for the frame
    // again, after twice its state goes to the log (once). Seen only in CI (devices-test: no
    // media query events and scrolling anymore, while scripts still ran).
    unsigned m_renderingUpdates { 0 };
    unsigned m_renderingUpdatesAtStallCheck { 0 };
    unsigned m_stallChecksMissed { 0 };
    bool m_stallCheckPending { false };
    bool m_stallLogged { false };
    void checkRenderingStall();
    // First frame after the first visible layout of a page (event
    // "first-paint"): the next rendering update carries it, with layers the
    // compositor thread reports it with the frame that shows it
    enum class FirstPaint : uint8_t { None, WaitingForLayout, WaitingForUpdate };
    FirstPaint m_firstPaint { FirstPaint::None };
    String m_hoveredLink;
    // In Page::updateRendering (for the debug log of the first layout)
    bool m_inRenderingUpdate { false };
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
