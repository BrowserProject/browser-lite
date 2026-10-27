// EditorClient: text input, keyboard commands while editing and undo/redo.
// Method list after WebCore EmptyEditorClient (WebKit, BSD), keyboard handling
// after WinCairo WebPage::handleEditingKeyboardEvent.
#pragma once

#include <WebCore/DOMPasteAccess.h>
#include <WebCore/EditorClient.h>
#include <WebCore/IntRect.h>
#include <WebCore/TextCheckerClient.h>
#include <WebCore/UndoStep.h>
#include <wtf/Vector.h>

namespace BrowserLite {

class EditorClient final : public WebCore::EditorClient {
    WTF_MAKE_TZONE_ALLOCATED(EditorClient);
public:
    explicit EditorClient(int viewId)
        : m_viewId(viewId)
    {
    }

private:
    bool shouldDeleteRange(const std::optional<WebCore::SimpleRange>&) final { return true; }
    bool smartInsertDeleteEnabled() final { return false; }
    bool isSelectTrailingWhitespaceEnabled() const final { return false; }
    bool isContinuousSpellCheckingEnabled() final { return false; }
    void toggleContinuousSpellChecking() final { }
    bool isGrammarCheckingEnabled() final { return false; }
    void toggleGrammarChecking() final { }
    int spellCheckerDocumentTag() final { return -1; }

    bool shouldBeginEditing(const WebCore::SimpleRange&) final { return true; }
    bool shouldEndEditing(const WebCore::SimpleRange&) final { return true; }
    bool shouldInsertNode(WebCore::Node&, const std::optional<WebCore::SimpleRange>&, WebCore::EditorInsertAction) final { return true; }
    bool shouldInsertText(const String&, const std::optional<WebCore::SimpleRange>&, WebCore::EditorInsertAction) final { return true; }
    bool shouldChangeSelectedRange(const std::optional<WebCore::SimpleRange>&, const std::optional<WebCore::SimpleRange>&, WebCore::Affinity, bool) final { return true; }

    bool shouldApplyStyle(const WebCore::StyleProperties&, const std::optional<WebCore::SimpleRange>&) final { return true; }
    void didApplyStyle() final { }
    bool shouldMoveRangeAfterDelete(const WebCore::SimpleRange&, const WebCore::SimpleRange&) final { return true; }

    void didBeginEditing() final { }
    void respondToChangedContents() final { }
    // Caret position to the host: the input field for IME is placed there. Also the kind of
    // text input of the focused frame (on-screen keyboard of the host)
    void respondToChangedSelection(WebCore::LocalFrame*) final;
    void updateEditorStateAfterLayoutIfEditabilityChanged() final { }
    void discardedComposition(const WebCore::Document&) final { }
    void canceledComposition() final { }
    void didUpdateComposition() final { }
    void didEndEditing() final { }
    void didEndUserTriggeredSelectionChanges() final { }
    void willWriteSelectionToPasteboard(const std::optional<WebCore::SimpleRange>&) final { }
    void didWriteSelectionToPasteboard() final { }
    void getClientPasteboardData(const std::optional<WebCore::SimpleRange>&, Vector<std::pair<String, RefPtr<WebCore::SharedBuffer>>>&) final { }
    void requestCandidatesForSelection(const WebCore::VisibleSelection&) final { }
    void handleAcceptedCandidateWithSoftSpaces(WebCore::TextCheckingResult) final { }

    void registerUndoStep(WebCore::UndoStep&) final;
    void registerRedoStep(WebCore::UndoStep&) final;
    void clearUndoRedoOperations() final;

    WebCore::DOMPasteAccessResponse requestDOMPasteAccess(WebCore::DOMPasteAccessCategory, WebCore::FrameIdentifier, const String&) final { return WebCore::DOMPasteAccessResponse::GrantedForGesture; }

    bool canCopyCut(WebCore::LocalFrame*, bool defaultValue) const final { return defaultValue; }
    bool canPaste(WebCore::LocalFrame*, bool defaultValue) const final { return defaultValue; }
    bool canUndo() const final { return !m_undoStack.isEmpty(); }
    bool canRedo() const final { return !m_redoStack.isEmpty(); }
    void undo() final;
    void redo() final;

    void handleKeyboardEvent(WebCore::KeyboardEvent&) final;
    void handleInputMethodKeydown(WebCore::KeyboardEvent&) final { }

    void textFieldDidBeginEditing(WebCore::Element&) final { }
    void textFieldDidEndEditing(WebCore::Element&) final { }
    void textDidChangeInTextField(WebCore::Element&) final { }
    bool doTextFieldCommandFromEvent(WebCore::Element&, WebCore::KeyboardEvent*) final { return false; }
    void textWillBeDeletedInTextField(WebCore::Element&) final { }
    void textDidChangeInTextArea(WebCore::Element&) final { }
    void overflowScrollPositionChanged() final { }
    void subFrameScrollPositionChanged() final { }

    bool performTwoStepDrop(WebCore::DocumentFragment&, const WebCore::SimpleRange&, bool) final { return false; }

    WebCore::TextCheckerClient* textChecker() final { return &m_textCheckerClient; }

    void updateSpellingUIWithGrammarString(const String&, const WebCore::GrammarDetail&) final { }
    void updateSpellingUIWithMisspelledWord(const String&) final { }
    void showSpellingUI(bool) final { }
    bool spellingUIIsShowing() final { return false; }

    void setInputMethodState(WebCore::Element*) final { }

    class TextCheckerClient final : public WebCore::TextCheckerClient {
        bool shouldEraseMarkersAfterChangeSelection(WebCore::TextCheckingType) const final { return true; }
        void ignoreWordInSpellDocument(const String&) final { }
        void learnWord(const String&) final { }
        void checkSpellingOfString(StringView, int*, int*) final { }
        void checkGrammarOfString(StringView, Vector<WebCore::GrammarDetail>&, int*, int*) final { }
#if USE(UNIFIED_TEXT_CHECKING)
        Vector<WebCore::TextCheckingResult> checkTextOfParagraph(StringView, OptionSet<WebCore::TextCheckingType>, const WebCore::VisibleSelection&) final { return { }; }
#endif
        void getGuessesForWord(const String&, const String&, const WebCore::VisibleSelection&, Vector<String>&) final { }
        void requestCheckingOfString(WebCore::TextCheckingRequest&, const WebCore::VisibleSelection&) final { }
        void requestExtendedCheckingOfString(WebCore::TextCheckingRequest&, const WebCore::VisibleSelection&) final { }
    };

    TextCheckerClient m_textCheckerClient;
    Vector<Ref<WebCore::UndoStep>> m_undoStack;
    Vector<Ref<WebCore::UndoStep>> m_redoStack;
    bool m_inUndoRedo { false };

    int m_viewId;
    WebCore::IntRect m_caret;
    String m_textInput;
};

} // namespace BrowserLite
