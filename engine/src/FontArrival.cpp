// Lazy fonts of other scripts, CJK and emoji that the text went on without (setLazyWaitLimit in
// LazyFiles.cpp) arrived. Only the fallback fonts per character can change with them: a font
// family is only realized from a font file that could be read, and a family that could not be
// read stays unknown (the typeface cache of FontCacheSkia.cpp). So WebKit forgets the fallbacks
// it looked up, and only the elements with text outside the fonts of engine.data get new fonts
// and are laid out again. FontCache::invalidate() would rebuild the style of every element of
// every page instead and lay out all of them: on the HTML standard seconds per arrival (#401).
#include "config.h"
#include "FontArrival.h"

#include "Engine.h"
#include "FontPrefetch.h"

#include <WebCore/Document.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/FontCache.h>
#include <WebCore/FontCascade.h>
#include <WebCore/FontCascadeCache.h>
#include <WebCore/FontCascadeFonts.h>
#include <WebCore/RenderElement.h>
#include <WebCore/RenderObjectInlines.h>
#include <WebCore/RenderText.h>
#include <WebCore/RenderView.h>
#include <WebCore/StyleComputedStyle.h>
#include <WebCore/SystemFallbackFontCache.h>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/text/StringView.h>

namespace BrowserLite {

using namespace WebCore;

namespace {

bool hasCharacterOfLazyFont(StringView text)
{
    // Latin-1 only: all of it is in the fonts of engine.data
    if (text.is8Bit())
        return false;
    for (char32_t c : text.codePoints()) {
        if (needsLazyFont(c))
            return true;
    }
    return false;
}

// The elements with text that may take another font now get their style again with new fonts,
// like after a change of their font: their text is measured anew (also whether it can take the
// fast path of the primary font, decided while the fonts were missing). Returns their number.
unsigned layOutTextAgain(Document& document)
{
    CheckedPtr view = document.renderView();
    if (!view)
        return 0;
    HashSet<const RenderElement*> done;
    // Renderers that shared fonts share the new ones
    HashMap<const FontCascadeFonts*, Ref<FontCascadeFonts>> newFonts;
    for (CheckedPtr<RenderObject> renderer = view.get(); renderer; renderer = renderer->nextInPreOrder()) {
        CheckedPtr text = dynamicDowncast<RenderText>(*renderer);
        if (!text)
            continue;
        CheckedPtr parent = text->parent();
        if (!parent || done.contains(parent.get()) || !hasCharacterOfLazyFont(text->text()))
            continue;
        done.add(parent.get());
        auto style = Style::ComputedStyle::clone(parent->style());
        FontCascade fontCascade = style.fontCascade();
        RefPtr fonts = fontCascade.fonts();
        if (!fonts || fonts->isForPlatformFont())
            continue;
        fontCascade.updateFonts(newFonts.ensure(fonts.get(), [] {
            return FontCascadeFonts::create();
        }).iterator->value.copyRef());
        style.setFontCascade(WTF::move(fontCascade));
        parent->setStyle(WTF::move(style));
    }
    return done.size();
}

} // namespace

void lazyFontsArrived()
{
    // The fallbacks per character (also the ones that found no font), their glyphs and the
    // widths and shapes measured with them
    if (auto* fallbacks = SystemFallbackFontCache::forCurrentThreadIfExists())
        fallbacks->clear();
    FontCache::forCurrentThread().purgeInactiveFontData();
    FontCascadeCache::forCurrentThread().clearMeasurementCaches();

    unsigned elements = 0;
    for (auto& entry : Document::allDocuments()) {
        Ref document = entry.get();
        // A page in the back/forward cache gets all its style again when it comes back
        // (CachedPage::restore)
        if (document->backForwardCacheState() == Document::NotInBackForwardCache)
            elements += layOutTextAgain(document);
    }
    debugLog("Lazy fonts arrived: text of %u elements laid out again", elements);
}

} // namespace BrowserLite
