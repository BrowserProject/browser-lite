// Fonts and line break dictionaries of the rendered text, fetched side by side (FontPrefetch.cpp).
#pragma once

namespace BrowserLite {

// On the engine thread, before a read waits for a lazy font: starts fetching the lazy files the
// rendered text of the open pages needs. Once per burst of reads.
void prefetchFontsOfRenderedText();

} // namespace BrowserLite
