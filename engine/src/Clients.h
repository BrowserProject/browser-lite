// WebCore clients of the engine. They derive from the "Empty" clients (patch
// 0007 makes their methods overridable) and only override what a real browser
// needs.
#pragma once

#include <WebCore/DragClient.h>
#include <WebCore/EmptyClients.h>
#include <WebCore/EmptyFrameLoaderClient.h>
#include <WebCore/ProgressTrackerClient.h>
#include <wtf/WeakPtr.h>

namespace BrowserLite {

class WebView;

// Ends the open dialogs of a view with the default answer (the view closes)
void dismissDialogs(int viewId);

class ChromeClient final : public WebCore::EmptyChromeClient {
public:
    explicit ChromeClient(WebView&);

    // Does the main document have a beforeunload listener? Goes to the host as
    // the event "beforeunload", the host asks when its tab closes.
    static void reportBeforeUnload(WebView&);

    // A real page, not a helper page like an SVG image (that would mean
    // EmptyChromeClient): otherwise ~Page does not free its pages in the
    // back/forward cache, they live on and the cache crashes when pruning
    bool isEmptyChromeClient() const final { return false; }

private:
    void chromeDestroyed() final { }

    WebCore::FloatRect windowRect() const final;
    WebCore::FloatRect pageRect() const final;

    // window.focus(), window.open() on an open window, WindowClient.focus():
    // view to the front (WebCore checks before whether the page may do that)
    void focus() final;
    void unfocus() final { }
    bool canTakeFocus(WebCore::FocusDirection) const final { return true; }
    void takeFocus(WebCore::FocusDirection) final;

    void invalidateRootView(const WebCore::IntRect&) final;
    void invalidateContentsAndRootView(const WebCore::IntRect&) final;
    void invalidateContentsForSlowScroll(const WebCore::IntRect&) final;
    void scroll(const WebCore::IntSize&, const WebCore::IntRect&, const WebCore::IntRect&) final;

    WebCore::IntPoint screenToRootView(const WebCore::IntPoint& p) const final { return p; }
    WebCore::IntPoint rootViewToScreen(const WebCore::IntPoint& p) const final { return p; }
    WebCore::IntRect rootViewToScreen(const WebCore::IntRect& r) const final { return r; }

    void contentsSizeChanged(WebCore::LocalFrame&, const WebCore::IntSize&) const final;
    void setCursor(const WebCore::Cursor&) final;

    // CSS pointer/hover: mouse, with a touch screen also coarse; mobile device
    // touch only (WasmPlatform::ScreenInfo, bl_set_screen)
    bool hoverSupportedByPrimaryPointingDevice() const final;
    bool hoverSupportedByAnyAvailablePointingDevice() const final;
    std::optional<WebCore::PointerCharacteristics> pointerCharacteristicsOfPrimaryPointingDevice() const final;
    OptionSet<WebCore::PointerCharacteristics> pointerCharacteristicsOfAllAvailablePointingDevices() const final;

    void addMessageToConsole(JSC::MessageSource, JSC::MessageLevel, const String& message, unsigned lineNumber, unsigned columnNumber, const String& sourceID) final;
    void runJavaScriptAlert(WebCore::LocalFrame&, const String&) final;
    void print(WebCore::LocalFrame&, const WebCore::StringWithDirection&) final;
    // Does the page play sound? (speaker icon like Chrome)
    void isPlayingMediaDidChange(WebCore::MediaProducerMediaStateFlags) final;
    bool runJavaScriptConfirm(WebCore::LocalFrame&, const String&) final;
    bool runJavaScriptPrompt(WebCore::LocalFrame&, const String& message, const String& defaultValue, String& result) final;
    bool canRunBeforeUnloadConfirmPanel() final { return true; }
    bool runBeforeUnloadConfirmPanel(String&& message, WebCore::LocalFrame&) final;
    // This is how WebCore reports unload and beforeunload listeners
    void enableSuddenTermination() final { reportBeforeUnload(m_view.get()); }
    void disableSuddenTermination() final { reportBeforeUnload(m_view.get()); }

    RefPtr<WebCore::Page> createWindow(WebCore::LocalFrame&, const String&, const WebCore::WindowFeatures&, const WebCore::NavigationAction&) final;
    void closeWindow() final;
    void runOpenPanel(WebCore::LocalFrame&, WebCore::FileChooser&) final;

    RefPtr<WebCore::PopupMenu> createPopupMenu(WebCore::PopupMenuClient&) const final;
    RefPtr<WebCore::SearchPopupMenu> createSearchPopupMenu(WebCore::PopupMenuClient&) const final;
    RefPtr<WebCore::ColorChooser> createColorChooser(WebCore::ColorChooserClient&, const WebCore::Color&) final;
    RefPtr<WebCore::DateTimeChooser> createDateTimeChooser(WebCore::DateTimeChooserClient&) final;
#if ENABLE(POINTER_LOCK)
    void requestPointerLock(CompletionHandler<void(WebCore::PointerLockRequestResult)>&&) final;
    void requestPointerUnlock(CompletionHandler<void(bool)>&&) final;
#endif
    void mouseDidMoveOverElement(const WebCore::HitTestResult&, OptionSet<WebCore::PlatformEventModifier>, const String& toolTip, WebCore::TextDirection) final;

    void triggerRenderingUpdate() final;
    WebCore::GraphicsLayerFactory* graphicsLayerFactory() const final;
    void attachRootGraphicsLayer(WebCore::LocalFrame&, WebCore::GraphicsLayer*) final;
    RefPtr<WebCore::ScrollingCoordinator> createScrollingCoordinator(WebCore::Page&) const final;
    void attachViewOverlayGraphicsLayer(WebCore::GraphicsLayer*) final;
    bool scheduleRenderingUpdate() final;

#if ENABLE(FULLSCREEN_API)
    bool supportsFullScreenForElement(const WebCore::Element&, bool) final { return true; }
    void enterFullScreenForElement(WebCore::Element&, WebCore::HTMLMediaElementEnums::VideoFullscreenMode, CompletionHandler<void(WebCore::ExceptionOr<void>)>&&, CompletionHandler<bool(bool)>&&) final;
    void exitFullScreenForElement(WebCore::Element*, CompletionHandler<void()>&&) final;
#endif

    WeakRef<WebView> m_view;
    bool m_audible { false };
    bool m_capturing { false };
    String m_hoveredLink;
    String m_toolTip;
};

class FrameLoaderClient final : public WebCore::EmptyFrameLoaderClient {
public:
    FrameLoaderClient(WebCore::FrameLoader&, WebView&);

private:
    void dispatchDecidePolicyForNavigationAction(const WebCore::NavigationAction&, const WebCore::ResourceRequest&, const WebCore::ResourceResponse&, WebCore::FormState*, const String&, std::optional<WebCore::NavigationIdentifier>, std::optional<WebCore::HitTestResult>&&, bool, WebCore::NavigationUpgradeToHTTPSBehavior, WebCore::SandboxFlags, WebCore::PolicyDecisionMode, WebCore::FramePolicyFunction&&) final;
    void dispatchDecidePolicyForResponse(const WebCore::ResourceResponse&, const WebCore::ResourceRequest&, const String&, WebCore::FramePolicyFunction&&) final;
    void dispatchDecidePolicyForNewWindowAction(const WebCore::NavigationAction&, const WebCore::ResourceRequest&, WebCore::FormState*, const String&, std::optional<WebCore::HitTestResult>&&, WebCore::FramePolicyFunction&&) final;

    bool canHandleRequest(const WebCore::ResourceRequest&) const final { return true; }
    // Like WebKit2: otherwise PingLoader sends <a ping> and CSP reports without cookies
    bool shouldUseCredentialStorage(WebCore::DocumentLoader*, WebCore::ResourceLoaderIdentifier) final { return true; }
    bool canShowMIMEType(const String&) const final;
    bool canShowMIMETypeAsHTML(const String&) const final { return true; }
    // <object>/<embed>: image or frame by MIME type (there are no plugins)
    WebCore::ObjectContentType objectContentType(const URL&, const String& mimeType) final;
    void startDownload(const WebCore::ResourceRequest&, const String& suggestedName, WebCore::FromDownloadAttribute) final;
    void convertMainResourceLoadToDownload(WebCore::DocumentLoader*, const WebCore::ResourceRequest&, const WebCore::ResourceResponse&) final;
    void committedLoad(WebCore::DocumentLoader*, const WebCore::SharedBuffer&) final;
    String userAgent(const URL&) const final;

    RefPtr<WebCore::LocalFrame> createFrame(const AtomString& name, WebCore::HTMLFrameOwnerElement&) final;
    WebCore::LocalFrame* dispatchCreatePage(const WebCore::NavigationAction&, WebCore::NewFrameOpenerPolicy, const String& openedMainFrameName) final;
    void transitionToCommittedForNewPage(InitializingIframe) final;

    void dispatchDidStartProvisionalLoad() final;
    void dispatchDidCommitLoad(std::optional<WebCore::HasInsecureContent>, std::optional<WebCore::UsedLegacyTLS>, std::optional<WebCore::WasPrivateRelayed>) final;
    void dispatchDidReceiveTitle(const WebCore::StringWithDirection&) final;
    // Within the same document (anchor, history.pushState/replaceState,
    // back/forward to it): new address and history to the host
    void dispatchDidNavigateWithinPage() final;
    void dispatchDidPushStateWithinPage() final;
    void dispatchDidReplaceStateWithinPage() final;
    void dispatchDidFinishLoad() final;
    void dispatchDidReachLayoutMilestone(OptionSet<WebCore::LayoutMilestone>) final;
    void dispatchDidFailLoad(const WebCore::ResourceError&) final;
    void dispatchDidFailProvisionalLoad(const WebCore::ResourceError&, WebCore::WillContinueLoading, WebCore::WillInternallyHandleFailure) final;
    void dispatchDidClearWindowObjectInWorld(WebCore::DOMWrapperWorld&) final;
    // History (back/forward): the empty clients create no entries and reject
    // every back navigation
    RefPtr<WebCore::HistoryItem> createHistoryItemTree(bool clipAtTarget, WebCore::BackForwardItemIdentifier) const final;
    WebCore::ShouldGoToHistoryItem shouldGoToHistoryItem(WebCore::HistoryItem&, WebCore::IsSameDocumentNavigation) const final { return WebCore::ShouldGoToHistoryItem::Yes; }
    // Back/forward cache (main.cpp): pages may stay suspended in memory
    bool canCachePage() const final { return true; }

    bool isMainFrame() const;
    void didEndLoadWithError(const WebCore::ResourceError&);

    WeakRef<WebCore::FrameLoader> m_frameLoader;
    WeakRef<WebView> m_view;
};

class ProgressTrackerClient final : public WebCore::ProgressTrackerClient {
public:
    explicit ProgressTrackerClient(WebView&);

private:
    void progressStarted(WebCore::LocalFrame&) final;
    void progressEstimateChanged(WebCore::LocalFrame&) final;
    void progressFinished(WebCore::LocalFrame&) final;

    WeakRef<WebView> m_view;
};

// Drag and drop from the page (draggable, selected text, links, images). There
// is no real system drag in a canvas: the WebView plays it through itself with
// the following mouse moves (WebView::startPageDrag).
class DragClient final : public WebCore::DragClient {
public:
    explicit DragClient(WebView&);

private:
    void willPerformDragDestinationAction(WebCore::DragDestinationAction, const WebCore::DragData&) final { }
    void willPerformDragSourceAction(WebCore::DragSourceAction, const WebCore::IntPoint&, WebCore::DataTransfer&) final { }
    OptionSet<WebCore::DragSourceAction> dragSourceActionMaskForPoint(const WebCore::IntPoint&) final { return WebCore::anyDragSourceAction(); }
    void startDrag(WebCore::DragItem, WebCore::DataTransfer&, WebCore::Frame&, const std::optional<WebCore::NodeIdentifier>&) final;

    WeakRef<WebView> m_view;
};

} // namespace BrowserLite
