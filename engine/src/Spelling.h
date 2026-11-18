// Spell checking of editable text like Chrome on Linux: Hunspell (deps/recipes/hunspell.sh) with
// the dictionary of the first language of the pages from lazy/dictionaries
// (deps/recipes/dictionaries.sh), which loads in the background the first time a field needs it.
// Everything runs on the engine thread except that load.
#pragma once

#include <wtf/Forward.h>
#include <wtf/Vector.h>

namespace WebCore {
class Document;
}

namespace BrowserLite::Spelling {

// Mounts lazy/dictionaries (the index in the data package); before the first view
void initialize();

// The languages of the pages (bl_set_languages): the dictionary of the first one, like Chrome's
// default of the browser language; an exact match (en-US: en_US), else one of the same language
// (en-GB: en_US). None: no spell checking.
void setLanguages(const Vector<String>&);

// The preference of the host (bl_set_preferences), on by default
void setEnabled(bool);

// Continuous spell checking is on: enabled and a dictionary for the language exists. Words count
// as spelled correctly until its dictionary is loaded.
bool isEnabled();

// Offset and length of the first misspelled word of text, length 0 for none. Starts loading the
// dictionary when it is not there yet.
void findFirstMisspelling(StringView text, int& location, int& length);

// Offsets and lengths of all misspelled words of text; nullopt while the dictionary loads
std::optional<Vector<std::pair<unsigned, unsigned>>> findMisspellings(StringView text);

// At most 3 corrections of a misspelled word, the best first (Chrome's menu)
Vector<String> guesses(const String& word);

// Add to dictionary: the word counts as spelled correctly from now on, also after a restart
// (/data/spelling/custom-dictionary.txt)
void learn(const String& word);
// Ignore: until the engine ends
void ignore(const String& word);

// Checks the whole text of the focused editable element of the document, which already had text
// when it got the focus (WebCore checks only words that are typed or left). Asynchronously
// through WebCore's SpellChecker, after the dictionary arrived if it is loading.
void checkFocusedEditable(WebCore::Document&);

} // namespace BrowserLite::Spelling
