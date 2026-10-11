// WebCore-Clients der Engine. Sie leiten von den "Empty"-Clients ab (Patch
// 0007 macht deren Methoden ueberschreibbar) und ueberschreiben nur, was ein
// echter Browser braucht.
#pragma once

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
    void takeFocus(WebCore::FocusDirection) final { }

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
    bool runJavaScriptConfirm(WebCore::LocalFrame&, const String&) final;
    bool runJavaScriptPrompt(WebCore::LocalFrame&, const String& message, const String& defaultValue, String& result) final;

    RefPtr<WebCore::Page> createWindow(WebCore::LocalFrame&, const String&, const WebCore::WindowFeatures&, const WebCore::NavigationAction&) final;
    void closeWindow() final;
    void runOpenPanel(WebCore::LocalFrame&, WebCore::FileChooser&) final;

    void triggerRenderingUpdate() final;
    bool scheduleRenderingUpdate() final;

    WeakRef<WebView> m_view;
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

} // namespace BrowserLite
