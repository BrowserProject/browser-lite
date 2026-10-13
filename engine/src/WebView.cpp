#include "config.h"
#include "WebView.h"
#include "Choosers.h"
#include "DeviceClients.h"

#include "BackForwardList.h"
#include "Clients.h"
#include "EditorClient.h"
#include "Engine.h"
#include "CacheStorageWasm.h"
#include "Compositor.h"
#include "GpuRaster.h"
#include "LayerTreeHostWasm.h"
#include "ScrollingWasm.h"
#include "ServiceWorkerWasm.h"
#include "WebPlatformExtras.h"
#include "WebCodecsWasm.h"
#if ENABLE(MEDIA_STREAM)
#include "MediaStreamWasm.h"
#endif
#include "Host.h"
#include "LoaderStrategy.h"
#include "WasmSocketProvider.h"
#include "Storage.h"
#include "Strategies.h"

#include <WebCore/BackForwardController.h>
#include <WebCore/CookieJar.h>
#include <WebCore/DatabaseProvider.h>
#include <WebCore/Cursor.h>
#include <WebCore/DocumentFullscreen.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/DocumentLoader.h>
#include <WebCore/DocumentView.h>
#include <WebCore/Editor.h>
#include <WebCore/EventHandler.h>
#include <WebCore/ContextMenuController.h>
#include <WebCore/FileChooser.h>
#include <WebCore/HitTestResult.h>
#include <WebCore/FocusController.h>
#include <WebCore/FrameInlines.h>
#include <WebCore/FrameLoadRequest.h>
#include <WebCore/FrameLoader.h>
#include <WebCore/GraphicsContextSkia.h>
#include <WebCore/HandleUserInputEventResult.h>
#include <WebCore/LinkIconCollector.h>
#include <WebCore/LinkIconType.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/LocalFrameView.h>
#include <WebCore/NodeInlines.h>
#include <WebCore/Page.h>
#include <WebCore/CacheStorageProvider.h>
#include <WebCore/PageConfiguration.h>
#include <WebCore/SpeechRecognitionProvider.h>
#include <WebCore/ScreenOrientationManager.h>
#include <WebCore/StorageProvider.h>
#include <WebCore/UserContentProvider.h>
#include <WebCore/PlatformKeyboardEvent.h>
#include <WebCore/PlatformMouseEvent.h>
#include <WebCore/PlatformWheelEvent.h>
#include <WebCore/PointerLockController.h>
#include <WebCore/PlatformTouchEvent.h>
#include <WebCore/PlatformTouchPoint.h>
#include <WebCore/WasmPlatform.h>
#include <WebCore/RemoteFrameGeometryTransformer.h>
#include <WebCore/RenderLayerCompositor.h>
#include <WebCore/RenderView.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/ResourceResponse.h>
#include <WebCore/ScrollingCoordinatorTypes.h>
#include <WebCore/Settings.h>
#include <WebCore/SharedBuffer.h>
#include <WebCore/StorageNamespaceProvider.h>
#include <WebCore/StorageSessionProvider.h>
#include <WebCore/SubstituteData.h>
#include <pal/SessionID.h>
#include <optional>
#include <skia/core/SkCanvas.h>
#include <skia/core/SkImage.h>
#include <skia/core/SkPaint.h>
#include <skia/core/SkSurface.h>
#include <wtf/HashMap.h>
#include <wtf/JSONValues.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>

namespace BrowserLite {

using namespace WebCore;

static HashMap<int, WeakPtr<WebView>>& viewsByID()
{
    static NeverDestroyed<HashMap<int, WeakPtr<WebView>>> views;
    return views;
}

WebView* WebView::fromID(int id)
{
    return viewsByID().get(id);
}

// Offene Views (Tabs). Die Oberflaeche oeffnet und schliesst sie, Popups
// (window.open, target=_blank) oeffnet die Engine selber.
static HashMap<int, Ref<WebView>>& openViews()
{
    static NeverDestroyed<HashMap<int, Ref<WebView>>> views;
    return views;
}

WebView& WebView::open(int id, IntSize size, float deviceScaleFactor)
{
    Ref view = create(id, size, deviceScaleFactor);
    auto& result = view.get();
    openViews().set(id, WTF::move(view));
    // Die Oberflaeche schickt das Canvas oft, bevor der View hier existiert
    if (hasWorkerCanvas(id))
        result.canvasAttached();
    return result;
}

void WebView::close(int id)
{
    closeChoosers(id);
    openViews().remove(id);
    detachDeviceClients(id);
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
    debugLog("View %d: erstellen", id);

    auto configuration = pageConfigurationWithEmptyClients(PageIdentifier::generate(), PAL::SessionID::defaultSessionID());
    configuration.chromeClient = makeUniqueRef<ChromeClient>(*this);
    configuration.editorClient = makeUniqueRef<EditorClient>();
    configuration.speechRecognitionProvider = createSpeechRecognitionProvider(m_id);
    configuration.backForwardClient = BackForwardList::create();
    configuration.progressTrackerClient = makeUniqueRef<ProgressTrackerClient>(*this);
    configuration.cookieJar = CookieJar::create(SessionProvider::create());
    configuration.storageNamespaceProvider = &storageNamespaceProvider();
    configuration.databaseProvider = &databaseProvider();
    configuration.socketProvider = createSocketProvider();
    configuration.storageProvider = createStorageProvider();
    configuration.cacheStorageProvider = createCacheStorageProvider();
    configuration.screenOrientationManager = screenOrientationManager();
    configuration.userContentProvider = userContentProvider();

    // Die Empty-Konfiguration ist fuer SVG-Bilder gedacht: alles gesandboxt,
    // kein Script. Fuer echte Seiten: ohne Sandbox und mit unserem FrameLoaderClient.
    if (auto* parameters = std::get_if<PageConfiguration::LocalMainFrameCreationParameters>(&configuration.mainFrameCreationParameters)) {
        parameters->effectiveSandboxFlags = { };
        parameters->clientCreator = [this](auto&, auto& frameLoader) -> UniqueRef<LocalFrameLoaderClient> {
            return makeUniqueRefWithoutRefCountedCheck<FrameLoaderClient>(frameLoader, *this);
        };
    }

    m_page = Page::create(WTF::move(configuration));
    debugLog("View %d: Page erstellt", id);
    attachDeviceClients(*this, *m_page);
#if ENABLE(MEDIA_STREAM)
    // getUserMedia/getDisplayMedia ueber Kamera und Bildschirm des Host
    MediaStreams::attachTo(m_id, *m_page);
#endif
    m_page->setUseColorAppearance(WasmPlatform::screenInfo().prefersDarkMode, false);

    auto& settings = m_page->settings();
    settings.setScriptEnabled(true);
    settings.setLoadsImagesAutomatically(true);
    // Compositing mit Ebenen, wenn die GPU geht (BL_COMPOSITING=0 bzw.
    // ?compositing=0 in der Oberflaeche schaltet ab)
    const char* compositing = getenv("BL_COMPOSITING");
    if ((!compositing || strcmp(compositing, "0")) && LayerTreeHostWasm::isAvailable()) {
        m_layerTreeHost = makeUnique<LayerTreeHostWasm>(*this);
        m_compositing = true;
    }
    settings.setAcceleratedCompositingEnabled(m_compositing);
    settings.setForceCompositingMode(m_compositing);
    settings.setAcceleratedCompositingForFixedPositionEnabled(m_compositing);
#if ENABLE(ASYNC_SCROLLING) && ENABLE(SCROLLING_THREAD)
    // Scrollen im eigenen Thread (ScrollingWasm.h), braucht die Ebenen.
    // BL_ASYNC_SCROLLING=0 schaltet ab.
    const char* asyncScrolling = getenv("BL_ASYNC_SCROLLING");
    bool useAsyncScrolling = m_compositing && (!asyncScrolling || strcmp(asyncScrolling, "0"));
    settings.setScrollingCoordinatorEnabled(useAsyncScrolling);
    settings.setAsyncFrameScrollingEnabled(useAsyncScrolling);
    settings.setAsyncOverflowScrollingEnabled(useAsyncScrolling);
#endif
    settings.setLocalStorageEnabled(true);
    settings.setSessionStorageEnabled(true);
    settings.setRequestIdleCallbackEnabled(true);
    settings.setWebAudioEnabled(true);
#if ENABLE(WEBGL)
    settings.setWebGLEnabled(true);
#endif
#if ENABLE(FULLSCREEN_API)
    settings.setFullScreenEnabled(true);
#endif
#if ENABLE(MEDIA_SOURCE)
    settings.setMediaSourceEnabled(true);
    // ManagedMediaSource braucht Hinweise vom System (startstreaming), die wir
    // nicht haben. hls.js & Co. nehmen sonst MMS und warten ewig.
    settings.setManagedMediaSourceEnabled(false);
#endif
    // Funktionen, die WebKit-Browser (WPE/GTK/Safari) einschalten, die fuer
    // WebCore allein aber aus sind (UnifiedWebPreferences.yaml, Standard "WebCore")
    settings.setCompressionStreamEnabled(true);
    settings.setNavigationAPIEnabled(true);
    // Fertig in WebKit, nur die Standardwerte fuer WebCore allein sind aus
    // (Messlatte tests/engine/features.html)
    settings.setCanvasFiltersEnabled(true);
    settings.setMoveBeforeEnabled(true);
    settings.setSelectShowPickerEnabled(true);
    settings.setCSSScrollbarColorEnabled(true);
    settings.setStorageAPIEnabled(true);
    settings.setCacheAPIEnabled(true);
    ServiceWorkers::enableIn(settings);
    WebCodecs::enableIn(settings);
#if ENABLE(MEDIA_STREAM)
    MediaStreams::enableIn(settings);
#endif
    settings.setSpeechRecognitionEnabled(true);
    // Origin Private File System (FileSystemStorageWasm.cpp)
    settings.setFileSystemEnabled(true);
    settings.setFileSystemWritableStreamEnabled(true);
    settings.setAccessHandleEnabled(true);
    settings.setStorageAPIEstimateEnabled(true);
    settings.setScreenOrientationAPIEnabled(true);
    settings.setScreenOrientationLockingAPIEnabled(true);
    settings.setScreenWakeLockAPIEnabled(true);
    settings.setPermissionsAPIEnabled(true);
    settings.setUserActivationAPIEnabled(true);
    settings.setLazyImageLoadingEnabled(true);
    settings.setLazyIframeLoadingEnabled(true);
    settings.setVisualViewportAPIEnabled(true);
    settings.setBeaconAPIEnabled(true);
    settings.setDataListElementEnabled(true);
    settings.setAsyncClipboardAPIEnabled(true);
    settings.setGenericCueAPIEnabled(true);
    settings.setInputTypeColorEnabled(true);
    settings.setInputTypeDateEnabled(true);
    settings.setInputTypeDateTimeLocalEnabled(true);
    settings.setInputTypeTimeEnabled(true);
    settings.setInputTypeMonthEnabled(true);
    settings.setInputTypeWeekEnabled(true);
    settings.setDateTimeInputsEditableComponentsEnabled(true);
    settings.setInteractiveFormValidationEnabled(true);
    settings.setTextAreasAreResizable(true);
    settings.setShouldRespectImageOrientation(true);
    settings.setNeedsSiteSpecificQuirks(true);
    settings.setDataTransferItemsEnabled(true);
    settings.setDirectoryUploadEnabled(true);
    settings.setDownloadAttributeEnabled(true);
    settings.setClearSiteDataHTTPHeaderEnabled(true);
    settings.setCrossOriginEmbedderPolicyEnabled(true);
    settings.setCrossOriginOpenerPolicyEnabled(true);
    settings.setMediaCapabilitiesEnabled(true);
    settings.setRequestVideoFrameCallbackEnabled(true);
    settings.setHiddenPageDOMTimerThrottlingEnabled(true);
    settings.setHiddenPageCSSAnimationSuspensionEnabled(true);
    // Brauchen die Funktions-Schalter in OptionsWasm.cmake
#if ENABLE(OFFSCREEN_CANVAS)
    settings.setOffscreenCanvasEnabled(true);
#endif
#if ENABLE(OFFSCREEN_CANVAS_IN_WORKERS)
    settings.setOffscreenCanvasInWorkersEnabled(true);
#endif
#if ENABLE(POINTER_LOCK)
    settings.setPointerLockEnabled(true);
#endif
#if ENABLE(GAMEPAD)
    settings.setGamepadsEnabled(true);
    settings.setGamepadVibrationActuatorEnabled(true);
#endif

    settings.setDefaultFontSize(16);
    settings.setDefaultFixedFontSize(13);
    settings.setStandardFontFamily("Noto Sans"_s);
    settings.setSansSerifFontFamily("Noto Sans"_s);
    settings.setSerifFontFamily("Noto Serif"_s);
    settings.setFixedFontFamily("Noto Sans Mono"_s);

    m_page->setDeviceScaleFactor(m_deviceScaleFactor);
    debugLog("View %d: Einstellungen gesetzt", id);

    RefPtr frame = m_page->localMainFrame();
    RELEASE_ASSERT(frame);
    frame->setView(LocalFrameView::create(*frame, m_size));
    frame->init();
    debugLog("View %d: Frame bereit", id);
    if (RefPtr view = frame->view()) {
        view->resize(m_size);
        view->setCanHaveScrollbars(true);
    }

    createSurface();
    setFocused(true);
    addDamage(IntRect { { }, m_size });
    debugLog("View %d: fertig", id);
}

WebView::~WebView()
{
    viewsByID().remove(m_id);
    forgetWorkerCanvas(m_id);
    if (m_page) {
        if (RefPtr frame = m_page->localMainFrame())
            frame->loader().detachFromParent();
    }
    // Die Ebenen gehoeren der Page, darum den Compositor erst danach abbauen
    m_page = nullptr;
    m_layerTreeHost = nullptr;
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
    m_pendingScrolls.clear();
    m_pixelSize = IntSize { static_cast<int>(std::ceil(m_size.width() * m_deviceScaleFactor)), static_cast<int>(std::ceil(m_size.height() * m_deviceScaleFactor)) };
    m_pixels.fill(0, static_cast<size_t>(m_pixelSize.width()) * m_pixelSize.height() * 4);
    auto info = SkImageInfo::Make(m_pixelSize.width(), m_pixelSize.height(), kRGBA_8888_SkColorType, kPremul_SkAlphaType);
    m_surface = SkSurfaces::WrapPixels(info, m_pixels.mutableSpan().data(), m_pixelSize.width() * 4);
    RELEASE_ASSERT(m_surface);
    m_gpuSurface = nullptr;
    createGpuSurfaceIfPossible();
    if (m_layerTreeHost)
        m_layerTreeHost->sizeDidChange(m_pixelSize, m_deviceScaleFactor);
}

// Mit Canvas im Engine-Worker und WebGL 2 malt Skia auf der GPU (GpuRaster.h).
// Die Flaeche ist neu und leer, darum alles neu malen.
void WebView::createGpuSurfaceIfPossible()
{
    // Mit Compositor-Thread hat der Engine-Worker kein Canvas und keine GPU
    if (m_gpuSurface || !m_canvasAttached || m_pixelSize.isEmpty() || Compositor::isRunning())
        return;
    Gpu::Scope scope;
    if (!scope)
        return;
    m_gpuSurface = Gpu::createSurface(m_pixelSize.width(), m_pixelSize.height());
    if (m_gpuSurface)
        addDamage(IntRect { { }, m_size });
}

// Zurueck auf die CPU (GPU verloren): der Pixel-Buffer ist alt, alles neu malen
void WebView::dropGpuSurface()
{
    if (!m_gpuSurface)
        return;
    m_gpuSurface = nullptr;
    stopCompositing();
    m_pendingScrolls.clear();
    addDamage(IntRect { { }, m_size });
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
    // Eingabe in der Adressleiste: wie in anderen Browsern darf das auch eine
    // data:-URL sein (Seiten selber duerfen nicht dorthin navigieren)
    FrameLoadRequest request { *frame, ResourceRequest { WTF::move(url) } };
    request.setIsRequestFromClientOrUserInput();
    frame->loader().load(WTF::move(request));
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
    if (m_compositing) {
        scheduleRenderingUpdate();
        return;
    }
    addDamage(IntRect { { }, m_size });
}

void WebView::addDamage(const IntRect& rect)
{
    // Mit Compositing malen die Ebenen selber (setNeedsDisplay)
    if (m_compositing)
        return;
    IntRect clipped = intersection(rect, IntRect { { }, m_size });
    if (clipped.isEmpty())
        return;
    m_damage.unite(Region { clipped });
    if (!m_frameRequested) {
        m_frameRequested = true;
        requestFrameFromHost(m_id);
    }
}

void WebView::scrollDamage(const IntSize& delta, const IntRect& rectToScroll, const IntRect& clipRect)
{
    if (m_compositing)
        return;
    IntRect area = intersection(intersection(rectToScroll, clipRect), IntRect { { }, m_size });
    if (area.isEmpty())
        return;
    // Nur ganze Geraete-Pixel lassen sich verschieben, sonst neu malen
    float deviceX = delta.width() * m_deviceScaleFactor;
    float deviceY = delta.height() * m_deviceScaleFactor;
    if (deviceX != std::round(deviceX) || deviceY != std::round(deviceY) || std::abs(delta.width()) >= area.width() || std::abs(delta.height()) >= area.height()) {
        addDamage(area);
        return;
    }

    // Was noch neu gemalt werden muss, wandert mit dem Inhalt mit
    Region moved = intersect(m_damage, Region { area });
    m_damage.subtract(area);
    moved.translate(delta);
    moved.intersect(Region { area });
    m_damage.unite(moved);

    m_pendingScrolls.append({ delta, area });

    // Der frei gewordene Streifen muss neu gemalt werden
    IntRect kept = intersection(area, IntRect { area.location() + delta, area.size() });
    Region exposed { area };
    exposed.subtract(kept);
    for (auto& rect : exposed.rects())
        addDamage(rect);
    if (!m_frameRequested) {
        m_frameRequested = true;
        requestFrameFromHost(m_id);
    }
}

// Verschiebt die Pixel im Buffer (Geraete-Pixel). presented bekommt den
// Bereich, den die Oberflaeche neu kopieren muss.
void WebView::applyPendingScrolls(IntRect& presented)
{
    const size_t stride = static_cast<size_t>(m_pixelSize.width()) * 4;
    for (auto& [delta, area] : std::exchange(m_pendingScrolls, { })) {
        IntRect deviceArea = area;
        deviceArea.scale(m_deviceScaleFactor);
        deviceArea.intersect(IntRect { { }, m_pixelSize });
        int dx = std::lround(delta.width() * m_deviceScaleFactor);
        int dy = std::lround(delta.height() * m_deviceScaleFactor);
        IntRect target = intersection(deviceArea, IntRect { deviceArea.location() + IntSize { dx, dy }, deviceArea.size() });
        if (target.isEmpty())
            continue;
        if (m_gpuSurface) {
            // Auf der GPU: den Bereich als Bild nehmen und verschoben wieder hinein
            IntRect source = target;
            source.move(-dx, -dy);
            auto image = m_gpuSurface->makeImageSnapshot(SkIRect::MakeXYWH(source.x(), source.y(), source.width(), source.height()));
            if (image) {
                SkPaint paint;
                paint.setBlendMode(SkBlendMode::kSrc);
                m_gpuSurface->getCanvas()->drawImage(image, target.x(), target.y(), SkSamplingOptions { }, &paint);
            }
            presented.unite(deviceArea);
            continue;
        }
        auto pixels = m_pixels.mutableSpan();
        size_t rowBytes = static_cast<size_t>(target.width()) * 4;
        auto copyRow = [&](int y) {
            size_t to = static_cast<size_t>(y) * stride + static_cast<size_t>(target.x()) * 4;
            size_t from = static_cast<size_t>(y - dy) * stride + static_cast<size_t>(target.x() - dx) * 4;
            memmove(pixels.data() + to, pixels.data() + from, rowBytes);
        };
        // Bei Bewegung nach unten von unten her kopieren, sonst ueberschreiben wir die Quelle
        if (dy > 0) {
            for (int y = target.maxY() - 1; y >= target.y(); --y)
                copyRow(y);
        } else {
            for (int y = target.y(); y < target.maxY(); ++y)
                copyRow(y);
        }
        presented.unite(deviceArea);
    }
}

void WebView::scheduleRenderingUpdate()
{
    m_renderingUpdateRequested = true;
    if (!m_frameRequested) {
        m_frameRequested = true;
        requestFrameFromHost(m_id);
    }
}

void WebView::requestComposite()
{
    if (!m_frameRequested) {
        m_frameRequested = true;
        requestFrameFromHost(m_id);
    }
}

GraphicsLayerFactory* WebView::graphicsLayerFactory() const
{
    return m_compositing ? m_layerTreeHost.get() : nullptr;
}

void WebView::attachRootGraphicsLayer(GraphicsLayer* layer)
{
    if (m_layerTreeHost)
        m_layerTreeHost->setRootCompositingLayer(layer);
}

void WebView::attachViewOverlayGraphicsLayer(GraphicsLayer* layer)
{
    if (m_layerTreeHost)
        m_layerTreeHost->setViewOverlayRootLayer(layer);
}

// Zurueck zum Malen ohne Ebenen (GPU verloren). WebCore baut die Ebenen ab,
// der Compositor bleibt bis zum Ende des Views (die Ebenen zeigen auf ihn).
void WebView::stopCompositing()
{
    if (!m_compositing)
        return;
    debugLog("View %d: Compositing aus", m_id);
    m_compositing = false;
    auto& settings = m_page->settings();
    settings.setForceCompositingMode(false);
    settings.setAcceleratedCompositingEnabled(false);
    settings.setAcceleratedCompositingForFixedPositionEnabled(false);
#if ENABLE(ASYNC_SCROLLING) && ENABLE(SCROLLING_THREAD)
    // Ohne Ebenen scrollt wieder der Engine-Thread
    settings.setAsyncFrameScrollingEnabled(false);
    settings.setAsyncOverflowScrollingEnabled(false);
    Scrolling::stopForView(m_id);
#endif
    // Die Einstellung wirkt sonst erst bei der naechsten echten Aenderung an
    // Style oder Layout: Compositing in allen Frames gleich beenden
    for (RefPtr<Frame> frame = m_page->mainFrame(); frame; frame = frame->tree().traverseNext()) {
        RefPtr localFrame = dynamicDowncast<LocalFrame>(*frame);
        if (CheckedPtr renderView = localFrame ? localFrame->contentRenderer() : nullptr) {
            auto& compositor = renderView->compositor();
            compositor.willRecalcStyle(); // liest die Einstellungen neu
            // Backings der Ebenen abbauen, sonst malt WebCore ihren Inhalt nicht selber
            compositor.clearBackingForAllLayers();
            compositor.enableCompositingMode(false);
        }
    }
    m_page->setNeedsRecalcStyleInAllFrames();
    m_repaintAfterCompositingStopped = true;
    addDamage(IntRect { { }, m_size });
    scheduleRenderingUpdate();
}

// Wie WebKit2 (LayerTreeHost::updateRendering): Rendering-Update und den Stand
// der Ebenen an den Compositor-Thread. Der zeigt das Bild selber und meldet
// sich mit didComposite(); erst dann kommt das naechste Rendering-Update.
bool WebView::renderCompositedFrame(IntRect*)
{
    auto& host = *m_layerTreeHost;
    if (std::exchange(m_needsFullPresent, false))
        host.forceRepaint();
    if (!m_renderingUpdateRequested || host.isWaitingForCompositor())
        return false;
    auto start = MonotonicTime::now();
    m_renderingUpdateRequested = false;
    m_page->updateRendering();
    m_page->finalizeRenderingUpdate({ FinalizeRenderingUpdateFlags::ApplyScrollingTreeLayerPositions });
    host.flush();
    // Nichts zu zeigen: das Bild ist trotzdem "fertig"
    if (!host.isWaitingForCompositor())
        didComposite();
    auto milliseconds = (MonotonicTime::now() - start).milliseconds();
    if (milliseconds > 30)
        debugLog("View %d: Rendering-Update %.0f ms", m_id, milliseconds);
    return false;
}

void WebView::didComposite()
{
    if (m_layerTreeHost)
        m_layerTreeHost->didComposite();
    m_page->didCompleteRenderingUpdateDisplay();
    m_page->didCompleteRenderingFrame();
    if (m_renderingUpdateRequested)
        requestComposite();
}

// Der Compositor-Thread hat seine GPU verloren: ohne Ebenen weitermalen
void WebView::compositorLost()
{
    if (m_layerTreeHost)
        m_layerTreeHost->didComposite();
    stopCompositing();
}

bool WebView::renderFrame(IntRect* dirtyOut)
{
    m_frameRequested = false;
    if (m_compositing)
        return renderCompositedFrame(dirtyOut);
    auto start = MonotonicTime::now();

    if (m_renderingUpdateRequested) {
        m_renderingUpdateRequested = false;
        // requestAnimationFrame-Callbacks, Animationen, Style, Layout, ...
        m_page->updateRendering();
        m_page->finalizeRenderingUpdate({ });
        // Nach stopCompositing: solange WebCore noch Ebenen hat, malt es den
        // Inhalt nicht selber. Sobald sie weg sind, alles neu malen.
        if (m_repaintAfterCompositingStopped) {
            RefPtr frameView = mainFrameView();
            CheckedPtr renderView = frameView ? frameView->renderView() : nullptr;
            if (renderView && !renderView->usesCompositing()) {
                m_repaintAfterCompositingStopped = false;
                addDamage(IntRect { { }, m_size });
            } else
                scheduleRenderingUpdate();
        }
    }

    RefPtr view = mainFrameView();
    if (!view)
        return false;
    view->updateLayoutAndStyleIfNeededRecursive();
    auto layoutDone = MonotonicTime::now();

    // Skia legt auf der GPU schon beim Malen Texturen an (Bilder): der eigene
    // GL-Kontext muss die ganze Zeit aktuell sein
    std::optional<Gpu::Scope> gpuScope;
    if (m_gpuSurface)
        gpuScope.emplace();

    IntRect presented;
    applyPendingScrolls(presented);
    if (std::exchange(m_needsFullPresent, false))
        presented = IntRect { { }, m_pixelSize };

    if (m_damage.isEmpty() && presented.isEmpty())
        return false;

    auto damage = std::exchange(m_damage, Region { });
    SkCanvas* canvas = m_gpuSurface ? m_gpuSurface->getCanvas() : m_surface->getCanvas();
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

    auto end = MonotonicTime::now();
    if ((end - start).milliseconds() > 30)
        debugLog("View %d: Bild %.0f ms (Layout %.0f ms, Malen %.0f ms)", m_id, (end - start).milliseconds(), (layoutDone - start).milliseconds(), (end - layoutDone).milliseconds());

    if (dirtyOut) {
        IntRect bounds = damage.bounds();
        if (!bounds.isEmpty()) {
            bounds.scale(m_deviceScaleFactor);
            bounds.inflate(1);
        }
        bounds.unite(presented);
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
    if (m_gpuSurface && !Gpu::context())
        dropGpuSurface();
    IntRect dirty;
    if (!renderFrame(&dirty))
        return;
    if (m_gpuSurface) {
        auto start = MonotonicTime::now();
        Gpu::Scope scope;
        if (scope && Gpu::present(m_id, *m_gpuSurface)) {
            auto milliseconds = (MonotonicTime::now() - start).milliseconds();
            if (milliseconds > 30)
                debugLog("View %d: GPU-Abschicken %.0f ms", m_id, milliseconds);
            return;
        }
        // Ging nicht (Kontext weg): ab jetzt auf der CPU, im naechsten Bild alles
        dropGpuSurface();
        return;
    }
    // Mit Compositor-Thread zeigt dessen Worker auch die Bilder ohne Ebenen;
    // bis er fertig ist, darf der Pixel-Buffer nicht geaendert werden
    if (Compositor::isRunning()) {
        m_frameInFlight = true;
        presentFrameOnCompositor(m_id, pixels(), m_pixelSize.width(), m_pixelSize.height(), dirty.x(), dirty.y(), dirty.width(), dirty.height());
        return;
    }
    if (presentFrameInWorker(m_id, pixels(), m_pixelSize.width(), m_pixelSize.height(), dirty.x(), dirty.y(), dirty.width(), dirty.height()))
        return;
    m_frameInFlight = true;
    presentFrameToHost(m_id, pixels(), m_pixelSize.width(), m_pixelSize.height(), dirty.x(), dirty.y(), dirty.width(), dirty.height());
}

void WebView::canvasAttached()
{
    m_canvasAttached = true;
    createGpuSurfaceIfPossible();
    m_needsFullPresent = true;
    if (!m_frameRequested) {
        m_frameRequested = true;
        requestFrameFromHost(m_id);
    }
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

namespace {
// movementX/Y kommen vom Host (bei Pointer Lock die einzige Bewegung)
class MouseEventWasm final : public PlatformMouseEvent {
public:
    MouseEventWasm(const DoublePoint& position, MouseButton button, PlatformEvent::Type type, int clickCount, OptionSet<PlatformEvent::Modifier> modifiers, DoublePoint movement)
        : PlatformMouseEvent(position, position, button, type, clickCount, modifiers, MonotonicTime::now(), 0, SyntheticClickType::NoTap, MouseEventInputSource::UserDriven)
    {
        m_movementDelta = movement;
    }
};
}

void WebView::mouseEvent(int type, int button, double x, double y, int clickCount, int modifiers, double movementX, double movementY)
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
    MouseEventWasm event { position, mouseButton, eventType, clickCount, modifiersFromBits(modifiers), { movementX, movementY } };

    auto& handler = frame->eventHandler();
    switch (eventType) {
    case PlatformEvent::Type::MousePressed:
        handler.handleMousePressEvent(event);
        break;
    case PlatformEvent::Type::MouseReleased:
        handler.handleMouseReleaseEvent(event);
        break;
    default:
        handler.mouseMoved(event);
        break;
    }
}

PlatformWheelEvent WebView::makeWheelEvent(double x, double y, double deltaX, double deltaY, int modifiers)
{
    IntPoint position { static_cast<int>(x), static_cast<int>(y) };
    // DOM: deltaY > 0 heisst nach unten scrollen. WebCore: umgekehrtes Vorzeichen.
    return { position, position, static_cast<float>(-deltaX), static_cast<float>(-deltaY), static_cast<float>(-deltaX / 40), static_cast<float>(-deltaY / 40),
        PlatformWheelEventGranularity::ScrollByPixelWheelEvent, !!(modifiers & 1), !!(modifiers & 2), !!(modifiers & 4), !!(modifiers & 8) };
}

void WebView::wheelEvent(double x, double y, double deltaX, double deltaY, int modifiers)
{
    dispatchWheelEvent(makeWheelEvent(x, y, deltaX, deltaY, modifiers), { WheelEventProcessingSteps::SynchronousScrolling, WheelEventProcessingSteps::BlockingDOMEventDispatch });
}

void WebView::dispatchWheelEvent(const PlatformWheelEvent& event, OptionSet<WheelEventProcessingSteps> steps)
{
    RefPtr frame = mainFrame();
    if (!frame)
        return;
    frame->eventHandler().handleWheelEvent(event, steps);
}

RefPtr<ScrollingCoordinator> WebView::createScrollingCoordinator(Page& page) const
{
#if ENABLE(ASYNC_SCROLLING) && ENABLE(SCROLLING_THREAD)
    if (m_compositing)
        return ScrollingCoordinatorWasm::create(page, m_id);
#else
    UNUSED_PARAM(page);
#endif
    return nullptr;
}

#if ENABLE(TOUCH_EVENTS)
namespace {
// PlatformTouchEvent/-Point haben nur geschuetzte Felder, die Ports fuellen sie selber
class TouchPointWasm final : public PlatformTouchPoint {
public:
    TouchPointWasm(unsigned id, State state, DoublePoint position, DoubleSize radius, float force)
    {
        m_id = id;
        m_state = state;
        m_pos = position;
        m_screenPos = position;
        m_radius = radius;
        m_rotationAngle = 0;
        m_twist = 0;
        m_force = force;
    }
};

class TouchEventWasm final : public PlatformTouchEvent {
public:
    TouchEventWasm(PlatformEvent::Type type, Vector<PlatformTouchPoint>&& points, OptionSet<PlatformEvent::Modifier> modifiers)
    {
        m_type = type;
        m_touchPoints = WTF::move(points);
        m_modifiers = modifiers;
        m_timestamp = MonotonicTime::now();
    }
};
}
#endif

// Touch (Chromebooks): type 0 Start, 1 Bewegung, 2 Ende, 3 Abbruch. Punkte als
// JSON [{id, x, y, state, rx, ry, force}], state wie PlatformTouchPoint::State.
// Die Oberflaeche erfaehrt, ob die Seite das Event abgefangen hat (dann kein
// Scrollen und kein Klick daraus).
void WebView::touchEvent(int type, const String& json, int modifiers)
{
#if ENABLE(TOUCH_EVENTS)
    RefPtr frame = mainFrame();
    auto value = JSON::Value::parseJSON(json);
    auto array = value ? value->asArray() : nullptr;
    if (!frame || !array)
        return;
    Vector<PlatformTouchPoint> points;
    for (auto& item : *array) {
        auto point = item->asObject();
        if (!point)
            continue;
        auto state = static_cast<PlatformTouchPoint::State>(std::clamp(point->getInteger("state"_s).value_or(0), 0, 4));
        points.append(TouchPointWasm(point->getInteger("id"_s).value_or(0), state,
            { point->getDouble("x"_s).value_or(0), point->getDouble("y"_s).value_or(0) },
            { point->getDouble("rx"_s).value_or(1), point->getDouble("ry"_s).value_or(1) },
            static_cast<float>(point->getDouble("force"_s).value_or(0))));
    }
    static constexpr PlatformEvent::Type types[] = { PlatformEvent::Type::TouchStart, PlatformEvent::Type::TouchMove, PlatformEvent::Type::TouchEnd, PlatformEvent::Type::TouchCancel };
    TouchEventWasm event { types[std::clamp(type, 0, 3)], WTF::move(points), modifiersFromBits(modifiers) };
    auto result = frame->eventHandler().handleTouchEvent(event);
    bool consumed = result && *result;
    notifyHost(m_id, "touch-result", makeString("{\"type\":"_s, type, ",\"consumed\":"_s, consumed ? "true"_s : "false"_s, '}'));
#else
    UNUSED_PARAM(type);
    UNUSED_PARAM(json);
    UNUSED_PARAM(modifiers);
#endif
}

#if ENABLE(POINTER_LOCK)
// Pointer Lock (Spiele, 3D): die Oberflaeche ruft requestPointerLock() am Canvas auf
void WebView::requestPointerLock(CompletionHandler<void(PointerLockRequestResult)>&& completionHandler)
{
    if (auto previous = std::exchange(m_pointerLockHandler, WTF::move(completionHandler)))
        previous(PointerLockRequestResult::Failure);
    notifyHost(m_id, "pointerlock", "{\"on\":true}"_s);
}

void WebView::pointerLockResult(bool locked)
{
    if (auto completionHandler = std::exchange(m_pointerLockHandler, nullptr))
        completionHandler(locked ? PointerLockRequestResult::Success : PointerLockRequestResult::Failure);
    else if (!locked)
        m_page->pointerLockController().didLosePointerLock();
}

void WebView::requestPointerUnlock()
{
    notifyHost(m_id, "pointerlock", "{\"on\":false}"_s);
}
#endif

void WebView::forEach(const Function<void(WebView&)>& function)
{
    for (auto& view : copyToVector(openViews().values()))
        function(view.get());
}

void WebView::setDarkAppearance(bool dark)
{
    m_page->setUseColorAppearance(dark, false);
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

// Fertiger Text aus der Texteingabe des Hosts (IME, tote Tasten, Bildschirmtastatur)
void WebView::contextMenu(double x, double y)
{
    RefPtr frame = mainFrame();
    RefPtr view = mainFrameView();
    if (!frame || !view)
        return;
    DoublePoint position { x, y };
    PlatformMouseEvent event { position, position, MouseButton::Right, PlatformEvent::Type::MousePressed, 1, { }, MonotonicTime::now(), 0, SyntheticClickType::NoTap, MouseEventInputSource::UserDriven };
    // Wie in WebKit2: Faengt die Seite das contextmenu-Event nicht ab, baut der
    // ContextMenuController von WebCore ein Menue. Nur dann zeigen wir unseres.
    auto& controller = m_page->contextMenuController();
    controller.clearContextMenu();
    frame->eventHandler().sendContextMenuEvent(event);
    bool show = controller.contextMenu();
    debugLog("Kontextmenue bei %.0f,%.0f: %s", x, y, show ? "zeigen" : "die Seite hat ein eigenes");
    if (!show)
        return;
    auto result = controller.hitTestResult();
    controller.clearContextMenu();
    String selection;
    if (RefPtr focused = m_page->focusController().focusedOrMainFrame())
        selection = focused->editor().selectedText();
    auto& backForward = m_page->backForward();
    notifyHost(m_id, "contextmenu", makeString("{\"x\":"_s, x, ",\"y\":"_s, y,
        ",\"link\":\""_s, jsonEscape(result.absoluteLinkURL().string()),
        "\",\"image\":\""_s, jsonEscape(result.absoluteImageURL().string()),
        "\",\"selection\":\""_s, jsonEscape(selection.left(200)),
        "\",\"editable\":"_s, result.isContentEditable() ? "true"_s : "false"_s,
        ",\"canGoBack\":"_s, backForward.canGoBackOrForward(-1) ? "true"_s : "false"_s,
        ",\"canGoForward\":"_s, backForward.canGoBackOrForward(1) ? "true"_s : "false"_s, '}'));
}

void WebView::executeCommand(const String& name)
{
    if (RefPtr frame = m_page->focusController().focusedOrMainFrame())
        frame->editor().command(name).execute();
}

void WebView::insertText(const String& text)
{
    RefPtr frame = m_page->focusController().focusedOrMainFrame();
    if (!frame || text.isEmpty())
        return;
    frame->editor().insertText(text, nullptr);
}

void WebView::openFileChooser(FileChooser& chooser)
{
    if (m_fileChooser)
        m_fileChooser->cancelFileChoosing();
    m_fileChooser = &chooser;
    auto& settings = chooser.settings();
    StringBuilder accept;
    for (auto& type : settings.acceptMIMETypes)
        accept.append(accept.isEmpty() ? ""_s : ","_s, type);
    for (auto& extension : settings.acceptFileExtensions)
        accept.append(accept.isEmpty() ? ""_s : ","_s, extension);
    notifyHost(m_id, "filechooser", makeString("{\"multiple\":"_s, settings.allowsMultipleFiles ? "true"_s : "false"_s,
        ",\"accept\":\""_s, jsonEscape(accept.toString()), "\"}"_s));
}

void WebView::chooseFiles(const Vector<String>& paths)
{
    RefPtr chooser = std::exchange(m_fileChooser, nullptr);
    if (!chooser)
        return;
    if (paths.isEmpty())
        chooser->cancelFileChoosing();
    else
        chooser->chooseFiles(paths);
}

void WebView::setFocused(bool focused)
{
    m_page->focusController().setActive(focused);
    m_page->focusController().setFocused(focused);
}

// Tab aus der Adressleiste in die Seite: erstes bzw. letztes Element fokussieren
void WebView::focusInitial(bool forward)
{
    setFocused(true);
    m_page->focusController().setInitialFocus(forward ? FocusDirection::Forward : FocusDirection::Backward, nullptr);
}

// Zoom wie Strg +/- in Chrome (Seite inkl. Bilder, Layout neu)
void WebView::setZoom(float factor)
{
    if (RefPtr frame = mainFrame())
        frame->setPageZoomFactor(factor);
}

// Suchen auf der Seite (Strg+F): alle Treffer markieren, zum naechsten springen,
// der Oberflaeche "Treffer x von y" melden
void WebView::find(const String& text, bool backwards, bool again)
{
    m_page->unmarkAllTextMatches();
    if (text.isEmpty()) {
        notifyHost(m_id, "find", "{\"matches\":0,\"index\":0}"_s);
        return;
    }
    constexpr unsigned maxMatches = 1000;
    FindOptions options { FindOption::CaseInsensitive, FindOption::WrapAround };
    if (backwards)
        options.add(FindOption::Backwards);
    if (!again)
        options.add(FindOption::StartInSelection);
    auto matches = m_page->findTextMatches(text, { FindOption::CaseInsensitive }, maxMatches, false);
    m_page->markAllMatchesForText(text, { FindOption::CaseInsensitive }, true, maxMatches);
    auto found = m_page->findString(text, options);
    unsigned index = 0;
    if (found.range) {
        for (size_t i = 0; i < matches.ranges.size(); i++) {
            if (matches.ranges[i] == *found.range) {
                index = i + 1;
                break;
            }
        }
    }
    notifyHost(m_id, "find", makeString("{\"matches\":"_s, matches.ranges.size(), ",\"index\":"_s, index, '}'));
}

void WebView::stopFind()
{
    m_page->unmarkAllTextMatches();
}

void WebView::notifyNavigationState()
{
    auto& backForward = m_page->backForward();
    notifyHost(m_id, "navigation", makeString("{\"url\":\""_s, jsonEscape(currentURL()), "\",\"canGoBack\":"_s, backForward.canGoBackOrForward(-1) ? "true"_s : "false"_s,
        ",\"canGoForward\":"_s, backForward.canGoBackOrForward(1) ? "true"_s : "false"_s, ",\"loading\":"_s, m_isLoading ? "true"_s : "false"_s, '}'));
}

void WebView::didStartLoading()
{
    debugLog("View %d: Laden beginnt", m_id);
    m_isLoading = true;
    notifyNavigationState();
}

void WebView::didCommitLoad()
{
    debugLog("View %d: Commit", m_id);
    notifyNavigationState();
}

void WebView::didFinishLoading()
{
    debugLog("View %d: fertig geladen", m_id);
    m_isLoading = false;
    notifyNavigationState();
    notifyHost(m_id, "load");
    loadFavicon();
}

void WebView::exitFullscreen()
{
#if ENABLE(FULLSCREEN_API)
    RefPtr frame = mainFrame();
    if (RefPtr document = frame ? frame->document() : nullptr)
        protect(document->fullscreen())->fullyExitFullscreen();
#endif
}

// Bestes Icon aus <link rel=icon> (am naechsten an 32 px, SVG passt immer),
// sonst /favicon.ico. Die Engine laedt es selber, die Oberflaeche hat kein Netz.
void WebView::loadFavicon()
{
    RefPtr frame = mainFrame();
    RefPtr document = frame ? frame->document() : nullptr;
    if (!document || !document->url().protocolIsInHTTPFamily())
        return;
    URL best;
    unsigned bestScore = std::numeric_limits<unsigned>::max();
    for (auto& icon : LinkIconCollector(*document).iconsOfTypes({ LinkIconType::Favicon })) {
        unsigned score = icon.mimeType == "image/svg+xml"_s || icon.url.path().endsWith(".svg"_s) ? 0
            : icon.size ? static_cast<unsigned>(std::abs(static_cast<int>(*icon.size) - 32)) + 1 : 20;
        if (score < bestScore) {
            bestScore = score;
            best = icon.url;
        }
    }
    if (best.isEmpty())
        best = URL(document->url(), "/favicon.ico"_s);
    if (best == m_faviconURL)
        return;
    m_faviconURL = best;
    loadIcon(m_id, best);
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
