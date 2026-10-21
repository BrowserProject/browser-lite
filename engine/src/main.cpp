// Engine entry point. Thanks to -sPROXY_TO_PTHREAD main() runs in its own
// worker thread, the engine thread. Afterwards main() returns with a live
// runtime and the engine only reacts to calls (Exports.cpp) and its own event
// loop (EngineLoop.cpp).

#include "config.h"

#include "Compositor.h"
#include "Engine.h"
#include "EngineConfig.h"
#include "Gamepad.h"
#include "Host.h"
#include "Measurements.h"
#include "MediaPlayerPrivateWasm.h"
#include "ServiceWorkerWasm.h"
#include "Speech.h"
#include "Storage.h"
#include "Strategies.h"
#include "WebCodecsWasm.h"
#include "wasm/WasmBridge.h"

#include <JavaScriptCore/InitializeThreading.h>
#include <WebCore/ANGLEShimWasm.h>
#include <WebCore/BackForwardCache.h>
#include <WebCore/CommonAtomStrings.h>
#include <WebCore/CommonVM.h>
#include <WebCore/MediaPlayer.h>
#include <WebCore/MemoryCache.h>
#include <WebCore/WasmPlatform.h>
#include <atomic>
#include <cstdlib>
#include <cstdio>
#include <sys/stat.h>
#include <unistd.h>
#include <cstring>
#include <dirent.h>
#include <fontconfig/fontconfig.h>
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <utime.h>
#include <wtf/MainThread.h>
#include <wtf/Threading.h>
#include <wtf/text/MakeString.h>

// The fontconfig cache in the data package (deps/tools/fc-precache.c) is only
// valid if the font folders have mtime 0. Otherwise fontconfig rescans all
// fonts on the first layout (over 5 seconds).
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

// The 8 prepared web workers (PTHREAD_POOL_SIZE) are taken quickly on the
// first load. Every further thread (data: URLs, IndexedDB, images, blobs) then
// starts a new worker and the engine thread waits until it runs (CNN: about
// 1 s). So right after the start load a few more workers, asynchronously on
// the main thread, without waiting for them, until the pool and the spare
// workers exist (workers started for threads meanwhile count). A bigger pool
// (#133) delays the engine start instead.
void BrowserLite::addSpareWorkers(SpareWorkersAt moment)
{
    static std::atomic<bool> added { false };
    auto& config = engineConfig();
    if (moment != config.spareWorkersAt || config.spareWorkers <= 0 || added.exchange(true))
        return;
    MAIN_THREAD_ASYNC_EM_ASM({
        var workers = PThread.unusedWorkers.length + Object.keys(PThread.pthreads).length;
        for (; workers < Module.blPoolWorkers + $0; workers++)
            PThread.loadWasmModuleToWorker(PThread.allocateUnusedWorker());
    }, config.spareWorkers);
}

int main(int, char**)
{
    using namespace BrowserLite;
    Measurements::mark(Measurements::Mark::Main);

    // Before any other thread starts; the file system (WasmFS for BL_EXTRA_CA)
    // only exists from main() on
    loadEngineConfig();
    setEngineThread();
    auto& config = engineConfig();

    // fontconfig reads its configuration from the virtual file system
    // (data package from sysroot/runtime, see engine.cmake)
    setenv("FONTCONFIG_FILE", "/etc/fonts/fonts.conf", 1);
    prepareFontCache("/usr/share/fonts");

    // All views share curl. WebKit allows 6 connections per host (like Chrome) but
    // only 17 in total: a few long polls in background views kept the active view
    // waiting. 64 is far below the 256 streams of the relay, room for WebSockets.
    setenv("WEBKIT_CURL_MAX_TOTAL_CONNECTIONS", "64", 0);

    JSC::initialize();
    WTF::initializeMainThread();

    // Set up fontconfig in the background right away: it reads its configuration
    // with many file accesses. Otherwise that happens in the middle of loading the
    // first page (CNN: 0.5 s on the engine thread, at the first style resolution).
    if (config.fontconfigEarly)
        Thread::create("fontconfig"_s, [] {
            FcInit();
            // Program name for the rules of the configuration: fontconfig gets it via
            // readlink("/proc/self/exe") through the UI thread, otherwise at the first
            // font lookup of the page (CNN: 0.5 s waiting on the engine thread)
            // (FcConfigSubstitute fetches it internally and remembers it)
            if (FcPattern* pattern = FcPatternCreate()) {
                FcConfigSubstitute(nullptr, pattern, FcMatchPattern);
                FcPatternDestroy(pattern);
            }
            // Skia checks with access() whether a font file is readable; the answers
            // are remembered by FileAccessCache.cpp, the first one otherwise cost a
            // wait for the UI thread in the middle of loading (CNN: 0.45 s)
            if (FcFontSet* fonts = FcConfigGetFonts(nullptr, FcSetSystem)) {
                for (int i = 0; i < fonts->nfont; ++i) {
                    FcChar8* file = nullptr;
                    if (FcPatternGetString(fonts->fonts[i], FC_FILE, 0, &file) == FcResultMatch)
                        access(reinterpret_cast<const char*>(file), R_OK);
                }
            }
        })->detach();
    // Spare web workers (see addSpareWorkers)
    addSpareWorkers(SpareWorkersAt::Start);
    WebCore::initializeCommonAtomStrings();
    initializeStorage();
    // Create the VM right away: from now on all work runs with DeferGC (EngineLoop.cpp)
    WebCore::commonVM();
    installPlatformStrategies();
    installPermissionController();
    // Without these features WebCore keeps its empty implementations
    if (featureEnabled(Feature::Gamepad))
        installGamepadProvider();
    if (featureEnabled(Feature::Speech))
        installSpeech();
    // Service workers of the pages (ServiceWorkerWasm.cpp)
    ServiceWorkers::initialize();
    // <video>/<audio> through the host <video> (media/). Always registered:
    // srcObject streams play without the media feature, files and MSE do not
    WebCore::MediaPlayerFactorySupport::callRegisterMediaEngine(MediaPlayerPrivateWasm::registerMediaEngine);
    // WebCodecs of the pages through the WebCodecs of the host (media/WebCodecsWasm.cpp)
    WebCodecs::initialize();
    BrowserLite::initializeWebAssembly();
    initializeEngineLoop();
    // Own thread for compositing and presentation (needs WebGL 2)
    Compositor::start();

    // Copy in the page -> real clipboard (the host writes it). Always on: the
    // clipboard feature only gates navigator.clipboard of the pages (WebView.cpp).
    WebCore::WasmPlatform::setClipboardChangedCallback([](const WebCore::WasmPlatform::ClipboardItems& items) {
        // With HTML, so formatted text arrives formatted (like in Chrome)
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

    // The WebCore default is 8 MB, a modern page evicts everything with that
    WebCore::MemoryCache::singleton().setCapacities(0, 16 * 1024 * 1024, 64 * 1024 * 1024);
    // Back/forward without reloading like in Chrome (back/forward cache): the last
    // pages stay suspended in memory. Under memory pressure releaseMemory
    // (EngineLoop.cpp) frees them. The WebCore default is 0.
    WebCore::BackForwardCache::singleton().setMaxSize(3);

#if ENABLE(WEBGL)
    // Create the host WebGL contexts as the first task, while the GPU has
    // nothing to do yet (ANGLEShimWasm.cpp)
    callOnMainThread([] {
        WebCore::angleShimPrewarm();
    });
#endif

    log("Engine ready");
    Measurements::mark(Measurements::Mark::Ready);
    addSpareWorkers(SpareWorkersAt::Ready);
    MAIN_THREAD_ASYNC_EM_ASM({
        if (Module.onEngineReady)
            Module.onEngineReady();
    });

    emscripten_exit_with_live_runtime();
    return 0;
}
