// The spelling part of the context menu like Chrome: a right click on a misspelled word selects
// it, the event 'context-menu' tells the word and its corrections, and bl_spelling_action
// replaces it with one of them or adds it to the dictionary (Spelling.h).
#pragma once

#include <wtf/Forward.h>

namespace WebCore {
class HitTestResult;
class LocalFrame;
class Page;
}

namespace BrowserLite {

// Like Blink's SelectClosestMisspellingFromHitTestResult, before the page's contextmenu event: a
// word underlined as misspelled at the point of the hit test gets selected
void selectMisspellingAt(const WebCore::HitTestResult&);

// "spelling" of the event 'context-menu': {word, suggestions} of the misspelled word that is
// selected or has the caret in an editable element of the menu, null without one
String spellingMenuJSON(WebCore::Page&, const WebCore::HitTestResult&);

// "replace": the selected misspelled word (or the one with the caret) becomes replacement, like
// Chrome's ReplaceMisspelling with the input type insertReplacementText; "add": word counts as
// spelled correctly from now on. Nothing when the misspelled word is no longer word.
void spellingMenuAction(WebCore::Page&, const String& action, const String& word, const String& replacement);

} // namespace BrowserLite
