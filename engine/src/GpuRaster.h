// GPU rasterization: Skia (Ganesh) paints through the browser's WebGL 2.
//
// One WebGL 2 context per thread, each on its own OffscreenCanvas: the engine
// thread paints views without layers, the compositor thread (Compositor.h)
// composites the layers. Every view has a target surface (texture). For
// presentation it goes into the framebuffer of the context and from there via
// transferToImageBitmap without a copy into the canvas of the view
// (engine-pre.js).
//
// Our WebGL bridge (platform/wasm/angle) switches GL contexts itself. So Skia
// makes its context current before every GL call (patch 0020), everything else
// that needs GL runs inside a Gpu::Scope.
//
// After a context loss the thread paints on the CPU until the browser restores
// the context. Then Skia gets a new one.
#pragma once

#include <skia/core/SkRefCnt.h>

class GrDirectContext;
class SkSurface;

namespace BrowserLite::Gpu {

// The context of this thread, created on the first call. nullptr without
// WebGL 2, after a loss or when turned off (BL_GPU=0).
GrDirectContext* context();

// Makes Skia's GL context current and afterwards the previous one again
class Scope {
public:
    Scope();
    ~Scope();
    explicit operator bool() const { return m_active; }

private:
    int m_previous { 0 };
    bool m_active { false };
};

// Target surface for a view (texture, the content stays between frames)
sk_sp<SkSurface> createSurface(int width, int height);
// The same with the origin of the framebuffer (bottom left): what Skia draws
// into it has exactly the pixels it would have in the framebuffer (compositor)
sk_sp<SkSurface> createFramebufferLikeSurface(int width, int height);

// Submit and present: surface into the canvas of the view. Needs a scope.
// false if the view has no canvas in the engine worker (yet).
bool present(int viewId, SkSurface&);

// Paint directly into the framebuffer of the context (compositor): surface in
// the size of the view, nullptr if the view has no canvas here. Afterwards
// showFramebuffer() sends the frame without a copy into the canvas of the view.
sk_sp<SkSurface> framebufferSurface(int viewId, int width, int height);
bool showFramebuffer(int viewId);

} // namespace BrowserLite::Gpu
