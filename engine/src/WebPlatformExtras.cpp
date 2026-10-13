#include "config.h"
#include "WebPlatformExtras.h"

#include <WebCore/DOMWrapperWorld.h>
#include <WebCore/Exception.h>
#include <WebCore/ExceptionOr.h>
#include <WebCore/ScreenOrientationManager.h>
#include <WebCore/ScreenOrientationType.h>
#include <WebCore/StorageConnection.h>
#include <WebCore/StorageProvider.h>
#include <WebCore/UserContentController.h>
#include <WebCore/UserScript.h>
#include <WebCore/WasmPlatform.h>
#include <filesystem>
#include <system_error>
#include <wtf/NeverDestroyed.h>
#include <wtf/RefCounted.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/WeakHashSet.h>

namespace BrowserLite {

using namespace WebCore;

// ---------------------------------------------------------------- navigator.storage

// Alles Dauerhafte liegt unter /data (IDBFS, web/app.js). Die Quote ist eine
// feste Groesse wie bei Chrome auf einem kleinen Geraet; die echte Grenze setzt
// der Host-Browser fuer browser-lite als Ganzes.
static constexpr uint64_t storageQuota = 2ull * 1024 * 1024 * 1024;

static uint64_t storageUsage()
{
    uint64_t usage = 0;
    std::error_code error;
    for (auto it = std::filesystem::recursive_directory_iterator("/data", error); !error && it != std::filesystem::recursive_directory_iterator(); it.increment(error)) {
        if (it->is_regular_file(error))
            usage += it->file_size(error);
    }
    return usage;
}

class StorageConnectionWasm final : public StorageConnection {
public:
    static Ref<StorageConnectionWasm> create() { return adoptRef(*new StorageConnectionWasm); }

    void getPersisted(ClientOrigin&&, PersistCallback&& completionHandler) final { completionHandler(false); }
    void persist(const ClientOrigin&, PersistCallback&& completionHandler) final { completionHandler(false); }
    void fileSystemGetDirectory(ClientOrigin&&, GetDirectoryCallback&& completionHandler) final
    {
        // Origin Private File System fehlt noch (braucht einen FileSystemStorageConnection)
        completionHandler(ExceptionOr<DirectoryInfo> { Exception { ExceptionCode::NotSupportedError } });
    }
    void getEstimate(ClientOrigin&&, GetEstimateCallback&& completionHandler) final
    {
        completionHandler(ExceptionOr<StorageEstimate> { StorageEstimate { storageUsage(), storageQuota } });
    }
};

class StorageProviderWasm final : public StorageProvider {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(StorageProviderWasm);
public:
    StorageConnection& storageConnection() final { return m_connection.get(); }
    String ensureMediaKeysStorageDirectoryForOrigin(const SecurityOriginData&) final { return { }; }
    void setMediaKeysStorageDirectory(const String&) final { }

private:
    Ref<StorageConnectionWasm> m_connection { StorageConnectionWasm::create() };
};

UniqueRef<StorageProvider> createStorageProvider()
{
    return makeUniqueRef<StorageProviderWasm>();
}

// ---------------------------------------------------------------- screen.orientation

// Wie Chrome auf dem Desktop: Ausrichtung aus der Bildschirmgroesse, sperren
// geht nicht (lock() lehnt mit NotSupportedError ab).
class ScreenOrientationManagerWasm final : public ScreenOrientationManager, public RefCounted<ScreenOrientationManagerWasm> {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(ScreenOrientationManagerWasm);
public:
    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    ScreenOrientationType currentOrientation() final
    {
        auto rect = WasmPlatform::screenInfo().rect;
        return rect.width() >= rect.height() ? ScreenOrientationType::LandscapePrimary : ScreenOrientationType::PortraitPrimary;
    }

    void lock(ScreenOrientationLockType, CompletionHandler<void(std::optional<Exception>&&)>&& completionHandler) final
    {
        completionHandler(Exception { ExceptionCode::NotSupportedError, "screen.orientation.lock() is not available on this device."_s });
    }

    void unlock() final { }
    void addObserver(ScreenOrientationManagerObserver& observer) final { m_observers.add(observer); }
    void removeObserver(ScreenOrientationManagerObserver& observer) final { m_observers.remove(observer); }

    void notifyIfChanged()
    {
        auto orientation = currentOrientation();
        if (orientation == m_lastOrientation)
            return;
        m_lastOrientation = orientation;
        Vector<Ref<ScreenOrientationManagerObserver>> observers;
        for (auto& observer : m_observers)
            observers.append(observer);
        for (auto& observer : observers)
            observer->screenOrientationDidChange(orientation);
    }

private:
    WeakHashSet<ScreenOrientationManagerObserver> m_observers;
    ScreenOrientationType m_lastOrientation { ScreenOrientationType::LandscapePrimary };
};

static ScreenOrientationManagerWasm& orientationManager()
{
    static NeverDestroyed<Ref<ScreenOrientationManagerWasm>> manager = adoptRef(*new ScreenOrientationManagerWasm);
    return manager.get();
}

ScreenOrientationManager& screenOrientationManager()
{
    return orientationManager();
}

void screenOrientationMayHaveChanged()
{
    orientationManager().notifyIfChanged();
}

// ---------------------------------------------------------------- Polyfills

// Laeuft vor jedem Skript der Seite in jedem Frame (Haupt-Welt). Nur APIs mit
// klarer Bedeutung, die sich mit vorhandenen Mitteln sauber nachbauen lassen.
static constexpr auto polyfillSource = R"JS((() => {
  const define = (target, name, value) => {
    if (!(name in target))
      Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  };

  // Prioritized Task Scheduling (scheduler.postTask, scheduler.yield)
  if (typeof globalThis.AbortController === 'function') {
    class TaskSignal extends AbortSignal {}
    class TaskController extends AbortController {
      constructor(init = {}) {
        super();
        this._priority = init.priority || 'user-visible';
      }
      setPriority(priority) { this._priority = priority; }
    }
    const abortError = (signal) => signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    const scheduler = {
      postTask(callback, options = {}) {
        const { signal, delay = 0 } = options;
        return new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(abortError(signal));
            return;
          }
          const onAbort = () => {
            clearTimeout(id);
            reject(abortError(signal));
          };
          const id = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            try {
              resolve(callback());
            } catch (error) {
              reject(error);
            }
          }, Math.max(0, Number(delay) || 0));
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
      yield() {
        return new Promise((resolve) => setTimeout(resolve, 0));
      },
    };
    define(globalThis, 'scheduler', scheduler);
    define(globalThis, 'TaskController', TaskController);
    define(globalThis, 'TaskSignal', TaskSignal);
  }

  // navigator.vibrate: Chrome auf dem Desktop hat es, ohne Motor passiert nichts
  if (typeof Navigator === 'function')
    define(Navigator.prototype, 'vibrate', function vibrate() { return true; });
})();)JS";

Ref<UserContentProvider> userContentProvider()
{
    static NeverDestroyed<Ref<UserContentController>> controller = [] {
        auto controller = UserContentController::create();
        controller->addUserScript(mainThreadNormalWorldSingleton(), makeUnique<UserScript>(String::fromUTF8(polyfillSource)));
        return controller;
    }();
    return controller.get();
}

} // namespace BrowserLite
