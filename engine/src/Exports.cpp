// C interface for the host (JS on the main thread of the page). Every function
// may be called from any thread; the work happens asynchronously on the engine
// thread. The caller passes strings as UTF-8 (e.g. with stringToNewUTF8), the
// engine frees them with free().

#include "config.h"

#include "Choosers.h"
#include "Compositor.h"
#include "DeviceClients.h"
#include "Printing.h"
#include "Engine.h"
#include "EngineConfig.h"
#include "Gamepad.h"
#include "Host.h"
#include "HttpAuth.h"
#include "Preconnect.h"
#include "LayerTreeHostWasm.h"
#include "LazyFiles.h"
#include "MediaFetch.h"
#include "MediaPlayerPrivateWasm.h"
#include "MemoryVFS.h"
#include "ScrollingWasm.h"
#include "Speech.h"
#include "UserContent.h"
#include "WebPlatformExtras.h"
#include "LoaderStrategy.h"
#include "WebView.h"

#include <JavaScriptCore/DeferGCInlines.h>
#include <JavaScriptCore/JSCJSValueInlines.h>
#include <JavaScriptCore/HeapInlines.h>
#include <JavaScriptCore/HeapSnapshotBuilder.h>
#include <JavaScriptCore/JSLock.h>
#include <JavaScriptCore/MarkedVector.h>
#include <JavaScriptCore/Options.h>
#include <WebCore/ANGLEShimWasm.h>
#include <WebCore/MediaProducer.h>
#include <WebCore/Page.h>
#include <WebCore/CommonVM.h>
#include <WebCore/Document.h>
#include <WebCore/FrameDestructionObserverInlines.h>
#include <WebCore/FrameLoader.h>
#include <WebCore/MemoryCache.h>
#include <WebCore/MemoryRelease.h>
#include <WebCore/WasmPlatform.h>
#include <malloc.h>
#include <algorithm>
#include <wtf/HashSet.h>
#include <wtf/FileSystem.h>
#include <wtf/Language.h>
#include <wtf/text/MakeString.h>
#include <WebCore/DOMWrapperWorld.h>
#include <WebCore/JSDOMWindowBase.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/ScriptController.h>
#include <emscripten/emscripten.h>
#include <emscripten/heap.h>
#include <emscripten/stack.h>
#include <wtf/JSONValues.h>

using namespace BrowserLite;

static String takeString(char* utf8)
{
    if (!utf8)
        return { };
    String string = String::fromUTF8(utf8);
    free(utf8);
    return string;
}

// A command for a view. While a dialog of its page group is open (#258) it
// runs only afterwards, in order, like in Chrome where the page's thread waits.
template<typename Function>
static void withView(int id, Function&& function)
{
    runOnEngineThread([id, function = std::forward<Function>(function)]() mutable {
        if (auto* view = WebView::fromID(id))
            view->runWhenNotBlocked(WTF::move(function));
    });
}

// Input for a view: dropped while a dialog of its page group is open, like Chrome
template<typename Function>
static void withInput(int id, Function&& function)
{
    runOnEngineThread([id, function = std::forward<Function>(function)]() mutable {
        if (auto* view = WebView::fromID(id); view && !view->isBlockedByDialog())
            function(*view);
    });
}

extern "C" {

EMSCRIPTEN_KEEPALIVE void bl_create_view(int id, int width, int height, float deviceScaleFactor)
{
    runOnEngineThread([=] {
        WebView::open(id, { width, height }, deviceScaleFactor);
    });
}

EMSCRIPTEN_KEEPALIVE void bl_destroy_view(int id)
{
    runOnEngineThread([=] {
        WebView::close(id);
    });
}

EMSCRIPTEN_KEEPALIVE void bl_load_url(int id, char* url)
{
    withView(id, [url = takeString(url)](WebView& view) {
        debugLog("bl_load_url %s", url.utf8().data());
        view.loadURL(url);
    });
}

// An address the user is about to open (typed in the address bar): connects to its origin ahead
EMSCRIPTEN_KEEPALIVE void bl_preconnect(char* url)
{
    runOnEngineThread([url = takeString(url)] {
        preconnect(URL { url });
    });
}

EMSCRIPTEN_KEEPALIVE void bl_load_html(int id, char* html, char* baseURL)
{
    withView(id, [html = takeString(html), baseURL = takeString(baseURL)](WebView& view) {
        view.loadHTML(html, baseURL);
    });
}

EMSCRIPTEN_KEEPALIVE void bl_restore_history(int id, char* data)
{
    withView(id, [data = takeString(data)](WebView& view) { view.restoreHistory(data); });
}

EMSCRIPTEN_KEEPALIVE void bl_go_back(int id) { withView(id, [](WebView& view) { view.goBack(); }); }
EMSCRIPTEN_KEEPALIVE void bl_go_forward(int id) { withView(id, [](WebView& view) { view.goForward(); }); }
EMSCRIPTEN_KEEPALIVE void bl_reload(int id) { withView(id, [](WebView& view) { view.reload(); }); }
EMSCRIPTEN_KEEPALIVE void bl_stop(int id) { withView(id, [](WebView& view) { view.stop(); }); }

// Close a view: first the page's beforeunload (with a prompt), the answer
// arrives as the event "try-close"
EMSCRIPTEN_KEEPALIVE void bl_try_close(int id)
{
    runOnEngineThread([id] {
        RefPtr view = WebView::fromID(id);
        RefPtr frame = view ? view->mainFrame() : nullptr;
        // A page waiting in a dialog closes without asking, like in Chrome
        bool close = !frame || view->isBlockedByDialog() || frame->loader().shouldClose();
        notifyHost(id, "try-close", close ? "{\"close\":true}"_s : "{\"close\":false}"_s);
    });
}

EMSCRIPTEN_KEEPALIVE void bl_resize(int id, int width, int height, float deviceScaleFactor)
{
    withView(id, [=](WebView& view) { view.resize({ width, height }, deviceScaleFactor); });
}

// From the host once per requestAnimationFrame when the engine wanted a frame
EMSCRIPTEN_KEEPALIVE void bl_frame(int id)
{
    withView(id, [](WebView& view) { view.presentIfNeeded(); });
}

// Comes from the worker that receives the canvases (bl__presenter_thread)
EMSCRIPTEN_KEEPALIVE void bl__canvas_attached(int id)
{
    workerCanvasArrived(id);
    withView(id, [](WebView& view) { view.canvasAttached(); });
}

// pthread of the engine thread: engine-pre.js finds its worker with it
EMSCRIPTEN_KEEPALIVE int bl__engine_thread()
{
    return static_cast<int>(reinterpret_cast<uintptr_t>(engineThread()));
}

// pthread whose worker receives the canvases of the views: the compositor
// thread, otherwise the engine thread
EMSCRIPTEN_KEEPALIVE int bl__presenter_thread()
{
    return static_cast<int>(reinterpret_cast<uintptr_t>(Compositor::presenterThread()));
}

// Source of the current page (Ctrl+U): arrives like a download flagged viewSource
EMSCRIPTEN_KEEPALIVE void bl_view_source(int id)
{
    withView(id, [id](WebView& view) {
        URL url { view.currentURL() };
        if (url.protocolIsInHTTPFamily())
            startViewSource(id, url);
    });
}

EMSCRIPTEN_KEEPALIVE void bl_download_cancel(int id)
{
    runOnEngineThread([id] { cancelDownload(id); });
}

// Debugging: runs JS in the page (even if the page's CSP forbids javascript:
// URLs), the result is printed as text to the console. Only with BL_TEST_HOOKS=1.
EMSCRIPTEN_KEEPALIVE void bl_eval_script(int id, char* source)
{
    auto script = takeString(source);
    if (!engineConfig().testHooks)
        return;
    withView(id, [source = WTF::move(script), id](WebView& view) {
        RefPtr frame = view.mainFrame();
        if (!frame)
            return;
        auto result = frame->script().executeScriptIgnoringException(source, JSC::SourceTaintedOrigin::Untainted);
        String text = result ? result.toWTFString(frame->script().globalObject(WebCore::mainThreadNormalWorldSingleton())) : "(exception)"_s;
        RefPtr document = frame->document();
        printf("[eval %d] %s (painting allowed %d, render blocking %d, view transition %d)\n", id, text.utf8().data(),
            document && document->visualUpdatesAllowed(), document && document->isRenderBlocked(),
            document && document->renderingIsSuppressedForViewTransition());
    });
}

// The host copied the last frame, the pixel buffer may be painted again
EMSCRIPTEN_KEEPALIVE void bl_frame_presented(int id)
{
    withView(id, [](WebView& view) {
        view.framePresented();
        view.presentIfNeeded();
    });
}

EMSCRIPTEN_KEEPALIVE void bl_mouse(int id, int type, int button, double x, double y, int clickCount, int modifiers)
{
    withInput(id, [=](WebView& view) { view.mouseEvent(type, button, x, y, clickCount, modifiers); });
}

// Mouse move with movementX/Y (also with pointer lock). button: pressed
// button like in bl_mouse (-1 = none), otherwise there is no dragging/selecting
EMSCRIPTEN_KEEPALIVE void bl_mouse_move(int id, double x, double y, double movementX, double movementY, int button, int modifiers)
{
    withInput(id, [=](WebView& view) { view.mouseEvent(2, button, x, y, 0, modifiers, movementX, movementY); });
}

// Dragging from the host over the page: phase 0 = over, 1 = left, 2 = dropped.
// data: JSON with text/HTML/URI list and file paths (WebView::hostDrag)
EMSCRIPTEN_KEEPALIVE void bl_drag(int id, int phase, double x, double y, int modifiers, char* data)
{
    withInput(id, [=, json = takeString(data)](WebView& view) { view.hostDrag(phase, x, y, modifiers, json); });
}

EMSCRIPTEN_KEEPALIVE void bl_pointer_lock(int id, int locked)
{
#if ENABLE(POINTER_LOCK)
    withView(id, [=](WebView& view) { view.pointerLockResult(locked); });
#else
    UNUSED_PARAM(id);
    UNUSED_PARAM(locked);
#endif
}

EMSCRIPTEN_KEEPALIVE void bl_wheel(int id, double x, double y, double deltaX, double deltaY, double wheelDeltaX, double wheelDeltaY, int modifiers)
{
    // With the compositor thread: through it to the scrolling thread (ScrollingWasm.h),
    // so the page scrolls even when its JS blocks the engine thread
    if (Compositor::isRunning()) {
        // Pinch zoom the engine thread does not show yet: the wheel moves the
        // scaled view, the page only gets the event to observe (like a passive
        // wheel listener)
        RefPtr scene = CompositorScene::forView(id);
        if (scene && scene->scrollPinch({ static_cast<float>(deltaX), static_cast<float>(deltaY) })) {
            withInput(id, [=](WebView& view) {
                view.dispatchWheelEvent(WebView::makeWheelEvent(x, y, deltaX, deltaY, wheelDeltaX, wheelDeltaY, modifiers), { WebCore::WheelEventProcessingSteps::NonBlockingDOMEventDispatch });
            });
            return;
        }
        Compositor::dispatch([=] {
            Scrolling::wheelEvent(id, WebView::makeWheelEvent(x, y, deltaX, deltaY, wheelDeltaX, wheelDeltaY, modifiers));
        });
        return;
    }
    withInput(id, [=](WebView& view) { view.wheelEvent(x, y, deltaX, deltaY, wheelDeltaX, wheelDeltaY, modifiers); });
}

// Ctrl + wheel (zoom) goes to the page first like in Chrome (maps, editors
// zoom themselves). Return 1: the page may call preventDefault, the answer
// arrives as "wheel-result". 0: only sent for observing (no blocking listener
// at that point or not cancelable), the host zooms right away, even when JS
// blocks the engine thread.
EMSCRIPTEN_KEEPALIVE int bl_zoom_wheel(int id, double x, double y, double deltaX, double deltaY, double wheelDeltaX, double wheelDeltaY, int modifiers, int cancelable)
{
    auto event = WebView::makeWheelEvent(x, y, deltaX, deltaY, wheelDeltaX, wheelDeltaY, modifiers);
    bool blocking = cancelable && Scrolling::mayCancelWheelEvent(id, event);
    runOnEngineThread([id, event, blocking] {
        if (auto* view = WebView::fromID(id))
            view->zoomWheelEvent(event, blocking);
    });
    return blocking;
}

EMSCRIPTEN_KEEPALIVE void bl_key(int id, int type, char* key, char* code, char* text, int keyCode, int repeat, int modifiers)
{
    withInput(id, [=, key = takeString(key), code = takeString(code), text = takeString(text)](WebView& view) {
        view.keyEvent(type, key, code, text, keyCode, repeat, modifiers);
    });
}

// Preview during text input (compositionupdate) and completion (compositionend)
EMSCRIPTEN_KEEPALIVE void bl_set_composition(int id, char* text, int selectionStart, int selectionEnd)
{
    withInput(id, [=, text = takeString(text)](WebView& view) { view.setComposition(text, std::max(selectionStart, 0), std::max(selectionEnd, 0)); });
}

EMSCRIPTEN_KEEPALIVE void bl_confirm_composition(int id, char* text)
{
    withInput(id, [text = takeString(text)](WebView& view) { view.confirmComposition(text); });
}

EMSCRIPTEN_KEEPALIVE void bl_insert_text(int id, char* text)
{
    withInput(id, [text = takeString(text)](WebView& view) { view.insertText(text); });
}

// paths: paths in the virtual file system, separated by newlines. Empty = cancelled.
EMSCRIPTEN_KEEPALIVE void bl_choose_files(int id, char* paths)
{
    withView(id, [paths = takeString(paths)](WebView& view) {
        view.chooseFiles(paths.split('\n'));
    });
}

// Answers of the choosers (Choosers.h): list item (-1 = cancelled), color
// "#rrggbb", date/time as the value of the input field. done = chooser closed
EMSCRIPTEN_KEEPALIVE void bl_popup_choose(int id, int index)
{
    withView(id, [=](WebView&) { choosePopupItem(id, index); });
}

EMSCRIPTEN_KEEPALIVE void bl_color_chosen(int id, char* color, int done)
{
    withView(id, [id, color = takeString(color), done](WebView&) { chooseColor(id, color, done); });
}

EMSCRIPTEN_KEEPALIVE void bl_datetime_chosen(int id, char* value, int done)
{
    withView(id, [id, value = takeString(value), done](WebView&) { chooseDateTime(id, value, done); });
}

EMSCRIPTEN_KEEPALIVE void bl_focus_initial(int id, int forward)
{
    withInput(id, [=](WebView& view) { view.focusInitial(forward); });
}

EMSCRIPTEN_KEEPALIVE void bl_set_zoom(int id, float factor)
{
    withView(id, [=](WebView& view) { view.setZoom(factor); });
}

// Pinch zoom (PinchZoom.h): phase 0 begin, 1 step (factor relative to the last
// one), 2 end, 3 cancel; x/y = focus point in the view (CSS pixels). With
// layers the compositor thread scales, even when the engine thread is
// blocked.
EMSCRIPTEN_KEEPALIVE void bl_pinch(int id, int phase, double factor, double x, double y)
{
    auto pinchPhase = static_cast<PinchPhase>(std::clamp(phase, 0, 3));
    WebCore::FloatPoint focus(x, y);
    if (RefPtr scene = Compositor::isRunning() ? CompositorScene::forView(id) : nullptr) {
        scene->pinch(pinchPhase, factor, focus);
        return;
    }
    withInput(id, [=](WebView& view) { view.pinch(pinchPhase, factor, focus); });
}

// Find: again = find next with the same input (Enter / Shift+Enter)
EMSCRIPTEN_KEEPALIVE void bl_find(int id, char* text, int backwards, int again)
{
    withView(id, [text = takeString(text), backwards, again](WebView& view) { view.find(text, backwards, again); });
}

// Mute a view (speaker icon)
EMSCRIPTEN_KEEPALIVE void bl_set_muted(int id, int muted)
{
    withView(id, [muted](WebView& view) {
        view.page().setMuted(muted ? WebCore::MediaProducerMutedStateFlags { WebCore::MediaProducerMutedState::AudioIsMuted } : WebCore::MediaProducerMutedStateFlags { });
    });
}

// Print (Ctrl+P, menu): main frame as PDF
EMSCRIPTEN_KEEPALIVE void bl_print(int id)
{
    withView(id, [id](WebView& view) {
        if (RefPtr frame = view.mainFrame())
            printFrame(id, *frame);
    });
}

EMSCRIPTEN_KEEPALIVE void bl_find_done(int id)
{
    withView(id, [](WebView& view) { view.stopFind(); });
}

EMSCRIPTEN_KEEPALIVE void bl_context_menu(int id, double x, double y)
{
    withInput(id, [=](WebView& view) { view.contextMenu(x, y); });
}

EMSCRIPTEN_KEEPALIVE void bl_command(int id, char* name)
{
    withInput(id, [name = takeString(name)](WebView& view) { view.executeCommand(name); });
}

// Video/audio: state of the host <video> (JSON), new frame, data for the service worker
EMSCRIPTEN_KEEPALIVE void bl_media_event(int playerId, char* json)
{
    runOnEngineThread([playerId, json = takeString(json)] {
        if (auto* player = MediaPlayerPrivateWasm::fromId(playerId))
            player->hostEvent(json);
    });
}

EMSCRIPTEN_KEEPALIVE void bl_media_frame(int playerId, uint8_t* pixels, int width, int height)
{
    runOnEngineThread([=] {
        if (auto* player = MediaPlayerPrivateWasm::fromId(playerId))
            player->hostFrame(pixels, width, height);
        else
            free(pixels);
    });
}

// Overlay (#232): the host <video> showed a frame
EMSCRIPTEN_KEEPALIVE void bl_media_presented(int playerId, double mediaTime)
{
    runOnEngineThread([=] {
        if (auto* player = MediaPlayerPrivateWasm::fromId(playerId))
            player->hostFramePresented(mediaTime);
    });
}

EMSCRIPTEN_KEEPALIVE void bl_media_fetch(int playerId, int fetchId, double start, double end)
{
    runOnEngineThread([=] { startMediaFetch(playerId, fetchId, start, end); });
}

EMSCRIPTEN_KEEPALIVE void bl_media_fetch_cancel(int fetchId)
{
    runOnEngineThread([=] { cancelMediaFetch(fetchId); });
}

// The host browser left fullscreen (Esc) or could not enter it
EMSCRIPTEN_KEEPALIVE void bl_exit_fullscreen(int id)
{
    withView(id, [](WebView& view) { view.exitFullscreen(); });
}

EMSCRIPTEN_KEEPALIVE void bl_focus(int id, int focused)
{
    withView(id, [=](WebView& view) { view.setFocused(focused); });
}

// View visible (1) or hidden (0): in the background or the host tab is hidden
EMSCRIPTEN_KEEPALIVE void bl_set_visible(int id, int visible)
{
    withView(id, [=](WebView& view) { view.setVisible(visible); });
}

// flags: 1 = dark color scheme (prefers-color-scheme), 2 = touch screen,
// 4 = mobile device (primary pointer coarse without hover)
EMSCRIPTEN_KEEPALIVE void bl_set_screen(int width, int height, int availableWidth, int availableHeight, int flags)
{
    runOnEngineThread([=] {
        WebCore::WasmPlatform::ScreenInfo info;
        info.rect = WebCore::FloatRect(0, 0, width, height);
        info.availableRect = WebCore::FloatRect(0, 0, availableWidth, availableHeight);
        info.prefersDarkMode = flags & 1;
        info.hasTouch = flags & 2;
        info.mobile = flags & 4;
        auto& old = WebCore::WasmPlatform::screenInfo();
        bool darkChanged = info.prefersDarkMode != old.prefersDarkMode;
        bool pointerChanged = info.hasTouch != old.hasTouch || info.mobile != old.mobile;
        WebCore::WasmPlatform::setScreenInfo(info);
        if (darkChanged)
            WebView::forEach([&](WebView& view) { view.setDarkAppearance(info.prefersDarkMode); });
        if (pointerChanged)
            WebCore::Page::updateStyleForAllPagesAfterGlobalChangeInEnvironment();
        screenOrientationMayHaveChanged();
    });
}

EMSCRIPTEN_KEEPALIVE void bl_touch(int id, int type, char* points, int modifiers)
{
    withInput(id, [type, points = takeString(points), modifiers](WebView& view) { view.touchEvent(type, points, modifiers); });
}

// Permissions, geolocation, notifications (DeviceClients.cpp).
// answer and decision like PermissionDecision: 1 = granted, 2 = denied,
// 0 = no decision (request gone because the view closes: not remembered)
EMSCRIPTEN_KEEPALIVE void bl_permission_answer(int requestId, int answer)
{
    runOnEngineThread([=] { answerPermission(requestId, static_cast<PermissionDecision>(std::clamp(answer, 0, 2))); });
}

// HTTP authentication (HttpAuth.cpp): username null = cancelled
EMSCRIPTEN_KEEPALIVE void bl_auth_answer(int requestId, char* username, char* password)
{
    std::optional<std::pair<String, String>> answer;
    if (username)
        answer = std::pair { takeString(username), takeString(password) };
    else
        free(password);
    runOnEngineThread([requestId, answer = WTF::move(answer)]() mutable { HttpAuth::answer(requestId, WTF::move(answer)); });
}

EMSCRIPTEN_KEEPALIVE void bl_set_permission(char* kind, char* origin, int decision)
{
    runOnEngineThread([kind = takeString(kind), origin = takeString(origin), decision] {
        setStoredPermission(kind, origin, static_cast<PermissionDecision>(std::clamp(decision, 0, 2)));
    });
}

EMSCRIPTEN_KEEPALIVE void bl_geolocation_position(int id, double latitude, double longitude, double accuracy, double altitude, double altitudeAccuracy, double heading, double speed, double timestamp)
{
    runOnEngineThread([=] { geolocationPosition(id, latitude, longitude, accuracy, altitude, altitudeAccuracy, heading, speed, timestamp); });
}

EMSCRIPTEN_KEEPALIVE void bl_geolocation_error(int id, int code, char* message)
{
    runOnEngineThread([id, code, message = takeString(message)] { geolocationError(id, code, message); });
}

// Orientation/motion from the host browser (NaN = value missing)
EMSCRIPTEN_KEEPALIVE void bl_device_orientation(int id, double alpha, double beta, double gamma, int absolute)
{
    runOnEngineThread([=] { deviceOrientation(id, alpha, beta, gamma, absolute); });
}

EMSCRIPTEN_KEEPALIVE void bl_device_motion(int id, double x, double y, double z, double gravityX, double gravityY, double gravityZ, double rotationAlpha, double rotationBeta, double rotationGamma, double interval)
{
    runOnEngineThread([=] {
        double values[9] = { x, y, z, gravityX, gravityY, gravityZ, rotationAlpha, rotationBeta, rotationGamma };
        deviceMotion(id, values, interval);
    });
}

// The host's answer to a call of the host bridge (WebPlatformExtras.h)
EMSCRIPTEN_KEEPALIVE void bl_host_call_result(double identifier, int ok, char* result)
{
    runOnEngineThread([identifier = static_cast<uint64_t>(identifier), ok, result = takeString(result)] {
        hostCallFinished(identifier, ok, result);
    });
}

// Scripts and styles of the host's extensions (UserContent.h): [{extension,
// scripts, styles}] replaces all of them
EMSCRIPTEN_KEEPALIVE void bl_set_user_content(char* json)
{
    runOnEngineThread([json = takeString(json)] { setUserContent(json); });
}

// A message (JSON) of the host to the scripts of an extension in a view
EMSCRIPTEN_KEEPALIVE void bl_extension_message(int id, char* extension, char* json)
{
    withView(id, [extension = takeString(extension), json = takeString(json)](WebView& view) {
        sendExtensionMessage(view, extension, json);
    });
}

EMSCRIPTEN_KEEPALIVE void bl_notification_event(char* notificationID, int type)
{
    runOnEngineThread([notificationID = takeString(notificationID), type] { notificationEvent(notificationID, type); });
}

// Gamepads (Gamepad.cpp) and speech (Speech.cpp)
EMSCRIPTEN_KEEPALIVE void bl_gamepad(int index, char* json)
{
    runOnEngineThread([index, json = takeString(json)] { updateGamepad(index, json); });
}

EMSCRIPTEN_KEEPALIVE void bl_speech_voices(char* json)
{
    runOnEngineThread([json = takeString(json)] { setSpeechVoices(json); });
}

EMSCRIPTEN_KEEPALIVE void bl_speech_event(double id, int type, int charIndex, int charLength)
{
    runOnEngineThread([=] { speechEvent(static_cast<uint64_t>(id), type, charIndex, charLength); });
}

EMSCRIPTEN_KEEPALIVE void bl_speech_recognition_event(double id, int type, char* json)
{
    runOnEngineThread([id, type, json = takeString(json)] { speechRecognitionEvent(static_cast<uint64_t>(id), type, json); });
}

// User agent and navigator.platform, empty = default. Before the first view
EMSCRIPTEN_KEEPALIVE void bl_set_user_agent(char* userAgent, char* platform)
{
    runOnEngineThread([userAgent = takeString(userAgent), platform = takeString(platform)] {
        WebCore::WasmPlatform::setUserAgent(userAgent);
        WebCore::WasmPlatform::setPlatform(platform);
    });
}

// Languages of the pages (navigator.languages, Accept-Language, Intl) as a
// comma list like "de-CH,de,en", empty = default (en-US)
EMSCRIPTEN_KEEPALIVE void bl_set_languages(char* languages)
{
    runOnEngineThread([languages = takeString(languages)] {
        Vector<String> list;
        for (auto& language : languages.split(',')) {
            auto trimmed = language.trim(isASCIIWhitespace<char16_t>);
            if (!trimmed.isEmpty())
                list.append(WTF::move(trimmed));
        }
        WTF::overrideUserPreferredLanguages(list);
        // Their ICU data loads in the background (tools/icu-data.mjs groups the files of a
        // locale): "de-CH" fetches de_CH and de
        for (auto& language : list) {
            String id = makeStringByReplacingAll(language, '-', '_');
            while (!id.isEmpty()) {
                BrowserLite::prefetchLazyGroup(makeString("icu:"_s, id).utf8().data());
                size_t cut = id.reverseFind('_');
                id = cut == notFound ? String() : id.left(cut);
            }
        }
    });
}

// For all views (WebView::Preference): 1 = JavaScript off, 2 = images off,
// 4 = Global Privacy Control
EMSCRIPTEN_KEEPALIVE void bl_set_preferences(int flags)
{
    runOnEngineThread([flags] {
        WebView::setPreferences(OptionSet<WebView::Preference>::fromRaw(flags & 15));
    });
}

// navigator.onLine and the online/offline events: network of the host browser
// and connection of the transport
EMSCRIPTEN_KEEPALIVE void bl_set_online(int onLine)
{
    runOnEngineThread([onLine] { WebCore::WasmPlatform::setOnLine(onLine); });
}

EMSCRIPTEN_KEEPALIVE void bl_set_clipboard_text(char* text)
{
    runOnEngineThread([text = takeString(text)] {
        WebCore::WasmPlatform::ClipboardItems items;
        items.append({ "text/plain;charset=utf-8"_s, text });
        WebCore::WasmPlatform::setClipboardFromHost(WTF::move(items), { });
    });
}

// Paste from the host: {"text":..,"html":..,"files":[paths in the engine file system]}
EMSCRIPTEN_KEEPALIVE void bl_set_clipboard(char* data)
{
    runOnEngineThread([json = takeString(data)] {
        WebCore::WasmPlatform::ClipboardItems items;
        Vector<String> files;
        auto value = JSON::Value::parseJSON(json);
        if (auto object = value ? value->asObject() : nullptr) {
            auto text = object->getString("text"_s);
            if (!text.isNull())
                items.append({ "text/plain;charset=utf-8"_s, text });
            auto html = object->getString("html"_s);
            if (!html.isEmpty())
                items.append({ "text/html"_s, html });
            if (auto array = object->getArray("files"_s)) {
                for (auto& file : *array)
                    files.append(file->asString());
            }
        }
        WebCore::WasmPlatform::setClipboardFromHost(WTF::move(items), WTF::move(files));
    });
}


// Writes a chunk of a host file (upload, drag and drop, paste) into the engine
// file system, offset 0 creates it. Only on the engine thread:
// engine/js/engine-pre.js reads the host files there itself in chunks.
// 1: written
EMSCRIPTEN_KEEPALIVE int bl__write_file(const char* path, const uint8_t* data, int length, double offset)
{
    ASSERT(isEngineThread());
    if (!offset) {
        String directory = String::fromUTF8(path);
        size_t slash = directory.reverseFind('/');
        if (slash != notFound && slash > 0)
            FileSystem::makeAllDirectories(directory.left(slash));
    }
    FILE* file = fopen(path, offset ? "r+b" : "wb");
    if (!file) {
        debugLog("bl__write_file: %s not writable", path);
        return 0;
    }
    bool ok = !fseeko(file, static_cast<off_t>(offset), SEEK_SET) && fwrite(data, 1, length, file) == static_cast<size_t>(length);
    return !fclose(file) && ok;
}

// Deletes a file or folder (with contents), e.g. the uploads of a closed view.
// On the engine thread after everything that came before.
EMSCRIPTEN_KEEPALIVE void bl_remove_path(char* path)
{
    runOnEngineThread([path = takeString(path)] {
        if (FileSystem::fileType(path) == FileSystem::FileType::Directory)
            FileSystem::deleteNonEmptyDirectory(path);
        else
            FileSystem::deleteFile(path);
    });
}

// Writes databases from memory into the file system (MemoryVFS.cpp), on the
// engine thread (writing to OPFS). The host waits at most waitMilliseconds
// for it (when the page is hidden).
EMSCRIPTEN_KEEPALIVE void bl_storage_flush(int waitMilliseconds)
{
    if (waitMilliseconds > 0)
        flushMemoryVFSAndWait(Seconds::fromMilliseconds(waitMilliseconds));
    else {
        runOnEngineThread([] {
            flushMemoryVFS();
        });
    }
}

// Allocated memory (malloc) for tests. mallinfo walks the whole heap (about
// 25 ms on CNN) and holds the malloc lock meanwhile.
EMSCRIPTEN_KEEPALIVE double bl_memory_used()
{
    return static_cast<double>(mallinfo().uordblks);
}

// Memory report 4 (tests): what in the JS heap keeps the documents without a frame alive. A GC
// debugging snapshot of JSC, from the JS wrapper of each such document back to a root: the path
// with class names and edge names, and the reason of the root (conservative scan, strong handle,
// ...)
static void printDetachedDocumentRetainers(JSC::VM& vm)
{
    Vector<std::pair<String, String>> targets; // cell address of the wrapper, URL
    for (auto& document : WebCore::Document::allDocuments()) {
        if (document->frame() || !document->wrapper())
            continue;
        targets.append({ makeString("0x"_s, hex(reinterpret_cast<uintptr_t>(document->wrapper()), Lowercase)), document->url().string().left(80) });
    }
    if (targets.isEmpty())
        return;
    JSC::HeapSnapshotBuilder builder(vm.ensureHeapProfiler(), JSC::HeapSnapshotBuilder::SnapshotType::GCDebuggingSnapshot);
    builder.buildSnapshot();
    auto json = builder.json();
    auto parsed = JSON::Value::parseJSON(json);
    RefPtr object = parsed ? parsed->asObject() : nullptr;
    if (!object) {
        printf("[memory]   retainers: no snapshot\n");
        return;
    }
    auto array = [&](ASCIILiteral name) { return object->getArray(name); };
    RefPtr nodes = array("nodes"_s);
    RefPtr edges = array("edges"_s);
    RefPtr roots = array("roots"_s);
    RefPtr labels = array("labels"_s);
    RefPtr classNames = array("nodeClassNames"_s);
    RefPtr edgeNames = array("edgeNames"_s);
    RefPtr edgeTypes = array("edgeTypes"_s);
    if (!nodes || !edges || !roots || !labels || !classNames || !edgeNames || !edgeTypes)
        return;
    auto integer = [](JSON::Array& list, size_t index) { return list.get(index)->asInteger().value_or(0); };
    auto string = [](JSON::Array& list, size_t index) { return index < list.length() ? list.get(index)->asString() : String(); };
    HashMap<int, size_t> nodeIndex; // id -> first field
    HashMap<String, int> cellToNode;
    for (size_t i = 0; i + 6 < nodes->length(); i += 7) {
        int id = integer(*nodes, i);
        nodeIndex.add(id + 1, i);
        cellToNode.add(string(*nodes, i + 5), id);
    }
    auto describe = [&](int id) {
        auto entry = nodeIndex.find(id + 1);
        if (entry == nodeIndex.end())
            return String("?"_s);
        auto i = entry->value;
        auto label = string(*labels, integer(*nodes, i + 4));
        auto name = string(*classNames, integer(*nodes, i + 2));
        return label.isEmpty() ? name : makeString(name, '[', label.left(40), ']');
    };
    HashMap<int, String> rootReason;
    HashMap<int, String> reachability; // why a root of WeakSets counts as reachable
    for (size_t i = 0; i + 2 < roots->length(); i += 3) {
        rootReason.add(integer(*roots, i) + 1, string(*labels, integer(*roots, i + 1)));
        if (int reason = integer(*roots, i + 2))
            reachability.add(integer(*roots, i) + 1, string(*labels, reason));
    }
    // Reverse edges: to -> (from, edge index)
    HashMap<int, Vector<std::pair<int, size_t>>> referrers;
    for (size_t i = 0; i + 3 < edges->length(); i += 4)
        referrers.ensure(integer(*edges, i + 1) + 1, [] { return Vector<std::pair<int, size_t>> { }; }).iterator->value.append({ integer(*edges, i), i });
    auto edgeLabel = [&](size_t i) {
        auto type = string(*edgeTypes, integer(*edges, i + 2));
        if (type == "Property"_s || type == "Variable"_s)
            return string(*edgeNames, integer(*edges, i + 3)).left(30);
        if (type == "Index"_s)
            return makeString('[', integer(*edges, i + 3), ']');
        return String("internal"_s);
    };
    for (auto& [cell, url] : targets) {
        auto start = cellToNode.find(cell);
        if (start == cellToNode.end()) {
            printf("[memory]   retainers of %s: wrapper not in the snapshot\n", url.utf8().data());
            continue;
        }
        // Breadth first towards a root. A root "WeakSets" is a wrapper kept for an opaque root
        // (its document or window) that something else marked: first look for another root.
        auto pathToRoot = [&](bool acceptWeakSets) -> String {
            HashMap<int, std::pair<int, size_t>> cameFrom; // node -> (node it keeps alive, edge)
            Deque<int> queue;
            queue.append(start->value);
            cameFrom.add(start->value + 1, std::pair<int, size_t> { -1, 0 });
            int found = -1;
            while (!queue.isEmpty() && cameFrom.size() < 2000000) {
                int node = queue.takeFirst();
                if (auto reason = rootReason.find(node + 1); reason != rootReason.end() && (acceptWeakSets || reason->value != "WeakSets"_s)) {
                    found = node;
                    break;
                }
                auto it = referrers.find(node + 1);
                if (it == referrers.end())
                    continue;
                for (auto& [from, edge] : it->value) {
                    if (cameFrom.add(from + 1, std::pair<int, size_t> { node, edge }).isNewEntry)
                        queue.append(from);
                }
            }
            if (found < 0)
                return { };
            StringBuilder path;
            path.append("root ("_s, rootReason.get(found + 1), ") "_s);
            for (int node = found, steps = 0; node >= 0 && steps < 14; ++steps) {
                auto [next, edge] = cameFrom.get(node + 1);
                path.append(describe(node));
                if (next < 0)
                    break;
                path.append(" -"_s, edgeLabel(edge), "-> "_s);
                node = next;
            }
            return path.toString();
        };
        auto path = pathToRoot(false);
        if (path.isNull())
            path = pathToRoot(true);
        if (path.isNull())
            path = "no path to a root"_s;
        printf("[memory]   retainers of %s: %s\n", url.utf8().data(), path.utf8().data());

        // Every root that reaches the document, by class and reason: the one that keeps it is
        // mostly a rare kind among thousands of its connected nodes
        HashMap<String, unsigned> kinds;
        HashSet<int> seen;
        Deque<int> queue;
        queue.append(start->value);
        seen.add(start->value + 1);
        while (!queue.isEmpty() && seen.size() < 2000000) {
            int node = queue.takeFirst();
            if (auto reason = rootReason.find(node + 1); reason != rootReason.end()) {
                auto entry = nodeIndex.find(node + 1);
                auto name = entry == nodeIndex.end() ? String("?"_s) : string(*classNames, integer(*nodes, entry->value + 2));
                auto why = reachability.get(node + 1);
                kinds.add(makeString(name, " ("_s, reason->value, why.isEmpty() ? ""_s : ": "_s, why, ')'), 0).iterator->value++;
            }
            auto it = referrers.find(node + 1);
            if (it == referrers.end())
                continue;
            for (auto& [from, edge] : it->value) {
                if (seen.add(from + 1).isNewEntry)
                    queue.append(from);
            }
        }
        auto sorted = copyToVector(kinds);
        std::ranges::sort(sorted, [](auto& a, auto& b) { return a.value < b.value; });
        StringBuilder list;
        for (size_t i = 0; i < sorted.size() && i < 12; ++i)
            list.append(i ? ", "_s : ""_s, sorted[i].key, " x"_s, sorted[i].value);
        printf("[memory]   roots that reach %s (rarest first): %s\n", url.utf8().data(), list.toString().utf8().data());
    }
}

// What the conservative scan sees above this function (the GC's own frames are below): the words
// of the C stack that may point into the heap, by their distance from the stack's base, to match
// with the cell the verifier names "from scan of ConservativeScan roots"; and the
// MarkedArgumentBuffers on the heap, which also count as conservative roots
static void printConservativeRoots(JSC::VM& vm)
{
    auto base = emscripten_stack_get_base();
    auto top = emscripten_stack_get_current() & ~uintptr_t { 3 };
    auto heapEnd = emscripten_get_heap_size();
    printf("[memory]   C stack %u bytes\n", static_cast<unsigned>(base - top));
    StringBuilder line;
    unsigned count = 0;
    for (auto address = top; address < base; address += 4) {
        auto value = *reinterpret_cast<uint32_t*>(address);
        if (value < 0x100000 || value >= heapEnd)
            continue;
        line.append(' ', base - address, ":"_s, hex(value, Lowercase));
        if (++count % 16)
            continue;
        printf("[memory]   C stack words%s\n", line.toString().utf8().data());
        line.clear();
    }
    if (!line.isEmpty())
        printf("[memory]   C stack words%s\n", line.toString().utf8().data());
    size_t lists = 0;
    size_t values = 0;
    for (auto* list : vm.heap.markListSet()) {
        ++lists;
        values += list->size();
    }
    printf("[memory]   mark lists %zu with %zu values\n", lists, values);
}

// Who marks the documents without a frame: the snapshot has no edge for an opaque root (a
// wrapper that adds its document while marking keeps all wrappers of that document). One more
// full GC with JSC's verifier, which remembers for each cell and opaque root what marked or added
// it; its chain from the document's wrapper ends at a real root.
static void printDetachedDocumentMarkers(JSC::VM& vm)
{
    Vector<std::pair<JSC::JSCell*, String>> targets;
    for (auto& document : WebCore::Document::allDocuments()) {
        if (!document->frame() && document->wrapper())
            targets.append({ document->wrapper(), document->url().string().left(80) });
    }
    if (targets.isEmpty())
        return;
    JSC::Options::verifyGC() = true;
    JSC::Options::verboseVerifyGC() = true;
    vm.heap.setKeepVerifierSlotVisitor();
    clearStackBelow();
    vm.heap.collectNow(JSC::Sync, JSC::CollectionScope::Full);
    for (auto& [cell, url] : targets) {
        printf("[memory]   marking of %s:\n", url.utf8().data());
        fflush(stdout);
        vm.heap.dumpVerifierMarkerData(cell);
        WTF::dataFile().flush();
        printf("[memory]   marking end\n");
    }
    vm.heap.clearVerifierSlotVisitor();
    JSC::Options::verifyGC() = false;
    JSC::Options::verboseVerifyGC() = false;
    printConservativeRoots(vm);
}

static void printMemoryReport(int full)
{
    auto& vm = WebCore::commonVM();
    JSC::JSLockHolder lock(vm);
    // 3, 4: first release everything releasable like under memory pressure
    if (full >= 3)
        WebCore::releaseMemory(WTF::Critical::Yes, WTF::Synchronous::Yes);
    if (full) {
        clearStackBelow();
        vm.heap.collectNow(JSC::Sync, JSC::CollectionScope::Full);
    }
    struct mallinfo info = mallinfo();
    auto& cache = WebCore::MemoryCache::singleton();
    printf("[memory] malloc used %zu MB, free %zu MB, JS heap %zu MB (capacity %zu MB), documents %u, cache %u KB\n",
        static_cast<size_t>(info.uordblks) >> 20, static_cast<size_t>(info.fordblks) >> 20,
        vm.heap.size() >> 20, vm.heap.capacity() >> 20, WebCore::Document::allDocumentsMap().size(), cache.size() >> 10);
    auto statistics = cache.getStatistics();
    printf("[memory]   cache images %d (%d KB, decoded %d KB), scripts %d KB, CSS %d KB, fonts %d KB\n",
        statistics.images.count, statistics.images.size >> 10, statistics.images.decodedSize >> 10,
        statistics.scripts.size >> 10, statistics.cssStyleSheets.size >> 10, statistics.fonts.size >> 10);
    if (full > 1) {
        // Live documents: references, frame, URL
        for (auto& document : WebCore::Document::allDocuments()) {
            // What keeps a detached one: nodes (JS wrappers or C++), its JS wrapper
            printf("[memory]   doc refs=%u nodes=%u frame=%d wrapper=%d %s\n", document->refCount(), document->referencingNodeCount(),
                document->frame() ? 1 : 0, document->wrapper() ? 1 : 0, document->url().string().left(100).utf8().data());
        }
    }
    if (full == 4) {
        printDetachedDocumentRetainers(vm);
        printDetachedDocumentMarkers(vm);
    }
}

// Engine memory in the console (tests and debugging). Only with BL_TEST_HOOKS=1.
// full: run a full GC first.
EMSCRIPTEN_KEEPALIVE void bl_memory_report(int full)
{
    if (!engineConfig().testHooks)
        return;
    // At top level, so the GC runs before the report and the heap snapshot has a GC to record
    runOnEngineThread([full] {
        runAtTopLevel([full] { printMemoryReport(full); });
    });
}

// Why a thread crashed, for the host (Module.blCrashReason): the worker of the
// thread writes its error with the stack there (engine/js/engine-pre.js), in
// static memory because malloc may be locked by the crashed thread
struct CrashReason {
    uint32_t capacity { sizeof(text) };
    char text[4092] { };
};
static CrashReason s_crashReason;

EMSCRIPTEN_KEEPALIVE CrashReason* bl__crash_reason()
{
    return &s_crashReason;
}

// For tests, only with BL_TEST_HOOKS=1: a real crash on the engine thread.
// kind 0 = abort(), 1 = WASM trap
EMSCRIPTEN_KEEPALIVE void bl_crash_for_testing(int kind)
{
    runOnEngineThread([kind] {
        if (!engineConfig().testHooks)
            return;
        log("Crash for tests: %s", kind ? "trap" : "abort");
        if (kind)
            __builtin_trap();
        abort();
    });
}

#if ENABLE(WEBGL)
// For tests: lose the host WebGL contexts the WebGL canvases of the pages
// draw on (ANGLEShimWasm.cpp)
EMSCRIPTEN_KEEPALIVE void bl_webgl_lose_context_for_testing()
{
    runOnEngineThread([] { WebCore::angleShimLoseHostContextsForTesting(); });
}
#endif
} // extern "C"
