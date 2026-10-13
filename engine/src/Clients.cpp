// WebCore-Clients der Engine. Das Muster fuer FrameLoaderClient (welche
// Empty-Methoden einen echten Browser stillschweigend kaputt machen) stammt
// aus github.com/theogbob/WebkitWasm (BSD-2-Clause, Copyright (c) 2026 theogbob)
// und dem WebKit2 WebLocalFrameLoaderClient.

#include "config.h"
#include "Clients.h"
#include "Printing.h"
#include "Choosers.h"

#include "Engine.h"
#include "Host.h"
#include "LoaderStrategy.h"
#include "WebPlatformExtras.h"
#include "WebView.h"
#include "wasm/WasmBridge.h"

#include <JavaScriptCore/ConsoleTypes.h>
#include <WebCore/PlatformMouseEvent.h>
#include <WebCore/ScrollingCoordinator.h>
#include <WebCore/Chrome.h>
#include <WebCore/Cursor.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/DocumentLoader.h>
#include <WebCore/DocumentPage.h>
#include <WebCore/DocumentView.h>
#include <WebCore/FileChooser.h>
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
#include <WebCore/NavigationAction.h>
#include <WebCore/NodeInlines.h>
#include <WebCore/MediaProducer.h>
#include <WebCore/Page.h>
#include <WebCore/PointerLockController.h>
#include <WebCore/ProgressTracker.h>
#include <WebCore/ResourceError.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/ResourceResponse.h>
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
// Module.engineDialog(type, message, default) im Haupt-Thread liefert:
//   alert -> 0, confirm -> 0/1, prompt -> Pointer auf UTF-8 (malloc) oder 0
static intptr_t runDialog(int type, const String& message, const String& defaultValue)
{
    auto messageUTF8 = message.utf8();
    auto defaultUTF8 = defaultValue.utf8();
    return MAIN_THREAD_EM_ASM_INT({
        if (!Module.engineDialog)
            return 0;
        return Module.engineDialog($0, UTF8ToString($1), UTF8ToString($2)) | 0;
    }, type, messageUTF8.data(), defaultUTF8.data());
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

void ChromeClient::runJavaScriptAlert(LocalFrame&, const String& message)
{
    runDialog(0, message, { });
}

bool ChromeClient::runJavaScriptConfirm(LocalFrame&, const String& message)
{
    return runDialog(1, message, { });
}

bool ChromeClient::runJavaScriptPrompt(LocalFrame&, const String& message, const String& defaultValue, String& result)
{
    auto* answer = reinterpret_cast<char*>(runDialog(2, message, defaultValue));
    if (!answer)
        return false;
    result = String::fromUTF8(answer);
    free(answer);
    return true;
}

// Neuer Tab fuer window.open / target=_blank. Die Engine vergibt die ID selber
// (ab 2^20, die Oberflaeche zaehlt ab 1) und meldet den Tab der Oberflaeche.
RefPtr<Page> ChromeClient::createWindow(LocalFrame&, const String&, const WindowFeatures&, const NavigationAction&)
{
    static int nextPopupID = 1 << 20;
    int id = nextPopupID++;
    auto& popup = WebView::open(id, m_view->size(), m_view->deviceScaleFactor());
    notifyHost(id, "newview", makeString("{\"opener\":"_s, m_view->id(), '}'));
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

void FrameLoaderClient::dispatchDecidePolicyForNavigationAction(const NavigationAction& action, const ResourceRequest& request, const ResourceResponse&, FormState*, const String&, std::optional<NavigationIdentifier>, std::optional<HitTestResult>&&, bool, NavigationUpgradeToHTTPSBehavior, SandboxFlags, PolicyDecisionMode, FramePolicyFunction&& function)
{
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

void FrameLoaderClient::dispatchDecidePolicyForResponse(const ResourceResponse& response, const ResourceRequest& request, const String& downloadAttribute, FramePolicyFunction&& function)
{
    if (!response.isAttachment() && downloadAttribute.isNull() && canShowMIMEType(response.mimeType())) {
        function(PolicyAction::Use);
        return;
    }
    // Download (Content-Disposition: attachment, <a download>, unbekannter Typ):
    // nochmal mit eigenem Request laden, die Daten gehen an die Oberflaeche.
    // Die URL der Antwort ist schon das Ziel nach allen Redirects.
    auto downloadRequest = request;
    downloadRequest.setURL(URL { response.url() });
    BrowserLite::startDownload(m_view->id(), downloadRequest, downloadAttribute);
    function(PolicyAction::Ignore);
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

void FrameLoaderClient::dispatchDecidePolicyForNewWindowAction(const NavigationAction&, const ResourceRequest&, FormState*, const String&, std::optional<HitTestResult>&&, FramePolicyFunction&& function)
{
    // Neue Fenster (target=_blank, window.open) werden neue Tabs, siehe ChromeClient::createWindow
    function(PolicyAction::Use);
}

bool FrameLoaderClient::canShowMIMEType(const String& mimeType) const
{
    return MIMETypeRegistry::canShowMIMEType(mimeType);
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

void FrameLoaderClient::dispatchDidChangeLocationWithinPage()
{
    if (isMainFrame())
        m_view->didCommitLoad();
}

void FrameLoaderClient::dispatchDidFinishLoad()
{
    if (isMainFrame())
        m_view->didFinishLoading();
}

void FrameLoaderClient::dispatchDidFailLoad(const ResourceError& error)
{
    if (isMainFrame())
        m_view->didFailLoading(error.failingURL().string(), error.localizedDescription());
}

void FrameLoaderClient::dispatchDidFailProvisionalLoad(const ResourceError& error, WillContinueLoading, WillInternallyHandleFailure)
{
    if (isMainFrame() && !error.isCancellation())
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

} // namespace BrowserLite
