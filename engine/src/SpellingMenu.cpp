#include "config.h"
#include "SpellingMenu.h"

#include "Host.h"
#include "Spelling.h"

#include <WebCore/DocumentInlines.h>
#include <WebCore/DocumentMarkerController.h>
#include <WebCore/Editor.h>
#include <WebCore/EditorClient.h>
#include <WebCore/FocusController.h>
#include <WebCore/FrameDestructionObserverInlines.h>
#include <WebCore/FrameSelection.h>
#include <WebCore/HitTestResult.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/NodeInlines.h>
#include <WebCore/Page.h>
#include <WebCore/RenderObjectInlines.h>
#include <WebCore/RenderedDocumentMarker.h>
#include <WebCore/Text.h>
#include <WebCore/VisiblePosition.h>
#include <WebCore/VisibleSelection.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>

namespace BrowserLite {
using namespace WebCore;

void selectMisspellingAt(const HitTestResult& hit)
{
    RefPtr node = hit.targetNode();
    RefPtr frame = node ? node->document().frame() : nullptr;
    if (!frame || !node->renderer() || !node->hasEditableStyle() || !Spelling::isEnabled())
        return;
    CheckedPtr markers = node->document().markersIfExists();
    if (!markers)
        return;
    VisiblePosition position { node->renderer()->visiblePositionForPoint(hit.localPoint(), HitTestSource::User) };
    auto point = makeBoundaryPoint(position);
    RefPtr text = point ? dynamicDowncast<Text>(point->container) : nullptr;
    if (!text)
        return;
    for (auto& marker : markers->markersFor(*text, DocumentMarkerType::Spelling)) {
        if (!marker || marker->startOffset() > point->offset || point->offset > marker->endOffset())
            continue;
        SimpleRange word { { *text, marker->startOffset() }, { *text, marker->endOffset() } };
        frame->selection().setSelection(VisibleSelection { word }, FrameSelection::defaultSetSelectionOptions(UserTriggered::Yes));
        return;
    }
}

// The frame of the selection and its misspelled word: the selected word, or the one with the caret
// (WebCore's behavior on Linux), checked again; not in password fields
static String misspelledWord(Page& page, RefPtr<LocalFrame>& frame)
{
    frame = page.focusController().focusedOrMainFrame();
    RefPtr document = frame ? frame->document() : nullptr;
    if (!document || frame->selection().selection().isInPasswordField())
        return { };
    return frame->editor().misspelledWordAtCaretOrRange(protect(document->focusedElement()).get());
}

String spellingMenuJSON(Page& page, const HitTestResult& result)
{
    RefPtr<LocalFrame> frame;
    auto word = result.isContentEditable() ? misspelledWord(page, frame) : String();
    if (word.isEmpty())
        return "null"_s;
    StringBuilder suggestions;
    for (auto& guess : Spelling::guesses(word))
        suggestions.append(suggestions.isEmpty() ? ""_s : ","_s, '"', jsonEscape(guess), '"');
    return makeString("{\"word\":\""_s, jsonEscape(word), "\",\"suggestions\":["_s, suggestions.toString(), "]}"_s);
}

void spellingMenuAction(Page& page, const String& action, const String& word, const String& replacement)
{
    RefPtr<LocalFrame> frame;
    if (word.isEmpty() || misspelledWord(page, frame) != word)
        return;
    if (action == "add"_s) {
        Spelling::learn(word);
        return;
    }
    if (action != "replace"_s || replacement.isEmpty())
        return;
    // The caret in the word: the word is selected first, like WebCore's spelling guess items
    auto selection = frame->selection().selection();
    if (selection.isCaret()) {
        VisibleSelection wordSelection { selection.base() };
        wordSelection.expandUsingGranularity(TextGranularity::WordGranularity);
        frame->selection().setSelection(wordSelection);
    }
    if (frame->editor().selectedText() != word)
        return;
    frame->editor().replaceSelectionWithText(replacement, Editor::SelectReplacement::No, Editor::SmartReplace::No, EditAction::InsertReplacement);
}

} // namespace BrowserLite
