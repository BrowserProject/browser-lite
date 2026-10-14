#include "config.h"
#include "Passwords.h"

#include "Host.h"

#include <WebCore/Document.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/ElementTraversal.h>
#include <WebCore/TypedElementDescendantIteratorInlines.h>
#include <WebCore/FocusController.h>
#include <WebCore/FrameDestructionObserverInlines.h>
#include <WebCore/HTMLFormElement.h>
#include <WebCore/HTMLInputElement.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/Page.h>
#include <WebCore/SecurityOrigin.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite::Passwords {

using namespace WebCore;

namespace {

struct LoginFields {
    RefPtr<HTMLInputElement> username;
    RefPtr<HTMLInputElement> password;
};

// Felder fuer Benutzername: Text, E-Mail, Telefon (wie Chrome)
bool isUsernameCandidate(HTMLInputElement& input)
{
    return input.isTextField() && !input.isPasswordField() && !input.isSearchField() && !input.isDisabledFormControl();
}

// Eingabefelder des Formulars, ohne Formular alle des Dokuments
Vector<Ref<HTMLInputElement>> inputsAround(Element& element)
{
    Vector<Ref<HTMLInputElement>> inputs;
    RefPtr input = dynamicDowncast<HTMLInputElement>(element);
    RefPtr form = input ? input->form() : dynamicDowncast<HTMLFormElement>(element);
    if (form) {
        for (auto& listed : form->unsafeListedElements()) {
            if (RefPtr control = dynamicDowncast<HTMLInputElement>(listed.get()))
                inputs.append(control.releaseNonNull());
        }
        return inputs;
    }
    for (Ref control : descendantsOfType<HTMLInputElement>(element.document()))
        inputs.append(WTF::move(control));
    return inputs;
}

// Passwortfeld (beim Abschicken das erste mit Inhalt) und davor das letzte
// Feld fuer den Benutzernamen
LoginFields findLoginFields(Element& element, bool needsValues)
{
    LoginFields fields;
    RefPtr<HTMLInputElement> lastUsername;
    for (auto& input : inputsAround(element)) {
        if (input->isPasswordField()) {
            if (needsValues && input->value()->isEmpty())
                continue;
            fields.password = input.ptr();
            fields.username = lastUsername;
            break;
        }
        if (isUsernameCandidate(input) && (!needsValues || !input->value()->isEmpty()))
            lastUsername = input.ptr();
    }
    return fields;
}

String originOf(Document& document)
{
    return document.securityOrigin().toString();
}

} // namespace

void formWillSubmit(int viewId, HTMLFormElement& form)
{
    auto fields = findLoginFields(form, true);
    if (!fields.password)
        return;
    notifyHost(viewId, "password-submit", makeString("{\"origin\":\""_s, jsonEscape(originOf(form.document())),
        "\",\"username\":\""_s, jsonEscape(fields.username ? String { fields.username->value() } : String()),
        "\",\"password\":\""_s, jsonEscape(String { fields.password->value() }), "\"}"_s));
}

void focusChanged(int viewId, Element* element)
{
    RefPtr input = dynamicDowncast<HTMLInputElement>(element);
    if (!input || !(input->isPasswordField() || isUsernameCandidate(*input)))
        return;
    auto fields = findLoginFields(*input, false);
    // Nur Anmeldeformulare: ein Passwortfeld, noch leer
    if (!fields.password || !fields.password->value()->isEmpty())
        return;
    if (input != fields.password && input != fields.username)
        return;
    notifyHost(viewId, "login-field", makeString("{\"origin\":\""_s, jsonEscape(originOf(input->document())), "\"}"_s));
}

void fill(Page& page, const String& origin, const String& username, const String& password)
{
    RefPtr frame = page.focusController().focusedOrMainFrame();
    RefPtr document = frame ? frame->document() : nullptr;
    // Der Fokus kann inzwischen woanders sein: nur in den Ursprung, fuer den die Anmeldung gilt
    if (!document || originOf(*document) != origin)
        return;
    RefPtr<Element> around = document->focusedElement();
    if (!around)
        around = document->documentElement();
    if (!around)
        return;
    auto fields = findLoginFields(*around, false);
    if (!fields.password || !fields.password->value()->isEmpty())
        return;
    if (fields.username && !username.isEmpty() && fields.username->value()->isEmpty()) {
        // Zuerst markieren: die Seite sieht :autofill schon im input-Ereignis (wie Chrome)
        fields.username->setAutofilled();
        fields.username->setValue(username, DispatchInputAndChangeEvent);
    }
    fields.password->setAutofilled();
    fields.password->setValue(password, DispatchInputAndChangeEvent);
}

} // namespace BrowserLite::Passwords
