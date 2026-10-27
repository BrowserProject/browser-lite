// Fonts and line break dictionaries of the rendered text, fetched side by side. A font of
// /lazy/fonts (LazyFiles.cpp) loads on its first read, synchronously, in the middle of the layout
// that needs it; a page with many scripts (the language menu of bbc.com: Bengali, Gujarati,
// Korean, Myanmar, Thai, ...) waited one round trip after the other, 4 s at 150 ms before its
// first paint. Before such a read waits, the text that has a renderer gets scanned and the files
// its characters need start loading at once; the reads that follow find them on the way or in the
// HTTP cache.
#include "config.h"
#include "FontPrefetch.h"

#include "Engine.h"
#include "LazyFiles.h"
#include "WebView.h"

#include <WebCore/Document.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/ElementInlines.h>
#include <WebCore/HTMLNames.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/NodeTraversal.h>
#include <WebCore/Page.h>
#include <WebCore/Text.h>
#include <algorithm>
#include <fontconfig/fontconfig.h>
#include <set>
#include <string>
#include <unicode/uchar.h>
#include <unicode/utypes.h>
#include <vector>
#include <wtf/text/StringView.h>

namespace BrowserLite {

using namespace WebCore;

namespace {

struct LazyFont {
    std::string path; // relative to the engine folder ("lazy/fonts/...")
    std::string family;
    FcCharSet* charset;
};

struct Fonts {
    FcCharSet* base { nullptr }; // the fonts of engine.data
    std::vector<LazyFont> lazy; // Regular upright faces, Sans families first
};

// From fontconfig's cache, once
const Fonts& fonts()
{
    static Fonts* fonts = [] {
        auto* result = new Fonts;
        result->base = FcCharSetCreate();
        FcFontSet* set = FcConfigGetFonts(nullptr, FcSetSystem);
        for (int i = 0; set && i < set->nfont; ++i) {
            FcPattern* pattern = set->fonts[i];
            FcChar8* file = nullptr;
            FcCharSet* charset = nullptr;
            if (FcPatternGetString(pattern, FC_FILE, 0, &file) != FcResultMatch || FcPatternGetCharSet(pattern, FC_CHARSET, 0, &charset) != FcResultMatch)
                continue;
            std::string path(reinterpret_cast<const char*>(file));
            if (path.rfind("/lazy/fonts/", 0)) {
                FcCharSetMerge(result->base, charset, nullptr);
                continue;
            }
            int weight = FC_WEIGHT_REGULAR;
            int slant = FC_SLANT_ROMAN;
            FcPatternGetInteger(pattern, FC_WEIGHT, 0, &weight);
            FcPatternGetInteger(pattern, FC_SLANT, 0, &slant);
            if (weight != FC_WEIGHT_REGULAR || slant != FC_SLANT_ROMAN)
                continue;
            FcChar8* family = nullptr;
            FcPatternGetString(pattern, FC_FAMILY, 0, &family);
            result->lazy.push_back({ path.substr(1), family ? reinterpret_cast<const char*>(family) : "", charset });
        }
        // Text without its own font comes from a Sans face in the fallback of the pages
        std::stable_partition(result->lazy.begin(), result->lazy.end(), [](const LazyFont& font) {
            return font.family.find("Sans") != std::string::npos && font.family.find("Mono") == std::string::npos;
        });
        return result;
    }();
    return *fonts;
}

// The CJK family of the language: Han characters are in all four
const char* cjkFamily(const String& language)
{
    if (language.startsWith("ja"_s))
        return "Noto Sans JP";
    if (language.startsWith("ko"_s))
        return "Noto Sans KR";
    if (language.startsWith("zh-TW"_s) || language.startsWith("zh-HK"_s) || language.startsWith("zh-Hant"_s))
        return "Noto Sans TC";
    return "Noto Sans SC";
}

// ICU's line breaking needs a dictionary for these scripts (lazy/icu, tools/icu-data.mjs)
const char* breakDictionary(char32_t c)
{
    if (c >= 0x0E00 && c <= 0x0E7F)
        return "thaidict.dict";
    if (c >= 0x0E80 && c <= 0x0EFF)
        return "laodict.dict";
    if (c >= 0x1000 && c <= 0x109F)
        return "burmesedict.dict";
    if (c >= 0x1780 && c <= 0x17FF)
        return "khmerdict.dict";
    return nullptr;
}

bool isHan(char32_t c)
{
    return (c >= 0x3400 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0x20000 && c <= 0x3134F);
}

void collect(Document& document, std::set<char32_t>& characters)
{
    for (RefPtr node = document.firstChild(); node; node = NodeTraversal::next(*node)) {
        RefPtr text = dynamicDowncast<Text>(*node);
        // Only what is rendered: hidden menus would load fonts the layout never asks for
        if (!text || !text->renderer())
            continue;
        for (char32_t c : StringView(text->data()).codePoints()) {
            if (c >= 0x0370 && !FcCharSetHasChar(fonts().base, c))
                characters.insert(c);
        }
    }
}

} // namespace

void prefetchFontsOfRenderedText(const char* path)
{
    static std::set<std::string> started;
    // A file an earlier scan foresaw is already on the way; one it did not means new text (a scan
    // per such file, each file waits once)
    if (!isEngineThread() || started.count(path))
        return;

    std::string paths;
    auto add = [&](const std::string& path) {
        if (started.insert(path).second)
            paths += (paths.empty() ? "" : "\n") + path;
    };
    WebView::forEach([&](WebView& view) {
        RefPtr frame = dynamicDowncast<LocalFrame>(view.page().mainFrame());
        RefPtr document = frame ? frame->document() : nullptr;
        if (!document)
            return;
        std::set<char32_t> characters;
        collect(*document, characters);
        RefPtr root = document->documentElement();
        const char* cjk = cjkFamily(root ? root->getAttribute(HTMLNames::langAttr).string() : String());
        for (char32_t c : characters) {
            if (const char* dictionary = breakDictionary(c))
                add(std::string("lazy/icu/" U_ICUDATA_NAME "/brkitr/") + dictionary);
            for (auto& font : fonts().lazy) {
                if (isHan(c) && font.family != cjk)
                    continue;
                if (FcCharSetHasChar(font.charset, c)) {
                    add(font.path);
                    break;
                }
            }
        }
    });
    if (!paths.empty()) {
        debugLog("Fonts ahead: %s", paths.c_str());
        prefetchLazyFiles(paths.c_str());
    }
}

} // namespace BrowserLite
