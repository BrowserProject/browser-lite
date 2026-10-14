// Einstiegspunkt der Engine. main() laeuft dank -sPROXY_TO_PTHREAD in einem
// eigenen Worker-Thread, dem Engine-Thread. Danach kehrt main() mit lebender
// Runtime zurueck und die Engine reagiert nur noch auf Aufrufe (Exports.cpp)
// und den eigenen Event-Loop (EngineLoop.cpp).

#include "config.h"

#include "BytecodeCache.h"
#include "Compositor.h"
#include "Engine.h"
#include "Gamepad.h"
#include "Host.h"
#include "MediaPlayerPrivateWasm.h"
#include "ServiceWorkerWasm.h"
#include "Speech.h"
#include "Storage.h"
#include "Strategies.h"
#include "WebCodecsWasm.h"
#include "wasm/WasmBridge.h"

#include <JavaScriptCore/InitializeThreading.h>
#include <WebCore/BackForwardCache.h>
#include <WebCore/CommonAtomStrings.h>
#include <WebCore/CommonVM.h>
#include <WebCore/MediaPlayer.h>
#include <WebCore/MemoryCache.h>
#include <WebCore/WasmPlatform.h>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fontconfig/fontconfig.h>
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <sys/stat.h>
#include <utime.h>
#include <wtf/MainThread.h>
#include <wtf/Threading.h>
#include <wtf/text/MakeString.h>

// Der fontconfig-Cache im Datenpaket (deps/tools/fc-precache.c) gilt nur, wenn
// die Schrift-Ordner die mtime 0 haben. Sonst liest fontconfig beim ersten
// Seitenaufbau alle Schriften neu ein (ueber 5 Sekunden).
static void prepareFontCache(const char* path)
{
    struct utimbuf times = { 0, 0 };
    if (DIR* dir = opendir(path)) {
        while (auto* entry = readdir(dir)) {
            if (entry->d_name[0] == '.')
                continue;
            auto child = makeString(String::fromUTF8(path), '/', String::fromUTF8(entry->d_name)).utf8();
            struct stat info;
            if (!stat(child.data(), &info) && S_ISDIR(info.st_mode))
                prepareFontCache(child.data());
        }
        closedir(dir);
    }
    utime(path, &times);
}

#if ENABLE(WEBGL)
namespace WebCore {
// platform/wasm/angle/ANGLEShimWasm.h (kein exportierter Header)
void angleShimPrewarm();
}
#endif

int main(int, char**)
{
    using namespace BrowserLite;

    setEngineThread();

    // fontconfig liest seine Konfiguration aus dem virtuellen Dateisystem
    // (Datenpaket aus sysroot/runtime, siehe engine.cmake)
    setenv("FONTCONFIG_FILE", "/etc/fonts/fonts.conf", 1);
    prepareFontCache("/usr/share/fonts");

    JSC::initialize();
    WTF::initializeMainThread();

    // fontconfig gleich im Hintergrund einrichten: es liest seine Konfiguration
    // mit vielen Dateizugriffen, die alle synchron ueber den UI-Thread laufen.
    // Sonst passiert das mitten im Laden der ersten Seite (CNN: 0.5 s im
    // Engine-Thread, bei der ersten Style-Berechnung).
    if (const char* value = getenv("BL_FONTCONFIG_EARLY"); !value || strcmp(value, "0"))
        Thread::create("fontconfig"_s, [] { FcInit(); })->detach();
    WebCore::initializeCommonAtomStrings();
    initializeStorage();
    // VM gleich anlegen: ab jetzt laeuft jede Arbeit mit DeferGC (EngineLoop.cpp)
    WebCore::commonVM();
    installPlatformStrategies();
    installPermissionController();
    installGamepadProvider();
    installSpeech();
    // Service Worker der Seiten (ServiceWorkerWasm.cpp)
    ServiceWorkers::initialize();
    // <video>/<audio> ueber das Host-<video> (media/)
    WebCore::MediaPlayerFactorySupport::callRegisterMediaEngine(MediaPlayerPrivateWasm::registerMediaEngine);
    // WebCodecs der Seiten ueber die WebCodecs des Host (media/WebCodecsWasm.cpp)
    WebCodecs::initialize();
    BytecodeCache::initialize();
    BrowserLite::initializeWebAssembly();
    initializeEngineLoop();
    // Eigener Thread fuer Compositing und Anzeige (braucht WebGL 2)
    Compositor::start();

    // Kopieren in der Seite -> echte Zwischenablage (der Host schreibt sie)
    WebCore::WasmPlatform::setClipboardChangedCallback([](const WebCore::WasmPlatform::ClipboardItems& items) {
        // Mit HTML, damit formatierter Text formatiert ankommt (wie in Chrome)
        String text;
        String html;
        for (auto& [type, value] : items) {
            if (type.startsWith("text/plain"_s))
                text = value;
            else if (type == "text/html"_s)
                html = value;
        }
        if (text.isNull() && html.isNull())
            return;
        notifyHost(0, "clipboard", makeString("{\"text\":\""_s, jsonEscape(text), "\",\"html\":\""_s, jsonEscape(html), "\"}"_s));
    });

    // Standard von WebCore ist 8 MB, eine moderne Seite verdraengt damit alles
    WebCore::MemoryCache::singleton().setCapacities(0, 16 * 1024 * 1024, 64 * 1024 * 1024);
    // Zurueck/Vor ohne Neuladen wie in Chrome (Back/Forward-Cache): die letzten
    // Seiten bleiben angehalten im Speicher. Bei Speicherdruck gibt
    // releaseMemory (EngineLoop.cpp) sie frei. Standard von WebCore ist 0.
    WebCore::BackForwardCache::singleton().setMaxSize(3);

#if ENABLE(WEBGL)
    // WebGL-Kontexte des Host gleich als erste Aufgabe anlegen, solange die
    // GPU noch nichts zu tun hat (ANGLEShimWasm.cpp)
    callOnMainThread([] {
        WebCore::angleShimPrewarm();
    });
#endif

    log("Engine bereit");
    MAIN_THREAD_ASYNC_EM_ASM({
        if (Module.onEngineReady)
            Module.onEngineReady();
    });

    emscripten_exit_with_live_runtime();
    return 0;
}
