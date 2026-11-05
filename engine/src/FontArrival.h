// Lazy fallback fonts that arrived after the text went on without them (FontArrival.cpp).
#pragma once

namespace BrowserLite {

// On the engine thread, once the lazy fonts the text went on without arrived (setLazyWaitLimit):
// the characters look up their fallback fonts again and the text that may take them is laid out
// again, in every document.
void lazyFontsArrived();

} // namespace BrowserLite
