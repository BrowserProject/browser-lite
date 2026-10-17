// Fehlerseite fuer eine Navigation, die nicht ankommt (siehe ErrorPage.cpp).
#pragma once

#include <cstdint>
#include <optional>

namespace JSC {
class JSGlobalObject;
}

namespace WebCore {
class LocalFrame;
class ResourceError;
}

namespace BrowserLite::ErrorPage {

// Certificate: das Zertifikat der Website ist nicht gueltig (Adressleiste "Nicht sicher")
enum class Kind : uint8_t { Network, Certificate };

// Zeigt sie im Frame, wenn der Fehler vom Netz kommt (curl), sonst nullopt. Nur beim
// Melden des Fehlers aufrufen (dispatchDidFailProvisionalLoad): dann nimmt WebCore sie an
// die Stelle der Adresse im Verlauf, auch bei Zurueck/Vor.
std::optional<Kind> show(WebCore::LocalFrame&, const WebCore::ResourceError&);

// Neues window-Objekt: in einer Fehlerseite __blReload fuer ihren Knopf
void installBridge(WebCore::LocalFrame&, JSC::JSGlobalObject&);

}
