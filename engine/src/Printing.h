// Printing like in Chrome: the page is broken into pages with @media print and
// becomes a PDF with Skia's PDF output (A4, 1 cm margin). The host shows the
// PDF and opens the print dialog of the host browser.
#pragma once

namespace WebCore {
class LocalFrame;
}

namespace BrowserLite {

// window.print() or Ctrl+P (engine thread)
void printFrame(int viewId, WebCore::LocalFrame&);

} // namespace BrowserLite
