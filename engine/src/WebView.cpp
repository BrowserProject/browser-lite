#include "config.h"
#include "WebView.h"

#include "Clients.h"
#include "Engine.h"
#include "Host.h"
#include "Strategies.h"

#include <WebCore/BackForwardController.h>
#include <WebCore/CookieJar.h>
#include <WebCore/Cursor.h>
#include <WebCore/DocumentLoader.h>
#include <WebCore/EventHandler.h>
#include <WebCore/FocusController.h>
#include <WebCore/FrameLoadRequest.h>
#include <WebCore/FrameLoader.h>
#include <WebCore/GraphicsContextSkia.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameView.h>
#include <WebCore/Page.h>
#include <WebCore/PageConfiguration.h>
#include <WebCore/PlatformKeyboardEvent.h>
#include <WebCore/PlatformMouseEvent.h>
#include <WebCore/PlatformWheelEvent.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/ResourceResponse.h>
#include <WebCore/ScrollingCoordinatorTypes.h>
#include <WebCore/Settings.h>
#include <WebCore/SharedBuffer.h>
#include <WebCore/StorageSessionProvider.h>
#include <WebCore/SubstituteData.h>
#include <pal/SessionID.h>
#include <skia/core/SkCanvas.h>
#include <skia/core/SkSurface.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite {

using namespace WebCore;

static HashMap<int, WeakPtr<WebView>>& viewsByID()
{
    static NeverDestroyed<HashMap<int, WeakPtr<WebView>>> views;
    return views;
}

WebView* WebView::fromID(int id)
{
    return viewsByID().get(id).get();
}

class SessionProvider final : public StorageSessionProvider {
public:
    static Ref<SessionProvider> create() { return adoptRef(*new SessionProvider); }
    NetworkStorageSession* storageSession() const final { return &networkStorageSession(); }
};

Ref<WebView> WebView::create(int id, IntSize size, float deviceScaleFactor)
{
    return adoptRef(*new WebView(id, size, deviceScaleFactor));
}

WebView::WebView(int id, IntSize size, float deviceScaleFactor)
    : m_id(id)
    , m_size(size)
    , m_deviceScaleFactor(deviceScaleFactor)
{
    viewsByID().set(id, *this);

    auto configuration = pageConfigurationWithEmptyClients(PageIdentifier::generate(), PAL::SessionID::defaultSessionID());
    configuration.chromeClient = makeUniqueRef<ChromeClient>(*this);
    configuration.progressTrackerClient = makeUniqueRef<ProgressTrackerClient>(*this);
    configuration.cookieJar = CookieJar::create(SessionProvider::create());

    // Die Empty-Konfiguration ist fuer SVG-Bilder gedacht: alles gesandboxt,
    // kein Script. Fuer echte Seiten: ohne Sandbox und mit unserem FrameLoaderClient.
    if (auto* parameters = std::get_if<PageConfiguration::LocalMainFrameCreationParameters>(&configuration.mainFrameCreationParameters)) {
        parameters->effectiveSandboxFlags = { };
        parameters->clientCreator = [this](auto&, auto& frameLoader) -> UniqueRef<LocalFrameLoaderClient> {
            return makeUniqueRefWithoutRefCountedCheck<FrameLoaderClient>(frameLoader, *this);
        };
    }

    m_page = Page::create(WTF::move(configuration));

    auto& settings = m_page->settings();
    settings.setScriptEnabled(true);
    settings.setLoadsImagesAutomatically(true);
    settings.setAcceleratedCompositingEnabled(false);
    settings.setLocalStorageEnabled(true);
    settings.setSessionStorageEnabled(true);
    settings.setRequestIdleCallbackEnabled(true);
    settings.setDefaultFontSize(16);
    settings.setDefaultFixedFontSize(13);
    settings.setStandardFontFamily("Noto Sans"_s);
    settings.setSansSerifFontFamily("Noto Sans"_s);
    settings.setSerifFontFamily("Noto Serif"_s);
    settings.setFixedFontFamily("Noto Sans Mono"_s);

    m_page->setDeviceScaleFactor(m_deviceScaleFactor);

    RefPtr frame = m_page->localMainFrame();
    RELEASE_ASSERT(frame);
    frame->setView(LocalFrameView::create(*frame, m_size));
    frame->init();
    if (RefPtr view = frame->view()) {
        view->resize(m_size);
        view->setCanHaveScrollbars(true);
    }

    createSurface();
    setFocused(true);
    addDamage(IntRect { { }, m_size });
}

WebView::~WebView()
{
    viewsByID().remove(m_id);
    if (m_page) {
        if (RefPtr frame = m_page->localMainFrame())
            frame->loader().detachFromParent();
    }
}

LocalFrame* WebView::mainFrame() const
{
    return m_page ? m_page->localMainFrame() : nullptr;
}

LocalFrameView* WebView::mainFrameView() const
{
    auto* frame = mainFrame();
    return frame ? frame->view() : nullptr;
}

void WebView::createSurface()
{
    m_pixelSize = IntSize { static_cast<int>(std::ceil(m_size.width() * m_deviceScaleFactor)), static_cast<int>(std::ceil(m_size.height() * m_deviceScaleFactor)) };
    m_pixels = Vector<uint8_t>(static_cast<size_t>(m_pixelSize.width()) * m_pixelSize.height() * 4, 0);
    auto info = SkImageInfo::Make(m_pixelSize.width(), m_pixelSize.height(), kRGBA_8888_SkColorType, kPremul_SkAlphaType);
    m_surface = makeUnique<sk_sp<SkSurface>>(SkSurfaces::WrapPixels(info, m_pixels.mutableSpan().data(), m_pixelSize.width() * 4));
    RELEASE_ASSERT(*m_surface);
}

void WebView::loadURL(const String& urlString)
{
    RefPtr frame = mainFrame();
    if (!frame)
        return;
    URL url { urlString };
    if (!url.isValid()) {
        // Ohne Schema: wie in jedem Browser https:// davor
        url = URL { makeString("https://"_s, urlString) };
    }
    frame->loader().load(FrameLoadRequest { *frame, ResourceRequest { WTF::move(url) } });
}

void WebView::loadHTML(const String& html, const String& baseURL)
{
    RefPtr frame = mainFrame();
    if (!frame)
        return;
    auto utf8 = html.utf8();
    URL base { baseURL.isEmpty() ? "about:blank"_s : baseURL };
    ResourceResponse response { URL { base }, "text/html"_s, static_cast<long long>(utf8.length()), "UTF-8"_s };
    SubstituteData data { SharedBuffer::create(utf8.span()), URL { }, WTF::move(response), SubstituteData::SessionHistoryVisibility::Hidden };
    frame->loader().load(FrameLoadRequest { *frame, ResourceRequest { WTF::move(base) }, WTF::move(data) });
}

void WebView::goBack()
{
    m_page->backForward().goBack();
}

void WebView::goForward()
{
    m_page->backForward().goForward();
}

void WebView::reload()
{
    if (RefPtr frame = mainFrame())
        frame->loader().reload();
}

void WebView::stop()
{
    if (RefPtr frame = mainFrame())
        frame->loader().stopAllLoaders();
}

String WebView::currentURL() const
{
    RefPtr frame = mainFrame();
    if (!frame || !frame->document())
        return { };
    return frame->document()->url().string();
}

String WebView::title() const
{
    RefPtr frame = mainFrame();
    if (!frame || !frame->document())
        return { };
    return frame->document()->title();
}

void WebView::resize(IntSize size, float deviceScaleFactor)
{
    if (size == m_size && deviceScaleFactor == m_deviceScaleFactor)
        return;
    m_size = size;
    m_deviceScaleFactor = deviceScaleFactor;
    m_page->setDeviceScaleFactor(deviceScaleFactor);
    if (RefPtr view = mainFrameView())
        view->resize(size);
    createSurface();
    addDamage(IntRect { { }, m_size });
}

void WebView::addDamage(const IntRect& rect)
{
    IntRect clipped = intersection(rect, IntRect { { }, m_size });
    if (clipped.isEmpty())
        return;
    m_damage.unite(Region { clipped });
    if (!m_frameRequested) {
        m_frameRequested = true;
        requestFrameFromHost(m_id);
    }
}

void WebView::scrollDamage(const IntSize&, const IntRect& rectToScroll, const IntRect& clipRect)
{
    // Einfach und korrekt: den ganzen verschobenen Bereich neu malen.
    // (Pixel verschieben statt neu malen kommt mit dem GPU-Pfad, Phase 8)
    addDamage(intersection(rectToScroll, clipRect));
}

void WebView::scheduleRenderingUpdate()
{
    m_renderingUpdateRequested = true;
    if (!m_frameRequested) {
        m_frameRequested = true;
        requestFrameFromHost(m_id);
    }
}

bool WebView::renderFrame(IntRect* dirtyOut)
{
    m_frameRequested = false;

    if (m_renderingUpdateRequested) {
        m_renderingUpdateRequested = false;
        // requestAnimationFrame-Callbacks, Animationen, Style, Layout, ...
        m_page->updateRendering();
        m_page->finalizeRenderingUpdate({ });
    }

    RefPtr view = mainFrameView();
    if (!view)
        return false;
    view->updateLayoutAndStyleIfNeededRecursive();

    if (m_damage.isEmpty())
        return false;

    auto damage = std::exchange(m_damage, Region { });
    SkCanvas* canvas = (*m_surface)->getCanvas();
    for (auto& rect : damage.rects()) {
        canvas->save();
        canvas->scale(m_deviceScaleFactor, m_deviceScaleFactor);
        canvas->clipRect(SkRect::MakeXYWH(rect.x(), rect.y(), rect.width(), rect.height()));
        canvas->drawColor(SK_ColorWHITE);
        GraphicsContextSkia context(*canvas, RenderingMode::Unaccelerated, RenderingPurpose::Unspecified);
        view->paint(context, rect);
        canvas->restore();
    }

    m_page->didCompleteRenderingUpdateDisplay();
    m_page->didCompleteRenderingFrame();

    if (dirtyOut) {
        IntRect bounds = damage.bounds();
        bounds.scale(m_deviceScaleFactor);
        bounds.inflate(1);
        *dirtyOut = intersection(bounds, IntRect { { }, m_pixelSize });
    }
    return true;
}

void WebView::presentIfNeeded()
{
    if (m_frameInFlight) {
        // Host malt noch das letzte Bild. Sobald er fertig ist, kommt bl_frame_presented
        // und wir werden erneut aufgerufen.
        m_frameRequested = true;
        return;
    }
    IntRect dirty;
    if (!renderFrame(&dirty))
        return;
    m_frameInFlight = true;
    presentFrameToHost(m_id, pixels(), m_pixelSize.width(), m_pixelSize.height(), dirty.x(), dirty.y(), dirty.width(), dirty.height());
}

static OptionSet<PlatformEvent::Modifier> modifiersFromBits(int bits)
{
    OptionSet<PlatformEvent::Modifier> modifiers;
    if (bits & 1)
        modifiers.add(PlatformEvent::Modifier::ShiftKey);
    if (bits & 2)
        modifiers.add(PlatformEvent::Modifier::ControlKey);
    if (bits & 4)
        modifiers.add(PlatformEvent::Modifier::AltKey);
    if (bits & 8)
        modifiers.add(PlatformEvent::Modifier::MetaKey);
    if (bits & 16)
        modifiers.add(PlatformEvent::Modifier::CapsLockKey);
    return modifiers;
}

void WebView::mouseEvent(int type, int button, double x, double y, int clickCount, int modifiers)
{
    RefPtr frame = mainFrame();
    if (!frame)
        return;
    MouseButton mouseButton = MouseButton::None;
    switch (button) {
    case 0: mouseButton = MouseButton::Left; break;
    case 1: mouseButton = MouseButton::Middle; break;
    case 2: mouseButton = MouseButton::Right; break;
    default: break;
    }
    PlatformEvent::Type eventType = type == 0 ? PlatformEvent::Type::MousePressed : type == 1 ? PlatformEvent::Type::MouseReleased : PlatformEvent::Type::MouseMoved;
    DoublePoint position { x, y };
    PlatformMouseEvent event { position, position, mouseButton, eventType, clickCount, modifiersFromBits(modifiers), MonotonicTime::now(), 0, SyntheticClickType::NoTap, MouseEventInputSource::UserDriven };

    Ref handler = frame->eventHandler();
    switch (eventType) {
    case PlatformEvent::Type::MousePressed:
        handler->handleMousePressEvent(event);
        break;
    case PlatformEvent::Type::MouseReleased:
        handler->handleMouseReleaseEvent(event);
        break;
    default:
        handler->mouseMoved(event);
        break;
    }
}

void WebView::wheelEvent(double x, double y, double deltaX, double deltaY, int modifiers)
{
    RefPtr frame = mainFrame();
    if (!frame)
        return;
    IntPoint position { static_cast<int>(x), static_cast<int>(y) };
    // DOM: deltaY > 0 heisst nach unten scrollen. WebCore: umgekehrtes Vorzeichen.
    PlatformWheelEvent event { position, position, static_cast<float>(-deltaX), static_cast<float>(-deltaY), static_cast<float>(-deltaX / 40), static_cast<float>(-deltaY / 40),
        PlatformWheelEventGranularity::ScrollByPixelWheelEvent, !!(modifiers & 1), !!(modifiers & 2), !!(modifiers & 4), !!(modifiers & 8) };
    frame->eventHandler().handleWheelEvent(event, { WheelEventProcessingSteps::SynchronousScrolling, WheelEventProcessingSteps::BlockingDOMEventDispatch });
}

static String keyIdentifierForKey(const String& key)
{
    if (key.length() == 1)
        return makeString("U+"_s, hex(u_toupper(key[0]), 4));
    static constexpr std::pair<ASCIILiteral, ASCIILiteral> names[] = {
        { "Backspace"_s, "U+0008"_s }, { "Tab"_s, "U+0009"_s }, { "Escape"_s, "U+001B"_s }, { "Delete"_s, "U+007F"_s },
        { "ArrowLeft"_s, "Left"_s }, { "ArrowRight"_s, "Right"_s }, { "ArrowUp"_s, "Up"_s }, { "ArrowDown"_s, "Down"_s },
    };
    for (auto& [domKey, identifier] : names) {
        if (key == domKey)
            return identifier;
    }
    return key; // Enter, Home, End, PageUp, PageDown, F1, ... heissen gleich
}

bool WebView::keyEvent(int type, const String& key, const String& code, const String& text, int keyCode, bool repeat, int modifiers)
{
    RefPtr frame = m_page->focusController().focusedOrMainFrame();
    if (!frame)
        return false;
    bool isKeypad = code.startsWith("Numpad"_s);
    auto platformType = type == 0 ? PlatformEvent::Type::KeyDown : PlatformEvent::Type::KeyUp;
    PlatformKeyboardEvent event { platformType, text, text, key, code, keyIdentifierForKey(key), keyCode, repeat, isKeypad, false, modifiersFromBits(modifiers), MonotonicTime::now() };
    return frame->eventHandler().keyEvent(event);
}

void WebView::setFocused(bool focused)
{
    m_page->focusController().setActive(focused);
    m_page->focusController().setFocused(focused);
}

void WebView::notifyNavigationState()
{
    auto& backForward = m_page->backForward();
    notifyHost(m_id, "navigation", makeString("{\"url\":\""_s, jsonEscape(currentURL()), "\",\"canGoBack\":"_s, backForward.canGoBackOrForward(-1) ? "true"_s : "false"_s,
        ",\"canGoForward\":"_s, backForward.canGoBackOrForward(1) ? "true"_s : "false"_s, ",\"loading\":"_s, m_isLoading ? "true"_s : "false"_s, '}'));
}

void WebView::didStartLoading()
{
    m_isLoading = true;
    notifyNavigationState();
}

void WebView::didCommitLoad()
{
    notifyNavigationState();
}

void WebView::didFinishLoading()
{
    m_isLoading = false;
    notifyNavigationState();
    notifyHost(m_id, "load");
}

void WebView::didFailLoading(const String& url, const String& description)
{
    m_isLoading = false;
    notifyNavigationState();
    notifyHost(m_id, "error", makeString("{\"url\":\""_s, jsonEscape(url), "\",\"description\":\""_s, jsonEscape(description), "\"}"_s));
}

void WebView::didChangeTitle(const String& title)
{
    notifyHost(m_id, "title", makeString("{\"title\":\""_s, jsonEscape(title), "\"}"_s));
}

void WebView::didChangeProgress(double progress)
{
    notifyHost(m_id, "progress", makeString("{\"progress\":"_s, progress, '}'));
}

void WebView::didChangeCursor(const String& cssCursor)
{
    notifyHost(m_id, "cursor", makeString("{\"cursor\":\""_s, cssCursor, "\"}"_s));
}

void WebView::didReceiveConsoleMessage(int level, const String& message, const String& source, unsigned line)
{
    notifyHost(m_id, "console", makeString("{\"level\":"_s, level, ",\"message\":\""_s, jsonEscape(message), "\",\"source\":\""_s, jsonEscape(source), "\",\"line\":"_s, line, '}'));
}

} // namespace BrowserLite
