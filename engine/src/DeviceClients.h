// Devices and permissions through the host browser: geolocation,
// notifications, camera and microphone. When a page asks for the first time,
// the host shows a prompt like Chrome ("... wants to use your location"). The
// decision applies per kind and origin of the top page (topOrigin), for
// notifications per origin of the document.
#pragma once

#include <memory>
#include <wtf/CompletionHandler.h>
#include <wtf/Forward.h>
#include <wtf/UniqueRef.h>

namespace WebCore {
class NotificationClient;
class Page;
struct NotificationData;
class SpeechRecognitionProvider;
}

namespace BrowserLite {

class WebView;

// When a view is created: attach clients to the page, clean up when it closes
void attachDeviceClients(WebView&, WebCore::Page&);
void detachDeviceClients(int viewId);

// Stored decision: 0 = not asked yet, 1 = granted, 2 = denied
enum class PermissionDecision : int { Ask = 0, Granted = 1, Denied = 2 };
PermissionDecision storedPermission(const String& kind, const String& origin);
// Stored decision or prompt in the host (engine thread)
void requestDevicePermission(int viewId, const String& kind, const String& origin, CompletionHandler<void(bool)>&&);

// Answers of the host (engine thread)
// answer: Ask = closed without a decision (denied, not remembered)
void answerPermission(int requestId, PermissionDecision answer);
void setStoredPermission(const String& kind, const String& origin, PermissionDecision);
void geolocationPosition(int viewId, double latitude, double longitude, double accuracy, double altitude, double altitudeAccuracy, double heading, double speed, double timestamp);
void geolocationError(int viewId, int code, const String& message);
// Orientation/motion from the host (NaN = value missing); values has 9 entries (see DeviceClients.cpp)
void deviceOrientation(int viewId, double alpha, double beta, double gamma, bool absolute);
void deviceMotion(int viewId, const double* values, double interval);
// type: 0 = shown, 1 = clicked, 2 = closed, 3 = error
void notificationEvent(const String& notificationID, int type);
// Notifications from showNotification() in the service worker and the still
// shown ones of a registration (getNotifications, empty tag = all)
std::unique_ptr<WebCore::NotificationClient> createServiceWorkerNotificationClient();
Vector<WebCore::NotificationData> shownPersistentNotifications(const URL& registrationURL, const String& tag);
// Speech recognition: provider for the PageConfiguration, events from the host
// (type: 0 start, 1-6 audio/sound/speech start and end, 7 result, 8 no match,
// 9 error, 10 end)
UniqueRef<WebCore::SpeechRecognitionProvider> createSpeechRecognitionProvider(int viewId);
void speechRecognitionEvent(uint64_t id, int type, const String& json);

} // namespace BrowserLite
