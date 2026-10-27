#include "config.h"
#include "EditorClient.h"

#include "Host.h"

#include <WebCore/Document.h>
#include <WebCore/EnterKeyHint.h>
#include <WebCore/FocusController.h>
#include <WebCore/HTMLInputElement.h>
#include <WebCore/InputMode.h>
#include <WebCore/Page.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/Editor.h>
#include <WebCore/EventNames.h>
#include <WebCore/FrameDestructionObserverInlines.h>
#include <WebCore/FrameInlines.h>
#include <WebCore/KeyboardEvent.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/DocumentView.h>
#include <WebCore/LocalFrameView.h>
#include <WebCore/FrameSelection.h>
#include <WebCore/Node.h>
#include <WebCore/NodeInlines.h>
#include <WebCore/PlatformKeyboardEvent.h>
#include <wtf/SetForScope.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite {

using namespace WebCore;

WTF_MAKE_TZONE_ALLOCATED_IMPL(EditorClient);

// The on-screen keyboard for an editable element: inputmode, else the input type, like iOS
static String inputModeOf(Element* element)
{
    RefPtr html = dynamicDowncast<HTMLElement>(element);
    if (!html)
        return "text"_s;
    auto mode = html->canonicalInputMode();
    if (mode != InputMode::Unspecified)
        return stringForInputMode(mode);
    if (RefPtr input = dynamicDowncast<HTMLInputElement>(*html)) {
        if (input->isEmailField())
            return "email"_s;
        if (input->isTelephoneField())
            return "tel"_s;
        if (input->isURLField())
            return "url"_s;
        if (input->isNumberField())
            return "decimal"_s;
        if (input->isSearchField())
            return "search"_s;
    }
    return "text"_s;
}

// Text input of the focused frame for "text-input": mode "" while nothing editable has the
// selection, so the host shows no on-screen keyboard
static String textInputState(LocalFrame& frame)
{
    RefPtr page = frame.page();
    RefPtr focused = page ? page->focusController().focusedOrMainFrame() : nullptr;
    if (!focused || !focused->selection().selection().isContentEditable())
        return "{\"mode\":\"\"}"_s;
    RefPtr root = focused->selection().selection().rootEditableElement();
    RefPtr html = dynamicDowncast<HTMLElement>(root.get());
    String hint = html ? attributeValueForEnterKeyHint(html->canonicalEnterKeyHint()) : String();
    return makeString("{\"mode\":\""_s, inputModeOf(root.get()), "\",\"enterKeyHint\":\""_s, hint, "\"}"_s);
}

void EditorClient::respondToChangedSelection(LocalFrame* frame)
{
    if (!frame)
        return;
    auto textInput = textInputState(*frame);
    if (textInput != m_textInput) {
        m_textInput = textInput;
        notifyHost(m_viewId, "text-input", textInput);
    }
    if (!frame->view() || !frame->selection().selection().isContentEditable())
        return;
    // End of the selection or caret, in view coordinates (CSS pixels)
    auto caret = frame->view()->contentsToRootView(frame->selection().absoluteCaretBounds());
    if (caret.isEmpty() || caret == m_caret)
        return;
    m_caret = caret;
    notifyHost(m_viewId, "caret", makeString("{\"x\":"_s, caret.x(), ",\"y\":"_s, caret.y(), ",\"height\":"_s, caret.height(), '}'));
}

void EditorClient::registerUndoStep(UndoStep& step)
{
    if (m_undoStack.size() >= 100)
        m_undoStack.removeAt(0);
    m_undoStack.append(step);
    if (!m_inUndoRedo)
        m_redoStack.clear();
}

void EditorClient::registerRedoStep(UndoStep& step)
{
    m_redoStack.append(step);
}

void EditorClient::clearUndoRedoOperations()
{
    m_undoStack.clear();
    m_redoStack.clear();
}

void EditorClient::undo()
{
    if (m_undoStack.isEmpty())
        return;
    Ref step = m_undoStack.takeLast();
    SetForScope scope { m_inUndoRedo, true };
    step->unapply(); // registers itself as a redo step
}

void EditorClient::redo()
{
    if (m_redoStack.isEmpty())
        return;
    Ref step = m_redoStack.takeLast();
    SetForScope scope { m_inUndoRedo, true };
    step->reapply(); // registers itself as an undo step
}

// Commands for KeyDown (movement, deletion, shortcuts)
static ASCIILiteral commandForKeyDown(const PlatformKeyboardEvent& event)
{
    const String& key = event.key();
    bool shift = event.shiftKey();
    bool command = event.controlKey() || event.metaKey(); // Ctrl (Linux/Windows) or Cmd (Mac)

    if (command && key.length() == 1) {
        switch (toASCIILower(key[0])) {
        case 'a': return "SelectAll"_s;
        case 'c': return "Copy"_s;
        case 'x': return "Cut"_s;
        case 'v': return shift ? "PasteAndMatchStyle"_s : "Paste"_s;
        case 'z': return shift ? "Redo"_s : "Undo"_s;
        case 'y': return "Redo"_s;
        case 'b': return "ToggleBold"_s;
        case 'i': return "ToggleItalic"_s;
        case 'u': return "ToggleUnderline"_s;
        default: return ""_s;
        }
    }
    if (key == "Backspace"_s)
        return command ? "DeleteWordBackward"_s : "DeleteBackward"_s;
    if (key == "Delete"_s)
        return command ? "DeleteWordForward"_s : "DeleteForward"_s;
    if (key == "ArrowLeft"_s) {
        if (command)
            return shift ? "MoveWordLeftAndModifySelection"_s : "MoveWordLeft"_s;
        return shift ? "MoveLeftAndModifySelection"_s : "MoveLeft"_s;
    }
    if (key == "ArrowRight"_s) {
        if (command)
            return shift ? "MoveWordRightAndModifySelection"_s : "MoveWordRight"_s;
        return shift ? "MoveRightAndModifySelection"_s : "MoveRight"_s;
    }
    if (key == "ArrowUp"_s)
        return shift ? "MoveUpAndModifySelection"_s : "MoveUp"_s;
    if (key == "ArrowDown"_s)
        return shift ? "MoveDownAndModifySelection"_s : "MoveDown"_s;
    if (key == "Home"_s) {
        if (command)
            return shift ? "MoveToBeginningOfDocumentAndModifySelection"_s : "MoveToBeginningOfDocument"_s;
        return shift ? "MoveToBeginningOfLineAndModifySelection"_s : "MoveToBeginningOfLine"_s;
    }
    if (key == "End"_s) {
        if (command)
            return shift ? "MoveToEndOfDocumentAndModifySelection"_s : "MoveToEndOfDocument"_s;
        return shift ? "MoveToEndOfLineAndModifySelection"_s : "MoveToEndOfLine"_s;
    }
    if (key == "PageUp"_s)
        return shift ? "MovePageUpAndModifySelection"_s : "MovePageUp"_s;
    if (key == "PageDown"_s)
        return shift ? "MovePageDownAndModifySelection"_s : "MovePageDown"_s;
    return ""_s;
}

// Commands for the character event (Enter)
static ASCIILiteral commandForChar(const PlatformKeyboardEvent& event)
{
    if (event.text() == "\r"_s)
        return event.shiftKey() ? "InsertLineBreak"_s : "InsertNewline"_s;
    return ""_s;
}

void EditorClient::handleKeyboardEvent(KeyboardEvent& event)
{
    RefPtr node = dynamicDowncast<Node>(event.target());
    if (!node)
        return;
    RefPtr frame = node->document().frame();
    if (!frame)
        return;
    auto* platformEvent = event.underlyingPlatformEvent();
    if (!platformEvent || platformEvent->isSystemKey())
        return;

    if (event.type() == eventNames().keydownEvent) {
        if (platformEvent->type() != PlatformEvent::Type::RawKeyDown)
            return;
        auto name = commandForKeyDown(*platformEvent);
        if (name.isEmpty())
            return;
        auto command = frame->editor().command(String { name });
        // Commands that insert text are handled by the character event
        if (!command.isTextInsertion() && command.execute(&event))
            event.setDefaultHandled();
        return;
    }

    if (event.type() != eventNames().keypressEvent)
        return;
    auto name = commandForChar(*platformEvent);
    if (!name.isEmpty() && frame->editor().command(String { name }).execute(&event)) {
        event.setDefaultHandled();
        return;
    }
    // Never insert control characters, and Ctrl/Cmd combinations are commands, not text
    if (event.charCode() < ' ' || platformEvent->controlKey() || platformEvent->metaKey())
        return;
    if (frame->editor().insertText(platformEvent->text(), &event))
        event.setDefaultHandled();
}

} // namespace BrowserLite
