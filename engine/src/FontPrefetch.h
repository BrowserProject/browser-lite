// Fonts and line break dictionaries of the rendered text, fetched side by side (FontPrefetch.cpp).
#pragma once

namespace BrowserLite {

// On the engine thread, before a read waits for the lazy file `path`: starts fetching the lazy
// files the rendered text of the open pages needs, unless an earlier scan foresaw `path`.
void prefetchFontsOfRenderedText(const char* path);

// Whether the character is outside the fonts of engine.data, so its font loads on demand
bool needsLazyFont(char32_t);

} // namespace BrowserLite
