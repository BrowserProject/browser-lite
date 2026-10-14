// Passwort-Speicher wie in Chrome: die Engine meldet abgeschickte Anmeldungen
// und den Fokus auf Anmeldefelder, die Oberflaeche (web/passwords.js)
// speichert und fuellt aus.
#pragma once

#include <wtf/Forward.h>

namespace WebCore {
class Element;
class HTMLFormElement;
class Page;
}

namespace BrowserLite::Passwords {

// Vor dem submit-Ereignis (auch bei Formularen, die JS abschickt)
void formWillSubmit(int viewId, WebCore::HTMLFormElement&);
// Fokus auf ein Passwortfeld oder den Benutzernamen eines Anmeldeformulars
void focusChanged(int viewId, WebCore::Element*);
// Gespeicherte Anmeldung in das Formular mit dem Fokus (nur gleicher Ursprung)
void fill(WebCore::Page&, const String& origin, const String& username, const String& password);

} // namespace BrowserLite::Passwords
