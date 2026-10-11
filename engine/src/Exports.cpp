// C-Schnittstelle fuer die Browser-Oberflaeche (JS im Haupt-Thread der Seite).
// Jede Funktion darf von jedem Thread aufgerufen werden; die Arbeit passiert
// asynchron auf dem Engine-Thread. Strings uebergibt der Aufrufer als UTF-8
// (z.B. mit stringToNewUTF8), die Engine gibt sie mit free() frei.

#include "config.h"

#include "Engine.h"
#include "WebView.h"

#include <WebCore/WasmPlatform.h>
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

EMSCRIPTEN_KEEPALIVE void bl_context_menu(int id, double x, double y)
{
    withView(id, [=](WebView& view) { view.contextMenu(x, y); });
}

EMSCRIPTEN_KEEPALIVE void bl_command(int id, char* name)
{
    withView(id, [name = takeString(name)](WebView& view) { view.executeCommand(name); });
}

EMSCRIPTEN_KEEPALIVE void bl_focus(int id, int focused)
{
    withView(id, [=](WebView& view) { view.setFocused(focused); });
}

EMSCRIPTEN_KEEPALIVE void bl_set_screen(int width, int height, int availableWidth, int availableHeight)
{
    runOnEngineThread([=] {
        WebCore::WasmPlatform::ScreenInfo info;
        info.rect = WebCore::FloatRect(0, 0, width, height);
        info.availableRect = WebCore::FloatRect(0, 0, availableWidth, availableHeight);
        WebCore::WasmPlatform::setScreenInfo(info);
    });
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

} // extern "C"
