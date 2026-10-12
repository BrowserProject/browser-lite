// Antworten fuer navigator.permissions.query() wie in Chrome ohne bisherige
// Entscheidung: "prompt" fuer alles, was spaeter eine Abfrage zeigt, "granted"
// fuer das, was Chrome ohne Abfrage erlaubt.
#include "config.h"
#include "Engine.h"
#include "DeviceClients.h"

#include <WebCore/ClientOrigin.h>
#include <WebCore/PermissionController.h>
#include <WebCore/PermissionDescriptor.h>
#include <WebCore/PermissionQuerySource.h>
#include <WebCore/PermissionState.h>

using namespace WebCore;

namespace BrowserLite {

class EnginePermissionController final : public PermissionController {
public:
    static Ref<EnginePermissionController> create() { return adoptRef(*new EnginePermissionController); }

private:
    void query(ClientOrigin&& clientOrigin, PermissionDescriptor descriptor, const WeakPtr<Page>&, PermissionQuerySource, CompletionHandler<void(std::optional<PermissionState>)>&& completionHandler) final
    {
        // Schon entschieden (Abfrage in der Oberflaeche, DeviceClients.cpp)?
        String origin = clientOrigin.topOrigin.toString();
        String kind = descriptor.name == PermissionName::Geolocation ? "geolocation"_s
            : descriptor.name == PermissionName::Notifications ? "notifications"_s : String { };
        if (!kind.isNull()) {
            switch (storedPermission(kind, origin)) {
            case PermissionDecision::Granted:
                completionHandler(PermissionState::Granted);
                return;
            case PermissionDecision::Denied:
                completionHandler(PermissionState::Denied);
                return;
            case PermissionDecision::Ask:
                break;
            }
        }
        switch (descriptor.name) {
        case PermissionName::Accelerometer:
        case PermissionName::Gyroscope:
        case PermissionName::Magnetometer:
        case PermissionName::BackgroundFetch:
        case PermissionName::ScreenWakeLock:
            completionHandler(PermissionState::Granted);
            return;
        default:
            completionHandler(PermissionState::Prompt);
        }
    }
    void addObserver(PermissionObserver&) final { }
    void removeObserver(PermissionObserver&) final { }
    void storageAccessPermissionChanged(const RegistrableDomain&, const RegistrableDomain&) final { }
    void permissionChanged(PermissionName, const SecurityOriginData&) final { }
    void addChangeListener(PermissionName, const RegistrableDomain&, const RegistrableDomain&) final { }
    void removeChangeListener(PermissionName, const RegistrableDomain&, const RegistrableDomain&) final { }
};

void installPermissionController()
{
    PermissionController::setSharedController(EnginePermissionController::create());
}

} // namespace BrowserLite
