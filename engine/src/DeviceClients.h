// Geraete und Berechtigungen ueber den Host-Browser: Standort (Geolocation)
// und Benachrichtigungen. Fragt eine Seite zum ersten Mal, zeigt die
// Oberflaeche eine Abfrage wie Chrome ("... moechte deinen Standort
// verwenden"); die Entscheidung gilt pro Ursprung und Art.
#pragma once

#include <wtf/Forward.h>
#include <wtf/UniqueRef.h>

namespace WebCore {
class Page;
class SpeechRecognitionProvider;
}

namespace BrowserLite {

class WebView;

// Beim Anlegen eines Views: Clients an die Page haengen, beim Schliessen aufraeumen
void attachDeviceClients(WebView&, WebCore::Page&);
void detachDeviceClients(int viewId);

// Gespeicherte Entscheidung: 0 = noch nicht gefragt, 1 = erlaubt, 2 = blockiert
enum class PermissionDecision : int { Ask = 0, Granted = 1, Denied = 2 };
PermissionDecision storedPermission(const String& kind, const String& origin);

// Antworten der Oberflaeche (Engine-Thread)
void answerPermission(int requestId, bool granted);
void setStoredPermission(const String& kind, const String& origin, PermissionDecision);
void geolocationPosition(int viewId, double latitude, double longitude, double accuracy, double altitude, double altitudeAccuracy, double heading, double speed, double timestamp);
void geolocationError(int viewId, int code, const String& message);
// Lage/Bewegung vom Host (NaN = Wert fehlt); values hat 9 Eintraege (siehe DeviceClients.cpp)
void deviceOrientation(int viewId, double alpha, double beta, double gamma, bool absolute);
void deviceMotion(int viewId, const double* values, double interval);
// type: 0 = gezeigt, 1 = angeklickt, 2 = geschlossen, 3 = Fehler
void notificationEvent(const String& notificationID, int type);
// Spracherkennung: Provider fuer die PageConfiguration, Ereignisse vom Host
// (type: 0 start, 1-6 Audio/Ton/Sprache an und aus, 7 Ergebnis, 8 nichts
// erkannt, 9 Fehler, 10 Ende)
UniqueRef<WebCore::SpeechRecognitionProvider> createSpeechRecognitionProvider(int viewId);
void speechRecognitionEvent(uint64_t id, int type, const String& json);

} // namespace BrowserLite
