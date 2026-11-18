// Spell checking of editable text like Chrome on Linux (Spelling.h). The word loop follows
// WebCore's TextCheckerEnchant and Chrome's SpellCheck::SpellCheckWord: words of letters from
// ICU's word breaks, without digits, in the script of the language, at most 64 characters,
// checked by Hunspell in UTF-8.
#include "config.h"
#include "Spelling.h"

#include "Engine.h"
#include "LazyFiles.h"
#include "Storage.h"
#include "WebView.h"

#include <WebCore/BoundaryPointInlines.h>
#include <WebCore/Document.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/DocumentMarkerController.h>
#include <WebCore/FrameTree.h>
#include <WebCore/Editor.h>
#include <WebCore/FocusController.h>
#include <WebCore/HTMLInputElement.h>
#include <WebCore/HTMLTextFormControlElement.h>
#include <WebCore/FrameDestructionObserverInlines.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/NodeInlines.h>
#include <WebCore/Page.h>
#include <WebCore/SimpleRange.h>
#include <WebCore/SpellChecker.h>
#include <WebCore/TextControlInnerElements.h>
#include <WebCore/TextChecking.h>
#include <WebCore/TextIterator.h>
#include <cstdio>
#include <hunspell.hxx>
#include <memory>
#include <pthread.h>
#include <sys/stat.h>
#include <unicode/ubrk.h>
#include <unicode/uchar.h>
#include <unicode/uscript.h>
#include <wtf/MainThread.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/Function.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>
#include <wtf/text/TextBreakIterator.h>

namespace BrowserLite::Spelling {

using namespace WebCore;

static constexpr auto indexPath = "/usr/share/browser-lite/lazy-dictionaries.txt";
static constexpr auto mountPoint = "/lazy/dictionaries";
static constexpr auto customDictionaryDirectory = "/data/spelling";
static constexpr auto customDictionaryPath = "/data/spelling/custom-dictionary.txt";
// Chrome: kMaxSpellingSuggestions of its menu, kMaxCheckedLen of its renderer, and
// kMaxCustomDictionaryWordBytes
static constexpr size_t maxGuesses = 3;
static constexpr unsigned maxWordLength = 64;
static constexpr size_t maxCustomWordBytes = 99;
static constexpr Seconds retryDelay = 30_s;

namespace {

struct Loaded {
    std::unique_ptr<Hunspell> hunspell;
    Vector<String> customWords;
    bool customWordsWritable { false };
};

struct State {
    Vector<String> available; // dictionaries of the index, like "en_US"
    String language; // the chosen one, null for none
    UScriptCode script { USCRIPT_LATIN }; // of its language
    bool enabled { true };
    bool loading { false };
    MonotonicTime failedAt; // a dictionary that did not load is tried again after a while
    unsigned generation { 0 }; // changes with every choice, so a late load is dropped
    std::unique_ptr<Hunspell> hunspell;
    Vector<String> customWords;
    bool customWordsWritable { false };
};

} // namespace

static State& state()
{
    static NeverDestroyed<State> state;
    return state;
}

void initialize()
{
    FILE* file = fopen(indexPath, "r");
    if (!file)
        return;
    std::string index;
    char buffer[1024];
    for (size_t count; (count = fread(buffer, 1, sizeof(buffer), file));)
        index.append(buffer, count);
    fclose(file);
    if (!mountLazyFiles(mountPoint, "lazy/dictionaries", index.c_str())) {
        log("Spelling: %s could not be mounted", mountPoint);
        return;
    }
    // Lines "<path> <size> <language>"
    for (auto line : String::fromUTF8(index.c_str()).split('\n')) {
        auto fields = line.split(' ');
        if (fields.size() == 3 && !state().available.contains(fields[2]))
            state().available.append(fields[2]);
    }
    // Until bl_set_languages
    setLanguages({ });
}

static String dictionaryFor(const String& language)
{
    String id = makeStringByReplacingAll(language, '-', '_');
    auto& available = state().available;
    for (auto& name : available) {
        if (equalIgnoringASCIICase(name, id))
            return name;
    }
    auto primary = id.left(id.find('_'));
    for (auto& name : available) {
        if (equalIgnoringASCIICase(name.left(name.find('_')), primary))
            return name;
    }
    return { };
}

void setLanguages(const Vector<String>& languages)
{
    auto language = dictionaryFor(languages.isEmpty() ? "en-US"_s : languages[0]);
    auto& current = state();
    if (language == current.language)
        return;
    current.language = language;
    UErrorCode error = U_ZERO_ERROR;
    UScriptCode scripts[1];
    current.script = !language.isNull() && uscript_getCode(language.utf8().data(), scripts, 1, &error) == 1 && U_SUCCESS(error) ? scripts[0] : USCRIPT_LATIN;
    current.generation++;
    current.loading = false;
    current.failedAt = { };
    current.hunspell = nullptr;
}

static void recheckFocusedEditables();

// Turned off, the underlines go at once (WebCore drops them only at the next selection change);
// turned on, the focused field is checked
void setEnabled(bool enabled)
{
    if (enabled == state().enabled)
        return;
    state().enabled = enabled;
    if (enabled) {
        recheckFocusedEditables();
        return;
    }
    WebView::forEach([](WebView& view) {
        for (RefPtr<Frame> frame = &view.page().mainFrame(); frame; frame = frame->tree().traverseNext()) {
            RefPtr localFrame = dynamicDowncast<LocalFrame>(*frame);
            RefPtr document = localFrame ? localFrame->document() : nullptr;
            if (CheckedPtr markers = document ? document->markersIfExists() : nullptr)
                markers->removeMarkers(DocumentMarkerType::Spelling);
        }
    });
}

bool isEnabled()
{
    return state().enabled && !state().language.isNull();
}

// Whole file as UTF-8 text; false when it could not be read (a dictionary that did not arrive)
static bool readText(const char* path, std::string& text)
{
    FILE* file = fopen(path, "rb");
    if (!file)
        return false;
    char buffer[16384];
    size_t count;
    while ((count = fread(buffer, 1, sizeof(buffer), file)))
        text.append(buffer, count);
    bool ok = !ferror(file);
    fclose(file);
    return ok;
}

static void recheckFocusedEditables()
{
    WebView::forEach([](WebView& view) {
        RefPtr frame = view.page().focusController().focusedOrMainFrame();
        if (RefPtr document = frame ? frame->document() : nullptr)
            checkFocusedEditable(*document);
    });
}

// Runs work on a thread of its own without waiting for it to start: WTF::Thread::create waits until
// the new thread runs, which takes a loaded web worker (60 to 180 ms for a new one, workers.js),
// and the first focus of a field should not hold up the engine thread for that. False when no
// thread could start.
static bool runInBackground(Function<void()>&& work)
{
    pthread_attr_t attributes;
    pthread_attr_init(&attributes);
    pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
    pthread_t thread;
    auto* function = new Function<void()>(WTF::move(work));
    bool started = !pthread_create(&thread, &attributes, [](void* data) -> void* {
        std::unique_ptr<Function<void()>> work { static_cast<Function<void()>*>(data) };
        (*work)();
        return nullptr;
    }, function);
    pthread_attr_destroy(&attributes);
    if (!started)
        delete function;
    return started;
}

// The dictionary of the chosen language and the words added to it, read and parsed on a thread of
// its own (its files load from the network the first time)
static void load()
{
    auto& current = state();
    if (!isEnabled() || current.hunspell || current.loading || MonotonicTime::now() - current.failedAt < retryDelay)
        return;
    current.loading = true;
    bool started = runInBackground([language = current.language.isolatedCopy(), generation = current.generation] {
        auto startTime = MonotonicTime::now();
        auto loaded = std::make_unique<Loaded>();
        auto base = makeString(String::fromLatin1(mountPoint), '/', language);
        auto aff = makeString(base, ".aff"_s).utf8();
        auto dic = makeString(base, ".dic"_s).utf8();
        // Read once whole, so they are there (LazyFiles keeps them): Hunspell takes a missing
        // file as an empty dictionary, in which every word is wrong
        std::string affText;
        std::string dicText;
        if (readText(aff.data(), affText) && readText(dic.data(), dicText)) {
            loaded->hunspell = std::make_unique<Hunspell>(aff.data(), dic.data());
            if (loaded->hunspell->get_dict_encoding() != "UTF-8") {
                log("Spelling: %s is not UTF-8", language.utf8().data());
                loaded->hunspell = nullptr;
            }
        } else
            log("Spelling: the dictionary %s did not load", language.utf8().data());
        std::vector<uint8_t> words;
        auto result = readWholeFile(customDictionaryPath, words);
        loaded->customWordsWritable = result != ReadResult::Failed;
        if (result == ReadResult::Done) {
            for (auto& word : String::fromUTF8(std::span<const uint8_t> { words }).split('\n'))
                loaded->customWords.append(word.isolatedCopy());
        }
        if (loaded->hunspell) {
            for (auto& word : loaded->customWords)
                loaded->hunspell->add(std::string(word.utf8().data()));
        }
        debugLog("Spelling: %s read and parsed in %.0f ms", language.utf8().data(), (MonotonicTime::now() - startTime).milliseconds());
        callOnMainThread([loaded = WTF::move(loaded), generation]() mutable {
            auto& current = state();
            if (generation != current.generation)
                return;
            current.loading = false;
            if (!loaded->hunspell) {
                current.failedAt = MonotonicTime::now();
                return;
            }
            current.hunspell = WTF::move(loaded->hunspell);
            current.customWords = WTF::move(loaded->customWords);
            current.customWordsWritable = loaded->customWordsWritable;
            recheckFocusedEditables();
        });
    });
    if (!started) {
        current.loading = false;
        current.failedAt = MonotonicTime::now();
    }
}

static Hunspell* dictionary()
{
    if (!isEnabled())
        return nullptr;
    load();
    return state().hunspell.get();
}

// Like Chrome's SpellcheckCharAttribute only words in the script of the dictionary's language are
// checked: a Greek or Cyrillic word in English text is not wrong English
static bool isMisspelled(Hunspell& hunspell, StringView word)
{
    if (word.length() > maxWordLength)
        return false;
    for (auto character : word.codePoints()) {
        if (u_isdigit(character))
            return false;
        UErrorCode error = U_ZERO_ERROR;
        auto script = uscript_getScript(character, &error);
        if (script != USCRIPT_COMMON && script != USCRIPT_INHERITED && script != state().script)
            return false;
    }
    return !hunspell.spell(std::string(word.utf8().data()));
}

// Calls found(offset, length) for every misspelled word until it returns false
static void forEachMisspelling(Hunspell& hunspell, StringView text, const Function<bool(unsigned, unsigned)>& found)
{
    UBreakIterator* iterator = wordBreakIterator(text);
    if (!iterator)
        return;
    int start = ubrk_first(iterator);
    for (int end = ubrk_next(iterator); end != UBRK_DONE; start = end, end = ubrk_next(iterator)) {
        int status = ubrk_getRuleStatus(iterator);
        if (status < UBRK_WORD_LETTER || status >= UBRK_WORD_LETTER_LIMIT)
            continue;
        if (isMisspelled(hunspell, text.substring(start, end - start)) && !found(start, end - start))
            return;
    }
}

void findFirstMisspelling(StringView text, int& location, int& length)
{
    location = -1;
    length = 0;
    auto* hunspell = dictionary();
    if (!hunspell)
        return;
    forEachMisspelling(*hunspell, text, [&](unsigned offset, unsigned count) {
        location = offset;
        length = count;
        return false;
    });
}

std::optional<Vector<std::pair<unsigned, unsigned>>> findMisspellings(StringView text)
{
    auto* hunspell = dictionary();
    if (!hunspell)
        return std::nullopt;
    Vector<std::pair<unsigned, unsigned>> misspellings;
    forEachMisspelling(*hunspell, text, [&](unsigned offset, unsigned count) {
        misspellings.append({ offset, count });
        return true;
    });
    return misspellings;
}

Vector<String> guesses(const String& word)
{
    auto* hunspell = dictionary();
    if (!hunspell || word.length() > maxWordLength)
        return { };
    Vector<String> guesses;
    for (auto& guess : hunspell->suggest(std::string(word.utf8().data()))) {
        guesses.append(String::fromUTF8(guess.c_str()));
        if (guesses.size() == maxGuesses)
            break;
    }
    return guesses;
}

void ignore(const String& word)
{
    if (auto* hunspell = dictionary())
        hunspell->add(std::string(word.utf8().data()));
}

void learn(const String& word)
{
    auto utf8 = word.utf8();
    auto& current = state();
    if (!current.hunspell || !utf8.length() || utf8.length() > maxCustomWordBytes || word.contains('\n') || current.customWords.contains(word))
        return;
    current.hunspell->add(std::string(utf8.data()));
    current.customWords.append(word);
    recheckFocusedEditables();
    // Not over a file that exists but could not be read (the OPFS taken by another tab)
    if (!current.customWordsWritable)
        return;
    StringBuilder text;
    for (auto& custom : current.customWords) {
        text.append(custom);
        text.append('\n');
    }
    mkdir(customDictionaryDirectory, 0700);
    auto data = text.toString().utf8();
    if (!replaceWholeFile(customDictionaryPath, byteCast<uint8_t>(data.span())))
        log("Spelling: %s could not be written", customDictionaryPath);
}

// The element that holds the text of the focused field: the inner element of a text field or
// text area, the editing host of an editable element
static RefPtr<Element> focusedEditableRoot(Document& document)
{
    RefPtr focused = document.focusedElement();
    if (!focused)
        return nullptr;
    if (RefPtr control = dynamicDowncast<HTMLTextFormControlElement>(*focused)) {
        if (RefPtr input = dynamicDowncast<HTMLInputElement>(*control); input && (!input->isTextField() || input->isPasswordField()))
            return nullptr;
        return control->innerTextElement();
    }
    if (!focused->hasEditableStyle())
        return nullptr;
    return focused->rootEditableElement();
}

// The focused field's text is checked like Chrome's cold mode: in pieces of about this many
// characters (to the next white space, so no word is cut), one per task, so a long text (an
// article in a wiki's edit box) does not hold up the engine thread
static constexpr int chunkLength = 4000;
static constexpr int maxWordTail = 100;

// A new check of a focused field ends the pieces of the one before
static unsigned& checkGeneration()
{
    static unsigned generation;
    return generation;
}

static void checkChunk(Ref<Document>&& document, Ref<Element>&& root, BoundaryPoint start, unsigned generation)
{
    if (generation != checkGeneration() || !isEnabled() || !document->frame() || focusedEditableRoot(document) != root.ptr())
        return;
    Ref container = start.container;
    if (!container->isConnected() || !root->contains(container.get()) || start.offset > container->length())
        return;
    SimpleRange rest { WTF::move(start), makeBoundaryPointAfterNodeContents(root) };
    CharacterIterator characters { rest };
    characters.advance(chunkLength);
    for (int tail = 0; !characters.atEnd() && tail < maxWordTail; ++tail) {
        auto text = characters.text();
        if (!text.isEmpty() && isUnicodeCompatibleASCIIWhitespace(text[0]))
            break;
        characters.advance(1);
    }
    auto end = characters.atEnd() ? rest.end : characters.range().start;
    SimpleRange chunk { rest.start, end };
    if (auto request = SpellCheckRequest::create({ TextCheckingType::Spelling }, TextCheckingProcessType::TextCheckingProcessBatch, chunk, chunk, chunk))
        document->editor().spellChecker().requestCheckingFor(request.releaseNonNull());
    if (characters.atEnd())
        return;
    callOnMainThread([document = WTF::move(document), root = WTF::move(root), end = WTF::move(end), generation]() mutable {
        checkChunk(WTF::move(document), WTF::move(root), WTF::move(end), generation);
    });
}

void checkFocusedEditable(Document& document)
{
    if (!isEnabled() || !document.frame())
        return;
    RefPtr root = focusedEditableRoot(document);
    if (!root || !document.editor().isSpellCheckingEnabledFor(root.get()))
        return;
    if (!dictionary())
        return;
    auto start = makeBoundaryPointBeforeNodeContents(*root);
    checkChunk(Ref { document }, root.releaseNonNull(), WTF::move(start), ++checkGeneration());
}

} // namespace BrowserLite::Spelling
