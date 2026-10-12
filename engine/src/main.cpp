// Einstiegspunkt der Engine. main() laeuft dank -sPROXY_TO_PTHREAD in einem
// eigenen Worker-Thread, dem Engine-Thread. Danach kehrt main() mit lebender
// Runtime zurueck und die Engine reagiert nur noch auf Aufrufe (Exports.cpp)
// und den eigenen Event-Loop (EngineLoop.cpp).

#include "config.h"

#include "Engine.h"
#include "Host.h"
#include "MediaPlayerPrivateWasm.h"
#include "Storage.h"
#include "Strategies.h"
#include "wasm/WasmBridge.h"

#include <JavaScriptCore/InitializeThreading.h>
#include <WebCore/CommonAtomStrings.h>
#include <WebCore/CommonVM.h>
#include <WebCore/MediaPlayer.h>
#include <WebCore/MemoryCache.h>
#include <WebCore/WasmPlatform.h>
#include <cstdlib>
#include <dirent.h>
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <sys/stat.h>
#include <utime.h>
#include <wtf/MainThread.h>
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
    WebCore::initializeCommonAtomStrings();
    initializeStorage();
    // VM gleich anlegen: ab jetzt laeuft jede Arbeit mit DeferGC (EngineLoop.cpp)
    WebCore::commonVM();
    installPlatformStrategies();
    // <video>/<audio> ueber das Host-<video> (media/)
    WebCore::MediaPlayerFactorySupport::callRegisterMediaEngine(MediaPlayerPrivateWasm::registerMediaEngine);
    BrowserLite::initializeWebAssembly();
    initializeEngineLoop();

    // Kopieren in der Seite -> echte Zwischenablage (der Host schreibt sie)
    WebCore::WasmPlatform::setClipboardChangedCallback([](const WebCore::WasmPlatform::ClipboardItems& items) {
        for (auto& [type, text] : items) {
            if (type.startsWith("text/plain"_s)) {
                notifyHost(0, "clipboard", makeString("{\"text\":\""_s, jsonEscape(text), "\"}"_s));
                return;
            }
        }
    });

    // Standard von WebCore ist 8 MB, eine moderne Seite verdraengt damit alles
    WebCore::MemoryCache::singleton().setCapacities(0, 16 * 1024 * 1024, 64 * 1024 * 1024);

    log("Engine bereit");
    MAIN_THREAD_ASYNC_EM_ASM({
        if (Module.onEngineReady)
            Module.onEngineReady();
    });

    emscripten_exit_with_live_runtime();
    return 0;
}
