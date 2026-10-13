#include "config.h"
#include "Host.h"

#include <cstring>
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <wtf/HexNumber.h>
#include <wtf/text/StringBuilder.h>

// Im Engine-Worker: Module.blCanvases (engine-pre.js) haelt pro View das
// OffscreenCanvas. ImageData darf nicht auf den SharedArrayBuffer zeigen, darum
// die Zeilen kopieren. Chrome uebernimmt das Bild am Ende der Aufgabe.
EM_JS(int, bl_js_present_in_worker, (int viewId, const uint8_t* pixels, int width, int height, int x, int y, int w, int h), {
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    if (!target)
        return 0;
    // Nach dem GPU-Weg (GpuRaster.cpp) hat das Canvas schon einen
    // bitmaprenderer: dann ueber ein Zwischen-Canvas, immer das ganze Bild
    if (!target.ctx && !target.bitmapContext)
        target.ctx = target.canvas.getContext("2d", { alpha: false });
    var canvas = target.ctx ? target.canvas : (target.scratch || (target.scratch = new OffscreenCanvas(width, height)));
    if (!target.ctx && !target.scratchCtx)
        target.scratchCtx = canvas.getContext("2d", { alpha: false });
    if (canvas.width != width || canvas.height != height || !target.ctx) {
        // Neue Groesse leert das Canvas: alles kopieren
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

EM_JS(void, bl_js_forget_worker_canvas, (int viewId), {
    if (Module.blCanvases)
        Module.blCanvases.delete(viewId);
});

namespace BrowserLite {

bool presentFrameInWorker(int viewId, const uint8_t* pixels, int width, int height, int dirtyX, int dirtyY, int dirtyWidth, int dirtyHeight)
{
    return bl_js_present_in_worker(viewId, pixels, width, height, dirtyX, dirtyY, dirtyWidth, dirtyHeight);
}

bool hasWorkerCanvas(int viewId)
{
    return bl_js_has_worker_canvas(viewId);
}

void forgetWorkerCanvas(int viewId)
{
    bl_js_forget_worker_canvas(viewId);
}

void notifyHost(int viewId, const char* type, const String& payload)
{
    // Kopien im gemeinsamen Speicher, der Haupt-Thread gibt sie wieder frei
    char* typeCopy = strdup(type);
    char* payloadCopy = strdup(payload.utf8().data());
    MAIN_THREAD_ASYNC_EM_ASM({
        var type = UTF8ToString($1);
        var payload = UTF8ToString($2);
        _free($1);
        _free($2);
        if (Module.onEngineEvent)
            Module.onEngineEvent($0, type, payload);
    }, viewId, typeCopy, payloadCopy);
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
