#include "config.h"
#include "WebView.h"
#include "Choosers.h"
#include "DeviceClients.h"

#include "BackForwardList.h"
#include "Clients.h"
#include "EditorClient.h"
#include "Engine.h"
#include "EngineConfig.h"
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
#include "Preconnect.h"
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
#include <WebCore/CompositionUnderline.h>
#include <WebCore/DragController.h>
#include <WebCore/DragData.h>
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
#include <WebCore/RenderObjectInlines.h>
#include <WebCore/RenderView.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/ResourceResponse.h>
#include <WebCore/ScrollingCoordinatorTypes.h>
#include <WebCore/Settings.h>
#include <WebCore/StyleComputedStyle+GettersInlines.h>
#include <WebCore/SharedBuffer.h>
#include <WebCore/StorageNamespaceProvider.h>
#include <WebCore/StorageSessionProvider.h>
#include <WebCore/SubstituteData.h>
#include <WebCore/WindowEventLoop.h>
#include <pal/SessionID.h>
#include <optional>
#include <skia/core/SkCanvas.h>
#include <skia/core/SkImage.h>
#include <skia/core/SkPaint.h>
#include <skia/core/SkSurface.h>
#include <wtf/HashMap.h>
#include <wtf/JSONValues.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/SetForScope.h>
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

// Open views. The host opens and closes them, popups (window.open,
// target=_blank) are opened by the engine itself.
static HashMap<int, Ref<WebView>>& openViews()
{
    static NeverDestroyed<HashMap<int, Ref<WebView>>> views;
    return views;
}

static OptionSet<WebView::Preference> currentPreferences;

OptionSet<WebView::Preference> WebView::preferences()
{
    return currentPreferences;
}

static void applyPreferences(Settings& settings)
{
    bool script = !currentPreferences.contains(WebView::Preference::NoJavaScript);
    settings.setScriptEnabled(script);
    // Otherwise a registered service worker intercepts navigations and runs its script.
    // Applies from the next navigation on (DocumentLoader::startLoadingMainResource)
    settings.setServiceWorkersEnabled(script);
    settings.setLoadsImagesAutomatically(!currentPreferences.contains(WebView::Preference::NoImages));
    settings.setGlobalPrivacyControlEnabled(currentPreferences.contains(WebView::Preference::GlobalPrivacyControl));
}

void WebView::setPreferences(OptionSet<Preference> preferences)
{
    currentPreferences = preferences;
    forEach([](WebView& view) { applyPreferences(view.page().settings()); });
}

WebView& WebView::open(int id, IntSize size, float deviceScaleFactor)
{
    Ref view = create(id, size, deviceScaleFactor);
    auto& result = view.get();
    openViews().set(id, WTF::move(view));
    // The host often sends the canvas before the view exists here
    if (hasWorkerCanvas(id))
        result.canvasAttached();
    return result;
}

WebView& WebView::openFromEngine(int openerId, IntSize size, float deviceScaleFactor)
{
    static int nextID = 1 << 20;
    int id = nextID++;
    auto& view = open(id, size, deviceScaleFactor);
    notifyHost(id, "new-view", makeString("{\"opener\":"_s, openerId, '}'));
    return view;
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
    debugLog("View %d: create", id);

    auto configuration = pageConfigurationWithEmptyClients(PageIdentifier::generate(), PAL::SessionID::defaultSessionID());
    configuration.chromeClient = makeUniqueRef<ChromeClient>(*this);
    configuration.editorClient = makeUniqueRef<EditorClient>(m_id);
    configuration.dragClient = makeUnique<DragClient>(*this);
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

    // The empty configuration is meant for SVG images: everything sandboxed, no
    // script. For real pages: without sandbox and with our FrameLoaderClient.
    if (auto* parameters = std::get_if<PageConfiguration::LocalMainFrameCreationParameters>(&configuration.mainFrameCreationParameters)) {
        parameters->effectiveSandboxFlags = { };
        parameters->clientCreator = [this](auto&, auto& frameLoader) -> UniqueRef<LocalFrameLoaderClient> {
            return makeUniqueRefWithoutRefCountedCheck<FrameLoaderClient>(frameLoader, *this);
        };
    }

    m_page = Page::create(WTF::move(configuration));
    debugLog("View %d: page created", id);
    // Report the first visible layout (host, measurements in tests/core)
    m_page->addLayoutMilestones({ LayoutMilestone::DidFirstVisuallyNonEmptyLayout });
    attachDeviceClients(*this, *m_page);
#if ENABLE(MEDIA_STREAM)
    // getUserMedia/getDisplayMedia through camera and screen of the host
    MediaStreams::attachTo(m_id, *m_page);
#endif
    m_page->setUseColorAppearance(WasmPlatform::screenInfo().prefersDarkMode, false);

    auto& settings = m_page->settings();
    auto& config = engineConfig();
    // Compositing with layers when the GPU works (BL_COMPOSITING=0 turns it off)
    if (config.compositing && LayerTreeHostWasm::isAvailable()) {
        // Damage tracking like WPE (LayerTreeHostWasm reads it). The damage stays
        // in rectangles: unified into one box (WPE) it serves the platform, here
        // nothing but the compositor reads it.
        settings.setPropagateDamagingInformation(true);
        settings.setUseDamagingInformationForCompositing(true);
        m_layerTreeHost = makeUnique<LayerTreeHostWasm>(*this);
        m_compositing = true;
    }
    settings.setAcceleratedCompositingEnabled(m_compositing);
    settings.setForceCompositingMode(m_compositing);
    settings.setAcceleratedCompositingForFixedPositionEnabled(m_compositing);
#if ENABLE(ASYNC_SCROLLING) && ENABLE(SCROLLING_THREAD)
    // Scrolling in its own thread (ScrollingWasm.h), needs the layers.
    // BL_ASYNC_SCROLLING=0 turns it off.
    bool useAsyncScrolling = m_compositing && config.asyncScrolling;
    settings.setScrollingCoordinatorEnabled(useAsyncScrolling);
    settings.setAsyncFrameScrollingEnabled(useAsyncScrolling);
    settings.setAsyncOverflowScrollingEnabled(useAsyncScrolling);
#endif
    // Large images decode on the shared decoder thread (patch 0024, #241)
    settings.setLargeImageAsyncDecodingEnabled(config.asyncImageDecoding);
    settings.setAnimatedImageAsyncDecodingEnabled(config.asyncImageDecoding);
    settings.setLocalStorageEnabled(true);
    settings.setSessionStorageEnabled(true);
    settings.setRequestIdleCallbackEnabled(true);
    // <link rel=preconnect> (Preconnect.cpp)
    settings.setLinkPreconnectEnabled(true);
    // Without the audio feature there is no AudioContext, like a browser without Web Audio
    settings.setWebAudioEnabled(featureEnabled(Feature::Audio));
#if ENABLE(WEBGL)
    settings.setWebGLEnabled(true);
#endif
#if ENABLE(FULLSCREEN_API)
    settings.setFullScreenEnabled(true);
#endif
#if ENABLE(MEDIA_SOURCE)
    settings.setMediaSourceEnabled(featureEnabled(Feature::Media));
    // ManagedMediaSource needs hints from the system (startstreaming) we do not
    // have. hls.js and co. would take MMS and wait forever.
    settings.setManagedMediaSourceEnabled(false);
#endif
    // Features WebKit browsers (WPE/GTK/Safari) turn on, but that are off for
    // WebCore alone (UnifiedWebPreferences.yaml, default "WebCore")
    settings.setCompressionStreamEnabled(true);
    settings.setNavigationAPIEnabled(true);
    // Done in WebKit, only the defaults for WebCore alone are off (yardstick
    // tests/fixtures/features.html)
    settings.setCanvasFiltersEnabled(true);
    settings.setMoveBeforeEnabled(true);
    settings.setSelectShowPickerEnabled(true);
    settings.setCSSScrollbarColorEnabled(true);
    // Paint worklet: loading the script comes from patch 0034
    settings.setCSSPaintingAPIEnabled(true);
    settings.setStorageAPIEnabled(true);
    settings.setCacheAPIEnabled(true);
    ServiceWorkers::enableIn(settings);
    WebCodecs::enableIn(settings);
#if ENABLE(MEDIA_STREAM)
    MediaStreams::enableIn(settings);
#endif
    settings.setSpeechRecognitionEnabled(featureEnabled(Feature::Speech));
    settings.setSpeechSynthesisAPIEnabled(featureEnabled(Feature::Speech));
    // Origin private file system (FileSystemStorageWasm.cpp)
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
    settings.setAsyncClipboardAPIEnabled(featureEnabled(Feature::Clipboard));
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
    // Need the feature switches in OptionsWasm.cmake
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
    // Last, overrides ServiceWorkers::enableIn
    applyPreferences(settings);

    m_page->setDeviceScaleFactor(m_deviceScaleFactor);
    debugLog("View %d: settings applied", id);

    RefPtr frame = m_page->localMainFrame();
    RELEASE_ASSERT(frame);
    frame->setView(LocalFrameView::create(*frame, m_size));
    frame->init();
    debugLog("View %d: frame ready", id);
    if (RefPtr view = frame->view()) {
        view->resize(m_size);
        view->setCanHaveScrollbars(true);
    }

    createSurface();
    setFocused(true);
    addDamage(IntRect { { }, m_size });
    debugLog("View %d: done", id);
}

WebView::~WebView()
{
    viewsByID().remove(m_id);
    forgetWorkerCanvas(m_id);
    if (m_page) {
        if (RefPtr frame = m_page->localMainFrame())
            frame->loader().detachFromParent();
    }
    // The layers belong to the page, so tear down the compositor only afterwards
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

// With a canvas in the engine worker and WebGL 2 Skia paints on the GPU
// (GpuRaster.h). The surface is new and empty, so repaint everything.
void WebView::createGpuSurfaceIfPossible()
{
    // With the compositor thread the engine worker has no canvas and no GPU
    if (m_gpuSurface || !m_canvasAttached || m_pixelSize.isEmpty() || Compositor::isRunning())
        return;
    Gpu::Scope scope;
    if (!scope)
        return;
    m_gpuSurface = Gpu::createSurface(m_pixelSize.width(), m_pixelSize.height());
    if (m_gpuSurface)
        addDamage(IntRect { { }, m_size });
}

// Back to the CPU (GPU lost): the pixel buffer is stale, repaint everything
void WebView::dropGpuSurface()
{
    if (!m_gpuSurface)
        return;
    m_gpuSurface = nullptr;
    stopCompositing();
    m_pendingScrolls.clear();
    addDamage(IntRect { { }, m_size });
}

bool WebView::gpuRestored()
{
    createGpuSurfaceIfPossible();
    return !!m_gpuSurface;
}

void WebView::loadURL(const String& urlString)
{
    RefPtr frame = mainFrame();
    if (!frame)
        return;
    URL url { urlString };
    if (!url.isValid()) {
        // Without a scheme: https:// in front like in every browser
        url = URL { makeString("https://"_s, urlString) };
    }
    // Input in the address bar: like in other browsers this may also be a
    // data: URL (pages themselves may not navigate there)
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
    // With compositing the layers paint themselves (setNeedsDisplay)
    if (m_compositing)
        return;
    IntRect clipped = intersection(rect, IntRect { { }, m_size });
    if (clipped.isEmpty())
        return;
    m_damage.unite(Region { clipped });
    requestFrame();
}

void WebView::scrollDamage(const IntSize& delta, const IntRect& rectToScroll, const IntRect& clipRect)
{
    if (m_compositing)
        return;
    IntRect area = intersection(intersection(rectToScroll, clipRect), IntRect { { }, m_size });
    if (area.isEmpty())
        return;
    // Only whole device pixels can be moved, otherwise repaint
    float deviceX = delta.width() * m_deviceScaleFactor;
    float deviceY = delta.height() * m_deviceScaleFactor;
    if (deviceX != std::round(deviceX) || deviceY != std::round(deviceY) || std::abs(delta.width()) >= area.width() || std::abs(delta.height()) >= area.height()) {
        addDamage(area);
        return;
    }

    // What still needs repainting moves with the content
    Region moved = intersect(m_damage, Region { area });
    m_damage.subtract(area);
    moved.translate(delta);
    moved.intersect(Region { area });
    m_damage.unite(moved);

    m_pendingScrolls.append({ delta, area });

    // The freed strip needs repainting
    IntRect kept = intersection(area, IntRect { area.location() + delta, area.size() });
    Region exposed { area };
    exposed.subtract(kept);
    for (auto& rect : exposed.rects())
        addDamage(rect);
    requestFrame();
}

// Moves the pixels in the buffer (device pixels). presented gets the area the
// host has to copy again.
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
            // On the GPU: take the area as an image and put it back moved
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
        // When moving down copy from the bottom, otherwise we overwrite the source
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

void WebView::requestFrame()
{
    if (std::exchange(m_frameRequested, true) || !m_visible)
        return;
    requestFrameFromHost(m_id);
}

void WebView::scheduleRenderingUpdate()
{
    m_renderingUpdateRequested = true;
    requestFrame();
}

void WebView::requestComposite()
{
    requestFrame();
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

// Back to painting without layers (GPU lost). WebCore tears down the layers,
// the compositor stays until the end of the view (the layers point to it).
void WebView::stopCompositing()
{
    if (!m_compositing)
        return;
    debugLog("View %d: compositing off", m_id);
    m_compositing = false;
    if (m_layerTreeHost)
        m_layerTreeHost->detachScene();
    auto& settings = m_page->settings();
    settings.setForceCompositingMode(false);
    settings.setAcceleratedCompositingEnabled(false);
    settings.setAcceleratedCompositingForFixedPositionEnabled(false);
#if ENABLE(ASYNC_SCROLLING) && ENABLE(SCROLLING_THREAD)
    // Without layers the engine thread scrolls again
    settings.setAsyncFrameScrollingEnabled(false);
    settings.setAsyncOverflowScrollingEnabled(false);
    Scrolling::stopForView(m_id);
#endif
    // Otherwise the setting only takes effect with the next real change to
    // style or layout: end compositing in all frames right away
    for (RefPtr<Frame> frame = m_page->mainFrame(); frame; frame = frame->tree().traverseNext()) {
        RefPtr localFrame = dynamicDowncast<LocalFrame>(*frame);
        if (CheckedPtr renderView = localFrame ? localFrame->contentRenderer() : nullptr) {
            auto& compositor = renderView->compositor();
            compositor.willRecalcStyle(); // reads the settings again
            // Tear down the layer backings, otherwise WebCore does not paint their content itself
            compositor.clearBackingForAllLayers();
            compositor.enableCompositingMode(false);
        }
    }
    m_page->setNeedsRecalcStyleInAllFrames();
    m_repaintAfterCompositingStopped = true;
    addDamage(IntRect { { }, m_size });
    scheduleRenderingUpdate();
}

// Like WebKit2 (LayerTreeHost::updateRendering): rendering update and the
// layer state to the compositor thread. It shows the frame itself and reports
// back with didComposite(); only then the next rendering update comes.
bool WebView::renderCompositedFrame(IntRect*)
{
    auto& host = *m_layerTreeHost;
    if (std::exchange(m_needsFullPresent, false))
        host.forceRepaint();
    if (!m_renderingUpdateRequested)
        return false;
    if (host.isWaitingForCompositor()) {
        // The frame comes before the compositor showed the last one (engine
        // busy): didComposite catches up instead of waiting for a new one
        m_compositedFrameMissed = true;
        return false;
    }
    auto start = MonotonicTime::now();
    m_renderingUpdateRequested = false;
    {
        SetForScope inRenderingUpdate(m_inRenderingUpdate, true);
        m_page->updateRendering();
        m_page->finalizeRenderingUpdate({ FinalizeRenderingUpdateFlags::ApplyScrollingTreeLayerPositions });
    }
    bool firstPaint = m_firstPaint == FirstPaint::WaitingForUpdate;
    if (firstPaint)
        debugLog("View %d: first paint goes to the compositor", m_id);
    host.flush(firstPaint);
    if (firstPaint && host.isWaitingForCompositor())
        m_firstPaint = FirstPaint::None;
    // Nothing to show: the frame is "done" anyway
    if (!host.isWaitingForCompositor())
        didComposite();
    auto milliseconds = (MonotonicTime::now() - start).milliseconds();
    if (milliseconds > 30)
        debugLog("View %d: rendering update %.0f ms", m_id, milliseconds);
    return false;
}

void WebView::didComposite()
{
    if (m_layerTreeHost)
        m_layerTreeHost->didComposite();
    m_page->didCompleteRenderingUpdateDisplay();
    m_page->didCompleteRenderingFrame();
    if (std::exchange(m_compositedFrameMissed, false))
        presentIfNeeded();
    else if (m_renderingUpdateRequested)
        requestComposite();
}

// The compositor thread lost its GPU: keep painting without layers
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
        // requestAnimationFrame callbacks, animations, style, layout, ...
        m_page->updateRendering();
        m_page->finalizeRenderingUpdate({ });
        // After stopCompositing: as long as WebCore still has layers it does
        // not paint the content itself. Once they are gone, repaint everything.
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

    // On the GPU Skia creates textures (images) already while painting: the
    // own GL context has to be current the whole time
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
    if (m_firstPaint == FirstPaint::WaitingForUpdate) {
        m_firstPaint = FirstPaint::None;
        firstPaintShown(m_id);
    }

    auto end = MonotonicTime::now();
    if ((end - start).milliseconds() > 30)
        debugLog("View %d: frame %.0f ms (layout %.0f ms, paint %.0f ms)", m_id, (end - start).milliseconds(), (layoutDone - start).milliseconds(), (end - layoutDone).milliseconds());

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
    // Hidden we do not paint, not even for a frame the host still sends from
    // before: setVisible(true) catches up
    if (!m_visible) {
        m_frameRequested = true;
        return;
    }
    if (m_frameInFlight) {
        // The host still paints the last frame. As soon as it is done,
        // bl_frame_presented arrives and we are called again.
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
                debugLog("View %d: GPU submit %.0f ms", m_id, milliseconds);
            return;
        }
        // Did not work (context gone): from now on on the CPU, everything in the next frame
        log("View %d: frame not brought to the GPU, painting on the CPU", m_id);
        dropGpuSurface();
        return;
    }
    // With the compositor thread its worker also shows the frames without
    // layers; until it is done the pixel buffer must not change
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
    requestFrame();
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
// movementX/Y come from the host (with pointer lock the only movement)
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

    // While the page drags something the mouse belongs to the drag (like a
    // system drag in Chrome: no mousemove/mouseup to the page)
    if (m_drag && m_drag->fromPage) {
        IntPoint point { static_cast<int>(x), static_cast<int>(y) };
        if (eventType == PlatformEvent::Type::MouseReleased)
            endDrag(point, true, modifiers);
        else if (eventType == PlatformEvent::Type::MouseMoved && mouseButton == MouseButton::None)
            endDrag(point, false, modifiers); // button released outside of the canvas
        else if (eventType == PlatformEvent::Type::MouseMoved)
            updateDrag(point, modifiers);
        return;
    }

    DoublePoint position { x, y };
    MouseEventWasm event { position, mouseButton, eventType, clickCount, modifiersFromBits(modifiers), { movementX, movementY } };

    auto& handler = frame->eventHandler();
    switch (eventType) {
    case PlatformEvent::Type::MousePressed:
        // The click comes with the release, about 0.1 s later: the connection starts now
        if (mouseButton == MouseButton::Left && !m_hoveredLink.isEmpty())
            preconnect(URL { m_hoveredLink });
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

// ------------------------------------------------------------ Drag and drop

void WebView::startPageDrag(Ref<WasmPlatform::DragContent>&& content, OptionSet<DragOperation> sourceOperations)
{
    cancelDrag();
    m_drag = DragSession { WTF::move(content), true, sourceOperations, std::nullopt };
}

void WebView::updateDrag(IntPoint point, int modifiers)
{
    RefPtr frame = mainFrame();
    if (!frame || !m_drag)
        return;
    OptionSet<DragApplicationFlags> flags;
    if (m_drag->fromPage)
        flags.add(DragApplicationFlags::IsSource);
    if (modifiers & 2)
        flags.add(DragApplicationFlags::IsCopyKeyDown);
    // Without "Load": files or links from the host do not open the file
    // instead of the page
    DragData dragData { m_drag->content.ptr(), point, point, m_drag->sourceOperations, flags, { DragDestinationAction::DHTML, DragDestinationAction::Edit }, m_page->identifier() };
    m_drag->lastPoint = point;
    auto result = m_page->dragController().dragEnteredOrUpdated(*frame, WTF::move(dragData));
    if (m_drag) {
        auto* operation = std::get_if<std::optional<DragOperation>>(&result);
        m_drag->operation = operation ? *operation : std::nullopt;
    }
}

void WebView::endDrag(IntPoint point, bool drop, int modifiers)
{
    RefPtr frame = mainFrame();
    if (!frame || !m_drag)
        return;
    auto session = WTF::move(*m_drag);
    m_drag.reset();
    OptionSet<DragApplicationFlags> flags;
    if (session.fromPage)
        flags.add(DragApplicationFlags::IsSource);
    if (modifiers & 2)
        flags.add(DragApplicationFlags::IsCopyKeyDown);
    DragData dragData { session.content.ptr(), point, point, session.sourceOperations, flags, { DragDestinationAction::DHTML, DragDestinationAction::Edit }, m_page->identifier() };
    bool dropped = drop && session.operation;
    if (dropped)
        m_page->dragController().performDragOperation(WTF::move(dragData), *frame);
    else
        m_page->dragController().dragExited(*frame, WTF::move(dragData));
    m_page->dragController().dragEnded();
    if (session.fromPage) {
        // dragend to the source, with the result (dropEffect)
        MouseEventWasm event { DoublePoint { static_cast<double>(point.x()), static_cast<double>(point.y()) }, MouseButton::Left, PlatformEvent::Type::MouseMoved, 0, modifiersFromBits(modifiers), { } };
        frame->eventHandler().dragSourceEndedAt(event, dropped ? OptionSet<DragOperation> { *session.operation } : OptionSet<DragOperation> { });
    }
}

void WebView::cancelDrag()
{
    if (m_drag)
        endDrag({ }, false, 0);
}

// Dragging from the host: data = {"text":..,"html":..,"uriList":..,"files":[paths],"fileCount":n}.
// While dragging over the page the host only knows the types and the number of
// files (as Chrome also shows them to the page), on drop everything.
void WebView::hostDrag(int phase, double x, double y, int modifiers, const String& data)
{
    IntPoint point { static_cast<int>(x), static_cast<int>(y) };
    if (m_drag && m_drag->fromPage)
        return;
    if (phase == 1) {
        if (m_drag)
            endDrag(point, false, modifiers);
        return;
    }
    auto content = WasmPlatform::DragContent::create();
    auto value = JSON::Value::parseJSON(data);
    if (auto object = value ? value->asObject() : nullptr) {
        for (auto type : { "text/plain"_s, "text/html"_s, "text/uri-list"_s }) {
            auto key = type == "text/plain"_s ? "text"_s : type == "text/html"_s ? "html"_s : "uriList"_s;
            auto string = object->getString(key);
            if (!string.isNull())
                content->setString(type, string);
        }
        if (auto files = object->getArray("files"_s)) {
            for (auto& file : *files)
                content->files.append(file->asString());
        }
        content->fileCount = std::max<unsigned>(object->getInteger("fileCount"_s).value_or(0), content->files.size());
    }
    if (!m_drag)
        m_drag = DragSession { WTF::move(content), false, { DragOperation::Copy, DragOperation::Link, DragOperation::Generic }, std::nullopt };
    else
        m_drag->content = WTF::move(content);
    updateDrag(point, modifiers);
    if (phase == 2)
        endDrag(point, true, modifiers);
}

PlatformWheelEvent WebView::makeWheelEvent(double x, double y, double deltaX, double deltaY, int modifiers)
{
    IntPoint position { static_cast<int>(x), static_cast<int>(y) };
    // DOM: deltaY > 0 means scroll down. WebCore: inverted sign.
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

void WebView::zoomWheelEvent(const PlatformWheelEvent& event, bool cancelable)
{
    bool consumed = false;
    if (RefPtr frame = mainFrame()) {
        auto handling = frame->eventHandler().handleWheelEvent(event, { cancelable ? WheelEventProcessingSteps::BlockingDOMEventDispatch : WheelEventProcessingSteps::NonBlockingDOMEventDispatch }).second;
        consumed = handling.contains(EventHandling::DefaultPrevented);
    }
    if (cancelable)
        notifyHost(m_id, "wheel-result", consumed ? "{\"consumed\":true}"_s : "{\"consumed\":false}"_s);
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
// PlatformTouchEvent/-Point only have protected fields, the ports fill them themselves
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

// CSS touch-action at the point: may two fingers zoom the view?
bool touchActionAllowsPinchZoom(LocalFrame& frame, DoublePoint point)
{
    RefPtr view = frame.view();
    if (!view)
        return true;
    auto result = frame.eventHandler().hitTestResultAtPoint(LayoutPoint(view->windowToContents(flooredIntPoint(point))), { HitTestRequest::Type::ReadOnly, HitTestRequest::Type::AllowChildFrameContent });
    RefPtr node = result.innerNode();
    CheckedPtr renderer = node ? node->renderer() : nullptr;
    if (!renderer)
        return true;
    auto touchAction = renderer->style().usedTouchAction();
    if (touchAction.isAuto() || touchAction.isManipulation())
        return true;
    auto values = touchAction.tryEnumSet();
    return values && values->contains(Style::TouchActionValue::PinchZoom);
}
}
#endif

// Touch (Chromebooks): type 0 start, 1 move, 2 end, 3 cancel. Points as JSON
// [{id, x, y, state, rx, ry, force}], state like PlatformTouchPoint::State.
// The host learns whether the page handled the event (then no scrolling and no
// click from it) and on start whether touch-action at the new points allows
// pinch zoom.
void WebView::touchEvent(int type, const String& json, int modifiers)
{
#if ENABLE(TOUCH_EVENTS)
    RefPtr frame = mainFrame();
    auto value = JSON::Value::parseJSON(json);
    auto array = value ? value->asArray() : nullptr;
    if (!frame || !array)
        return;
    Vector<PlatformTouchPoint> points;
    bool pinchAllowed = true;
    for (auto& item : *array) {
        auto point = item->asObject();
        if (!point)
            continue;
        auto state = static_cast<PlatformTouchPoint::State>(std::clamp(point->getInteger("state"_s).value_or(0), 0, 4));
        DoublePoint position { point->getDouble("x"_s).value_or(0), point->getDouble("y"_s).value_or(0) };
        if (state == PlatformTouchPoint::State::TouchPressed)
            pinchAllowed = pinchAllowed && touchActionAllowsPinchZoom(*frame, position);
        points.append(TouchPointWasm(point->getInteger("id"_s).value_or(0), state, position,
            { point->getDouble("rx"_s).value_or(1), point->getDouble("ry"_s).value_or(1) },
            static_cast<float>(point->getDouble("force"_s).value_or(0))));
    }
    static constexpr PlatformEvent::Type types[] = { PlatformEvent::Type::TouchStart, PlatformEvent::Type::TouchMove, PlatformEvent::Type::TouchEnd, PlatformEvent::Type::TouchCancel };
    TouchEventWasm event { types[std::clamp(type, 0, 3)], WTF::move(points), modifiersFromBits(modifiers) };
    auto result = frame->eventHandler().handleTouchEvent(event);
    bool consumed = result && *result;
    notifyHost(m_id, "touch-result", makeString("{\"type\":"_s, type, ",\"consumed\":"_s, consumed ? "true"_s : "false"_s,
        ",\"pinch\":"_s, pinchAllowed ? "true"_s : "false"_s, '}'));
#else
    UNUSED_PARAM(type);
    UNUSED_PARAM(json);
    UNUSED_PARAM(modifiers);
#endif
}

#if ENABLE(POINTER_LOCK)
// Pointer lock (games, 3D): the host calls requestPointerLock() on the canvas
void WebView::requestPointerLock(CompletionHandler<void(PointerLockRequestResult)>&& completionHandler)
{
    if (auto previous = std::exchange(m_pointerLockHandler, WTF::move(completionHandler)))
        previous(PointerLockRequestResult::Failure);
    notifyHost(m_id, "pointer-lock", "{\"on\":true}"_s);
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
    notifyHost(m_id, "pointer-lock", "{\"on\":false}"_s);
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
    return key; // Enter, Home, End, PageUp, PageDown, F1, ... have the same names
}

bool WebView::keyEvent(int type, const String& key, const String& code, const String& text, int keyCode, bool repeat, int modifiers)
{
    // Escape cancels a drag from the page (like in Chrome, dragend with dropEffect "none")
    if (m_drag && m_drag->fromPage && key == "Escape"_s) {
        if (!type)
            endDrag(m_drag->lastPoint, false, modifiers);
        return true;
    }
    RefPtr frame = m_page->focusController().focusedOrMainFrame();
    if (!frame)
        return false;
    bool isKeypad = code.startsWith("Numpad"_s);
    auto platformType = type == 0 ? PlatformEvent::Type::KeyDown : PlatformEvent::Type::KeyUp;
    PlatformKeyboardEvent event { platformType, text, text, key, code, keyIdentifierForKey(key), keyCode, repeat, isKeypad, false, modifiersFromBits(modifiers), MonotonicTime::now() };
    return frame->eventHandler().keyEvent(event);
}

void WebView::contextMenu(double x, double y)
{
    RefPtr frame = mainFrame();
    RefPtr view = mainFrameView();
    if (!frame || !view)
        return;
    DoublePoint position { x, y };
    PlatformMouseEvent event { position, position, MouseButton::Right, PlatformEvent::Type::MousePressed, 1, { }, MonotonicTime::now(), 0, SyntheticClickType::NoTap, MouseEventInputSource::UserDriven };
    // Like in WebKit2: if the page does not handle the contextmenu event,
    // WebCore's ContextMenuController builds a menu. Only then we show ours.
    auto& controller = m_page->contextMenuController();
    controller.clearContextMenu();
    frame->eventHandler().sendContextMenuEvent(event);
    bool show = controller.contextMenu();
    debugLog("Context menu at %.0f,%.0f: %s", x, y, show ? "show" : "the page has its own");
    if (!show)
        return;
    auto result = controller.hitTestResult();
    controller.clearContextMenu();
    String selection;
    if (RefPtr focused = m_page->focusController().focusedOrMainFrame())
        selection = focused->editor().selectedText();
    auto& backForward = m_page->backForward();
    notifyHost(m_id, "context-menu", makeString("{\"x\":"_s, x, ",\"y\":"_s, y,
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

// Finished text from the host's text input (IME, dead keys, on-screen keyboard)
void WebView::insertText(const String& text)
{
    RefPtr frame = m_page->focusController().focusedOrMainFrame();
    if (!frame || text.isEmpty())
        return;
    frame->editor().insertText(text, nullptr);
}

void WebView::setComposition(const String& text, unsigned selectionStart, unsigned selectionEnd)
{
    RefPtr frame = m_page->focusController().focusedOrMainFrame();
    if (!frame)
        return;
    Ref editor = frame->editor();
    if (text.isEmpty()) {
        if (editor->hasComposition())
            editor->cancelComposition();
        return;
    }
    Vector<CompositionUnderline> underlines { CompositionUnderline(0, text.length(), CompositionUnderlineColor::TextColor, Color::black, false) };
    editor->setComposition(text, underlines, { }, { }, std::min<unsigned>(selectionStart, text.length()), std::min<unsigned>(selectionEnd, text.length()));
}

void WebView::confirmComposition(const String& text)
{
    RefPtr frame = m_page->focusController().focusedOrMainFrame();
    if (!frame)
        return;
    Ref editor = frame->editor();
    if (editor->hasComposition()) {
        if (text.isEmpty())
            editor->cancelComposition();
        else
            editor->confirmComposition(text);
    } else if (!text.isEmpty())
        editor->insertText(text, nullptr);
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
    notifyHost(m_id, "file-chooser", makeString("{\"multiple\":"_s, settings.allowsMultipleFiles ? "true"_s : "false"_s,
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

// Like WebKit2 for a hidden page (DrawingArea::visibilityDidChange): WebCore
// pauses rAF and CSS animations, throttles timers
// (HiddenPageDOMTimerThrottling) and fires visibilitychange; we do not paint
// anymore, the compositor neither. The last frame stays in the canvas.
void WebView::setVisible(bool visible)
{
    if (visible == m_visible)
        return;
    m_visible = visible;
    updateActivityState();
    if (m_layerTreeHost)
        m_layerTreeHost->setVisible(visible);
    if (visible && m_frameRequested)
        requestFrameFromHost(m_id);
}

void WebView::setAudible(bool audible)
{
    m_audible = audible;
    updateActivityState();
}

void WebView::updateActivityState()
{
    // Also while tearing down the page still reports media
    if (!m_page)
        return;
    auto state = m_page->activityState();
    state.set({ ActivityState::IsVisible, ActivityState::IsVisibleOrOccluded }, m_visible);
    state.set(ActivityState::IsVisuallyIdle, !m_visible && !m_audible);
    state.set(ActivityState::IsAudible, m_audible);
    m_page->setActivityState(state);
}

// Tab from the address bar into the page: focus the first or last element
void WebView::focusInitial(bool forward)
{
    setFocused(true);
    m_page->focusController().setInitialFocus(forward ? FocusDirection::Forward : FocusDirection::Backward, nullptr);
}

// Zoom like Ctrl +/- in Chrome (page including images, new layout)
void WebView::setZoom(float factor)
{
    if (RefPtr frame = mainFrame())
        frame->setPageZoomFactor(factor);
}

PinchViewport WebView::pinchViewport() const
{
    PinchViewport viewport;
    viewport.scale = m_page->pageScaleFactor();
    if (RefPtr view = mainFrameView()) {
        viewport.scrollPosition = view->scrollPosition();
        viewport.visibleSize = view->sizeForVisibleContent();
        if (CheckedPtr renderView = view->renderView())
            viewport.documentRect = renderView->unscaledDocumentRect();
    }
    return viewport;
}

void WebView::setPageScale(float scale, FloatPoint scrollPosition, unsigned pinchCommit)
{
    m_page->setPageScaleFactor(scale, roundedIntPoint(scrollPosition));
    if (pinchCommit && m_layerTreeHost)
        m_layerTreeHost->didApplyPinch(pinchCommit);
    scheduleRenderingUpdate();
}

// Without the compositor every step scales the page right away
void WebView::pinch(PinchPhase phase, float factor, FloatPoint focus)
{
    switch (phase) {
    case PinchPhase::Begin:
        m_pinch.emplace(pinchViewport(), focus);
        return;
    case PinchPhase::Update:
        if (!m_pinch)
            return;
        m_pinch->update(factor, focus);
        break;
    case PinchPhase::Cancel:
        if (!m_pinch)
            return;
        m_pinch->cancel();
        break;
    case PinchPhase::End:
        m_pinch = std::nullopt;
        return;
    }
    setPageScale(m_pinch->target().scale, m_pinch->target().scrollPosition);
    if (phase == PinchPhase::Cancel)
        m_pinch = std::nullopt;
}

// Find on the page (Ctrl+F): mark all matches, jump to the next one, report
// "match x of y" to the host
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
    // History for the session (back/forward after a restart or discard)
    auto& list = static_cast<BackForwardList&>(backForward.client());
    StringBuilder history;
    history.append("{\"index\":"_s, list.currentIndex().value_or(0), ",\"entries\":["_s);
    bool first = true;
    for (auto& item : list.entries()) {
        history.append(first ? ""_s : ","_s, "{\"url\":\""_s, jsonEscape(item->urlString()), "\",\"title\":\""_s, jsonEscape(item->title()), "\"}"_s);
        first = false;
    }
    history.append("]}"_s);
    notifyHost(m_id, "navigation", makeString("{\"url\":\""_s, jsonEscape(currentURL()), "\",\"canGoBack\":"_s, backForward.canGoBackOrForward(-1) ? "true"_s : "false"_s,
        ",\"canGoForward\":"_s, backForward.canGoBackOrForward(1) ? "true"_s : "false"_s, ",\"loading\":"_s, m_isLoading ? "true"_s : "false"_s,
        ",\"history\":"_s, history.toString(), '}'));
}

void WebView::restoreHistory(const String& data)
{
    RefPtr frame = mainFrame();
    auto value = JSON::Value::parseJSON(data);
    auto object = value ? value->asObject() : nullptr;
    auto array = object ? object->getArray("entries"_s) : nullptr;
    if (!frame || !array || !array->length())
        return;
    Vector<Ref<HistoryItem>> items;
    for (auto& entry : *array) {
        auto item = entry->asObject();
        if (!item)
            continue;
        URL url { item->getString("url"_s) };
        // Only addresses one could also type
        if (!url.isValid() || !(url.protocolIsInHTTPFamily() || url.protocolIsFile() || url.protocolIsAbout()))
            continue;
        items.append(HistoryItem::create(m_page->historyItemClient(), url.string(), item->getString("title"_s)));
    }
    if (items.isEmpty())
        return;
    size_t index = std::min<size_t>(std::max(object->getInteger("index"_s).value_or(0), 0), items.size() - 1);
    Ref current = items[index];
    static_cast<BackForwardList&>(m_page->backForward().client()).restore(WTF::move(items), index);
    // Like back/forward: loads the entry without creating a new one
    m_page->goToItem(*frame, current, FrameLoadType::IndexedBackForward, ShouldTreatAsContinuingLoad::No);
}

void WebView::didStartLoading()
{
    debugLog("View %d: loading starts", m_id);
    m_isLoading = true;
    notifyNavigationState();
}

void WebView::didCommitLoad()
{
    debugLog("View %d: commit", m_id);
    m_firstPaint = FirstPaint::WaitingForLayout;
    // New page without pinch zoom (back/forward restores the remembered one)
    m_pinch = std::nullopt;
    if (m_page->pageScaleFactor() != 1)
        m_page->setPageScaleFactor(1, { });
    // Error page: the address bar shows no lock, with an invalid certificate "Not secure"
    RefPtr frame = mainFrame();
    RefPtr loader = frame ? frame->loader().documentLoader() : nullptr;
    if (loader && !loader->unreachableURL().isEmpty())
        notifyHost(m_id, "commit", m_errorPageCertificate ? "{\"errorPage\":\"certificate\"}"_s : "{\"errorPage\":\"network\"}"_s);
    else
        notifyHost(m_id, "commit");
    notifyNavigationState();
}

void WebView::didNavigateWithinPage()
{
    debugLog("View %d: address within the document", m_id);
    notifyNavigationState();
}

void WebView::didStopLoading()
{
    debugLog("View %d: loading cancelled", m_id);
    m_isLoading = false;
    notifyNavigationState();
}

void WebView::didFinishLoading()
{
    debugLog("View %d: finished loading", m_id);
    m_isLoading = false;
    notifyNavigationState();
    notifyHost(m_id, "load");
    loadFavicon();
}

void WebView::didReachLayoutMilestone(OptionSet<LayoutMilestone> milestones)
{
    if (!milestones.contains(LayoutMilestone::DidFirstVisuallyNonEmptyLayout))
        return;
    debugLog("View %d: first visible layout%s", m_id, m_inRenderingUpdate ? " (in a rendering update)" : "");
    notifyHost(m_id, "first-layout");
    if (m_firstPaint != FirstPaint::WaitingForLayout)
        return;
    m_firstPaint = FirstPaint::WaitingForUpdate;
    // A layout outside a rendering update (a script or the parser asked for it): show it before
    // the waiting tasks (parsing, scripts), which otherwise ran first while the frame of the host
    // waited behind them
    if (!m_inRenderingUpdate && engineConfig().firstPaintEarly) {
        scheduleRenderingUpdate();
        // Ends the current RunLoop cycle after this timer, like the rendering update of the Mac
        // and WPE ports: otherwise the parser yields for the paint, and its next chunk with a long
        // script still ran in the same cycle (YouTube: 1.9 s)
        WindowEventLoop::breakToAllowRenderingUpdate();
        runNextOnEngineThread([id = m_id] {
            if (auto* view = fromID(id))
                view->presentIfNeeded();
        });
    }
}

void WebView::firstPaintShown(int id)
{
    debugLog("View %d: first paint", id);
    notifyHost(id, "first-paint");
}

void WebView::exitFullscreen()
{
#if ENABLE(FULLSCREEN_API)
    RefPtr frame = mainFrame();
    if (RefPtr document = frame ? frame->document() : nullptr)
        protect(document->fullscreen())->fullyExitFullscreen();
#endif
}

// Best icon from <link rel=icon> (closest to 32 px, SVG always fits),
// otherwise /favicon.ico. The engine loads it itself, the host has no network.
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
    // With an address: on back/forward the title can come before the navigation message
    notifyHost(m_id, "title", makeString("{\"title\":\""_s, jsonEscape(title), "\",\"url\":\""_s, jsonEscape(currentURL()), "\"}"_s));
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
