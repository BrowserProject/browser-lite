// Answers for navigator.permissions.query(): first the remembered decision
// (prompt in the host, DeviceClients.cpp), otherwise like Chrome without a
// previous decision: "prompt" for everything that shows a prompt later,
// "granted" for what Chrome allows without a prompt. A disabled feature
// answers "denied" (DeviceClients.cpp).
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

// Kind and origin under which DeviceClients.cpp remembers the decision
static PermissionDecision storedDecision(PermissionName name, const ClientOrigin& clientOrigin)
{
    auto top = clientOrigin.topOrigin.toString();
    switch (name) {
    case PermissionName::Geolocation:
        return storedPermission("geolocation"_s, top);
    case PermissionName::Camera:
        return storedPermission("camera"_s, top);
    case PermissionName::Microphone:
        return storedPermission("microphone"_s, top);
    case PermissionName::Notifications:
        return storedPermission("notifications"_s, clientOrigin.clientOrigin.toString());
    default:
        return PermissionDecision::Ask;
    }
}

class EnginePermissionController final : public PermissionController {
public:
    static Ref<EnginePermissionController> create() { return adoptRef(*new EnginePermissionController); }

private:
    void query(ClientOrigin&& clientOrigin, PermissionDescriptor descriptor, const WeakPtr<Page>&, PermissionQuerySource, CompletionHandler<void(std::optional<PermissionState>)>&& completionHandler) final
    {
        switch (storedDecision(descriptor.name, clientOrigin)) {
        case PermissionDecision::Granted:
            completionHandler(PermissionState::Granted);
            return;
        case PermissionDecision::Denied:
            completionHandler(PermissionState::Denied);
            return;
        case PermissionDecision::Ask:
            break;
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
