// WebCore-Clients der Engine. Das Muster fuer FrameLoaderClient (welche
// Empty-Methoden einen echten Browser stillschweigend kaputt machen) stammt
// aus github.com/theogbob/WebkitWasm (BSD-2-Clause, Copyright (c) 2026 theogbob)
// und dem WebKit2 WebLocalFrameLoaderClient.

#include "config.h"
#include "Clients.h"
#include "Printing.h"
#include "BackForwardList.h"
#include "Choosers.h"

#include "Engine.h"
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
#include <emscripten/threading.h>
#if ENABLE(FULLSCREEN_API)
#include <WebCore/DocumentFullscreen.h>
#include <WebCore/Element.h>
#endif
#include <wtf/RunLoop.h>
#include <wtf/text/MakeString.h>

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
    debugLog("Scrollen langsam (neu malen) %dx%d", rect.width(), rect.height());
    m_view->addDamage(rect);
}

void ChromeClient::scroll(const IntSize& delta, const IntRect& rectToScroll, const IntRect& clipRect)
{
    debugLog("Scrollen schnell (verschieben) %d,%d", delta.width(), delta.height());
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

void ChromeClient::addMessageToConsole(JSC::MessageSource, JSC::MessageLevel level, const String& message, unsigned lineNumber, unsigned, const String& sourceID)
{
    m_view->didReceiveConsoleMessage(static_cast<int>(level), message, sourceID, lineNumber);
}

// Dialoge: der Engine-Thread wartet, bis der Haupt-Thread den Dialog gezeigt hat.
// Module.engineDialog(viewId, type, origin, message, default) im Haupt-Thread liefert:
//   alert -> 0, confirm -> 0/1, prompt -> Pointer auf UTF-8 (malloc) oder 0
// origin ist der Ursprung des Frames, der fragt (wie "<host> meldet" in Chrome).
static intptr_t runDialog(int viewId, LocalFrame& frame, int type, const String& message, const String& defaultValue)
{
    RefPtr document = frame.document();
    auto originUTF8 = (document ? document->securityOrigin().toString() : String { }).utf8();
    auto messageUTF8 = message.utf8();
    auto defaultUTF8 = defaultValue.utf8();
    intptr_t answer = MAIN_THREAD_EM_ASM_INT({
        if (!Module.engineDialog)
            return 0;
        return Module.engineDialog($0, $1, UTF8ToString($2), UTF8ToString($3), UTF8ToString($4)) | 0;
    }, viewId, type, originUTF8.data(), messageUTF8.data(), defaultUTF8.data());
    restartScriptWatchdog();
    return answer;
}

void ChromeClient::print(LocalFrame& frame, const StringWithDirection&)
{
    // window.print(): PDF bauen, die Oberflaeche zeigt den Druckdialog
    BrowserLite::printFrame(m_view->id(), frame);
}

void ChromeClient::isPlayingMediaDidChange(MediaProducerMediaStateFlags state)
{
    bool audible = state.contains(MediaProducerMediaState::IsPlayingAudio);
    if (audible != m_audible) {
        m_audible = audible;
        notifyHost(m_view->id(), "media-state", audible ? "{\"audio\":true}"_s : "{\"audio\":false}"_s);
    }
    // Kamera, Mikrofon oder Bildschirm in Gebrauch: roter Punkt im Tab
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
    auto* answer = reinterpret_cast<char*>(runDialog(m_view->id(), frame, 2, message, defaultValue));
    if (!answer)
        return false;
    result = String::fromUTF8(answer);
    free(answer);
    return true;
}

// Neuer Tab fuer window.open / target=_blank
RefPtr<Page> ChromeClient::createWindow(LocalFrame&, const String&, const WindowFeatures&, const NavigationAction&)
{
    auto& popup = WebView::openFromEngine(m_view->id(), m_view->size(), m_view->deviceScaleFactor());
    return &popup.page();
}

void ChromeClient::runOpenPanel(LocalFrame&, FileChooser& chooser)
{
    m_view->openFileChooser(chooser);
}

// Tab ueber das letzte Element hinaus: Fokus zurueck an die Oberflaeche
void ChromeClient::takeFocus(FocusDirection direction)
{
    notifyHost(m_view->id(), "takefocus", makeString("{\"forward\":"_s, direction == FocusDirection::Backward ? "false"_s : "true"_s, '}'));
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

// Link-Adresse unten links und Tooltips (title-Attribut) wie in Chrome
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
    // Wir haben keinen DisplayRefreshMonitor. Das naechste Bild vom Host
    // (requestAnimationFrame) fuehrt das Rendering-Update aus.
    m_view->scheduleRenderingUpdate();
    return true;
}

#if ENABLE(FULLSCREEN_API)
// Vollbild (element.requestFullscreen()): WebCore-Zustand sofort umstellen,
// die Oberflaeche macht den Seitenbereich im Host-Browser gross. Die neue
// Groesse kommt dann wie sonst ueber bl_resize.
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

// Ein Prozess wie WebKitLegacy: der Eintrag beginnt immer beim Hauptframe, auch
// wenn ein Iframe navigiert (WebKit2 setzt den Baum im UI-Prozess zusammen)
RefPtr<HistoryItem> FrameLoaderClient::createHistoryItemTree(bool clipAtTarget, BackForwardItemIdentifier itemID) const
{
    Ref frame = m_frameLoader->frame();
    Ref rootFrame = frame->rootFrame();
    return rootFrame->loader().history().createItemTree(frame, clipAtTarget, itemID);
}

// Neues window-Objekt: WebAssembly anlegen (JSC kann es selber nicht, siehe wasm/WasmBridge.h)
void FrameLoaderClient::dispatchDidClearWindowObjectInWorld(DOMWrapperWorld& world)
{
    if (!world.isNormal())
        return;
    Ref frame = m_frameLoader->frame();
    if (auto* globalObject = frame->script().globalObject(world)) {
        installWebAssembly(*globalObject);
        installHostBridge(*globalObject, m_view->id());
    }
}

bool FrameLoaderClient::isMainFrame() const
{
    return m_frameLoader->frame().isMainFrame();
}

// Adressen, die die Engine selber laedt (view-source: zeigt die Oberflaeche,
// showSource in web/app.js), und filesystem:, das im Host-Browser der Speicher
// der Oberflaeche waere. Alles andere (mailto:, tel:, zoommtg:, ...) kann nur
// der Host-Browser an das System weitergeben.
static bool isExternalURL(const URL& url)
{
    return url.isValid() && !(url.protocolIsInHTTPFamily() || url.protocolIsFile() || url.protocolIsAbout() || url.protocolIsData()
        || url.protocolIsBlob() || url.protocolIsJavaScript() || url.protocolIs("view-source"_s) || url.protocolIs("filesystem"_s));
}

// Wie Chrome nur nach einem Klick oder aus der Adressleiste, sonst still
// verworfen. Ein Iframe mit sandbox braucht dazu allow-popups,
// allow-top-navigation(-to-custom-protocols) oder einen Klick mit
// allow-top-navigation-by-user-activation (HTML "hand-off to external
// software", wie frameSandboxAllowsOpeningExternalCustomProtocols in WebKit2).
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
    // <a download>: gleich herunterladen, ohne die Adresse erst als Seite zu
    // laden (WebCore prueft sandbox, ruft dann startDownload)
    if (!action.downloadAttribute().isNull()) {
        function(PolicyAction::Download);
        return;
    }
    // Strg/Cmd+Klick oder Mittelklick auf einen Link: wie Chrome in einem neuen
    // Tab im Hintergrund, die Seite bleibt
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
    // Download (Content-Disposition: attachment, unbekannter Typ): WebCore
    // prueft sandbox und data:, dann convertMainResourceLoadToDownload
    bool download = response.isAttachment() || !canShowMIMEType(response.mimeType());
    function(download ? PolicyAction::Download : PolicyAction::Use);
}

void FrameLoaderClient::startDownload(const ResourceRequest& request, const String& suggestedName, FromDownloadAttribute)
{
    BrowserLite::startDownload(m_view->id(), request, suggestedName);
}

// Die Datei nochmal mit eigenem Request laden (entscheidungen.md #33). Die URL
// der Antwort ist schon das Ziel nach allen Redirects.
void FrameLoaderClient::convertMainResourceLoadToDownload(DocumentLoader*, const ResourceRequest& request, const ResourceResponse& response)
{
    auto downloadRequest = request;
    downloadRequest.setURL(URL { response.url() });
    BrowserLite::startDownload(m_view->id(), downloadRequest, { });
}

// target=_blank und Links mit neuem Fenster (window.open geht ueber denselben
// ChromeClient::createWindow). Wie WebFrameLoaderClient in WebKitLegacy.
LocalFrame* FrameLoaderClient::dispatchCreatePage(const NavigationAction& action, NewFrameOpenerPolicy openerPolicy, const String& openedMainFrameName)
{
    Ref opener = m_frameLoader->frame();
    RefPtr page = opener->page();
    if (!page)
        return nullptr;
    RefPtr newPage = page->chrome().createWindow(opener, openedMainFrameName, { }, action);
    if (!newPage)
        return nullptr;
    RefPtr newFrame = dynamicDowncast<LocalFrame>(newPage->mainFrame());
    if (newFrame && openerPolicy == NewFrameOpenerPolicy::Allow)
        newFrame->setOpenerForWebKitLegacy(opener.ptr());
    return newFrame.get();
}

void FrameLoaderClient::dispatchDecidePolicyForNewWindowAction(const NavigationAction& action, const ResourceRequest& request, FormState*, const String&, std::optional<HitTestResult>&&, FramePolicyFunction&& function)
{
    // mailto: mit target=_blank: kein leerer Tab
    if (isExternalURL(request.url())) {
        Ref frame = m_frameLoader->frame();
        openExternalURL(m_view->id(), frame, frame->effectiveSandboxFlags(), action, request.url());
        function(PolicyAction::Ignore);
        return;
    }
    // Neue Fenster (target=_blank, window.open) werden neue Tabs, siehe ChromeClient::createWindow
    function(PolicyAction::Use);
}

bool FrameLoaderClient::canShowMIMEType(const String& mimeType) const
{
    return MIMETypeRegistry::canShowMIMEType(mimeType);
}

// Wie WebLocalFrameLoaderClient in WebKit2, ohne Plugins: None zeigt den
// Ersatzinhalt des <object>
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

    // init() kann Script ausfuehren, das den Frame gleich wieder entfernt
    if (!subframe->page())
        return nullptr;
    return subframe;
}

void FrameLoaderClient::transitionToCommittedForNewPage(InitializingIframe)
{
    // Wie WebKit2: bei jeder neuen Seite eine neue FrameView
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
    if (isMainFrame())
        m_view->didCommitLoad();
}

void FrameLoaderClient::dispatchDidReceiveTitle(const StringWithDirection& title)
{
    if (isMainFrame())
        m_view->didChangeTitle(title.string);
}

// Auch aus Iframes: deren Eintraege zaehlen fuer Zurueck/Vor mit
void FrameLoaderClient::dispatchDidNavigateWithinPage()
{
    m_view->didNavigateWithinPage();
}

// pushState legt den Eintrag nur mit dem Baum des Iframes an (WebKit2 ergaenzt ihn
// im UI-Prozess): wie bei createHistoryItemTree ab dem Hauptframe, mit dem
// Eintrag von pushState an der Stelle des Iframes
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
        // createItemTree gibt auch dem Iframe einen neuen aktuellen Eintrag
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

// WillContinueLoading::Yes kommt auch bei jedem Zurueck/Vor, das scheitert.
// Weiter geht es nur, wenn WebCore selber einspringt (HTTPS zuerst, dann HTTP).
void FrameLoaderClient::dispatchDidFailProvisionalLoad(const ResourceError& error, WillContinueLoading, WillInternallyHandleFailure willInternallyHandleFailure)
{
    if (willInternallyHandleFailure == WillInternallyHandleFailure::Yes)
        return;
    ServiceWorkers::frameLoadEnded(m_frameLoader->frame(), false);
    if (isMainFrame())
        didEndLoadWithError(error);
}

// Abbruch (Stopp, neue Navigation, Download) ist kein Fehler, das Laden ist nur zu Ende
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
    // Das Pasteboard des Ziehens schreibt in einen DragContent (DragWasm.cpp)
    RefPtr content = WasmPlatform::dragContent(dataTransfer.pasteboard());
    m_view->startPageDrag(content ? content.releaseNonNull() : WasmPlatform::DragContent::create(), dataTransfer.sourceOperationMask());
}

} // namespace BrowserLite
