#include "config.h"
#include "GpuRaster.h"

#include "Compositor.h"
#include "Engine.h"
#include "WebView.h"

#include <cstdlib>
#include <emscripten/emscripten.h>
#include <emscripten/html5_webgl.h>
#include <skia/core/SkCanvas.h>
#include <skia/core/SkColorSpace.h>
#include <skia/core/SkImage.h>
#include <skia/core/SkSurface.h>
#include <skia/gpu/ganesh/GrBackendSurface.h>
#include <skia/gpu/ganesh/GrDirectContext.h>
#include <skia/gpu/ganesh/SkSurfaceGanesh.h>
#include <skia/gpu/ganesh/gl/GrGLBackendSurface.h>
#include <skia/gpu/ganesh/gl/GrGLDirectContext.h>
#include <skia/gpu/ganesh/gl/GrGLInterface.h>
#include <skia/gpu/ganesh/gl/GrGLMakeWebGLInterface.h>
#include <skia/gpu/ganesh/gl/GrGLTypes.h>

// Eigener WebGL-2-Kontext auf einem OffscreenCanvas im Engine-Worker. Ohne
// Tiefe und Antialiasing: Skia malt in eigene Texturen, der Framebuffer bekommt
// nur das fertige Bild. Stencil braucht Skia fuer manche Pfade.
EM_JS(int, bl_gpu_create_context, (), {
    if (typeof OffscreenCanvas === "undefined")
        return 0;
    var canvas = new OffscreenCanvas(1, 1);
    var handle = 0;
    try {
        handle = GL.createContext(canvas, {
            majorVersion: 2, minorVersion: 0, alpha: false, depth: false, stencil: true,
            antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false,
            powerPreference: "high-performance", failIfMajorPerformanceCaveat: false,
            enableExtensionsByDefault: 1
        }) || 0;
    } catch (e) {
        handle = 0;
    }
    if (handle) {
        Module.blGpuCanvas = canvas;
        // GPU zurueckgesetzt (Treiber, Speicher, Ruhezustand). preventDefault:
        // der Browser stellt den Kontext wieder her, sobald es geht
        canvas.addEventListener("webglcontextlost", function (event) {
            event.preventDefault();
            Module._bl_gpu_context_lost_event();
        });
        canvas.addEventListener("webglcontextrestored", function () { Module._bl_gpu_context_restored_event(); });
    }
    return handle;
});

// Der Browser hat den Kontext wiederhergestellt: dasselbe WebGL-Objekt, aber
// ohne die Erweiterungen, die Emscripten beim Anlegen eingeschaltet hat. Neu
// angemeldet schaltet Emscripten sie wieder ein, ein neues Canvas braeuchte
// einen weiteren der wenigen WebGL-Kontexte pro Worker.
EM_JS(int, bl_gpu_register_restored_context, (int handle), {
    var context = GL.contexts[handle];
    if (!context || context.GLctx.isContextLost())
        return 0;
    GL.deleteContext(handle);
    return GL.registerContext(context.GLctx, context.attributes);
});

EM_JS(int, bl_gpu_current_context, (), {
    return GL.currentContext ? GL.currentContext.handle : 0;
});

EM_JS(int, bl_gpu_make_current, (int handle), {
    if (GL.currentContext === (handle ? GL.contexts[handle] : null))
        return 1;
    return GL.makeContextCurrent(handle) ? 1 : 0;
});

EM_JS(int, bl_gpu_context_lost, (int handle), {
    var context = GL.contexts[handle];
    return !context || context.GLctx.isContextLost() ? 1 : 0;
});

// Framebuffer auf die Groesse des Views; 0 wenn der View kein Canvas hier hat
EM_JS(int, bl_gpu_prepare, (int viewId, int width, int height), {
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    if (!target || !Module.blGpuCanvas)
        return 0;
    var canvas = Module.blGpuCanvas;
    if (canvas.width != width || canvas.height != height) {
        canvas.width = width;
        canvas.height = height;
    }
    return 1;
});

// Das fertige Bild ohne Kopie in das Canvas des Tabs
EM_JS(int, bl_gpu_transfer, (int viewId), {
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    if (!target)
        return 0;
    if (!target.bitmapContext) {
        target.bitmapContext = target.canvas.getContext("bitmaprenderer");
        if (!target.bitmapContext)
            return 0;
    }
    var image = Module.blGpuCanvas.transferToImageBitmap();
    if (target.canvas.width != image.width || target.canvas.height != image.height) {
        target.canvas.width = image.width;
        target.canvas.height = image.height;
    }
    target.bitmapContext.transferFromImageBitmap(image);
    return 1;
});

namespace WebCore {
// Patch in PlatformDisplaySkia.cpp: GrDirectContext fuer den Compositor
void setSkiaGrContextForWasm(GrDirectContext*);
}

namespace BrowserLite::Gpu {

// Pro Thread: der Engine-Thread (Malen ohne Ebenen) und der Compositor-Thread
// (Compositor.cpp) haben je einen eigenen Kontext in ihrem Worker
static thread_local int s_handle;
static thread_local sk_sp<GrDirectContext> s_context;
static thread_local bool s_tried;

static bool enabled()
{
    static bool enabled = [] {
        const char* value = getenv("BL_GPU");
        return !value || atoi(value);
    }();
    return enabled;
}

static void dropLostContext()
{
    log("GPU: WebGL-Kontext verloren, male auf der CPU");
    s_context->abandonContext();
    s_context = nullptr;
    // Der Compositor (LayerTreeHostWasm) darf ihn nicht mehr benutzen
    if (Compositor::isCompositorThread()) {
        WebCore::setSkiaGrContextForWasm(nullptr);
        Compositor::setLost(true);
    }
}

// Skia auf dem WebGL-Kontext s_handle
static bool createSkiaContext()
{
    int previous = bl_gpu_current_context();
    bl_gpu_make_current(s_handle);
    auto interface = GrGLInterfaces::MakeWebGL();
    if (interface)
        s_context = GrDirectContexts::MakeGL(WTF::move(interface));
    bl_gpu_make_current(previous);
    return !!s_context;
}

GrDirectContext* context()
{
    if (s_context && bl_gpu_context_lost(s_handle)) {
        dropLostContext();
        return nullptr;
    }
    if (s_context || s_tried || !enabled())
        return s_context.get();
    s_tried = true;

    s_handle = bl_gpu_create_context();
    if (!s_handle) {
        debugLog("GPU: kein WebGL 2, male auf der CPU");
        return nullptr;
    }
    if (!createSkiaContext()) {
        debugLog("GPU: Skia konnte WebGL 2 nicht nutzen, male auf der CPU");
        return nullptr;
    }
    debugLog("GPU: Skia malt ueber WebGL 2");
    return s_context.get();
}

// Im wiederhergestellten Kontext sind alle GL-Objekte weg, Skia faengt neu an
static GrDirectContext* recreateContext()
{
    if (s_context || !s_handle)
        return s_context.get();
    // 0: schon wieder verloren, die naechste Wiederherstellung versucht es erneut
    int handle = bl_gpu_register_restored_context(s_handle);
    if (handle)
        s_handle = handle;
    auto* gr = handle && createSkiaContext() ? s_context.get() : nullptr;
    if (gr && Compositor::isCompositorThread()) {
        WebCore::setSkiaGrContextForWasm(gr);
        Compositor::setLost(false);
    }
    log(gr ? "GPU: WebGL-Kontext wieder da" : "GPU: wiederhergestellter WebGL-Kontext nicht nutzbar, male weiter auf der CPU");
    return gr;
}

Scope::Scope()
{
    if (!context())
        return;
    m_previous = bl_gpu_current_context();
    m_active = bl_gpu_make_current(s_handle);
}

Scope::~Scope()
{
    if (m_active)
        bl_gpu_make_current(m_previous);
}

sk_sp<SkSurface> createSurface(int width, int height)
{
    auto* gr = context();
    if (!gr)
        return nullptr;
    auto info = SkImageInfo::Make(width, height, kRGBA_8888_SkColorType, kPremul_SkAlphaType);
    return SkSurfaces::RenderTarget(gr, skgpu::Budgeted::kNo, info, 0, kTopLeft_GrSurfaceOrigin, nullptr);
}

bool present(int viewId, SkSurface& surface)
{
    auto* gr = context();
    if (!gr || !bl_gpu_prepare(viewId, surface.width(), surface.height()))
        return false;

    // Framebuffer 0 des WebGL-Kontexts (Ursprung unten links wie bei GL)
    GrGLFramebufferInfo framebuffer { 0, 0x8058 /* GL_RGBA8 */ };
    auto target = GrBackendRenderTargets::MakeGL(surface.width(), surface.height(), 0, 8, framebuffer);
    auto screen = SkSurfaces::WrapBackendRenderTarget(gr, target, kBottomLeft_GrSurfaceOrigin, kRGBA_8888_SkColorType, nullptr, nullptr);
    if (!screen)
        return false;
    surface.draw(screen->getCanvas(), 0, 0);
    gr->flushAndSubmit(screen.get());
    return bl_gpu_transfer(viewId);
}

sk_sp<SkSurface> framebufferSurface(int viewId, int width, int height)
{
    auto* gr = context();
    if (!gr || width <= 0 || height <= 0 || !bl_gpu_prepare(viewId, width, height))
        return nullptr;
    GrGLFramebufferInfo framebuffer { 0, 0x8058 /* GL_RGBA8 */ };
    auto target = GrBackendRenderTargets::MakeGL(width, height, 0, 8, framebuffer);
    return SkSurfaces::WrapBackendRenderTarget(gr, target, kBottomLeft_GrSurfaceOrigin, kRGBA_8888_SkColorType, nullptr, nullptr);
}

bool showFramebuffer(int viewId)
{
    return bl_gpu_transfer(viewId);
}

} // namespace BrowserLite::Gpu

// Kontext verloren: die Views malen auf der CPU alles neu. Kommt wie die
// Wiederherstellung vom Worker, dem der Kontext gehoert (Engine- oder
// Compositor-Thread).
extern "C" EMSCRIPTEN_KEEPALIVE void bl_gpu_context_lost_event()
{
    using namespace BrowserLite;
    if (Gpu::s_context)
        Gpu::dropLostContext();
    if (Compositor::isCompositorThread()) {
        runOnEngineThread([] {
            WebView::forEach([](WebView& view) {
                view.compositorLost();
            });
        });
        return;
    }
    WebView::forEach([](WebView& view) {
        view.gpuLost();
    });
}

// Wieder GPU. Im Engine-Thread malen alle Views wieder darauf. Mit Compositor
// bekommen neue Views wieder Ebenen (LayerTreeHostWasm::isAvailable), Views,
// die beim Verlust auf die CPU gewechselt sind, bleiben ohne Ebenen.
extern "C" EMSCRIPTEN_KEEPALIVE void bl_gpu_context_restored_event()
{
    using namespace BrowserLite;
    if (!Gpu::recreateContext() || Compositor::isCompositorThread())
        return;
    int views = 0;
    WebView::forEach([&](WebView& view) {
        views += view.gpuRestored();
    });
    log("GPU: Views wieder auf der GPU: %d", views);
}

// Fuer Tests: den Kontext absichtlich verlieren und wiederherstellen
// (WEBGL_lose_context), mit Compositor-Thread dessen Kontext
static void runOnGpuThreadForTesting(Function<void()>&& function)
{
    if (BrowserLite::Compositor::isRunning())
        BrowserLite::Compositor::dispatch(WTF::move(function));
    else
        BrowserLite::runOnEngineThread(WTF::move(function));
}

extern "C" EMSCRIPTEN_KEEPALIVE void bl_gpu_lose_context_for_testing()
{
    runOnGpuThreadForTesting([] {
        using namespace BrowserLite::Gpu;
        if (!s_handle)
            return;
        // restoreContext wirkt erst nach dem Event webglcontextlost (preventDefault),
        // also ab der naechsten Aufgabe: kommt die Wiederherstellung frueher, folgt
        // sie gleich darauf
        EM_ASM({
            var context = GL.contexts[$0];
            var extension = context && context.GLctx.getExtension("WEBGL_lose_context");
            if (!extension)
                return;
            var lost = false;
            var restoreWhenLost = false;
            Module.blGpuRestoreForTesting = function () {
                if (lost)
                    extension.restoreContext();
                else
                    restoreWhenLost = true;
            };
            context.GLctx.canvas.addEventListener("webglcontextlost", function () {
                setTimeout(function () {
                    lost = true;
                    if (restoreWhenLost)
                        extension.restoreContext();
                });
            }, { once: true });
            extension.loseContext();
        }, s_handle);
    });
}

extern "C" EMSCRIPTEN_KEEPALIVE void bl_gpu_restore_context_for_testing()
{
    runOnGpuThreadForTesting([] {
        EM_ASM({
            if (Module.blGpuRestoreForTesting)
                Module.blGpuRestoreForTesting();
            Module.blGpuRestoreForTesting = null;
        });
    });
}

// Ruft Skia vor jedem GL-Aufruf auf (Patch 0020, GrGLAssembleWebGLInterfaceAutogen.cpp):
// WebGL der Seiten wechselt den Kontext auch mitten im Malen
extern "C" void bl_skia_ensure_gl_context()
{
    using namespace BrowserLite::Gpu;
    if (s_handle && emscripten_webgl_get_current_context() != static_cast<EMSCRIPTEN_WEBGL_CONTEXT_HANDLE>(s_handle))
        emscripten_webgl_make_context_current(static_cast<EMSCRIPTEN_WEBGL_CONTEXT_HANDLE>(s_handle));
}
