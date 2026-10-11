#include "config.h"
#include "EditorClient.h"

#include <WebCore/Editor.h>
#include <WebCore/EventNames.h>
#include <WebCore/KeyboardEvent.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/Node.h>
#include <WebCore/PlatformKeyboardEvent.h>
#include <wtf/TZoneMallocInlines.h>

namespace BrowserLite {

using namespace WebCore;

WTF_MAKE_TZONE_ALLOCATED_IMPL(EditorClient);

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
    step->unapply(); // registriert sich selber als Redo-Schritt
}

void EditorClient::redo()
{
    if (m_redoStack.isEmpty())
        return;
    Ref step = m_redoStack.takeLast();
    SetForScope scope { m_inUndoRedo, true };
    step->reapply(); // registriert sich selber als Undo-Schritt
}

// Befehle fuer KeyDown (Bewegen, Loeschen, Kurzbefehle)
static ASCIILiteral commandForKeyDown(const PlatformKeyboardEvent& event)
{
    const String& key = event.key();
    bool shift = event.shiftKey();
    bool command = event.controlKey() || event.metaKey(); // Ctrl (Linux/Windows) oder Cmd (Mac)

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

// Befehle fuer das Zeichen-Event (Enter)
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
        // Text einfuegende Befehle macht das Zeichen-Event
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
    // Steuerzeichen nie einfuegen, und Ctrl/Cmd-Kombinationen sind Befehle, kein Text
    if (event.charCode() < ' ' || platformEvent->controlKey() || platformEvent->metaKey())
        return;
    if (frame->editor().insertText(platformEvent->text(), &event))
        event.setDefaultHandled();
}

} // namespace BrowserLite
