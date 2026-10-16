#include "config.h"
#include "Compositor.h"

#include "Engine.h"
#include "GpuRaster.h"
#include <atomic>
#include <emscripten/emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <unistd.h>
#include <wtf/Vector.h>

#include <GLES2/gl2.h>

namespace WebCore {
// Patch in PlatformDisplaySkia.cpp: GrDirectContext fuer SkiaCompositingLayer
void setSkiaGrContextForWasm(GrDirectContext*);
}

namespace BrowserLite::Compositor {

static pthread_t s_thread;
static std::atomic<bool> s_running { false };
static std::atomic<bool> s_lost { false };
// 0 = startet noch, 1 = laeuft, 2 = kein WebGL 2
static std::atomic<int> s_startState { 0 };

static void* compositorMain(void*)
{
    s_thread = pthread_self();
    // Eigener WebGL-2-Kontext in diesem Worker (GpuRaster.cpp, pro Thread)
    auto* context = Gpu::context();
    if (context)
        WebCore::setSkiaGrContextForWasm(context);
    s_startState.store(context ? 1 : 2, std::memory_order_release);
    if (!context)
        return nullptr;
    // Zurueck in den JS-Event-Loop, der Thread lebt weiter; Arbeit kommt ueber
    // die Proxy-Queue (wie beim Engine-Thread in main.cpp)
    emscripten_exit_with_live_runtime();
    return nullptr;
}

bool start()
{
    const char* compositing = getenv("BL_COMPOSITING");
    if (compositing && !strcmp(compositing, "0"))
        return false;
    const char* gpu = getenv("BL_GPU");
    if (gpu && !atoi(gpu))
        return false;

    pthread_t thread;
    if (pthread_create(&thread, nullptr, compositorMain, nullptr)) {
        debugLog("Compositor: kein Thread");
        return false;
    }
    // Der Worker startet im Haupt-Thread des Browsers, das kann etwas dauern
    for (int i = 0; i < 5000 && !s_startState.load(std::memory_order_acquire); ++i)
        usleep(1000);
    if (s_startState.load(std::memory_order_acquire) != 1) {
        debugLog("Compositor: kein WebGL 2, Bilder kommen aus dem Engine-Worker");
        return false;
    }
    pthread_detach(thread);
    s_running.store(true, std::memory_order_release);
    debugLog("Compositor: eigener Thread mit WebGL 2");
    return true;
}

bool isRunning()
{
    return s_running.load(std::memory_order_acquire);
}

bool isCompositorThread()
{
    return isRunning() && pthread_equal(pthread_self(), s_thread);
}

pthread_t thread()
{
    return isRunning() ? s_thread : 0;
}

pthread_t presenterThread()
{
    return isRunning() ? s_thread : engineThread();
}

static void runFunction(void* argument)
{
    auto* function = static_cast<Function<void()>*>(argument);
    (*function)();
    delete function;
}

void dispatch(Function<void()>&& function)
{
    RELEASE_ASSERT(isRunning());
    auto* heapFunction = new Function<void()>(WTF::move(function));
    if (!emscripten_proxy_async(emscripten_proxy_get_system_queue(), s_thread, runFunction, heapFunction)) {
        delete heapFunction;
        debugLog("Compositor: proxy_async fehlgeschlagen");
    }
}

bool isLost()
{
    return s_lost.load(std::memory_order_acquire);
}

void setLost(bool lost)
{
    s_lost.store(lost, std::memory_order_release);
}

} // namespace BrowserLite::Compositor

// BitmapTexture (Patch 0025) loescht ueber diese Funktion. WebGL-Kennungen
// gelten nur im Worker, der sie angelegt hat: auf einem anderen Thread wuerde
// glDeleteTextures dort eine fremde Textur loeschen. Darum dorthin weiterreichen.
// kind: 0 = Textur, 1 = Framebuffer, 2 = Renderbuffer
extern "C" void bl_skia_ensure_gl_context();
extern "C" void bl_texmap_gl_delete(int kind, int count, const unsigned* ids)
{
    using namespace BrowserLite;
    if (count <= 0)
        return;
    Vector<unsigned> names(std::span { ids, static_cast<size_t>(count) });
    auto run = [kind, names = WTF::move(names)] {
        bl_skia_ensure_gl_context();
        switch (kind) {
        case 0:
            glDeleteTextures(names.size(), names.span().data());
            break;
        case 1:
            glDeleteFramebuffers(names.size(), names.span().data());
            break;
        case 2:
            glDeleteRenderbuffers(names.size(), names.span().data());
            break;
        }
    };
    if (!Compositor::isRunning() || Compositor::isCompositorThread()) {
        run();
        return;
    }
    Compositor::dispatch(WTF::move(run));
}
