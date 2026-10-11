// Einstiegspunkt der Engine. main() laeuft dank -sPROXY_TO_PTHREAD in einem
// eigenen Worker-Thread, dem Engine-Thread. Danach kehrt main() mit lebender
// Runtime zurueck und die Engine reagiert nur noch auf Aufrufe (Exports.cpp)
// und den eigenen Event-Loop (EngineLoop.cpp).

#include "config.h"

#include "Engine.h"
#include "Host.h"
#include "Strategies.h"

#include <JavaScriptCore/InitializeThreading.h>
#include <WebCore/CommonAtomStrings.h>
#include <WebCore/MemoryCache.h>
#include <WebCore/WasmPlatform.h>
#include <cstdlib>
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <wtf/MainThread.h>

int main(int, char**)
{
    using namespace BrowserLite;

    setEngineThread();

    // fontconfig liest seine Konfiguration aus dem virtuellen Dateisystem
    // (Datenpaket aus sysroot/runtime, siehe engine.cmake)
    setenv("FONTCONFIG_FILE", "/etc/fonts/fonts.conf", 1);

    JSC::initialize();
    WTF::initializeMainThread();
    WebCore::initializeCommonAtomStrings();
    installPlatformStrategies();
    initializeEngineLoop();

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
