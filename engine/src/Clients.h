// WebCore-Clients der Engine. Sie leiten von den "Empty"-Clients ab (Patch
// 0007 macht deren Methoden ueberschreibbar) und ueberschreiben nur, was ein
// echter Browser braucht.
#pragma once

#include <WebCore/DragClient.h>
#include <WebCore/EmptyClients.h>
#include <WebCore/EmptyFrameLoaderClient.h>
#include <WebCore/ProgressTrackerClient.h>
#include <wtf/WeakPtr.h>

namespace BrowserLite {

class WebView;

class ChromeClient final : public WebCore::EmptyChromeClient {
public:
    explicit ChromeClient(WebView&);

private:
    void chromeDestroyed() final { }

    WebCore::FloatRect windowRect() const final;
    WebCore::FloatRect pageRect() const final;

    void focus() final { }
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

    void addMessageToConsole(JSC::MessageSource, JSC::MessageLevel, const String& message, unsigned lineNumber, unsigned columnNumber, const String& sourceID) final;
    void runJavaScriptAlert(WebCore::LocalFrame&, const String&) final;
    void print(WebCore::LocalFrame&, const WebCore::StringWithDirection&) final;
    // Spielt die Seite Ton? (Lautsprecher im Tab wie Chrome)
    void isPlayingMediaDidChange(WebCore::MediaProducerMediaStateFlags) final;
    bool runJavaScriptConfirm(WebCore::LocalFrame&, const String&) final;
    bool runJavaScriptPrompt(WebCore::LocalFrame&, const String& message, const String& defaultValue, String& result) final;

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
    bool canShowMIMEType(const String&) const final;
    bool canShowMIMETypeAsHTML(const String&) const final { return true; }
    void committedLoad(WebCore::DocumentLoader*, const WebCore::SharedBuffer&) final;
    String userAgent(const URL&) const final;

    RefPtr<WebCore::LocalFrame> createFrame(const AtomString& name, WebCore::HTMLFrameOwnerElement&) final;
    WebCore::LocalFrame* dispatchCreatePage(const WebCore::NavigationAction&, WebCore::NewFrameOpenerPolicy, const String& openedMainFrameName) final;
    void transitionToCommittedForNewPage(InitializingIframe) final;

    void dispatchDidStartProvisionalLoad() final;
    void dispatchDidCommitLoad(std::optional<WebCore::HasInsecureContent>, std::optional<WebCore::UsedLegacyTLS>, std::optional<WebCore::WasPrivateRelayed>) final;
    void dispatchDidReceiveTitle(const WebCore::StringWithDirection&) final;
    void dispatchDidChangeLocationWithinPage() final;
    void dispatchDidFinishLoad() final;
    void dispatchDidFailLoad(const WebCore::ResourceError&) final;
    void dispatchDidFailProvisionalLoad(const WebCore::ResourceError&, WebCore::WillContinueLoading, WebCore::WillInternallyHandleFailure) final;
    void dispatchDidClearWindowObjectInWorld(WebCore::DOMWrapperWorld&) final;

    bool isMainFrame() const;

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

// Drag & Drop aus der Seite (draggable, markierter Text, Links, Bilder). Ein
// echtes System-Ziehen gibt es im Canvas nicht: die WebView spielt es selber
// mit den folgenden Mausbewegungen durch (WebView::startPageDrag).
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
