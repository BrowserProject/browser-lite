// C-Schnittstelle fuer die Browser-Oberflaeche (JS im Haupt-Thread der Seite).
// Jede Funktion darf von jedem Thread aufgerufen werden; die Arbeit passiert
// asynchron auf dem Engine-Thread. Strings uebergibt der Aufrufer als UTF-8
// (z.B. mit stringToNewUTF8), die Engine gibt sie mit free() frei.

#include "config.h"

#include "Choosers.h"
#include "Compositor.h"
#include "DeviceClients.h"
#include "Printing.h"
#include "Engine.h"
#include "Gamepad.h"
#include "Host.h"
#include "LayerTreeHostWasm.h"
#include "MediaFetch.h"
#include "MediaPlayerPrivateWasm.h"
#include "MemoryVFS.h"
#include "ScrollingWasm.h"
#include "Speech.h"
#include "WebPlatformExtras.h"
#include "LoaderStrategy.h"
#include "WebView.h"

#include <JavaScriptCore/DeferGCInlines.h>
#include <JavaScriptCore/JSCJSValueInlines.h>
#include <JavaScriptCore/HeapInlines.h>
#include <JavaScriptCore/JSLock.h>
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
#include <wtf/FileSystem.h>
#include <WebCore/DOMWrapperWorld.h>
#include <WebCore/JSDOMWindowBase.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/ScriptController.h>
#include <emscripten/emscripten.h>
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

EMSCRIPTEN_KEEPALIVE void bl_restore_history(int id, char* data)
{
    withView(id, [data = takeString(data)](WebView& view) { view.restoreHistory(data); });
}

EMSCRIPTEN_KEEPALIVE void bl_go_back(int id) { withView(id, [](WebView& view) { view.goBack(); }); }
EMSCRIPTEN_KEEPALIVE void bl_go_forward(int id) { withView(id, [](WebView& view) { view.goForward(); }); }
EMSCRIPTEN_KEEPALIVE void bl_reload(int id) { withView(id, [](WebView& view) { view.reload(); }); }
EMSCRIPTEN_KEEPALIVE void bl_stop(int id) { withView(id, [](WebView& view) { view.stop(); }); }

// Tab schliessen: erst beforeunload der Seite (mit Rueckfrage), die Antwort
// kommt als Ereignis "try-close"
EMSCRIPTEN_KEEPALIVE void bl_try_close(int id)
{
    runOnEngineThread([id] {
        RefPtr view = WebView::fromID(id);
        RefPtr frame = view ? view->mainFrame() : nullptr;
        bool close = !frame || frame->loader().shouldClose();
        notifyHost(id, "try-close", close ? "{\"close\":true}"_s : "{\"close\":false}"_s);
    });
}

EMSCRIPTEN_KEEPALIVE void bl_resize(int id, int width, int height, float deviceScaleFactor)
{
    withView(id, [=](WebView& view) { view.resize({ width, height }, deviceScaleFactor); });
}

// Vom Host einmal pro requestAnimationFrame, wenn die Engine ein Bild wollte
EMSCRIPTEN_KEEPALIVE void bl_frame(int id)
{
    withView(id, [](WebView& view) { view.presentIfNeeded(); });
}

// Kommt aus dem Worker, der die Canvas bekommt (bl_presenter_thread)
EMSCRIPTEN_KEEPALIVE void bl_canvas_attached(int id)
{
    workerCanvasArrived(id);
    withView(id, [](WebView& view) { view.canvasAttached(); });
}

// pthread des Engine-Threads: die Oberflaeche sucht damit den Worker
EMSCRIPTEN_KEEPALIVE int bl_engine_thread()
{
    return static_cast<int>(reinterpret_cast<uintptr_t>(engineThread()));
}

// pthread, dessen Worker die Canvas der Tabs bekommt: der Compositor-Thread,
// sonst der Engine-Thread
EMSCRIPTEN_KEEPALIVE int bl_presenter_thread()
{
    return static_cast<int>(reinterpret_cast<uintptr_t>(Compositor::presenterThread()));
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

// Ziehen aus dem Host ueber die Seite: phase 0 = darueber, 1 = verlassen,
// 2 = abgelegt. data: JSON mit Text/HTML/URI-Liste und Dateipfaden (WebView::hostDrag)
EMSCRIPTEN_KEEPALIVE void bl_drag(int id, int phase, double x, double y, int modifiers, char* data)
{
    withView(id, [=, json = takeString(data)](WebView& view) { view.hostDrag(phase, x, y, modifiers, json); });
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
    // Mit Compositor-Thread: ueber ihn zum Scroll-Thread (ScrollingWasm.h), so
    // scrollt die Seite auch, wenn ihr JS den Engine-Thread blockiert
    if (Compositor::isRunning()) {
        // Pinch-Zoom, den der Engine-Thread noch nicht zeigt: das Rad
        // verschiebt die skalierte Ansicht, die Seite bekommt das Event nur
        // zum Mitlesen (wie ein passiver wheel-Listener)
        RefPtr scene = CompositorScene::forView(id);
        if (scene && scene->scrollPinch({ static_cast<float>(deltaX), static_cast<float>(deltaY) })) {
            withView(id, [=](WebView& view) {
                view.dispatchWheelEvent(WebView::makeWheelEvent(x, y, deltaX, deltaY, modifiers), { WebCore::WheelEventProcessingSteps::NonBlockingDOMEventDispatch });
            });
            return;
        }
        Compositor::dispatch([=] {
            Scrolling::wheelEvent(id, WebView::makeWheelEvent(x, y, deltaX, deltaY, modifiers));
        });
        return;
    }
    withView(id, [=](WebView& view) { view.wheelEvent(x, y, deltaX, deltaY, modifiers); });
}

// Strg + Rad (Zoom) geht wie in Chrome zuerst an die Seite (Karten, Editoren
// zoomen selber). Rueckgabe 1: die Seite kann preventDefault rufen, die
// Antwort kommt als "wheel-result". 0: nur zum Mitlesen geschickt (kein
// blockierender Listener an der Stelle oder nicht cancelable), die
// Oberflaeche zoomt gleich, auch wenn das JS den Engine-Thread blockiert.
EMSCRIPTEN_KEEPALIVE int bl_zoom_wheel(int id, double x, double y, double deltaX, double deltaY, int modifiers, int cancelable)
{
    auto event = WebView::makeWheelEvent(x, y, deltaX, deltaY, modifiers);
    bool blocking = cancelable && Scrolling::mayCancelWheelEvent(id, event);
    withView(id, [event, blocking](WebView& view) { view.zoomWheelEvent(event, blocking); });
    return blocking;
}

EMSCRIPTEN_KEEPALIVE void bl_key(int id, int type, char* key, char* code, char* text, int keyCode, int repeat, int modifiers)
{
    withView(id, [=, key = takeString(key), code = takeString(code), text = takeString(text)](WebView& view) {
        view.keyEvent(type, key, code, text, keyCode, repeat, modifiers);
    });
}

// Vorschau waehrend der Texteingabe (compositionupdate) und Abschluss (compositionend)
EMSCRIPTEN_KEEPALIVE void bl_set_composition(int id, char* text, int selectionStart, int selectionEnd)
{
    withView(id, [=, text = takeString(text)](WebView& view) { view.setComposition(text, std::max(selectionStart, 0), std::max(selectionEnd, 0)); });
}

EMSCRIPTEN_KEEPALIVE void bl_confirm_composition(int id, char* text)
{
    withView(id, [text = takeString(text)](WebView& view) { view.confirmComposition(text); });
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

// Pinch-Zoom (PinchZoom.h): phase 0 Anfang, 1 Schritt (factor relativ zum
// letzten), 2 Ende, 3 Abbruch; x/y = Mittelpunkt in der View (CSS-Pixel).
// Mit Ebenen skaliert der Compositor-Thread, auch wenn der Engine-Thread
// blockiert ist.
EMSCRIPTEN_KEEPALIVE void bl_pinch(int id, int phase, double factor, double x, double y)
{
    auto pinchPhase = static_cast<PinchPhase>(std::clamp(phase, 0, 3));
    WebCore::FloatPoint focus(x, y);
    if (RefPtr scene = Compositor::isRunning() ? CompositorScene::forView(id) : nullptr) {
        scene->pinch(pinchPhase, factor, focus);
        return;
    }
    withView(id, [=](WebView& view) { view.pinch(pinchPhase, factor, focus); });
}

// Suchen: again = Weitersuchen mit derselben Eingabe (Enter / Shift+Enter)
EMSCRIPTEN_KEEPALIVE void bl_find(int id, char* text, int backwards, int again)
{
    withView(id, [text = takeString(text), backwards, again](WebView& view) { view.find(text, backwards, again); });
}

// Tab stummschalten (Lautsprecher im Tab)
EMSCRIPTEN_KEEPALIVE void bl_set_muted(int id, int muted)
{
    withView(id, [muted](WebView& view) {
        view.page().setMuted(muted ? WebCore::MediaProducerMutedStateFlags { WebCore::MediaProducerMutedState::AudioIsMuted } : WebCore::MediaProducerMutedStateFlags { });
    });
}

// Drucken (Strg+P, Menue): Hauptframe als PDF
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
        else
            free(pixels);
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

// Tab zu sehen (1) oder versteckt (0): im Hintergrund oder der Tab des Host verdeckt
EMSCRIPTEN_KEEPALIVE void bl_set_visible(int id, int visible)
{
    withView(id, [=](WebView& view) { view.setVisible(visible); });
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

// Berechtigungen, Standort, Benachrichtigungen (DeviceClients.cpp).
// answer und decision wie PermissionDecision: 1 = erlaubt, 2 = blockiert,
// 0 = ohne Entscheidung (Abfrage weg, weil der Tab zugeht: nicht gemerkt)
EMSCRIPTEN_KEEPALIVE void bl_permission_answer(int requestId, int answer)
{
    runOnEngineThread([=] { answerPermission(requestId, static_cast<PermissionDecision>(std::clamp(answer, 0, 2))); });
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

// Lage/Bewegung vom Host-Browser (NaN = Wert fehlt)
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

// Antwort der Oberflaeche auf einen Aufruf der Host-Bruecke (WebPlatformExtras.h)
EMSCRIPTEN_KEEPALIVE void bl_host_call_result(double identifier, int ok, char* result)
{
    runOnEngineThread([identifier = static_cast<uint64_t>(identifier), ok, result = takeString(result)] {
        hostCallFinished(identifier, ok, result);
    });
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

EMSCRIPTEN_KEEPALIVE void bl_speech_recognition_event(double id, int type, char* json)
{
    runOnEngineThread([id, type, json = takeString(json)] { speechRecognitionEvent(static_cast<uint64_t>(id), type, json); });
}

EMSCRIPTEN_KEEPALIVE void bl_set_user_agent(char* userAgent)
{
    runOnEngineThread([userAgent = takeString(userAgent)] {
        WebCore::WasmPlatform::setUserAgent(userAgent);
    });
}

// navigator.onLine und die Ereignisse online/offline: Netz des Host-Browsers
// und Verbindung zum Relay (web/app.js)
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

// Einfuegen aus dem Host: {"text":..,"html":..,"files":[Pfade im Dateisystem der Engine]}
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


// Ein Stueck einer Datei der Oberflaeche (Upload, Drag & Drop, Einfuegen) ins
// Dateisystem der Engine schreiben, offset 0 legt sie neu an. Nur im
// Engine-Thread: engine/js/engine-pre.js liest die Dateien des Host dort
// selber in Stuecken. 1: geschrieben
EMSCRIPTEN_KEEPALIVE int bl_write_file(const char* path, const uint8_t* data, int length, double offset)
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
        debugLog("bl_write_file: %s nicht schreibbar", path);
        return 0;
    }
    bool ok = !fseeko(file, static_cast<off_t>(offset), SEEK_SET) && fwrite(data, 1, length, file) == static_cast<size_t>(length);
    return !fclose(file) && ok;
}

// Datei oder Ordner (mit Inhalt) wieder loeschen, z.B. die Uploads eines
// geschlossenen Tabs. Im Engine-Thread nach allem, was vorher kam.
EMSCRIPTEN_KEEPALIVE void bl_remove_path(char* path)
{
    runOnEngineThread([path = takeString(path)] {
        if (FileSystem::fileType(path) == FileSystem::FileType::Directory)
            FileSystem::deleteNonEmptyDirectory(path);
        else
            FileSystem::deleteFile(path);
    });
}

// Datenbanken aus dem Speicher ins Dateisystem schreiben (MemoryVFS.cpp), im
// Engine-Thread (Schreiben nach OPFS). Die Oberflaeche wartet hoechstens
// waitMilliseconds darauf (beim Schliessen des Tabs).
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

// Belegter Speicher (malloc) fuer Tests. mallinfo laeuft ueber den ganzen Heap
// (auf CNN ca. 25 ms) und haelt dabei das Lock von malloc.
EMSCRIPTEN_KEEPALIVE double bl_memory_used()
{
    return static_cast<double>(mallinfo().uordblks);
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

// Fuer Tests, nur mit BL_TEST_HOOKS=1 (Oberflaeche: ?env=BL_TEST_HOOKS=1): ein
// echter Absturz im Engine-Thread. kind 0 = abort(), 1 = WASM-Trap
EMSCRIPTEN_KEEPALIVE void bl_crash_for_testing(int kind)
{
    runOnEngineThread([kind] {
        if (!getenv("BL_TEST_HOOKS"))
            return;
        log("Absturz fuer Tests: %s", kind ? "Trap" : "abort");
        if (kind)
            __builtin_trap();
        abort();
    });
}

#if ENABLE(WEBGL)
// Fuer Tests: die WebGL-Kontexte des Host verlieren, auf denen die WebGL-Canvas
// der Seiten zeichnen (ANGLEShimWasm.cpp)
EMSCRIPTEN_KEEPALIVE void bl_webgl_lose_context_for_testing()
{
    runOnEngineThread([] { WebCore::angleShimLoseHostContextsForTesting(); });
}
#endif
} // extern "C"
