// C-Schnittstelle fuer die Browser-Oberflaeche (JS im Haupt-Thread der Seite).
// Jede Funktion darf von jedem Thread aufgerufen werden; die Arbeit passiert
// asynchron auf dem Engine-Thread. Strings uebergibt der Aufrufer als UTF-8
// (z.B. mit stringToNewUTF8), die Engine gibt sie mit free() frei.

#include "config.h"

#include "Choosers.h"
#include "DeviceClients.h"
#include "Engine.h"
#include "Gamepad.h"
#include "MediaFetch.h"
#include "MediaPlayerPrivateWasm.h"
#include "MemoryVFS.h"
#include "Speech.h"
#include "WebPlatformExtras.h"
#include "LoaderStrategy.h"
#include "WebView.h"

#include <JavaScriptCore/DeferGCInlines.h>
#include <JavaScriptCore/JSCJSValueInlines.h>
#include <JavaScriptCore/HeapInlines.h>
#include <JavaScriptCore/JSLock.h>
#include <WebCore/CommonVM.h>
#include <WebCore/Document.h>
#include <WebCore/FrameDestructionObserverInlines.h>
#include <WebCore/MemoryCache.h>
#include <WebCore/MemoryRelease.h>
#include <WebCore/WasmPlatform.h>
#include <malloc.h>
#include <WebCore/DOMWrapperWorld.h>
#include <WebCore/JSDOMWindowBase.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/ScriptController.h>
#include <emscripten/emscripten.h>

using namespace BrowserLite;

static String takeString(char* utf8)
{
    if (!utf8)
        return { };
    String string = String::fromUTF8(utf8);
    free(utf8);
    return string;
}

template<typename Function>
static void withView(int id, Function&& function)
{
    runOnEngineThread([id, function = std::forward<Function>(function)]() mutable {
        if (auto* view = WebView::fromID(id))
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

EMSCRIPTEN_KEEPALIVE void bl_load_html(int id, char* html, char* baseURL)
{
    withView(id, [html = takeString(html), baseURL = takeString(baseURL)](WebView& view) {
        view.loadHTML(html, baseURL);
    });
}

EMSCRIPTEN_KEEPALIVE void bl_go_back(int id) { withView(id, [](WebView& view) { view.goBack(); }); }
EMSCRIPTEN_KEEPALIVE void bl_go_forward(int id) { withView(id, [](WebView& view) { view.goForward(); }); }
EMSCRIPTEN_KEEPALIVE void bl_reload(int id) { withView(id, [](WebView& view) { view.reload(); }); }
EMSCRIPTEN_KEEPALIVE void bl_stop(int id) { withView(id, [](WebView& view) { view.stop(); }); }

EMSCRIPTEN_KEEPALIVE void bl_resize(int id, int width, int height, float deviceScaleFactor)
{
    withView(id, [=](WebView& view) { view.resize({ width, height }, deviceScaleFactor); });
}

// Vom Host einmal pro requestAnimationFrame, wenn die Engine ein Bild wollte
EMSCRIPTEN_KEEPALIVE void bl_frame(int id)
{
    withView(id, [](WebView& view) { view.presentIfNeeded(); });
}

// Das Canvas des Views ist jetzt im Engine-Worker (engine-pre.js)
EMSCRIPTEN_KEEPALIVE void bl_canvas_attached(int id)
{
    withView(id, [](WebView& view) { view.canvasAttached(); });
}

// pthread des Engine-Threads: die Oberflaeche sucht damit den Worker
EMSCRIPTEN_KEEPALIVE int bl_engine_thread()
{
    return static_cast<int>(reinterpret_cast<uintptr_t>(engineThread()));
}

// Quelltext der aktuellen Seite (Strg+U): kommt wie ein Download mit viewSource-Merker
EMSCRIPTEN_KEEPALIVE void bl_view_source(int id)
{
    withView(id, [id](WebView& view) {
        URL url { view.currentURL() };
        if (url.protocolIsInHTTPFamily())
            startViewSource(id, url);
    });
}

// Fehlersuche: JS in der Seite ausfuehren (auch wenn die CSP der Seite
// javascript:-URLs verbietet), Ergebnis als Text in der Konsole.
// In der Oberflaeche: __blEval("document.title")
EMSCRIPTEN_KEEPALIVE void bl_eval_script(int id, char* source)
{
    withView(id, [source = takeString(source), id](WebView& view) {
        RefPtr frame = view.mainFrame();
        if (!frame)
            return;
        auto result = frame->script().executeScriptIgnoringException(source, JSC::SourceTaintedOrigin::Untainted);
        String text = result ? result.toWTFString(frame->script().globalObject(WebCore::mainThreadNormalWorldSingleton())) : "(Ausnahme)"_s;
        RefPtr document = frame->document();
        printf("[eval %d] %s (Malen erlaubt %d, Render-Blocking %d, View-Transition %d)\n", id, text.utf8().data(),
            document && document->visualUpdatesAllowed(), document && document->isRenderBlocked(),
            document && document->renderingIsSuppressedForViewTransition());
    });
}

// Host hat das letzte Bild kopiert, der Pixel-Buffer darf wieder bemalt werden
EMSCRIPTEN_KEEPALIVE void bl_frame_presented(int id)
{
    withView(id, [](WebView& view) {
        view.framePresented();
        view.presentIfNeeded();
    });
}

EMSCRIPTEN_KEEPALIVE void bl_mouse(int id, int type, int button, double x, double y, int clickCount, int modifiers)
{
    withView(id, [=](WebView& view) { view.mouseEvent(type, button, x, y, clickCount, modifiers); });
}

// Mausbewegung mit movementX/Y (auch bei Pointer Lock). button: gedrueckte
// Taste wie bei bl_mouse (-1 = keine), sonst gibt es kein Ziehen/Markieren
EMSCRIPTEN_KEEPALIVE void bl_mouse_move(int id, double x, double y, double movementX, double movementY, int button, int modifiers)
{
    withView(id, [=](WebView& view) { view.mouseEvent(2, button, x, y, 0, modifiers, movementX, movementY); });
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

EMSCRIPTEN_KEEPALIVE void bl_wheel(int id, double x, double y, double deltaX, double deltaY, int modifiers)
{
    withView(id, [=](WebView& view) { view.wheelEvent(x, y, deltaX, deltaY, modifiers); });
}

EMSCRIPTEN_KEEPALIVE void bl_key(int id, int type, char* key, char* code, char* text, int keyCode, int repeat, int modifiers)
{
    withView(id, [=, key = takeString(key), code = takeString(code), text = takeString(text)](WebView& view) {
        view.keyEvent(type, key, code, text, keyCode, repeat, modifiers);
    });
}

EMSCRIPTEN_KEEPALIVE void bl_insert_text(int id, char* text)
{
    withView(id, [text = takeString(text)](WebView& view) { view.insertText(text); });
}

// paths: Pfade im virtuellen Dateisystem, mit Zeilenumbruch getrennt. Leer = abgebrochen.
EMSCRIPTEN_KEEPALIVE void bl_choose_files(int id, char* paths)
{
    withView(id, [paths = takeString(paths)](WebView& view) {
        view.chooseFiles(paths.split('\n'));
    });
}

// Antworten der Auswahlen (Choosers.h): Listeneintrag (-1 = abgebrochen),
// Farbe "#rrggbb", Datum/Zeit als Wert des Eingabefelds. done = Auswahl zu
EMSCRIPTEN_KEEPALIVE void bl_popup_choose(int id, int index)
{
    runOnEngineThread([=] { choosePopupItem(id, index); });
}

EMSCRIPTEN_KEEPALIVE void bl_color_chosen(int id, char* color, int done)
{
    runOnEngineThread([id, color = takeString(color), done] { chooseColor(id, color, done); });
}

EMSCRIPTEN_KEEPALIVE void bl_datetime_chosen(int id, char* value, int done)
{
    runOnEngineThread([id, value = takeString(value), done] { chooseDateTime(id, value, done); });
}

EMSCRIPTEN_KEEPALIVE void bl_focus_initial(int id, int forward)
{
    withView(id, [=](WebView& view) { view.focusInitial(forward); });
}

EMSCRIPTEN_KEEPALIVE void bl_set_zoom(int id, float factor)
{
    withView(id, [=](WebView& view) { view.setZoom(factor); });
}

// Suchen: again = Weitersuchen mit derselben Eingabe (Enter / Shift+Enter)
EMSCRIPTEN_KEEPALIVE void bl_find(int id, char* text, int backwards, int again)
{
    withView(id, [text = takeString(text), backwards, again](WebView& view) { view.find(text, backwards, again); });
}

EMSCRIPTEN_KEEPALIVE void bl_find_done(int id)
{
    withView(id, [](WebView& view) { view.stopFind(); });
}

EMSCRIPTEN_KEEPALIVE void bl_context_menu(int id, double x, double y)
{
    withView(id, [=](WebView& view) { view.contextMenu(x, y); });
}

EMSCRIPTEN_KEEPALIVE void bl_command(int id, char* name)
{
    withView(id, [name = takeString(name)](WebView& view) { view.executeCommand(name); });
}

// Video/Audio: Zustand des Host-<video> (JSON), neues Bild, Daten fuer den Service Worker
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

// Der Host-Browser hat das Vollbild beendet (Esc) oder konnte es nicht starten
EMSCRIPTEN_KEEPALIVE void bl_exit_fullscreen(int id)
{
    withView(id, [](WebView& view) { view.exitFullscreen(); });
}

EMSCRIPTEN_KEEPALIVE void bl_focus(int id, int focused)
{
    withView(id, [=](WebView& view) { view.setFocused(focused); });
}

// flags: 1 = dunkles Farbschema (prefers-color-scheme), 2 = Touchscreen
EMSCRIPTEN_KEEPALIVE void bl_set_screen(int width, int height, int availableWidth, int availableHeight, int flags)
{
    runOnEngineThread([=] {
        WebCore::WasmPlatform::ScreenInfo info;
        info.rect = WebCore::FloatRect(0, 0, width, height);
        info.availableRect = WebCore::FloatRect(0, 0, availableWidth, availableHeight);
        info.prefersDarkMode = flags & 1;
        info.hasTouch = flags & 2;
        bool darkChanged = info.prefersDarkMode != WebCore::WasmPlatform::screenInfo().prefersDarkMode;
        WebCore::WasmPlatform::setScreenInfo(info);
        if (darkChanged)
            WebView::forEach([&](WebView& view) { view.setDarkAppearance(info.prefersDarkMode); });
        screenOrientationMayHaveChanged();
    });
}

EMSCRIPTEN_KEEPALIVE void bl_touch(int id, int type, char* points, int modifiers)
{
    withView(id, [type, points = takeString(points), modifiers](WebView& view) { view.touchEvent(type, points, modifiers); });
}

// Berechtigungen, Standort, Benachrichtigungen (DeviceClients.cpp)
EMSCRIPTEN_KEEPALIVE void bl_permission_answer(int requestId, int granted)
{
    runOnEngineThread([=] { answerPermission(requestId, granted); });
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

EMSCRIPTEN_KEEPALIVE void bl_notification_event(char* notificationID, int type)
{
    runOnEngineThread([notificationID = takeString(notificationID), type] { notificationEvent(notificationID, type); });
}

// Gamepads (Gamepad.cpp) und Sprachausgabe (Speech.cpp)
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

EMSCRIPTEN_KEEPALIVE void bl_set_user_agent(char* userAgent)
{
    runOnEngineThread([userAgent = takeString(userAgent)] {
        WebCore::WasmPlatform::setUserAgent(userAgent);
    });
}

EMSCRIPTEN_KEEPALIVE void bl_set_clipboard_text(char* text)
{
    runOnEngineThread([text = takeString(text)] {
        WebCore::WasmPlatform::ClipboardItems items;
        items.append({ "text/plain;charset=utf-8"_s, text });
        WebCore::WasmPlatform::setClipboardContents(WTF::move(items));
    });
}


// Datenbanken aus dem Speicher ins Dateisystem schreiben (MemoryVFS.cpp).
// Laeuft auf dem Haupt-Thread des Host, direkt vor dem Speichern des IDBFS.
EMSCRIPTEN_KEEPALIVE void bl_storage_flush()
{
    flushMemoryVFS(true);
}

// Speicher der Engine in der Konsole (fuer Tests und Fehlersuche).
// full: vorher einen vollen GC machen.
EMSCRIPTEN_KEEPALIVE void bl_memory_report(int full)
{
    runOnEngineThread([full] {
        auto& vm = WebCore::commonVM();
        JSC::JSLockHolder lock(vm);
        // 3: vorher wie bei Speicherdruck alles Freigebbare freigeben
        if (full == 3)
            WebCore::releaseMemory(WTF::Critical::Yes, WTF::Synchronous::Yes);
        if (full)
            vm.heap.collectNow(JSC::Sync, JSC::CollectionScope::Full);
        struct mallinfo info = mallinfo();
        auto& cache = WebCore::MemoryCache::singleton();
        printf("[speicher] malloc belegt %zu MB, frei %zu MB, JS-Heap %zu MB (Kapazitaet %zu MB), Dokumente %u, Cache %u KB\n",
            static_cast<size_t>(info.uordblks) >> 20, static_cast<size_t>(info.fordblks) >> 20,
            vm.heap.size() >> 20, vm.heap.capacity() >> 20, WebCore::Document::allDocumentsMap().size(), cache.size() >> 10);
        auto statistics = cache.getStatistics();
        printf("[speicher]   Cache Bilder %d (%d KB, dekodiert %d KB), Skripte %d KB, CSS %d KB, Schriften %d KB\n",
            statistics.images.count, statistics.images.size >> 10, statistics.images.decodedSize >> 10,
            statistics.scripts.size >> 10, statistics.cssStyleSheets.size >> 10, statistics.fonts.size >> 10);
        if (full > 1) {
            // Lebende Dokumente: Referenzen, Frame, URL
            for (auto& document : WebCore::Document::allDocuments()) {
                printf("[speicher]   doc refs=%u frame=%d %s\n", document->refCount(), document->frame() ? 1 : 0,
                    document->url().string().left(100).utf8().data());
            }
        }
    });
}
} // extern "C"
