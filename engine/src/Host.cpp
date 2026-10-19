#include "config.h"
#include "Host.h"

#include <cstring>
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include "Compositor.h"
#include "Engine.h"
#include "WebView.h"
#include <wtf/HashSet.h>
#include <wtf/HexNumber.h>
#include <wtf/Lock.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/StringBuilder.h>

// In the engine worker: Module.blCanvases (engine-pre.js) holds the
// OffscreenCanvas per view. ImageData must not point into the SharedArrayBuffer,
// so the rows are copied. Chrome takes the frame at the end of the task.
EM_JS(int, bl_js_present_in_worker, (int viewId, const uint8_t* pixels, int width, int height, int x, int y, int w, int h), {
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    if (!target)
        return 0;
    // After the GPU path (GpuRaster.cpp) the canvas already has a
    // bitmaprenderer: then go through a scratch canvas, always the whole frame
    if (!target.ctx && !target.bitmapContext)
        target.ctx = target.canvas.getContext("2d", { alpha: false });
    var canvas = target.ctx ? target.canvas : (target.scratch || (target.scratch = new OffscreenCanvas(width, height)));
    if (!target.ctx && !target.scratchCtx)
        target.scratchCtx = canvas.getContext("2d", { alpha: false });
    if (canvas.width != width || canvas.height != height || !target.ctx) {
        // A new size clears the canvas: copy everything
        canvas.width = width;
        canvas.height = height;
        x = 0;
        y = 0;
        w = width;
        h = height;
    }
    if (w > 0 && h > 0) {
        var image = new ImageData(w, h);
        var data = image.data;
        var heap = HEAPU8;
        for (var row = 0; row < h; row++) {
            var start = pixels + ((y + row) * width + x) * 4;
            data.set(heap.subarray(start, start + w * 4), row * w * 4);
        }
        (target.ctx || target.scratchCtx).putImageData(image, x, y);
    }
    if (!target.ctx) {
        target.canvas.width = width;
        target.canvas.height = height;
        target.bitmapContext.transferFromImageBitmap(canvas.transferToImageBitmap());
    }
    return 1;
});

EM_JS(int, bl_js_has_worker_canvas, (int viewId), {
    return Module.blCanvases && Module.blCanvases.has(viewId) ? 1 : 0;
});

// A closed view's canvas gets a last frame of 1x1 pixels: the frame shown
// before stays in this worker and in the GPU process until the canvas is
// garbage collected, and this mostly idle worker rarely collects (about 15 MB
// per closed view of 1000x700 pixels).
EM_JS(void, bl_js_forget_worker_canvas, (int viewId), {
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    if (!target)
        return;
    Module.blCanvases.delete(viewId);
    target.canvas.width = 1;
    target.canvas.height = 1;
    if (target.ctx)
        target.ctx.fillRect(0, 0, 1, 1);
    else if (target.bitmapContext)
        target.bitmapContext.transferFromImageBitmap(null);
    if (target.scratch) {
        target.scratch.width = 0;
        target.scratch.height = 0;
    }
});

namespace BrowserLite {

bool presentFrameInWorker(int viewId, const uint8_t* pixels, int width, int height, int dirtyX, int dirtyY, int dirtyWidth, int dirtyHeight)
{
    return bl_js_present_in_worker(viewId, pixels, width, height, dirtyX, dirtyY, dirtyWidth, dirtyHeight);
}

// Which views have a canvas in the worker. The worker is the compositor's or
// the engine thread's (Compositor::presenterThread), hence tracked in C++.
static Lock s_canvasLock;
static HashSet<int>& attachedCanvases() WTF_REQUIRES_LOCK(s_canvasLock)
{
    static NeverDestroyed<HashSet<int>> canvases;
    return canvases;
}

void workerCanvasArrived(int viewId)
{
    Locker locker { s_canvasLock };
    attachedCanvases().add(viewId);
}

bool hasWorkerCanvas(int viewId)
{
    Locker locker { s_canvasLock };
    return attachedCanvases().contains(viewId);
}

void forgetWorkerCanvas(int viewId)
{
    {
        Locker locker { s_canvasLock };
        attachedCanvases().remove(viewId);
    }
    if (Compositor::isRunning()) {
        Compositor::dispatch([viewId] {
            bl_js_forget_worker_canvas(viewId);
        });
        return;
    }
    bl_js_forget_worker_canvas(viewId);
}

void presentFrameOnCompositor(int viewId, const uint8_t* pixels, int width, int height, int dirtyX, int dirtyY, int dirtyWidth, int dirtyHeight)
{
    Compositor::dispatch([=] {
        bl_js_present_in_worker(viewId, pixels, width, height, dirtyX, dirtyY, dirtyWidth, dirtyHeight);
        runOnEngineThread([viewId] {
            if (auto* view = WebView::fromID(viewId)) {
                view->framePresented();
                view->presentIfNeeded();
            }
        });
    });
}

void notifyHost(int viewId, const char* type, const String& payload)
{
    // Copies in shared memory, the main thread frees them again.
    // Only messages from the engine thread show that it is not hanging
    // (the compositor reports e.g. first-paint even during a block).
    char* typeCopy = strdup(type);
    char* payloadCopy = strdup(payload.utf8().data());
    MAIN_THREAD_ASYNC_EM_ASM({
        var type = UTF8ToString($1);
        var payload = UTF8ToString($2);
        _free($1);
        _free($2);
        if (Module.onEngineEvent)
            Module.onEngineEvent($0, type, payload, !!$3);
    }, viewId, typeCopy, payloadCopy, isEngineThread());
}

void presentFrameToHost(int viewId, const uint8_t* pixels, int width, int height, int dirtyX, int dirtyY, int dirtyWidth, int dirtyHeight)
{
    MAIN_THREAD_ASYNC_EM_ASM({
        if (Module.onEngineFrame)
            Module.onEngineFrame($0, $1, $2, $3, $4, $5, $6, $7);
        else
            Module._bl_frame_presented($0);
    }, viewId, pixels, width, height, dirtyX, dirtyY, dirtyWidth, dirtyHeight);
}

void requestFrameFromHost(int viewId)
{
    MAIN_THREAD_ASYNC_EM_ASM({
        if (Module.onEngineNeedsFrame)
            Module.onEngineNeedsFrame($0);
    }, viewId);
}

void sendDownloadData(int downloadId, std::span<const uint8_t> data)
{
    if (data.empty())
        return;
    auto* copy = static_cast<uint8_t*>(malloc(data.size()));
    memcpy(copy, data.data(), data.size());
    MAIN_THREAD_ASYNC_EM_ASM({
        if (Module.onEngineDownloadData)
            Module.onEngineDownloadData($0, HEAPU8.slice($1, $1 + $2));
        _free($1);
    }, downloadId, copy, data.size());
}

void sendPrintDocument(int viewId, std::span<const uint8_t> data, const String& title)
{
    auto* copy = static_cast<uint8_t*>(malloc(data.size()));
    memcpy(copy, data.data(), data.size());
    char* titleCopy = strdup(title.utf8().data());
    MAIN_THREAD_ASYNC_EM_ASM({
        if (Module.onEnginePrint)
            Module.onEnginePrint($0, HEAPU8.slice($1, $1 + $2), UTF8ToString($3));
        _free($1);
        _free($3);
    }, viewId, copy, data.size(), titleCopy);
}

void notifyMedia(int playerId, ASCIILiteral type, const String& json, std::span<const uint8_t> data)
{
    char* jsonCopy = strdup(json.utf8().data());
    uint8_t* copy = nullptr;
    if (!data.empty()) {
        copy = static_cast<uint8_t*>(malloc(data.size()));
        memcpy(copy, data.data(), data.size());
    }
    MAIN_THREAD_ASYNC_EM_ASM({
        var json = UTF8ToString($2);
        var bytes = $3 ? HEAPU8.slice($3, $3 + $4) : null;
        _free($2);
        if ($3)
            _free($3);
        if (Module.onEngineMedia)
            Module.onEngineMedia($0, UTF8ToString($1), JSON.parse(json), bytes);
    }, playerId, type.characters(), jsonCopy, copy, data.size());
}

void sendMediaFetch(int fetchId, ASCIILiteral type, const String& json, std::span<const uint8_t> data)
{
    char* jsonCopy = strdup(json.utf8().data());
    uint8_t* copy = nullptr;
    if (!data.empty()) {
        copy = static_cast<uint8_t*>(malloc(data.size()));
        memcpy(copy, data.data(), data.size());
    }
    MAIN_THREAD_ASYNC_EM_ASM({
        var json = UTF8ToString($2);
        var bytes = $3 ? HEAPU8.slice($3, $3 + $4) : null;
        _free($2);
        if ($3)
            _free($3);
        if (Module.onEngineMediaFetch)
            Module.onEngineMediaFetch($0, UTF8ToString($1), json ? JSON.parse(json) : null, bytes);
    }, fetchId, type.characters(), jsonCopy, copy, data.size());
}

void sendIconData(int viewId, const String& url, const String& mimeType, std::span<const uint8_t> data)
{
    auto* copy = static_cast<uint8_t*>(malloc(std::max<size_t>(data.size(), 1)));
    if (!data.empty())
        memcpy(copy, data.data(), data.size());
    char* urlCopy = strdup(url.utf8().data());
    char* mimeCopy = strdup(mimeType.utf8().data());
    MAIN_THREAD_ASYNC_EM_ASM({
        if (Module.onEngineIcon)
            Module.onEngineIcon($0, UTF8ToString($1), UTF8ToString($2), HEAPU8.slice($3, $3 + $4));
        _free($1);
        _free($2);
        _free($3);
    }, viewId, urlCopy, mimeCopy, copy, data.size());
}

String jsonEscape(const String& input)
{
    StringBuilder builder;
    for (unsigned i = 0; i < input.length(); ++i) {
        char16_t c = input[i];
        switch (c) {
        case '"': builder.append("\\\""_s); break;
        case '\\': builder.append("\\\\"_s); break;
        case '\n': builder.append("\\n"_s); break;
        case '\r': builder.append("\\r"_s); break;
        case '\t': builder.append("\\t"_s); break;
        default:
            if (c < 0x20)
                builder.append("\\u"_s, hex(c, 4));
            else
                builder.append(c);
        }
    }
    return builder.toString();
}

} // namespace BrowserLite
