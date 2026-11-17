#include "config.h"
#include "EditorClient.h"

#include "Host.h"
#include "HostClipboard.h"

#include <WebCore/Document.h>
#include <WebCore/EnterKeyHint.h>
#include <WebCore/FocusController.h>
#include <WebCore/HTMLFormElement.h>
#include <WebCore/HTMLInputElement.h>
#include <WebCore/HTMLNames.h>
#include <WebCore/HTMLSelectElement.h>
#include <WebCore/HTMLTextFormControlElement.h>
#include <WebCore/InputMode.h>
#include <WebCore/Page.h>
#include <WebCore/ContainerNodeInlines.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/DocumentPage.h>
#include <WebCore/Editor.h>
#include <WebCore/ElementAncestorIteratorInlines.h>
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
#include <WebCore/RenderObjectInlines.h>
#include <WebCore/SecurityOrigin.h>
#include <WebCore/TextIterator.h>
#include <WebCore/VisibleUnits.h>
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

// The focused element of the focused frame when it takes text: a text field or text area that
// is not read only or disabled, or an editable element. Not the root of the selection: in a
// text field that is the inner element of its shadow tree, and the selection stays in a field
// when the focus moves to a button.
static RefPtr<Element> focusedTextInput(Page& page)
{
    RefPtr focused = page.focusController().focusedOrMainFrame();
    RefPtr document = focused ? focused->document() : nullptr;
    RefPtr element = document ? document->focusedElement() : nullptr;
    if (!element)
        return nullptr;
    if (RefPtr control = dynamicDowncast<HTMLTextFormControlElement>(*element)) {
        RefPtr input = dynamicDowncast<HTMLInputElement>(*control);
        if ((input && !input->isTextField()) || !control->isMutable())
            return nullptr;
        return element;
    }
    return element->hasEditableStyle() ? element : nullptr;
}

// The field the Next key of an on-screen keyboard moves to from a single line text field, after
// Chrome's FocusController::NextFocusableElementForImeAndAutofill (BSD): the next text field,
// select or editable element in tab order with the same form, none past a submit button. At
// most 50 steps, like Chrome, as every keystroke asks again.
static RefPtr<Element> nextFieldOf(Page& page, HTMLInputElement& input)
{
    RefPtr form = input.form();
    RefPtr<Element> next = &input;
    for (int step = 0; step < 50; ++step) {
        next = page.focusController().nextFocusableElement(*next).element;
        if (!next)
            return nullptr;
        RefPtr control = dynamicDowncast<HTMLFormControlElement>(*next);
        if (!control) {
            if (next->hasEditableStyle() && ancestorsOfType<HTMLFormElement>(*next).first() == form)
                return next;
            continue;
        }
        if (control->isSuccessfulSubmitButton())
            return nullptr;
        if (control->form() != form || !control->isMutable())
            continue;
        CheckedPtr renderer = control->renderer();
        if ((renderer && renderer->isRenderTextControl()) || is<HTMLSelectElement>(*control))
            return next;
    }
    return nullptr;
}

// URL, email and password fields get no capitals, corrections or suggestions (HTML spec)
static bool takesWords(const HTMLInputElement* input)
{
    return !input || !(input->isPasswordField() || input->isEmailField() || input->isURLField());
}

// The attribute of the element, else of its form owner like the HTML spec's
// autocapitalize-and-autocorrect inheriting elements; null without one
static AtomString ownOrFormAttribute(const Element& element, const QualifiedName& name, bool emptyInherits)
{
    auto& own = element.attributeWithoutSynchronization(name);
    if (!own.isNull() && !(emptyInherits && own.isEmpty()))
        return own;
    RefPtr control = dynamicDowncast<HTMLFormControlElement>(element);
    RefPtr form = control ? control->form() : nullptr;
    return form ? form->attributeWithoutSynchronization(name) : nullAtom();
}

// The used autocapitalization hint of the HTML spec. Its default state (no hint) is sentences, as
// Chrome and Safari start a text field or editable element with a capital
static ASCIILiteral autocapitalizeOf(const Element& element)
{
    if (!takesWords(dynamicDowncast<HTMLInputElement>(element)))
        return "none"_s;
    auto value = ownOrFormAttribute(element, HTMLNames::autocapitalizeAttr, true);
    if (equalLettersIgnoringASCIICase(value, "off"_s) || equalLettersIgnoringASCIICase(value, "none"_s))
        return "none"_s;
    if (equalLettersIgnoringASCIICase(value, "words"_s))
        return "words"_s;
    if (equalLettersIgnoringASCIICase(value, "characters"_s))
        return "characters"_s;
    return "sentences"_s;
}

// The used autocorrection state of the HTML spec: on unless the attribute says off
static bool autocorrectOf(const Element& element)
{
    if (!takesWords(dynamicDowncast<HTMLInputElement>(element)))
        return false;
    return !equalLettersIgnoringASCIICase(ownOrFormAttribute(element, HTMLNames::autocorrectAttr, false), "off"_s);
}

// Text input of the focused frame for "text-input": mode "" while nothing takes text, so the
// host shows no on-screen keyboard. The hints of an editable element are those of its editing host.
static String textInputState(LocalFrame& frame)
{
    RefPtr page = frame.page();
    RefPtr element = page ? focusedTextInput(*page) : nullptr;
    if (!element)
        return "{\"mode\":\"\"}"_s;
    RefPtr html = dynamicDowncast<HTMLElement>(*element);
    String hint = html ? attributeValueForEnterKeyHint(html->canonicalEnterKeyHint()) : String();
    RefPtr field = dynamicDowncast<HTMLInputElement>(*element);
    bool nextField = field && nextFieldOf(*page, *field);
    RefPtr<Element> hinted = element;
    if (!is<HTMLTextFormControlElement>(*element)) {
        if (RefPtr host = element->rootEditableElement())
            hinted = host;
    }
    bool spellcheck = takesWords(field.get()) && hinted->isSpellCheckingEnabled();
    return makeString("{\"mode\":\""_s, inputModeOf(element.get()), "\",\"enterKeyHint\":\""_s, hint,
        "\",\"singleLine\":"_s, field ? "true"_s : "false"_s, ",\"nextField\":"_s, nextField ? "true"_s : "false"_s,
        ",\"autocapitalize\":\""_s, autocapitalizeOf(*hinted), "\",\"autocorrect\":"_s, autocorrectOf(*hinted) ? "true"_s : "false"_s,
        ",\"spellcheck\":"_s, spellcheck ? "true"_s : "false"_s, '}');
}

// The text before the caret in its paragraph, at most the last 100 UTF-16 code units: the host's
// input method reads it like the text of a native field (the keyboard's automatic capital, its
// suggestions). Nothing from a password field.
static String textBeforeCaret(const VisibleSelection& selection)
{
    constexpr unsigned maxLength = 100;
    RefPtr input = dynamicDowncast<HTMLInputElement>(enclosingTextFormControl(selection.start()));
    if (input && input->isPasswordField())
        return emptyString();
    auto caret = selection.visibleStart();
    auto range = makeSimpleRange(startOfParagraph(caret), caret);
    if (!range)
        return emptyString();
    auto text = plainTextReplacingNoBreakSpace(*range);
    if (text.length() <= maxLength)
        return text;
    unsigned start = text.length() - maxLength;
    if (U16_IS_TRAIL(text[start]))
        start++;
    return text.substring(start);
}

void focusNextField(Page& page)
{
    RefPtr field = dynamicDowncast<HTMLInputElement>(focusedTextInput(page));
    if (RefPtr next = field ? nextFieldOf(page, *field) : nullptr)
        next->focus({ .direction = FocusDirection::Forward });
}

bool takesTextInput(Page& page)
{
    return !!focusedTextInput(page);
}

// Like Chrome: the decision of the top page applies, its frames need the permissions policy
// 'clipboard-read' (WebCore Clipboard)
void EditorClient::requestClipboardRead(LocalFrame& frame, CompletionHandler<void(bool)>&& completionHandler)
{
    RefPtr document = frame.document();
    if (!document) {
        completionHandler(false);
        return;
    }
    requestHostClipboard(m_viewId, document->topOrigin().toString(), WTF::move(completionHandler));
}

void EditorClient::updateTextInput(LocalFrame& frame)
{
    auto textInput = textInputState(frame);
    if (textInput == m_textInput)
        return;
    m_textInput = textInput;
    notifyHost(m_viewId, "text-input", textInput);
}

void EditorClient::respondToChangedSelection(LocalFrame* frame)
{
    if (!frame)
        return;
    updateTextInput(*frame);
    auto& selection = frame->selection().selection();
    if (!frame->view() || !selection.isContentEditable())
        return;
    // End of the selection or caret, in view coordinates (CSS pixels)
    auto caret = frame->view()->contentsToRootView(frame->selection().absoluteCaretBounds());
    auto before = textBeforeCaret(selection);
    if (caret.isEmpty() || (caret == m_caret && before == m_textBeforeCaret))
        return;
    m_caret = caret;
    m_textBeforeCaret = before;
    notifyHost(m_viewId, "caret", makeString("{\"x\":"_s, caret.x(), ",\"y\":"_s, caret.y(), ",\"height\":"_s, caret.height(),
        ",\"before\":\""_s, jsonEscape(before), "\"}"_s));
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
