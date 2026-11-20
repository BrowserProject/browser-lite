// Text drawn or measured into a 2D canvas waits for the lazy fonts of other scripts, CJK and emoji
// like for local fonts. The layout goes on without them after a while and lays the text out again
// once they are there (#255), but a canvas has no second chance: the page reads its widths
// (measureText) and pixels back at once. A fingerprint of them (hCaptcha's hsw.js) saw boxes on a
// first visit where Safari, which has these fonts, never shows any, and other values on the next
// visit. Patch 0171 marks the text of the 2D context's fillText, strokeText and measureText; while
// it runs the reads of /lazy/fonts wait like all others (at most 8 s), and the fallbacks a layout
// remembered as missing because it went on without their font are looked up again.
#include "config.h"
#include "CanvasTextFonts.h"

#include "Engine.h"
#include "FontArrival.h"
#include "LazyFiles.h"

#include <WebCore/WasmPlatform.h>

namespace BrowserLite {

namespace {

thread_local unsigned depth;
unsigned givenUpBefore; // lazyReadsGivenUp at the last forgetFallbackFonts (engine thread)

void begin()
{
    // Workers wait for every lazy font anyway
    if (depth++ || !isEngineThread())
        return;
    if (unsigned givenUp = lazyReadsGivenUp("/lazy/fonts"); givenUp != givenUpBefore) {
        givenUpBefore = givenUp;
        forgetFallbackFonts();
    }
}

void end()
{
    --depth;
}

} // namespace

void installCanvasTextFonts()
{
    WebCore::WasmPlatform::setCanvasTextCallbacks({ begin, end });
}

bool canvasTextRuns()
{
    return depth;
}

} // namespace BrowserLite
