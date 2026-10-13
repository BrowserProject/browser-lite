#include "config.h"
#include "WebPlatformExtras.h"

#include "Engine.h"
#include "FileSystemStorageWasm.h"
#include "Host.h"

#include <JavaScriptCore/CallData.h>
#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/JSLock.h>
#include <JavaScriptCore/JSNativeStdFunction.h>
#include <JavaScriptCore/StrongInlines.h>
#include <WebCore/DOMWrapperWorld.h>
#include <WebCore/Exception.h>
#include <WebCore/JSDOMGlobalObject.h>
#include <WebCore/ScriptExecutionContext.h>
#include <WebCore/SecurityOrigin.h>
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
#include <wtf/text/MakeString.h>

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
    void fileSystemGetDirectory(ClientOrigin&& origin, GetDirectoryCallback&& completionHandler) final
    {
        // Origin Private File System (FileSystemStorageWasm.cpp)
        BrowserLite::fileSystemGetDirectory(origin, WTF::move(completionHandler));
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

  // APIs des Host-Browsers ueber die Oberflaeche (installHostBridge, web/devices.js).
  // Die Bruecke ist nur hier sichtbar, die Seite sieht sie nicht.
  const host = globalThis.__blHost;
  delete globalThis.__blHost;
  if (typeof host !== 'function' || typeof Navigator !== 'function')
    return;
  const call = (name, payload) => new Promise((resolve, reject) => {
    host(name, JSON.stringify(payload ?? null), (ok, result) => {
      const value = JSON.parse(result);
      if (ok)
        resolve(value);
      else
        reject(new DOMException(value?.message || 'Failed', value?.name || 'NotSupportedError'));
    });
  });

  // EyeDropper: Farbe vom Bildschirm (die Seite ist im Host ja ein Canvas)
  if (!('EyeDropper' in globalThis)) {
    class EyeDropper {
      open(options = {}) {
        if (options.signal?.aborted)
          return Promise.reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return call('eyedropper');
      }
    }
    define(globalThis, 'EyeDropper', EyeDropper);
  }

  // Battery Status API (Chromebooks haben einen Akku)
  let battery;
  define(Navigator.prototype, 'getBattery', function getBattery() {
    battery ??= call('battery').then((info) => {
      const manager = new EventTarget();
      for (const name of ['charging', 'chargingTime', 'dischargingTime', 'level'])
        Object.defineProperty(manager, name, { get: () => info[name] ?? Infinity, enumerable: true });
      for (const name of ['onchargingchange', 'onchargingtimechange', 'ondischargingtimechange', 'onlevelchange'])
        manager[name] = null;
      return manager;
    });
    return battery;
  });

  // Keyboard API: Tasten im Vollbild selber behandeln, Tastatur-Belegung
  if (!('keyboard' in Navigator.prototype)) {
    const keyboard = {
      lock(keyCodes) { return call('keyboard-lock', { keyCodes: keyCodes ? [...keyCodes] : null }).then(() => undefined); },
      unlock() { call('keyboard-unlock').catch(() => {}); },
      getLayoutMap() { return call('keyboard-layout').then((entries) => new Map(entries)); },
    };
    Object.defineProperty(Navigator.prototype, 'keyboard', { get: () => keyboard, configurable: true, enumerable: true });
  }

  // File System Access API: Dateien und Ordner des Host oeffnen und speichern.
  // Die Handles des Host bleiben in der Oberflaeche, hier nur ihre id.
  if (typeof globalThis.showOpenFilePicker !== 'function' && typeof FileSystemFileHandle === 'function' && typeof FileSystemDirectoryHandle === 'function') {
    const ids = new WeakMap();
    const fromBase64 = typeof Uint8Array.fromBase64 === 'function'
      ? (text) => Uint8Array.fromBase64(text)
      : (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    const toBase64 = (bytes) => {
      if (typeof bytes.toBase64 === 'function')
        return bytes.toBase64();
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(text);
    };
    const toBytes = async (data) => {
      if (typeof data === 'string')
        return new TextEncoder().encode(data);
      if (data instanceof Blob)
        return new Uint8Array(await data.arrayBuffer());
      if (ArrayBuffer.isView(data))
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (data instanceof ArrayBuffer)
        return new Uint8Array(data);
      throw new TypeError('Unsupported data for FileSystemWritableFileStream.write()');
    };
    const makeWritable = (id) => {
      const send = (operation) => call('fs-write', Object.assign({ id }, operation)).then(() => undefined);
      const stream = new WritableStream({
        async write(chunk) {
          if (chunk && typeof chunk === 'object' && typeof chunk.type === 'string' && !(chunk instanceof Blob) && !ArrayBuffer.isView(chunk) && !(chunk instanceof ArrayBuffer)) {
            if (chunk.type === 'seek')
              return send({ op: 'seek', position: chunk.position });
            if (chunk.type === 'truncate')
              return send({ op: 'truncate', size: chunk.size });
            return send({ op: 'write', position: chunk.position, data: toBase64(await toBytes(chunk.data)) });
          }
          return send({ op: 'write', data: toBase64(await toBytes(chunk)) });
        },
        close: () => send({ op: 'close' }),
        abort: () => send({ op: 'abort' }),
      });
      if (typeof FileSystemWritableFileStream === 'function')
        Object.setPrototypeOf(stream, FileSystemWritableFileStream.prototype);
      const write = (value) => {
        const writer = WritableStream.prototype.getWriter.call(stream);
        return writer.write(value).finally(() => writer.releaseLock());
      };
      Object.defineProperties(stream, {
        write: { value: write, configurable: true },
        seek: { value: (position) => write({ type: 'seek', position }), configurable: true },
        truncate: { value: (size) => write({ type: 'truncate', size }), configurable: true },
      });
      return stream;
    };
    const makeHandle = (info) => {
      const directory = info.kind === 'directory';
      const handle = Object.create(directory ? FileSystemDirectoryHandle.prototype : FileSystemFileHandle.prototype);
      ids.set(handle, info.id);
      const own = (name, value) => Object.defineProperty(handle, name, { value, configurable: true });
      own('kind', info.kind);
      own('name', info.name);
      own('isSameEntry', (other) => call('fs-same', { id: info.id, other: ids.get(other) ?? null }));
      own('queryPermission', (descriptor) => call('fs-permission', { id: info.id, mode: descriptor?.mode || 'read', request: false }));
      own('requestPermission', (descriptor) => call('fs-permission', { id: info.id, mode: descriptor?.mode || 'read', request: true }));
      if (!directory) {
        own('getFile', async () => {
          const file = await call('fs-file', { id: info.id });
          return new File([fromBase64(file.data)], file.name, { type: file.type, lastModified: file.lastModified });
        });
        own('createWritable', async (options) => makeWritable((await call('fs-writable', { id: info.id, keepExistingData: !!options?.keepExistingData })).id));
        return handle;
      }
      const child = (kind) => async (name, options) => makeHandle(await call('fs-child', { id: info.id, name: String(name), kind, create: !!options?.create }));
      own('getFileHandle', child('file'));
      own('getDirectoryHandle', child('directory'));
      own('removeEntry', (name, options) => call('fs-remove', { id: info.id, name: String(name), recursive: !!options?.recursive }).then(() => undefined));
      own('resolve', (possibleDescendant) => call('fs-resolve', { id: info.id, other: ids.get(possibleDescendant) ?? null }));
      const list = () => call('fs-list', { id: info.id });
      own('entries', async function* entries() { for (const entry of await list()) yield [entry.name, makeHandle(entry)]; });
      own('keys', async function* keys() { for (const entry of await list()) yield entry.name; });
      own('values', async function* values() { for (const entry of await list()) yield makeHandle(entry); });
      own(Symbol.asyncIterator, handle.entries);
      return handle;
    };
    // Nur was der Host verstehen kann: Typen, Mehrfachauswahl, Name, Startordner als Text
    const pickerOptions = (options = {}) => ({
      types: Array.isArray(options.types) ? options.types.map((type) => ({ description: type?.description ? String(type.description) : undefined, accept: type?.accept })) : undefined,
      excludeAcceptAllOption: !!options.excludeAcceptAllOption,
      multiple: !!options.multiple,
      suggestedName: options.suggestedName ? String(options.suggestedName) : undefined,
      id: options.id ? String(options.id) : undefined,
      startIn: typeof options.startIn === 'string' ? options.startIn : undefined,
      mode: options.mode === 'readwrite' ? 'readwrite' : undefined,
    });
    define(globalThis, 'showOpenFilePicker', async (options) => (await call('fs-open', pickerOptions(options))).map(makeHandle));
    define(globalThis, 'showSaveFilePicker', async (options) => makeHandle(await call('fs-save', pickerOptions(options))));
    define(globalThis, 'showDirectoryPicker', async (options) => makeHandle(await call('fs-directory', pickerOptions(options))));
  }
})();)JS";

// ---------------------------------------------------------------- Host-Bruecke

namespace {

struct PendingHostCall {
    JSC::Strong<JSC::JSGlobalObject> globalObject;
    JSC::Strong<JSC::JSObject> callback;
};

HashMap<uint64_t, PendingHostCall>& pendingHostCalls()
{
    static NeverDestroyed<HashMap<uint64_t, PendingHostCall>> calls;
    return calls;
}

// Nur diese APIs des Host darf eine Seite ueber die Polyfills erreichen
bool isAllowedHostCall(const String& name)
{
    static constexpr ASCIILiteral allowed[] = {
        "eyedropper"_s, "battery"_s, "keyboard-lock"_s, "keyboard-unlock"_s, "keyboard-layout"_s,
        "fs-open"_s, "fs-save"_s, "fs-directory"_s, "fs-file"_s, "fs-writable"_s, "fs-write"_s, "fs-child"_s,
        "fs-list"_s, "fs-remove"_s, "fs-resolve"_s, "fs-same"_s, "fs-permission"_s,
        "rtc-create"_s, "rtc-op"_s, "rtc-poll"_s, "rtc-send"_s, "rtc-channel"_s, "rtc-channel-close"_s, "rtc-close"_s, "rtc-close-all"_s,
    };
    for (auto entry : allowed) {
        if (name == entry)
            return true;
    }
    return false;
}

}

void installHostBridge(JSC::JSGlobalObject& globalObject, int viewId)
{
    auto& vm = globalObject.vm();
    auto* function = JSC::JSNativeStdFunction::create(vm, &globalObject, 3, "__blHost"_s, [viewId](JSC::JSGlobalObject* globalObject, JSC::CallFrame* callFrame) -> JSC::EncodedJSValue {
        auto& vm = globalObject->vm();
        auto scope = DECLARE_THROW_SCOPE(vm);
        auto name = callFrame->argument(0).toWTFString(globalObject);
        RETURN_IF_EXCEPTION(scope, { });
        auto payload = callFrame->argument(1).toWTFString(globalObject);
        RETURN_IF_EXCEPTION(scope, { });
        auto* callback = callFrame->argument(2).getObject();
        if (!callback || !callback->isCallable() || !isAllowedHostCall(name))
            return JSC::JSValue::encode(JSC::jsUndefined());
        static uint64_t nextIdentifier;
        auto identifier = ++nextIdentifier;
        pendingHostCalls().add(identifier, PendingHostCall { { vm, globalObject }, { vm, callback } });
        // Der Ursprung der Seite: die Oberflaeche gibt Handles (Dateien) nur ihm wieder heraus
        String origin;
        if (auto* domGlobalObject = dynamicDowncast<WebCore::JSDOMGlobalObject>(globalObject)) {
            if (RefPtr context = domGlobalObject->scriptExecutionContext())
                origin = context->securityOrigin() ? context->securityOrigin()->toString() : String { };
        }
        notifyHost(viewId, "host-call", makeString("{\"id\":"_s, identifier, ",\"name\":\""_s, jsonEscape(name), "\",\"origin\":\""_s, jsonEscape(origin), "\",\"payload\":\""_s, jsonEscape(payload), "\"}"_s));
        return JSC::JSValue::encode(JSC::jsUndefined());
    });
    globalObject.putDirect(vm, JSC::Identifier::fromString(vm, "__blHost"_s), function, static_cast<unsigned>(JSC::PropertyAttribute::DontEnum));
}

void hostCallFinished(uint64_t identifier, bool ok, const String& resultJSON)
{
    auto call = pendingHostCalls().take(identifier);
    if (!call.callback)
        return;
    auto* globalObject = call.globalObject.get();
    auto& vm = globalObject->vm();
    JSC::JSLockHolder lock(vm);
    auto callData = JSC::getCallData(call.callback.get());
    JSC::MarkedArgumentBuffer arguments;
    arguments.append(JSC::jsBoolean(ok));
    arguments.append(JSC::jsString(vm, resultJSON));
    NakedPtr<JSC::Exception> exception;
    JSC::call(globalObject, call.callback.get(), callData, JSC::jsUndefined(), arguments, exception);
}

Ref<UserContentProvider> userContentProvider()
{
    static NeverDestroyed<Ref<UserContentController>> controller = [] {
        auto controller = UserContentController::create();
        controller->addUserScript(mainThreadNormalWorldSingleton(), makeUnique<UserScript>(String::fromUTF8(webrtcPolyfillSource)));
        controller->addUserScript(mainThreadNormalWorldSingleton(), makeUnique<UserScript>(String::fromUTF8(polyfillSource)));
        return controller;
    }();
    return controller.get();
}

} // namespace BrowserLite
