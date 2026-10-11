#include "config.h"
#include "Host.h"

#include <cstring>
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <wtf/HexNumber.h>
#include <wtf/text/StringBuilder.h>

namespace BrowserLite {

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
