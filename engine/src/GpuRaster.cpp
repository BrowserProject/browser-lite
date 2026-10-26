#include "config.h"
#include "GpuRaster.h"

#include "Compositor.h"
#include "Engine.h"
#include "EngineConfig.h"
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

// Own WebGL 2 context on an OffscreenCanvas in the engine worker. Without depth
// and antialiasing: Skia paints into its own textures, the framebuffer only
// gets the finished frame. Skia needs stencil for some paths. With alpha (the
// compositor with video overlays, #232) the holes of videos stay transparent.
EM_JS(int, bl_gpu_create_context, (int alpha), {
    if (typeof OffscreenCanvas === "undefined")
        return 0;
    var canvas = new OffscreenCanvas(1, 1);
    var handle = 0;
    try {
        handle = GL.createContext(canvas, {
            majorVersion: 2, minorVersion: 0, alpha: !!alpha, depth: false, stencil: true,
            antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false,
            powerPreference: "high-performance", failIfMajorPerformanceCaveat: false,
            enableExtensionsByDefault: 1
        }) || 0;
    } catch (e) {
        handle = 0;
    }
    if (handle) {
        Module.blGpuCanvas = canvas;
        // GPU reset (driver, memory, sleep). preventDefault: the browser
        // restores the context as soon as it can
        canvas.addEventListener("webglcontextlost", function (event) {
            event.preventDefault();
            Module._bl__gpu_context_lost_event();
        });
        canvas.addEventListener("webglcontextrestored", function () { Module._bl__gpu_context_restored_event(); });
    }
    return handle;
});

// The browser restored the context: the same WebGL object, but without the
// extensions Emscripten enabled on creation. Registered anew, Emscripten
// enables them again; a new canvas would need another one of the few WebGL
// contexts per worker.
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

// Framebuffer in the size of the view; 0 if the view has no canvas here
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

// The finished frame without a copy into the canvas of the view
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
// Patch in PlatformDisplaySkia.cpp: GrDirectContext for the compositor
void setSkiaGrContextForWasm(GrDirectContext*);
}

namespace BrowserLite::Gpu {

// Per thread: the engine thread (painting without layers) and the compositor
// thread (Compositor.cpp) each have their own context in their worker
static thread_local int s_handle;
static thread_local sk_sp<GrDirectContext> s_context;
static thread_local bool s_tried;

static bool enabled()
{
    return engineConfig().gpu;
}

static void dropLostContext()
{
    log("GPU: WebGL context lost, painting on the CPU");
    s_context->abandonContext();
    s_context = nullptr;
    // The compositor (LayerTreeHostWasm) must not use it anymore
    if (Compositor::isCompositorThread()) {
        WebCore::setSkiaGrContextForWasm(nullptr);
        Compositor::setLost(true);
    }
}

// Skia on the WebGL context s_handle
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

    s_handle = bl_gpu_create_context(Compositor::isCompositorThread() && engineConfig().videoOverlay);
    if (!s_handle) {
        debugLog("GPU: no WebGL 2, painting on the CPU");
        return nullptr;
    }
    if (!createSkiaContext()) {
        debugLog("GPU: Skia could not use WebGL 2, painting on the CPU");
        return nullptr;
    }
    debugLog("GPU: Skia paints through WebGL 2");
    return s_context.get();
}

// In the restored context all GL objects are gone, Skia starts over
static GrDirectContext* recreateContext()
{
    if (s_context || !s_handle)
        return s_context.get();
    // 0: lost again already, the next restoration tries again
    int handle = bl_gpu_register_restored_context(s_handle);
    if (handle)
        s_handle = handle;
    auto* gr = handle && createSkiaContext() ? s_context.get() : nullptr;
    if (gr && Compositor::isCompositorThread()) {
        WebCore::setSkiaGrContextForWasm(gr);
        Compositor::setLost(false);
    }
    log(gr ? "GPU: WebGL context is back" : "GPU: restored WebGL context not usable, still painting on the CPU");
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

    // Framebuffer 0 of the WebGL context (origin bottom left like in GL)
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

// Context lost: the views repaint everything on the CPU. Comes like the
// restoration from the worker that owns the context (engine or compositor
// thread).
extern "C" EMSCRIPTEN_KEEPALIVE void bl__gpu_context_lost_event()
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

// GPU again. On the engine thread all views paint on it again. With the
// compositor, new views get layers again (LayerTreeHostWasm::isAvailable),
// views that switched to the CPU on the loss stay without layers.
extern "C" EMSCRIPTEN_KEEPALIVE void bl__gpu_context_restored_event()
{
    using namespace BrowserLite;
    if (!Gpu::recreateContext() || Compositor::isCompositorThread())
        return;
    int views = 0;
    WebView::forEach([&](WebView& view) {
        views += view.gpuRestored();
    });
    log("GPU: views back on the GPU: %d", views);
}

// For tests: lose and restore the context on purpose (WEBGL_lose_context),
// with the compositor thread its context
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
        // restoreContext only works after the webglcontextlost event
        // (preventDefault), so from the next task on: if the restoration comes
        // earlier, it follows right after
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

// Skia calls this before every GL call (patch 0020, GrGLAssembleWebGLInterfaceAutogen.cpp):
// WebGL of the pages switches the context even in the middle of painting
extern "C" void bl_skia_ensure_gl_context()
{
    using namespace BrowserLite::Gpu;
    if (s_handle && emscripten_webgl_get_current_context() != static_cast<EMSCRIPTEN_WEBGL_CONTEXT_HANDLE>(s_handle))
        emscripten_webgl_make_context_current(static_cast<EMSCRIPTEN_WEBGL_CONTEXT_HANDLE>(s_handle));
}
