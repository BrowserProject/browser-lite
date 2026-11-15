// The word break rules of the engine: ICU's own rules (brkitr/word.brk of the linked data) with
// the change Chromium makes to its copy of ICU, so words end where they end in Chrome: a full
// stop between letters separates them ("example.com", "e.g."; between digits it still joins,
// "3.14"), and so does a colon ("foo:bar"). Built for the build host with the sysroot's ICU and
// run in node; the compiled rules replace word.brk in the engine's data (tools/icu-data.mjs).
//
//   node icu-word-rules.js <out.brk-data>
//
// Writes the rules as ICU compiles them (RBBI data, without the data header of the archive item).
// Fails if recompiling the unchanged rules does not give the shipped data back, or if a rule to
// change is missing, so a new ICU version cannot change the result silently.
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <unicode/brkiter.h>
#include <unicode/rbbi.h>

namespace {

// ICU stores its rules without comments and spaces; Chromium's word.txt changes these sets
struct Change {
    const char* from;
    const char* to;
};
constexpr Change changes[] = {
    { "$MidNumLet=[\\p{Word_Break=MidNumLet}];", "$MidNumLet=[\\p{Word_Break=MidNumLet}-[\\u002E\\uFF0E]];" },
    { "$MidLetter=[\\p{Word_Break=MidLetter}];", "$MidLetter=[\\p{Word_Break=MidLetter}-[\\:\\uFE55\\uFF1A]];" },
    { "$MidNum=[\\p{Word_Break=MidNum}];", "$MidNum=[\\p{Word_Break=MidNum}\\u002E\\uFF0E];" },
};

int fail(const char* message, UErrorCode status = U_ZERO_ERROR)
{
    std::fprintf(stderr, "icu-word-rules: %s %s\n", message, U_SUCCESS(status) ? "" : u_errorName(status));
    return 1;
}

std::unique_ptr<icu::RuleBasedBreakIterator> compile(const std::string& rules, UErrorCode& status)
{
    UParseError error;
    auto iterator = std::make_unique<icu::RuleBasedBreakIterator>(icu::UnicodeString::fromUTF8(rules), error, status);
    if (U_FAILURE(status))
        std::fprintf(stderr, "icu-word-rules: rule error at offset %d\n", error.offset);
    return iterator;
}

} // namespace

int main(int argc, char** argv)
{
    if (argc != 2)
        return fail("usage: icu-word-rules.js <out>");
    UErrorCode status = U_ZERO_ERROR;
    std::unique_ptr<icu::BreakIterator> shipped(icu::BreakIterator::createWordInstance(icu::Locale::getRoot(), status));
    if (U_FAILURE(status))
        return fail("no word rules in the ICU data", status);
    auto& shippedRules = static_cast<icu::RuleBasedBreakIterator&>(*shipped);
    std::string rules;
    shippedRules.getRules().toUTF8String(rules);

    uint32_t shippedLength;
    const uint8_t* shippedData = shippedRules.getBinaryRules(shippedLength);
    auto again = compile(rules, status);
    uint32_t againLength;
    const uint8_t* againData = U_SUCCESS(status) ? again->getBinaryRules(againLength) : nullptr;
    if (!againData || againLength != shippedLength || std::memcmp(againData, shippedData, shippedLength))
        return fail("the unchanged rules do not compile to the shipped data", status);

    for (auto& change : changes) {
        auto at = rules.find(change.from);
        if (at == std::string::npos || rules.find(change.from, at + 1) != std::string::npos)
            return fail(change.from);
        rules.replace(at, std::strlen(change.from), change.to);
    }
    auto changed = compile(rules, status);
    if (U_FAILURE(status))
        return fail("the changed rules do not compile", status);
    uint32_t length;
    const uint8_t* data = changed->getBinaryRules(length);

    FILE* out = std::fopen(argv[1], "wb");
    if (!out || std::fwrite(data, 1, length, out) != length || std::fclose(out))
        return fail(argv[1]);
    std::printf("ICU word rules like Chrome: %u bytes\n", length);
    return 0;
}
