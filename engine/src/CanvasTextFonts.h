// Text of a 2D canvas waits for its lazy fallback fonts (CanvasTextFonts.cpp).
#pragma once

namespace BrowserLite {

// Installs the callbacks of patch 0171 (WebCore::WasmPlatform::CanvasTextScope); once, before the
// first page.
void installCanvasTextFonts();

// Whether the current thread draws or measures text into a 2D canvas right now: its lazy fallback
// fonts wait like local fonts (setLazyWaitLimit)
bool canvasTextRuns();

} // namespace BrowserLite
