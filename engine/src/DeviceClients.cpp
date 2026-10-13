#include "config.h"
#include "DeviceClients.h"

#include "Host.h"
#include "WebView.h"
#if ENABLE(DEVICE_ORIENTATION)
// Nicht in den exportierten Headern von WebCore, aber im Include-Pfad (engine.cmake)
#include "DeviceMotionClient.h"
#include "DeviceMotionController.h"
#include "DeviceMotionData.h"
#include "DeviceOrientationClient.h"
#include "DeviceOrientationController.h"
#include "DeviceOrientationData.h"
#endif
#include <WebCore/Document.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/Geolocation.h>
#include <WebCore/GeolocationClient.h>
#include <WebCore/GeolocationController.h>
#include <WebCore/GeolocationError.h>
#include <WebCore/GeolocationPositionData.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/Notification.h>
#include <WebCore/NotificationClient.h>
#include <WebCore/NotificationController.h>
#include <WebCore/NotificationData.h>
#include <WebCore/NotificationResources.h>
#include <WebCore/Page.h>
#include <WebCore/ScriptExecutionContext.h>
#include <WebCore/SecurityOrigin.h>
#include <WebCore/SpeechRecognitionConnection.h>
#include <WebCore/SpeechRecognitionConnectionClient.h>
#include <WebCore/SpeechRecognitionError.h>
#include <WebCore/SpeechRecognitionProvider.h>
#include <WebCore/SpeechRecognitionResultData.h>
#include <WebCore/ClientOrigin.h>
#include <wtf/JSONValues.h>
#include <wtf/WeakPtr.h>
#include <cmath>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringHash.h>

using namespace WebCore;

namespace BrowserLite {

// ------------------------------------------------------------ Berechtigungen

static HashMap<String, PermissionDecision>& decisions()
{
    static NeverDestroyed<HashMap<String, PermissionDecision>> map;
    return map;
}

static String decisionKey(const String& kind, const String& origin)
{
    return makeString(kind, ' ', origin);
}

PermissionDecision storedPermission(const String& kind, const String& origin)
{
    return decisions().get(decisionKey(kind, origin));
}

void setStoredPermission(const String& kind, const String& origin, PermissionDecision decision)
{
    if (decision == PermissionDecision::Ask)
        decisions().remove(decisionKey(kind, origin));
    else
        decisions().set(decisionKey(kind, origin), decision);
}

static HashMap<int, CompletionHandler<void(bool)>>& pendingRequests()
{
    static NeverDestroyed<HashMap<int, CompletionHandler<void(bool)>>> map;
    return map;
}

// Erlaubt oder blockiert schon? Sonst die Oberflaeche fragen
static void requestPermission(int viewId, const String& kind, const String& origin, CompletionHandler<void(bool)>&& completionHandler)
{
    switch (storedPermission(kind, origin)) {
    case PermissionDecision::Granted:
        completionHandler(true);
        return;
    case PermissionDecision::Denied:
        completionHandler(false);
        return;
    case PermissionDecision::Ask:
        break;
    }
    static int nextRequestID = 1;
    int id = nextRequestID++;
    pendingRequests().set(id, [kind, origin, completionHandler = WTF::move(completionHandler)](bool granted) mutable {
        setStoredPermission(kind, origin, granted ? PermissionDecision::Granted : PermissionDecision::Denied);
        completionHandler(granted);
    });
    notifyHost(viewId, "permission", makeString("{\"id\":"_s, id, ",\"kind\":\""_s, jsonEscape(kind), "\",\"origin\":\""_s, jsonEscape(origin), "\"}"_s));
}

void requestDevicePermission(int viewId, const String& kind, const String& origin, CompletionHandler<void(bool)>&& completionHandler)
{
    requestPermission(viewId, kind, origin, WTF::move(completionHandler));
}

void answerPermission(int requestId, bool granted)
{
    if (auto completionHandler = pendingRequests().take(requestId))
        completionHandler(granted);
}

// ------------------------------------------------------------ Standort

class GeolocationClientWasm final : public GeolocationClient, public RefCounted<GeolocationClientWasm> {
    WTF_DEPRECATED_MAKE_FAST_ALLOCATED(GeolocationClientWasm);
public:
    static Ref<GeolocationClientWasm> create(int viewId) { return adoptRef(*new GeolocationClientWasm(viewId)); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    void setLastPosition(GeolocationPositionData&& position) { m_lastPosition = WTF::move(position); }

private:
    explicit GeolocationClientWasm(int viewId)
        : m_viewId(viewId)
    {
    }

    void geolocationDestroyed() final { }

    void startUpdating(const String&, bool needsHighAccuracy) final
    {
        m_highAccuracy = needsHighAccuracy;
        notifyHost(m_viewId, "geolocation-start", makeString("{\"highAccuracy\":"_s, needsHighAccuracy ? "true"_s : "false"_s, '}'));
    }

    void stopUpdating() final
    {
        notifyHost(m_viewId, "geolocation-stop");
    }

    void setEnableHighAccuracy(bool enabled) final
    {
        if (enabled == m_highAccuracy)
            return;
        m_highAccuracy = enabled;
        notifyHost(m_viewId, "geolocation-start", makeString("{\"highAccuracy\":"_s, enabled ? "true"_s : "false"_s, '}'));
    }

    std::optional<GeolocationPositionData> lastPosition() final { return m_lastPosition; }

    void requestPermission(Geolocation& geolocation) final
    {
        RefPtr frame = geolocation.frame();
        RefPtr document = frame ? frame->document() : nullptr;
        if (!document) {
            geolocation.setIsAllowed(false, { });
            return;
        }
        // Wie Chrome: die Entscheidung gilt fuer die Seite oben (topOrigin)
        String origin = document->topOrigin().toString();
        BrowserLite::requestPermission(m_viewId, "geolocation"_s, origin, [geolocation = Ref { geolocation }](bool granted) {
            geolocation->setIsAllowed(granted, { });
        });
    }

    void cancelPermissionRequest(Geolocation&) final { }

    int m_viewId;
    bool m_highAccuracy { false };
    std::optional<GeolocationPositionData> m_lastPosition;
};

static HashMap<int, RefPtr<GeolocationClientWasm>>& geolocationClients()
{
    static NeverDestroyed<HashMap<int, RefPtr<GeolocationClientWasm>>> map;
    return map;
}

static std::optional<double> optionalNumber(double value)
{
    if (std::isnan(value))
        return std::nullopt;
    return value;
}

void geolocationPosition(int viewId, double latitude, double longitude, double accuracy, double altitude, double altitudeAccuracy, double heading, double speed, double timestamp)
{
    RefPtr view = WebView::fromID(viewId);
    RefPtr client = geolocationClients().get(viewId);
    if (!view || !client)
        return;
    GeolocationPositionData position { timestamp / 1000, latitude, longitude, accuracy, optionalNumber(altitude), optionalNumber(altitudeAccuracy), optionalNumber(heading), optionalNumber(speed), std::nullopt };
    client->setLastPosition(GeolocationPositionData { position });
    if (auto* controller = GeolocationController::from(&view->page()))
        controller->positionChanged(position);
}

void geolocationError(int viewId, int code, const String& message)
{
    RefPtr view = WebView::fromID(viewId);
    if (!view)
        return;
    // Fehlercodes wie GeolocationPositionError: 1 = verweigert, sonst nicht verfuegbar
    auto error = GeolocationError::create(code == 1 ? GeolocationError::PermissionDenied : GeolocationError::PositionUnavailable, message);
    if (auto* controller = GeolocationController::from(&view->page()))
        controller->errorOccurred(error.get());
}

// ------------------------------------------------------------ Lage und Bewegung

#if ENABLE(DEVICE_ORIENTATION)
// Die Oberflaeche hoert auf deviceorientation/devicemotion des Host-Browsers,
// solange die Seite Zuhoerer hat (Chromebooks mit Touchscreen haben Sensoren,
// auf dem Desktop kommt wie bei Chrome nie ein Event).
class DeviceOrientationClientWasm final : public DeviceOrientationClient, public CanMakeCheckedPtr<DeviceOrientationClientWasm> {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(DeviceOrientationClientWasm);
    WTF_OVERRIDE_DELETE_FOR_CHECKED_PTR(DeviceOrientationClientWasm);
public:
    explicit DeviceOrientationClientWasm(int viewId)
        : m_viewId(viewId)
    {
    }

    void update(Ref<DeviceOrientationData>&& data)
    {
        m_last = WTF::move(data);
        if (m_controller)
            m_controller->didChangeDeviceOrientation(m_last.get());
    }

private:
    void setController(DeviceOrientationController* controller) final { m_controller = controller; }
    void startUpdating() final { notifyHost(m_viewId, "sensor-start", "{\"kind\":\"orientation\"}"_s); }
    void stopUpdating() final { notifyHost(m_viewId, "sensor-stop", "{\"kind\":\"orientation\"}"_s); }
    DeviceOrientationData* lastOrientation() const final { return m_last.get(); }
    void deviceOrientationControllerDestroyed() final { m_controller = nullptr; }
    uint32_t checkedPtrCount() const final { return CanMakeCheckedPtr::checkedPtrCount(); }
    uint32_t checkedPtrCountWithoutThreadCheck() const final { return CanMakeCheckedPtr::checkedPtrCountWithoutThreadCheck(); }
    void incrementCheckedPtrCount() const final { CanMakeCheckedPtr::incrementCheckedPtrCount(); }
    void decrementCheckedPtrCount() const final { CanMakeCheckedPtr::decrementCheckedPtrCount(); }
    void setDidBeginCheckedPtrDeletion() final { CanMakeCheckedPtr::setDidBeginCheckedPtrDeletion(); }

    int m_viewId;
    DeviceOrientationController* m_controller { nullptr };
    RefPtr<DeviceOrientationData> m_last;
};

class DeviceMotionClientWasm final : public DeviceMotionClient, public CanMakeCheckedPtr<DeviceMotionClientWasm> {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(DeviceMotionClientWasm);
    WTF_OVERRIDE_DELETE_FOR_CHECKED_PTR(DeviceMotionClientWasm);
public:
    explicit DeviceMotionClientWasm(int viewId)
        : m_viewId(viewId)
    {
    }

    void update(Ref<DeviceMotionData>&& data)
    {
        m_last = WTF::move(data);
        if (m_controller)
            m_controller->didChangeDeviceMotion(m_last.get());
    }

private:
    void setController(DeviceMotionController* controller) final { m_controller = controller; }
    void startUpdating() final { notifyHost(m_viewId, "sensor-start", "{\"kind\":\"motion\"}"_s); }
    void stopUpdating() final { notifyHost(m_viewId, "sensor-stop", "{\"kind\":\"motion\"}"_s); }
    DeviceMotionData* lastMotion() const final { return m_last.get(); }
    void deviceMotionControllerDestroyed() final { m_controller = nullptr; }
    uint32_t checkedPtrCount() const final { return CanMakeCheckedPtr::checkedPtrCount(); }
    uint32_t checkedPtrCountWithoutThreadCheck() const final { return CanMakeCheckedPtr::checkedPtrCountWithoutThreadCheck(); }
    void incrementCheckedPtrCount() const final { CanMakeCheckedPtr::incrementCheckedPtrCount(); }
    void decrementCheckedPtrCount() const final { CanMakeCheckedPtr::decrementCheckedPtrCount(); }
    void setDidBeginCheckedPtrDeletion() final { CanMakeCheckedPtr::setDidBeginCheckedPtrDeletion(); }

    int m_viewId;
    DeviceMotionController* m_controller { nullptr };
    RefPtr<DeviceMotionData> m_last;
};

// Die Controller der Page zeigen auf die Clients und werden nicht vor ihnen
// abgebaut, darum bleiben die (kleinen) Clients bis zum Ende der Engine.
struct SensorClients {
    std::unique_ptr<DeviceOrientationClientWasm> orientation;
    std::unique_ptr<DeviceMotionClientWasm> motion;
};

static HashMap<int, SensorClients>& sensorClients()
{
    static NeverDestroyed<HashMap<int, SensorClients>> map;
    return map;
}
#endif

void deviceOrientation(int viewId, double alpha, double beta, double gamma, bool absolute)
{
#if ENABLE(DEVICE_ORIENTATION)
    auto it = sensorClients().find(viewId);
    if (it != sensorClients().end())
        it->value.orientation->update(DeviceOrientationData::create(optionalNumber(alpha), optionalNumber(beta), optionalNumber(gamma), absolute));
#else
    UNUSED_PARAM(viewId); UNUSED_PARAM(alpha); UNUSED_PARAM(beta); UNUSED_PARAM(gamma); UNUSED_PARAM(absolute);
#endif
}

void deviceMotion(int viewId, const double* values, double interval)
{
#if ENABLE(DEVICE_ORIENTATION)
    auto it = sensorClients().find(viewId);
    if (it == sensorClients().end())
        return;
    // values: Beschleunigung x/y/z, mit Schwerkraft x/y/z, Drehung alpha/beta/gamma (NaN = fehlt)
    auto acceleration = [&](int start) -> RefPtr<DeviceMotionData::Acceleration> {
        if (std::isnan(values[start]) && std::isnan(values[start + 1]) && std::isnan(values[start + 2]))
            return nullptr;
        return DeviceMotionData::Acceleration::create(optionalNumber(values[start]), optionalNumber(values[start + 1]), optionalNumber(values[start + 2]));
    };
    RefPtr<DeviceMotionData::RotationRate> rotation;
    if (!std::isnan(values[6]) || !std::isnan(values[7]) || !std::isnan(values[8]))
        rotation = DeviceMotionData::RotationRate::create(optionalNumber(values[6]), optionalNumber(values[7]), optionalNumber(values[8]));
    it->value.motion->update(DeviceMotionData::create(acceleration(0), acceleration(3), WTF::move(rotation), optionalNumber(interval)));
#else
    UNUSED_PARAM(viewId); UNUSED_PARAM(values); UNUSED_PARAM(interval);
#endif
}

// ------------------------------------------------------------ Benachrichtigungen

static HashMap<String, std::unique_ptr<NotificationData>>& shownNotifications()
{
    static NeverDestroyed<HashMap<String, std::unique_ptr<NotificationData>>> map;
    return map;
}

class NotificationClientWasm final : public NotificationClient {
    WTF_DEPRECATED_MAKE_FAST_ALLOCATED(NotificationClientWasm);
public:
    explicit NotificationClientWasm(int viewId)
        : m_viewId(viewId)
    {
    }

private:
    static String originOf(ScriptExecutionContext& context)
    {
        RefPtr origin = context.securityOrigin();
        return origin ? origin->toString() : String { };
    }

    bool show(ScriptExecutionContext& context, NotificationData&& data, RefPtr<NotificationResources>&&, CompletionHandler<void()>&& completionHandler) final
    {
        if (storedPermission("notifications"_s, originOf(context)) != PermissionDecision::Granted) {
            completionHandler();
            return false;
        }
        String id = data.notificationID.toString();
        notifyHost(m_viewId, "notification", makeString("{\"id\":\""_s, id, "\",\"title\":\""_s, jsonEscape(data.title),
            "\",\"body\":\""_s, jsonEscape(data.body), "\",\"icon\":\""_s, jsonEscape(data.iconURL),
            "\",\"tag\":\""_s, jsonEscape(data.tag), "\",\"lang\":\""_s, jsonEscape(data.language),
            "\",\"silent\":"_s, data.silent.value_or(false) ? "true"_s : "false"_s, '}'));
        shownNotifications().set(id, std::make_unique<NotificationData>(WTF::move(data)));
        completionHandler();
        return true;
    }

    void cancel(NotificationData&& data) final
    {
        String id = data.notificationID.toString();
        notifyHost(m_viewId, "notification-close", makeString("{\"id\":\""_s, id, "\"}"_s));
    }

    void notificationObjectDestroyed(NotificationData&& data) final
    {
        shownNotifications().remove(data.notificationID.toString());
    }

    void notificationControllerDestroyed() final
    {
        delete this;
    }

    void requestPermission(ScriptExecutionContext& context, PermissionHandler&& permissionHandler) final
    {
        BrowserLite::requestPermission(m_viewId, "notifications"_s, originOf(context), [permissionHandler = WTF::move(permissionHandler)](bool granted) mutable {
            permissionHandler(granted ? Permission::Granted : Permission::Denied);
        });
    }

    Permission checkPermission(ScriptExecutionContext* context) final
    {
        if (!context)
            return Permission::Default;
        switch (storedPermission("notifications"_s, originOf(*context))) {
        case PermissionDecision::Granted:
            return Permission::Granted;
        case PermissionDecision::Denied:
            return Permission::Denied;
        case PermissionDecision::Ask:
            break;
        }
        return Permission::Default;
    }

    int m_viewId;
};

void notificationEvent(const String& notificationID, int type)
{
    auto it = shownNotifications().find(notificationID);
    if (it == shownNotifications().end())
        return;
    NotificationData data = *it->value;
    if (type >= 2)
        shownNotifications().remove(it);
    Notification::ensureOnNotificationThread(data, [type](Notification* notification) {
        if (!notification)
            return;
        switch (type) {
        case 0:
            notification->dispatchShowEvent();
            break;
        case 1:
            notification->dispatchClickEvent();
            break;
        case 2:
            notification->dispatchCloseEvent();
            break;
        default:
            notification->dispatchErrorEvent();
        }
    });
}

// ------------------------------------------------------------ Spracherkennung
// webkitSpeechRecognition: die Oberflaeche erkennt mit SpeechRecognition des
// Host-Browsers und meldet die Ereignisse zurueck (bl_speech_recognition_event).
// Wie Chrome fragen wir pro Ursprung nach dem Mikrofon.

static HashMap<uint64_t, WeakPtr<SpeechRecognitionConnectionClient>>& recognitionClients()
{
    static NeverDestroyed<HashMap<uint64_t, WeakPtr<SpeechRecognitionConnectionClient>>> map;
    return map;
}

class SpeechRecognitionConnectionWasm final : public SpeechRecognitionConnection {
public:
    static Ref<SpeechRecognitionConnectionWasm> create(int viewId) { return adoptRef(*new SpeechRecognitionConnectionWasm(viewId)); }

private:
    explicit SpeechRecognitionConnectionWasm(int viewId)
        : m_viewId(viewId)
    {
    }

    void registerClient(SpeechRecognitionConnectionClient& client) final
    {
        recognitionClients().set(client.identifier().toUInt64(), client);
    }

    void unregisterClient(SpeechRecognitionConnectionClient& client) final
    {
        auto id = client.identifier().toUInt64();
        if (recognitionClients().remove(id))
            notifyHost(m_viewId, "speech-recognition", makeString("{\"id\":"_s, id, ",\"action\":\"abort\"}"_s));
    }

    void start(SpeechRecognitionConnectionClientIdentifier identifier, const String& lang, bool continuous, bool interimResults, uint64_t maxAlternatives, ClientOrigin&& clientOrigin, FrameIdentifier) final
    {
        auto id = identifier.toUInt64();
        auto origin = clientOrigin.clientOrigin.toString();
        requestPermission(m_viewId, "microphone"_s, origin, [viewId = m_viewId, id, lang = lang.isolatedCopy(), continuous, interimResults, maxAlternatives](bool granted) {
            RefPtr client = recognitionClients().get(id);
            if (!client)
                return;
            if (!granted) {
                client->didError({ SpeechRecognitionErrorType::NotAllowed, "Permission is denied"_s });
                return;
            }
            notifyHost(viewId, "speech-recognition", makeString("{\"id\":"_s, id, ",\"action\":\"start\",\"lang\":\""_s, jsonEscape(lang),
                "\",\"continuous\":"_s, continuous ? "true"_s : "false"_s, ",\"interimResults\":"_s, interimResults ? "true"_s : "false"_s,
                ",\"maxAlternatives\":"_s, maxAlternatives, '}'));
        });
    }

    void stop(SpeechRecognitionConnectionClientIdentifier identifier) final
    {
        notifyHost(m_viewId, "speech-recognition", makeString("{\"id\":"_s, identifier.toUInt64(), ",\"action\":\"stop\"}"_s));
    }

    void abort(SpeechRecognitionConnectionClientIdentifier identifier) final
    {
        notifyHost(m_viewId, "speech-recognition", makeString("{\"id\":"_s, identifier.toUInt64(), ",\"action\":\"abort\"}"_s));
    }

    void didReceiveUpdate(SpeechRecognitionUpdate&&) final { }

    const int m_viewId;
};

class SpeechRecognitionProviderWasm final : public SpeechRecognitionProvider {
public:
    explicit SpeechRecognitionProviderWasm(int viewId)
        : m_connection(SpeechRecognitionConnectionWasm::create(viewId))
    {
    }

private:
    SpeechRecognitionConnection& speechRecognitionConnection() final { return m_connection; }

    const Ref<SpeechRecognitionConnectionWasm> m_connection;
};

UniqueRef<SpeechRecognitionProvider> createSpeechRecognitionProvider(int viewId)
{
    return makeUniqueRef<SpeechRecognitionProviderWasm>(viewId);
}

void speechRecognitionEvent(uint64_t id, int type, const String& json)
{
    RefPtr client = recognitionClients().get(id);
    if (!client)
        return;
    switch (type) {
    case 0:
        client->didStart();
        break;
    case 1:
        client->didStartCapturingAudio();
        break;
    case 2:
        client->didStartCapturingSound();
        break;
    case 3:
        client->didStartCapturingSpeech();
        break;
    case 4:
        client->didStopCapturingSpeech();
        break;
    case 5:
        client->didStopCapturingSound();
        break;
    case 6:
        client->didStopCapturingAudio();
        break;
    case 7: {
        // [{"final":true,"alternatives":[["Text",0.9],...]},...]
        auto value = JSON::Value::parseJSON(json);
        auto array = value ? value->asArray() : nullptr;
        if (!array)
            break;
        Vector<SpeechRecognitionResultData> results;
        for (auto& item : *array) {
            auto object = item->asObject();
            if (!object)
                continue;
            SpeechRecognitionResultData result;
            result.isFinal = object->getBoolean("final"_s).value_or(false);
            if (auto alternatives = object->getArray("alternatives"_s)) {
                for (auto& alternative : *alternatives) {
                    auto pair = alternative->asArray();
                    if (!pair || pair->length() < 2)
                        continue;
                    result.alternatives.append({ pair->get(0)->asString(), pair->get(1)->asDouble().value_or(0) });
                }
            }
            results.append(WTF::move(result));
        }
        client->didReceiveResult(WTF::move(results));
        break;
    }
    case 8:
        client->didFindNoMatch();
        break;
    case 9: {
        // {"error":2,"message":"..."} mit error als Index in SpeechRecognitionErrorType
        auto value = JSON::Value::parseJSON(json);
        auto object = value ? value->asObject() : nullptr;
        int error = object ? object->getInteger("error"_s).value_or(0) : 0;
        if (error < 0 || error > static_cast<int>(SpeechRecognitionErrorType::LanguageNotSupported))
            error = static_cast<int>(SpeechRecognitionErrorType::Network);
        client->didError({ static_cast<SpeechRecognitionErrorType>(error), object ? object->getString("message"_s) : String { } });
        break;
    }
    case 10:
        client->didEnd();
        break;
    default:
        break;
    }
}

// ------------------------------------------------------------

void attachDeviceClients(WebView& view, Page& page)
{
    auto geolocationClient = GeolocationClientWasm::create(view.id());
    provideGeolocationTo(&page, geolocationClient.get());
    geolocationClients().set(view.id(), WTF::move(geolocationClient));
    // Gehoert danach dem NotificationController (notificationControllerDestroyed)
    provideNotification(&page, new NotificationClientWasm(view.id()));
#if ENABLE(DEVICE_ORIENTATION)
    auto& sensors = sensorClients().add(view.id(), SensorClients { }).iterator->value;
    if (!sensors.orientation) {
        sensors.orientation = makeUnique<DeviceOrientationClientWasm>(view.id());
        sensors.motion = makeUnique<DeviceMotionClientWasm>(view.id());
    }
    // Namen wie DeviceOrientationController::supplementName() (privat). In
    // WebKit stellt kein Port die Controller mehr bereit.
    Supplement<Page>::provideTo(&page, "DeviceOrientationController"_s, makeUnique<DeviceOrientationController>(*sensors.orientation));
    Supplement<Page>::provideTo(&page, "DeviceMotionController"_s, makeUnique<DeviceMotionController>(*sensors.motion));
#endif
}

void detachDeviceClients(int viewId)
{
    geolocationClients().remove(viewId);
}

} // namespace BrowserLite
