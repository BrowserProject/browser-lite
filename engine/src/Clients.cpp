// WebCore clients of the engine. The pattern for FrameLoaderClient (which
// Empty methods silently break a real browser) comes from
// github.com/theogbob/WebkitWasm (BSD-2-Clause, Copyright (c) 2026 theogbob)
// and the WebKit2 WebLocalFrameLoaderClient.

#include "config.h"
#include "Clients.h"
#include "Printing.h"
#include "BackForwardList.h"
#include "Choosers.h"

#include "Engine.h"
#include "ErrorPage.h"
#include "Host.h"
#include "LoaderStrategy.h"
#include "ServiceWorkerWasm.h"
#include "WebPlatformExtras.h"
#include "WebView.h"
#include "wasm/WasmBridge.h"

#include <JavaScriptCore/ConsoleTypes.h>
#include <WebCore/PlatformMouseEvent.h>
#include <WebCore/ScrollingCoordinator.h>
#include <WebCore/BackForwardController.h>
#include <WebCore/Chrome.h>
#include <WebCore/Cursor.h>
#include <WebCore/DataTransfer.h>
#include <WebCore/DragItem.h>
#include <WebCore/Pasteboard.h>
#include <WebCore/WasmPlatform.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/DocumentLoader.h>
#include <WebCore/DocumentPage.h>
#include <WebCore/DocumentView.h>
#include <WebCore/FileChooser.h>
#include <WebCore/HistoryController.h>
#include <WebCore/HistoryItem.h>
#include <WebCore/HitTestResult.h>
#include <WebCore/FrameDestructionObserverInlines.h>
#include <WebCore/FrameInlines.h>
#include <WebCore/FrameLoadRequest.h>
#include <WebCore/FrameLoader.h>
#include <WebCore/FrameTree.h>
#include <WebCore/FrameTreeSyncData.h>
#include <WebCore/HTMLFrameOwnerElement.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/LocalFrameView.h>
#include <WebCore/DOMWrapperWorld.h>
#include <WebCore/JSDOMGlobalObject.h>
#include <WebCore/MIMETypeRegistry.h>
#include <WebCore/ScriptController.h>
#include <WebCore/SecurityOrigin.h>
#include <WebCore/NavigationAction.h>
#include <WebCore/NodeInlines.h>
#include <WebCore/EventNames.h>
#include <WebCore/LocalDOMWindow.h>
#include <WebCore/PolicyChecker.h>
#include <WebCore/MediaProducer.h>
#include <WebCore/Page.h>
#include <WebCore/PointerLockController.h>
#include <WebCore/ProgressTracker.h>
#include <WebCore/ResourceError.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/ResourceResponse.h>
#include <WebCore/SandboxFlags.h>
#include <WebCore/SharedBuffer.h>
#include <WebCore/StringWithDirection.h>
#include <WebCore/UserAgent.h>
#include <WebCore/WindowFeatures.h>
#include <emscripten/emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#if ENABLE(FULLSCREEN_API)
#include <WebCore/DocumentFullscreen.h>
#include <WebCore/Element.h>
#endif
#include <wtf/RunLoop.h>
#include <wtf/text/MakeString.h>
#include <unordered_map>

extern "C" void bl_dialog_answer(int id, int accepted, char* text);

namespace BrowserLite {

using namespace WebCore;

// ---------------------------------------------------------------- ChromeClient

ChromeClient::ChromeClient(WebView& view)
    : m_view(view)
{
}

FloatRect ChromeClient::windowRect() const
{
    return FloatRect { { }, m_view->size() };
}

FloatRect ChromeClient::pageRect() const
{
    return windowRect();
}

void ChromeClient::invalidateRootView(const IntRect& rect)
{
    m_view->addDamage(rect);
}

void ChromeClient::invalidateContentsAndRootView(const IntRect& rect)
{
    m_view->addDamage(rect);
}

void ChromeClient::invalidateContentsForSlowScroll(const IntRect& rect)
{
    debugLog("Slow scroll (repaint) %dx%d", rect.width(), rect.height());
    m_view->addDamage(rect);
}

void ChromeClient::scroll(const IntSize& delta, const IntRect& rectToScroll, const IntRect& clipRect)
{
    debugLog("Fast scroll (move) %d,%d", delta.width(), delta.height());
    m_view->scrollDamage(delta, rectToScroll, clipRect);
}

void ChromeClient::contentsSizeChanged(LocalFrame&, const IntSize&) const
{
}

static ASCIILiteral cssCursorName(Cursor::Type type)
{
    switch (type) {
    case Cursor::Type::Pointer: return "default"_s;
    case Cursor::Type::Cross: return "crosshair"_s;
    case Cursor::Type::Hand: return "pointer"_s;
    case Cursor::Type::IBeam: return "text"_s;
    case Cursor::Type::Wait: return "wait"_s;
    case Cursor::Type::Help: return "help"_s;
    case Cursor::Type::EastResize: return "e-resize"_s;
    case Cursor::Type::NorthResize: return "n-resize"_s;
    case Cursor::Type::NorthEastResize: return "ne-resize"_s;
    case Cursor::Type::NorthWestResize: return "nw-resize"_s;
    case Cursor::Type::SouthResize: return "s-resize"_s;
    case Cursor::Type::SouthEastResize: return "se-resize"_s;
    case Cursor::Type::SouthWestResize: return "sw-resize"_s;
    case Cursor::Type::WestResize: return "w-resize"_s;
    case Cursor::Type::NorthSouthResize: return "ns-resize"_s;
    case Cursor::Type::EastWestResize: return "ew-resize"_s;
    case Cursor::Type::NorthEastSouthWestResize: return "nesw-resize"_s;
    case Cursor::Type::NorthWestSouthEastResize: return "nwse-resize"_s;
    case Cursor::Type::ColumnResize: return "col-resize"_s;
    case Cursor::Type::RowResize: return "row-resize"_s;
    case Cursor::Type::Move: return "move"_s;
    case Cursor::Type::VerticalText: return "vertical-text"_s;
    case Cursor::Type::Cell: return "cell"_s;
    case Cursor::Type::ContextMenu: return "context-menu"_s;
    case Cursor::Type::Alias: return "alias"_s;
    case Cursor::Type::Progress: return "progress"_s;
    case Cursor::Type::NoDrop: return "no-drop"_s;
    case Cursor::Type::Copy: return "copy"_s;
    case Cursor::Type::None: return "none"_s;
    case Cursor::Type::NotAllowed: return "not-allowed"_s;
    case Cursor::Type::ZoomIn: return "zoom-in"_s;
    case Cursor::Type::ZoomOut: return "zoom-out"_s;
    case Cursor::Type::Grab: return "grab"_s;
    case Cursor::Type::Grabbing: return "grabbing"_s;
    default: return "default"_s;
    }
}

void ChromeClient::setCursor(const Cursor& cursor)
{
    m_view->didChangeCursor(String { cssCursorName(cursor.type()) });
}

bool ChromeClient::hoverSupportedByPrimaryPointingDevice() const
{
    return !WasmPlatform::screenInfo().mobile;
}

bool ChromeClient::hoverSupportedByAnyAvailablePointingDevice() const
{
    return !WasmPlatform::screenInfo().mobile;
}

std::optional<PointerCharacteristics> ChromeClient::pointerCharacteristicsOfPrimaryPointingDevice() const
{
    return WasmPlatform::screenInfo().mobile ? PointerCharacteristics::Coarse : PointerCharacteristics::Fine;
}

OptionSet<PointerCharacteristics> ChromeClient::pointerCharacteristicsOfAllAvailablePointingDevices() const
{
    auto& screen = WasmPlatform::screenInfo();
    if (screen.mobile)
        return PointerCharacteristics::Coarse;
    if (screen.hasTouch)
        return { PointerCharacteristics::Fine, PointerCharacteristics::Coarse };
    return PointerCharacteristics::Fine;
}

void ChromeClient::addMessageToConsole(JSC::MessageSource, JSC::MessageLevel level, const String& message, unsigned lineNumber, unsigned, const String& sourceID)
{
    m_view->didReceiveConsoleMessage(static_cast<int>(level), message, sourceID, lineNumber);
}

// Dialogs: the engine thread waits until the host answered. The main thread is
// not blocked: Module.engineDialog(dialogId, viewId, type, origin, message,
// default) shows the dialog and the host answers later with bl_dialog_answer.
// type: alert (0), confirm (1), prompt (2), beforeunload when leaving (3) or
// reloading (4). origin is the origin of the asking frame (like "<host> says"
// in Chrome).
namespace {
struct PendingDialog {
    int viewId;
    int type;
    CString origin;
    CString message;
    CString defaultValue;
    em_proxying_ctx* context { nullptr };
    bool accepted { false };
    char* text { nullptr };
};
}

// Open dialogs by id, only used on the main thread
static std::unordered_map<int, PendingDialog*>& pendingDialogs()
{
    static std::unordered_map<int, PendingDialog*> dialogs;
    return dialogs;
}

static void showDialogOnMainThread(em_proxying_ctx* context, void* argument)
{
    static int nextID = 1;
    auto* dialog = static_cast<PendingDialog*>(argument);
    dialog->context = context;
    int id = nextID++;
    pendingDialogs().emplace(id, dialog);
    int shown = EM_ASM_INT({
        if (!Module.engineDialog)
            return 0;
        try {
            Module.engineDialog($0, $1, $2, UTF8ToString($3), UTF8ToString($4), UTF8ToString($5));
            return 1;
        } catch (error) {
            console.error(error);
            return 0;
        }
    }, id, dialog->viewId, dialog->type, dialog->origin.data(), dialog->message.data(), dialog->defaultValue.data());
    if (!shown)
        bl_dialog_answer(id, 0, nullptr);
}

// Returns whether the user accepted; text gets the answer of a prompt
static bool runDialog(int viewId, LocalFrame& frame, int type, const String& message, const String& defaultValue, String* text = nullptr)
{
    RefPtr document = frame.document();
    PendingDialog dialog { viewId, type, (document ? document->securityOrigin().toString() : String { }).utf8(), message.utf8(), defaultValue.utf8() };
    bool answered = emscripten_proxy_sync_with_ctx(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(), showDialogOnMainThread, &dialog);
    restartScriptWatchdog();
    if (dialog.text) {
        if (text)
            *text = String::fromUTF8(dialog.text);
        free(dialog.text);
    }
    return answered && dialog.accepted;
}

void ChromeClient::print(LocalFrame& frame, const StringWithDirection&)
{
    // window.print(): build a PDF, the host shows the print dialog
    BrowserLite::printFrame(m_view->id(), frame);
}

void ChromeClient::isPlayingMediaDidChange(MediaProducerMediaStateFlags state)
{
    bool audible = state.contains(MediaProducerMediaState::IsPlayingAudio);
    if (audible != m_audible) {
        m_audible = audible;
        m_view->setAudible(audible);
        notifyHost(m_view->id(), "media-state", audible ? "{\"audio\":true}"_s : "{\"audio\":false}"_s);
    }
    // Camera, microphone or screen in use: red dot on the view
    bool capturing = state.containsAny({ MediaProducerMediaState::HasActiveAudioCaptureDevice, MediaProducerMediaState::HasActiveVideoCaptureDevice,
        MediaProducerMediaState::HasActiveScreenCaptureDevice, MediaProducerMediaState::HasActiveWindowCaptureDevice });
    if (capturing != m_capturing) {
        m_capturing = capturing;
        notifyHost(m_view->id(), "capture-state", capturing ? "{\"active\":true}"_s : "{\"active\":false}"_s);
    }
}

void ChromeClient::runJavaScriptAlert(LocalFrame& frame, const String& message)
{
    runDialog(m_view->id(), frame, 0, message, { });
}

bool ChromeClient::runJavaScriptConfirm(LocalFrame& frame, const String& message)
{
    return runDialog(m_view->id(), frame, 1, message, { });
}

bool ChromeClient::runJavaScriptPrompt(LocalFrame& frame, const String& message, const String& defaultValue, String& result)
{
    return runDialog(m_view->id(), frame, 2, message, defaultValue, &result);
}

// beforeunload (navigation, reload, closing the view through bl_try_close):
// like Chrome without the page's text. The host asks "leave" (3) or "reload"
// (4), 1 means continue. WebCore only asks after a user action.
bool ChromeClient::runBeforeUnloadConfirmPanel(String&&, LocalFrame& frame)
{
    RefPtr mainFrame = dynamicDowncast<LocalFrame>(frame.mainFrame());
    bool reload = mainFrame && mainFrame->loader().policyDocumentLoader() && isReload(mainFrame->loader().policyChecker().loadType());
    return runDialog(m_view->id(), frame, reload ? 4 : 3, { }, { });
}

// Only in the next step: when reported, the listener is not yet added or
// removed, and pages from the back/forward cache report nothing
void ChromeClient::reportBeforeUnload(WebView& view)
{
    runOnEngineThread([weakView = WeakPtr { view }] {
        RefPtr view = weakView.get();
        if (!view)
            return;
        RefPtr frame = view->mainFrame();
        RefPtr window = frame && frame->document() ? frame->document()->window() : nullptr;
        bool listener = window && window->hasEventListeners(eventNames().beforeunloadEvent);
        notifyHost(view->id(), "beforeunload", listener ? "{\"listener\":true}"_s : "{\"listener\":false}"_s);
    });
}

void ChromeClient::focus()
{
    notifyHost(m_view->id(), "focus");
}

// New view for window.open / target=_blank. Like WebChromeClient in
// WebKitLegacy: opener (except noopener), name and sandbox of the window
RefPtr<Page> ChromeClient::createWindow(LocalFrame& frame, const String& openedMainFrameName, const WindowFeatures& features, const NavigationAction&)
{
    auto& popup = WebView::openFromEngine(m_view->id(), m_view->size(), m_view->deviceScaleFactor());
    Ref mainFrame = popup.page().mainFrame();
    if (!features.wantsNoOpener())
        mainFrame->setOpenerForWebKitLegacy(&frame);
    auto sandboxFlags = frame.effectiveSandboxFlags();
    if (!sandboxFlags.contains(SandboxFlag::PropagatesToAuxiliaryBrowsingContexts))
        sandboxFlags = { };
    mainFrame->updateSandboxFlags(sandboxFlags, Frame::NotifyUIProcess::No);
    mainFrame->tree().setSpecifiedName(AtomString { openedMainFrameName });
    return &popup.page();
}

void ChromeClient::runOpenPanel(LocalFrame&, FileChooser& chooser)
{
    m_view->openFileChooser(chooser);
}

// Tab past the last element: focus back to the host
void ChromeClient::takeFocus(FocusDirection direction)
{
    notifyHost(m_view->id(), "take-focus", makeString("{\"forward\":"_s, direction == FocusDirection::Backward ? "false"_s : "true"_s, '}'));
}

RefPtr<PopupMenu> ChromeClient::createPopupMenu(PopupMenuClient& client) const
{
    return BrowserLite::createPopupMenu(m_view.get(), client);
}

RefPtr<SearchPopupMenu> ChromeClient::createSearchPopupMenu(PopupMenuClient& client) const
{
    return BrowserLite::createSearchPopupMenu(m_view.get(), client);
}

RefPtr<ColorChooser> ChromeClient::createColorChooser(ColorChooserClient& client, const Color& color)
{
    return BrowserLite::createColorChooser(m_view.get(), client, color);
}

RefPtr<DateTimeChooser> ChromeClient::createDateTimeChooser(DateTimeChooserClient& client)
{
    return BrowserLite::createDateTimeChooser(m_view.get(), client);
}

#if ENABLE(POINTER_LOCK)
void ChromeClient::requestPointerLock(CompletionHandler<void(PointerLockRequestResult)>&& completionHandler)
{
    m_view->requestPointerLock(WTF::move(completionHandler));
}

void ChromeClient::requestPointerUnlock(CompletionHandler<void(bool)>&& completionHandler)
{
    m_view->requestPointerUnlock();
    completionHandler(true);
}
#endif

// Link address at the bottom left and tooltips (title attribute) like in Chrome
void ChromeClient::mouseDidMoveOverElement(const HitTestResult& result, OptionSet<PlatformEventModifier>, const String& toolTip, TextDirection)
{
    String link = result.absoluteLinkURL().string();
    if (link == m_hoveredLink && toolTip == m_toolTip)
        return;
    m_hoveredLink = link;
    m_toolTip = toolTip;
    notifyHost(m_view->id(), "hover", makeString("{\"link\":\""_s, jsonEscape(link), "\",\"tooltip\":\""_s, jsonEscape(toolTip), "\"}"_s));
}

void ChromeClient::closeWindow()
{
    notifyHost(m_view->id(), "close");
}

void ChromeClient::triggerRenderingUpdate()
{
    m_view->scheduleRenderingUpdate();
}

GraphicsLayerFactory* ChromeClient::graphicsLayerFactory() const
{
    return m_view->graphicsLayerFactory();
}

RefPtr<ScrollingCoordinator> ChromeClient::createScrollingCoordinator(Page& page) const
{
    return m_view->createScrollingCoordinator(page);
}

void ChromeClient::attachRootGraphicsLayer(LocalFrame&, GraphicsLayer* layer)
{
    m_view->attachRootGraphicsLayer(layer);
}

void ChromeClient::attachViewOverlayGraphicsLayer(GraphicsLayer* layer)
{
    m_view->attachViewOverlayGraphicsLayer(layer);
}

bool ChromeClient::scheduleRenderingUpdate()
{
    // We have no DisplayRefreshMonitor. The next frame of the host
    // (requestAnimationFrame) runs the rendering update.
    m_view->scheduleRenderingUpdate();
    return true;
}

#if ENABLE(FULLSCREEN_API)
// Fullscreen (element.requestFullscreen()): switch the WebCore state right
// away, the host makes the view big in the host browser. The new size then
// arrives as usual through bl_resize.
void ChromeClient::enterFullScreenForElement(Element& element, HTMLMediaElementEnums::VideoFullscreenMode mode, CompletionHandler<void(ExceptionOr<void>)>&& willEnterFullscreen, CompletionHandler<bool(bool)>&& didEnterFullscreen)
{
    auto result = protect(protect(element.document())->fullscreen())->willEnterFullscreen(element, mode);
    bool failed = result.hasException();
    willEnterFullscreen(WTF::move(result));
    if (failed) {
        didEnterFullscreen(false);
        return;
    }
    notifyHost(m_view->id(), "fullscreen", "{\"on\":true}"_s);
    didEnterFullscreen(true);
}

void ChromeClient::exitFullScreenForElement(Element* element, CompletionHandler<void()>&& completionHandler)
{
    if (element)
        protect(protect(element->document())->fullscreen())->willExitFullscreen();
    notifyHost(m_view->id(), "fullscreen", "{\"on\":false}"_s);
    completionHandler();
}
#endif

// ------------------------------------------------------------ FrameLoaderClient

FrameLoaderClient::FrameLoaderClient(FrameLoader& frameLoader, WebView& view)
    : EmptyFrameLoaderClient(frameLoader)
    , m_frameLoader(frameLoader)
    , m_view(view)
{
}

// One process like WebKitLegacy: the entry always starts at the main frame,
// even when an iframe navigates (WebKit2 assembles the tree in the UI process)
RefPtr<HistoryItem> FrameLoaderClient::createHistoryItemTree(bool clipAtTarget, BackForwardItemIdentifier itemID) const
{
    Ref frame = m_frameLoader->frame();
    Ref rootFrame = frame->rootFrame();
    return rootFrame->loader().history().createItemTree(frame, clipAtTarget, itemID);
}

// New window object: create WebAssembly (JSC cannot do it itself, see
// wasm/WasmBridge.h), then the page extensions with their host bridges and, in
// an error page, its retry button (ErrorPage.cpp)
void FrameLoaderClient::dispatchDidClearWindowObjectInWorld(DOMWrapperWorld& world)
{
    if (!world.isNormal())
        return;
    Ref frame = m_frameLoader->frame();
    if (auto* globalObject = frame->script().globalObject(world)) {
        installWebAssembly(*globalObject);
        installPageExtensions(*globalObject, m_view->id());
        ErrorPage::installRetry(frame, *globalObject);
    }
}

bool FrameLoaderClient::isMainFrame() const
{
    return m_frameLoader->frame().isMainFrame();
}

// Addresses the engine loads itself (view-source: is shown by the host), and
// filesystem:, which in the host browser would be the host's storage.
// Everything else (mailto:, tel:, zoommtg:, ...) can only be passed on to the
// system by the host browser.
static bool isExternalURL(const URL& url)
{
    return url.isValid() && !(url.protocolIsInHTTPFamily() || url.protocolIsFile() || url.protocolIsAbout() || url.protocolIsData()
        || url.protocolIsBlob() || url.protocolIsJavaScript() || url.protocolIs("view-source"_s) || url.protocolIs("filesystem"_s));
}

// Like Chrome only after a click or from the address bar, otherwise silently
// dropped. A sandboxed iframe needs allow-popups,
// allow-top-navigation(-to-custom-protocols) or a click with
// allow-top-navigation-by-user-activation (HTML "hand-off to external
// software", like frameSandboxAllowsOpeningExternalCustomProtocols in WebKit2).
static void openExternalURL(int viewId, LocalFrame& frame, SandboxFlags sandboxFlags, const NavigationAction& action, const URL& url)
{
    bool userGesture = action.processingUserGesture();
    if (!userGesture && !action.isRequestFromClientOrUserInput())
        return;
    if (!frame.isMainFrame() && sandboxFlags.containsAll({ SandboxFlag::Popups, SandboxFlag::TopNavigation, SandboxFlag::TopNavigationToCustomProtocols })
        && (sandboxFlags.contains(SandboxFlag::TopNavigationByUserActivation) || !userGesture)) {
        if (RefPtr document = frame.document())
            document->addConsoleMessage(MessageSource::Security, MessageLevel::Error, "Ignoring request to open an external URL from a sandboxed iframe"_s);
        return;
    }
    notifyHost(viewId, "external-url", makeString("{\"url\":\""_s, jsonEscape(url.string()), "\"}"_s));
}

void FrameLoaderClient::dispatchDecidePolicyForNavigationAction(const NavigationAction& action, const ResourceRequest& request, const ResourceResponse&, FormState*, const String&, std::optional<NavigationIdentifier>, std::optional<HitTestResult>&&, bool, NavigationUpgradeToHTTPSBehavior, SandboxFlags sandboxFlags, PolicyDecisionMode, FramePolicyFunction&& function)
{
    if (isExternalURL(request.url())) {
        openExternalURL(m_view->id(), m_frameLoader->frame(), sandboxFlags, action, request.url());
        function(PolicyAction::Ignore);
        return;
    }
    // <a download>: download right away without loading the address as a page
    // first (WebCore checks sandbox, then calls startDownload)
    if (!action.downloadAttribute().isNull()) {
        function(PolicyAction::Download);
        return;
    }
    // Ctrl/Cmd+click or middle click on a link: like Chrome in a new
    // background view, the page stays
    if (action.type() == NavigationType::LinkClicked && request.url().protocolIsInHTTPFamily()) {
        auto& mouse = action.mouseEventData();
        if (mouse && (mouse->ctrlKey || mouse->metaKey || mouse->button == MouseButton::Middle)) {
            notifyHost(m_view->id(), "open-tab", makeString("{\"url\":\""_s, jsonEscape(request.url().string()), "\"}"_s));
            function(PolicyAction::Ignore);
            return;
        }
    }
    function(PolicyAction::Use);
}

void FrameLoaderClient::dispatchDecidePolicyForResponse(const ResourceResponse& response, const ResourceRequest&, const String&, FramePolicyFunction&& function)
{
    // Download (Content-Disposition: attachment, unknown type): WebCore checks
    // sandbox and data:, then convertMainResourceLoadToDownload
    bool download = response.isAttachment() || !canShowMIMEType(response.mimeType());
    function(download ? PolicyAction::Download : PolicyAction::Use);
}

void FrameLoaderClient::startDownload(const ResourceRequest& request, const String& suggestedName, FromDownloadAttribute)
{
    BrowserLite::startDownload(m_view->id(), request, suggestedName);
}

// Loads the file again with its own request (docs/decisions.md #33). The URL
// of the response is already the target after all redirects.
void FrameLoaderClient::convertMainResourceLoadToDownload(DocumentLoader*, const ResourceRequest& request, const ResourceResponse& response)
{
    auto downloadRequest = request;
    downloadRequest.setURL(URL { response.url() });
    BrowserLite::startDownload(m_view->id(), downloadRequest, { });
}

// target=_blank and links with a new window (window.open goes through the same
// ChromeClient::createWindow). Like WebFrameLoaderClient in WebKitLegacy.
LocalFrame* FrameLoaderClient::dispatchCreatePage(const NavigationAction& action, NewFrameOpenerPolicy openerPolicy, const String& openedMainFrameName)
{
    Ref opener = m_frameLoader->frame();
    RefPtr page = opener->page();
    if (!page)
        return nullptr;
    WindowFeatures features;
    features.noopener = openerPolicy == NewFrameOpenerPolicy::Suppress;
    RefPtr newPage = page->chrome().createWindow(opener, openedMainFrameName, features, action);
    if (!newPage)
        return nullptr;
    return dynamicDowncast<LocalFrame>(newPage->mainFrame());
}

void FrameLoaderClient::dispatchDecidePolicyForNewWindowAction(const NavigationAction& action, const ResourceRequest& request, FormState*, const String&, std::optional<HitTestResult>&&, FramePolicyFunction&& function)
{
    // mailto: with target=_blank: no empty view
    if (isExternalURL(request.url())) {
        Ref frame = m_frameLoader->frame();
        openExternalURL(m_view->id(), frame, frame->effectiveSandboxFlags(), action, request.url());
        function(PolicyAction::Ignore);
        return;
    }
    // New windows (target=_blank, window.open) become new views, see ChromeClient::createWindow
    function(PolicyAction::Use);
}

bool FrameLoaderClient::canShowMIMEType(const String& mimeType) const
{
    return MIMETypeRegistry::canShowMIMEType(mimeType);
}

// Like WebLocalFrameLoaderClient in WebKit2, without plugins: None shows the
// fallback content of the <object>
ObjectContentType FrameLoaderClient::objectContentType(const URL& url, const String& mimeTypeIn)
{
    String mimeType = mimeTypeIn.convertToASCIILowercase();
    if (mimeType.isEmpty()) {
        auto path = url.path();
        auto dot = path.reverseFind('.');
        if (dot != notFound)
            mimeType = MIMETypeRegistry::mimeTypeForExtension(path.substring(dot + 1));
        if (mimeType.isEmpty())
            return ObjectContentType::Frame;
    }
    if (MIMETypeRegistry::isSupportedImageMIMEType(mimeType))
        return ObjectContentType::Image;
    if (canShowMIMEType(mimeType))
        return ObjectContentType::Frame;
    return ObjectContentType::None;
}

void FrameLoaderClient::committedLoad(DocumentLoader* loader, const SharedBuffer& data)
{
    loader->commitData(data);
}

String FrameLoaderClient::userAgent(const URL& url) const
{
    return standardUserAgentForURL(url);
}

RefPtr<LocalFrame> FrameLoaderClient::createFrame(const AtomString& name, HTMLFrameOwnerElement& ownerElement)
{
    RefPtr ownerFrame = ownerElement.document().frame();
    if (!ownerFrame)
        return nullptr;
    RefPtr page = ownerFrame->page();
    if (!page)
        return nullptr;

    auto sandboxFlags = ownerElement.sandboxFlags();
    sandboxFlags.add(ownerFrame->effectiveSandboxFlags());
    auto referrerPolicy = ownerElement.referrerPolicy();
    if (RefPtr topDocument = page->localTopDocument(); referrerPolicy == ReferrerPolicy::EmptyString && topDocument)
        referrerPolicy = topDocument->referrerPolicy();

    WeakPtr view { m_view.get() };
    auto subframe = LocalFrame::createSubframe(*page, [view](auto&, auto& frameLoader) -> UniqueRef<LocalFrameLoaderClient> {
        return makeUniqueRefWithoutRefCountedCheck<FrameLoaderClient>(frameLoader, *view);
    }, generateFrameIdentifier(), sandboxFlags, referrerPolicy, ownerElement, FrameTreeSyncData::create());
    subframe->tree().setSpecifiedName(name);
    subframe->init();

    // init() may run script that removes the frame right away
    if (!subframe->page())
        return nullptr;
    return subframe;
}

void FrameLoaderClient::transitionToCommittedForNewPage(InitializingIframe)
{
    // Like WebKit2: a new FrameView for every new page
    Ref frame = m_frameLoader->frame();
    RefPtr oldView = frame->view();
    IntSize size = oldView ? oldView->size() : IntSize { };
    if (frame->isMainFrame())
        size = m_view->size();
    frame->createView(size, std::nullopt, { }, false);
    if (RefPtr view = frame->view())
        view->setCanHaveScrollbars(true);
    if (frame->isMainFrame())
        m_view->addDamage(IntRect { { }, m_view->size() });
}

void FrameLoaderClient::dispatchDidStartProvisionalLoad()
{
    if (isMainFrame())
        m_view->didStartLoading();
}

void FrameLoaderClient::dispatchDidCommitLoad(std::optional<HasInsecureContent>, std::optional<UsedLegacyTLS>, std::optional<WasPrivateRelayed>)
{
    if (isMainFrame()) {
        m_view->didCommitLoad();
        ChromeClient::reportBeforeUnload(m_view.get());
    }
}

void FrameLoaderClient::dispatchDidReceiveTitle(const StringWithDirection& title)
{
    if (isMainFrame())
        m_view->didChangeTitle(title.string);
}

// Also from iframes: their entries count for back/forward
void FrameLoaderClient::dispatchDidNavigateWithinPage()
{
    m_view->didNavigateWithinPage();
}

// pushState creates the entry only with the iframe's tree (WebKit2 completes it
// in the UI process): like createHistoryItemTree from the main frame, with the
// pushState entry in place of the iframe
void FrameLoaderClient::dispatchDidPushStateWithinPage()
{
    Ref frame = m_frameLoader->frame();
    RefPtr parent = dynamicDowncast<LocalFrame>(frame->tree().parent());
    Ref history = frame->loader().history();
    RefPtr item = history->currentItem();
    RefPtr previous = history->previousItem();
    auto& list = static_cast<BackForwardList&>(m_view->page().backForward().client());
    RefPtr root = parent && item && previous && item == list.currentItem() ? createHistoryItemTree(true, item->itemID()) : nullptr;
    if (root) {
        // createItemTree also gives the iframe a new current entry
        history->setCurrentItem(previous.releaseNonNull());
        history->setCurrentItem(*item);
        protect(parent->loader().history().currentItem())->setChildItem(*item);
        list.replaceCurrentItem(root.releaseNonNull());
    }
    m_view->didNavigateWithinPage();
}

void FrameLoaderClient::dispatchDidReplaceStateWithinPage()
{
    m_view->didNavigateWithinPage();
}

void FrameLoaderClient::dispatchDidFinishLoad()
{
    ServiceWorkers::frameLoadEnded(m_frameLoader->frame(), true);
    if (isMainFrame())
        m_view->didFinishLoading();
}

void FrameLoaderClient::dispatchDidReachLayoutMilestone(OptionSet<LayoutMilestone> milestones)
{
    if (isMainFrame())
        m_view->didReachLayoutMilestone(milestones);
}

void FrameLoaderClient::dispatchDidFailLoad(const ResourceError& error)
{
    ServiceWorkers::frameLoadEnded(m_frameLoader->frame(), true);
    if (isMainFrame())
        didEndLoadWithError(error);
}

// WillContinueLoading::Yes also comes with every back/forward that fails. It
// only continues if WebCore steps in itself (HTTPS first, then HTTP).
void FrameLoaderClient::dispatchDidFailProvisionalLoad(const ResourceError& error, WillContinueLoading, WillInternallyHandleFailure willInternallyHandleFailure)
{
    if (willInternallyHandleFailure == WillInternallyHandleFailure::Yes)
        return;
    ServiceWorkers::frameLoadEnded(m_frameLoader->frame(), false);
    if (isMainFrame()) {
        didEndLoadWithError(error);
        // An error page like Chrome, right here: that way WebCore takes it for the address
        if (auto kind = ErrorPage::show(m_frameLoader->frame(), error))
            m_view->willCommitErrorPage(*kind == ErrorPage::Kind::Certificate);
    }
}

// Cancelling (stop, new navigation, download) is no error, loading just ended
void FrameLoaderClient::didEndLoadWithError(const ResourceError& error)
{
    if (error.isCancellation())
        m_view->didStopLoading();
    else
        m_view->didFailLoading(error.failingURL().string(), error.localizedDescription());
}

// -------------------------------------------------------- ProgressTrackerClient

ProgressTrackerClient::ProgressTrackerClient(WebView& view)
    : m_view(view)
{
}

void ProgressTrackerClient::progressStarted(LocalFrame&)
{
    m_view->didChangeProgress(0.1);
}

void ProgressTrackerClient::progressEstimateChanged(LocalFrame& frame)
{
    if (RefPtr page = frame.page())
        m_view->didChangeProgress(page->progress().estimatedProgress());
}

void ProgressTrackerClient::progressFinished(LocalFrame&)
{
    m_view->didChangeProgress(1.0);
}

DragClient::DragClient(WebView& view)
    : m_view(view)
{
}

void DragClient::startDrag(DragItem, DataTransfer& dataTransfer, Frame&, const std::optional<NodeIdentifier>&)
{
    // The drag pasteboard writes into a DragContent (DragWasm.cpp)
    RefPtr content = WasmPlatform::dragContent(dataTransfer.pasteboard());
    m_view->startPageDrag(content ? content.releaseNonNull() : WasmPlatform::DragContent::create(), dataTransfer.sourceOperationMask());
}

} // namespace BrowserLite

// Answer of the host to Module.engineDialog (main thread only): the waiting
// engine thread continues. text is the answer of a prompt (the engine frees it).
extern "C" EMSCRIPTEN_KEEPALIVE void bl_dialog_answer(int id, int accepted, char* text)
{
    auto& dialogs = BrowserLite::pendingDialogs();
    auto entry = dialogs.find(id);
    if (entry == dialogs.end()) {
        free(text);
        return;
    }
    auto* dialog = entry->second;
    dialogs.erase(entry);
    dialog->accepted = accepted;
    dialog->text = text;
    emscripten_proxy_finish(dialog->context);
}
