// Regular expressions of the host for patterns that backtrack a lot (patch 0073).
//
// JSC interprets regular expressions here (no JIT for them in WebAssembly); a pattern that
// backtracks over a long input cost 10 to 30 times more than in the host browser, whose worker
// runs this thread (a cookie regexp of 20min.ch: 609 ms against 19 ms). The Yarr interpreter
// measures each pattern and hands the expensive ones to hostMatch: the pattern compiles once per
// thread into a RegExp of the worker (flag d for the capture offsets, g or y to start at
// `start`), the input is copied into a JS string for each call. Patterns the host does not
// accept stay in the interpreter.
#include "config.h"
#include "Engine.h"
#include "EngineConfig.h"

#include <emscripten.h>
#include <wtf/text/StringView.h>
#include <wtf/text/WTFString.h>

namespace JSC::Yarr {
// From patch 0073 (YarrInterpreter.cpp), without a header so JSC's headers stay unchanged
using HostMatch = unsigned (*)(unsigned id, const String& source, unsigned flags, StringView input, unsigned start, unsigned* output, unsigned outputSize);
// always: every pattern, not only those measured expensive
void setHostMatch(HostMatch, bool always);
}

namespace BrowserLite {

// flags: the bits of JSC::Yarr::Flags (d g i m s u v y). Returns the start of the match, -1
// without one, -2 when the host cannot run the pattern. output: start and end of each capture,
// 0xffffffff for one that did not take part.
EM_JS(int, bl_host_regexp_exec, (unsigned id, const void* source, unsigned sourceLength, int source8, unsigned flags, const void* input, unsigned length, int input8, unsigned start, unsigned* output, unsigned outputSize), {
    source >>>= 0; input >>>= 0; output >>>= 0;
    var text = function (pointer, size, latin1) {
        var view = latin1 ? HEAPU8.subarray(pointer, pointer + size) : HEAPU16.subarray(pointer >>> 1, (pointer >>> 1) + size);
        var parts = [];
        // Small pieces: apply puts each character on the stack, and this can run deep in the stack
        for (var i = 0; i < size; i += 1024)
            parts.push(String.fromCharCode.apply(null, view.subarray(i, Math.min(size, i + 1024))));
        return parts.join("");
    };
    var cache = Module.blHostRegExps || (Module.blHostRegExps = new Map());
    var regexp = cache.get(id);
    if (regexp === undefined) {
        var letters = 'd';
        if (flags & 4) letters += 'i';
        if (flags & 8) letters += 'm';
        if (flags & 16) letters += 's';
        if (flags & 32) letters += 'u';
        if (flags & 64) letters += 'v';
        letters += flags & 128 ? 'y' : 'g';
        try {
            regexp = new RegExp(text(source, sourceLength, source8), letters);
        } catch (e) {
            regexp = null;
        }
        if (cache.size >= 512)
            cache.delete(cache.keys().next().value);
        cache.set(id, regexp);
    }
    if (!regexp)
        return -2;
    var match;
    try {
        regexp.lastIndex = start;
        match = regexp.exec(text(input, length, input8));
    } catch (e) {
        return -2;
    }
    if (match && match.length * 2 > outputSize)
        return -2;
    var out = output >>> 2;
    for (var i = 0; i < outputSize; i++)
        HEAPU32[out + i] = 0xffffffff;
    if (!match)
        return -1;
    for (var i = 0; i < match.length; i++) {
        var range = match.indices[i];
        if (range) {
            HEAPU32[out + 2 * i] = range[0];
            HEAPU32[out + 2 * i + 1] = range[1];
        }
    }
    return match.index;
});

static constexpr unsigned noMatch = std::numeric_limits<unsigned>::max();
static constexpr unsigned declined = noMatch - 1;

static unsigned hostMatch(unsigned id, const String& source, unsigned flags, StringView input, unsigned start, unsigned* output, unsigned outputSize)
{
    auto pointer = [](const StringView& text) -> const void* {
        return text.is8Bit() ? static_cast<const void*>(text.span8().data()) : static_cast<const void*>(text.span16().data());
    };
    StringView sourceView = source;
    int result = bl_host_regexp_exec(id, pointer(sourceView), sourceView.length(), sourceView.is8Bit(), flags, pointer(input), input.length(), input.is8Bit(), start, output, outputSize);
    if (result == -2)
        return declined;
    return result < 0 ? noMatch : static_cast<unsigned>(result);
}

void installHostRegExp()
{
    auto mode = engineConfig().hostRegExp;
    if (mode != EngineConfig::HostRegExp::Off)
        JSC::Yarr::setHostMatch(hostMatch, mode == EngineConfig::HostRegExp::All);
}

} // namespace BrowserLite
