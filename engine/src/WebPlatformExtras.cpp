#include "config.h"
#include "WebPlatformExtras.h"

#include "CacheStorageWasm.h"
#include "Engine.h"
#include "EngineConfig.h"
#include "FileSystemStorageWasm.h"
#include "Host.h"
#include "MediaStreamWasm.h"
#include "Storage.h"

#include <JavaScriptCore/CallData.h>
#include <JavaScriptCore/Completion.h>
#include <JavaScriptCore/JSArray.h>
#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/JSLock.h>
#include <JavaScriptCore/JSNativeStdFunction.h>
#include <JavaScriptCore/ObjectConstructor.h>
#include <JavaScriptCore/PropertyNameArray.h>
#include <JavaScriptCore/StrongInlines.h>
#include <WebCore/DOMWrapperWorld.h>
#include <WebCore/EventLoop.h>
#include <WebCore/Exception.h>
#include <WebCore/JSDOMExceptionHandling.h>
#include <WebCore/JSDOMGlobalObject.h>
#include <WebCore/JSDOMWrapperCache.h>
#include <WebCore/JSExecState.h>
#include <WebCore/ScriptExecutionContext.h>
#include <WebCore/SecurityOrigin.h>
#include <WebCore/ExceptionOr.h>
#include <WebCore/ScreenOrientationManager.h>
#include <WebCore/ScreenOrientationType.h>
#include <WebCore/StorageConnection.h>
#include <WebCore/StorageProvider.h>
#include <WebCore/UserScript.h>
#include <WebCore/WasmPlatform.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RefCounted.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/WeakHashSet.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite {

using namespace WebCore;

// ---------------------------------------------------------------- navigator.storage

// Per origin like OriginQuotaManager in WebKit2: the quota is the IndexedDB
// limit (Storage.cpp), usage is what the origin has in IndexedDB, Cache API and
// OPFS. The uploads of the views in /data/tmp do not count.
static uint64_t storageUsage(const ClientOrigin& origin)
{
    return indexedDBUsage(origin) + cacheStorageUsage(origin) + fileSystemUsage(origin);
}

class StorageConnectionWasm final : public StorageConnection {
public:
    static Ref<StorageConnectionWasm> create() { return adoptRef(*new StorageConnectionWasm); }

    void getPersisted(ClientOrigin&&, PersistCallback&& completionHandler) final { completionHandler(false); }
    void persist(const ClientOrigin&, PersistCallback&& completionHandler) final { completionHandler(false); }
    void fileSystemGetDirectory(ClientOrigin&& origin, GetDirectoryCallback&& completionHandler) final
    {
        // Origin private file system (FileSystemStorageWasm.cpp)
        BrowserLite::fileSystemGetDirectory(origin, WTF::move(completionHandler));
    }
    void getEstimate(ClientOrigin&& origin, GetEstimateCallback&& completionHandler) final
    {
        completionHandler(ExceptionOr<StorageEstimate> { StorageEstimate { storageUsage(origin), indexedDBQuota() } });
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

// Like Chrome on the desktop: orientation from the screen size, locking does
// not work (lock() rejects with NotSupportedError).
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

// Runs in every window before any script of the page (main world), called with
// the bridge by installPageExtensions. Only APIs with a clear meaning that can
// be rebuilt cleanly with existing means.
static constexpr auto polyfillSource = R"JS((bridge) => {
  const define = (target, name, value) => {
    if (!(name in target))
      Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  };
  const defineValue = (target, name, value) => Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  // Built on the first access only (getter on globalThis): the classes cost
  // time in every frame otherwise, even if the page never needs them. Nothing
  // defined leaves no getter behind.
  const lazy = (names, build) => {
    if (names.some((name) => name in globalThis))
      return;
    let built = false;
    const getters = new Map();
    const run = () => {
      if (built)
        return;
      built = true;
      try {
        build();
      } catch (e) {
        reportError(e);
      }
      for (const [name, getter] of getters) {
        if (Object.getOwnPropertyDescriptor(globalThis, name)?.get === getter)
          delete globalThis[name];
      }
    };
    for (const name of names) {
      const get = () => {
        run();
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
        return descriptor && 'value' in descriptor ? descriptor.value : undefined;
      };
      getters.set(name, get);
      Object.defineProperty(globalThis, name, { get, set(value) { defineValue(globalThis, name, value); }, configurable: true, enumerable: false });
    }
  };

  // Prioritized Task Scheduling (scheduler.postTask, scheduler.yield)
  lazy(['scheduler', 'TaskController', 'TaskSignal'], () => {
    if (typeof AbortController !== 'function')
      return;
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
    defineValue(globalThis, 'scheduler', scheduler);
    defineValue(globalThis, 'TaskController', TaskController);
    defineValue(globalThis, 'TaskSignal', TaskSignal);
  });

  // navigator.vibrate: Chrome on the desktop has it, without a motor nothing happens
  if (typeof Navigator === 'function')
    define(Navigator.prototype, 'vibrate', function vibrate() { return true; });

  // WebSocketStream (Chrome): streams over a normal WebSocket. A WebSocket
  // cannot pause, so reading has no backpressure.
  lazy(['WebSocketStream', 'WebSocketError'], () => {
    if (typeof WebSocket !== 'function' || typeof ReadableStream !== 'function')
      return;
    class WebSocketError extends DOMException {
      constructor(message = '', init = {}) {
        super(message, 'WebSocketError');
        this.closeCode = init.closeCode ?? null;
        this.reason = init.reason ?? '';
      }
    }
    const sockets = new WeakMap();
    class WebSocketStream {
      constructor(url, options = {}) {
        const socket = new WebSocket(url, options.protocols ?? []);
        socket.binaryType = 'arraybuffer';
        sockets.set(this, socket);
        this.url = socket.url;
        let controller;
        const readable = new ReadableStream({
          start(c) { controller = c; },
          cancel() { socket.close(); },
        });
        const writable = new WritableStream({
          write(chunk) {
            if (typeof chunk !== 'string' && !(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk))
              throw new TypeError('WebSocketStream can only send strings and BufferSources.');
            socket.send(chunk);
          },
          close() { socket.close(); },
          abort() { socket.close(); },
        });
        this.opened = new Promise((resolve, reject) => {
          socket.addEventListener('open', () => resolve({ readable, writable, extensions: socket.extensions, protocol: socket.protocol }), { once: true });
          socket.addEventListener('close', (event) => reject(new WebSocketError('WebSocket connection could not be established.', { closeCode: event.code, reason: event.reason })), { once: true });
        });
        this.closed = new Promise((resolve, reject) => {
          socket.addEventListener('close', (event) => {
            try {
              controller.close();
            } catch (e) {
            }
            if (event.wasClean)
              resolve({ closeCode: event.code, reason: event.reason });
            else
              reject(new WebSocketError('WebSocket closed without a closing handshake.', { closeCode: event.code, reason: event.reason }));
          }, { once: true });
        });
        this.opened.catch(() => {});
        this.closed.catch(() => {});
        socket.addEventListener('message', (event) => {
          try {
            controller.enqueue(typeof event.data === 'string' ? event.data : new Uint8Array(event.data));
          } catch (e) {
          }
        });
        if (options.signal) {
          if (options.signal.aborted)
            socket.close();
          else
            options.signal.addEventListener('abort', () => socket.close(), { once: true });
        }
      }
      close(info = {}) {
        const socket = sockets.get(this);
        if (info.closeCode === undefined)
          socket.close(info.reason === undefined ? undefined : 1000, info.reason);
        else
          socket.close(info.closeCode, info.reason ?? '');
      }
    }
    defineValue(globalThis, 'WebSocketStream', WebSocketStream);
    defineValue(globalThis, 'WebSocketError', WebSocketError);
  });

  // APIs of the host browser through the host (installPageExtensions). Only
  // this function sees the bridge, the page never does. A feature the host does
  // not offer stays missing like in a browser without it.
  const { host, features } = bridge;
  const enabled = new Set(features);
  if (typeof Navigator !== 'function')
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

  // Network Information API and navigator.deviceMemory with the values of the
  // host (pages load e.g. smaller images on a slow connection)
  if (enabled.has('network-info') && !('connection' in Navigator.prototype)) {
    const info = { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false, type: undefined, downlinkMax: undefined };
    class NetworkInformation extends EventTarget {
      constructor() {
        throw new TypeError('Illegal constructor');
      }
    }
    for (const name of ['effectiveType', 'downlink', 'rtt', 'saveData', 'type', 'downlinkMax']) {
      Object.defineProperty(NetworkInformation.prototype, name, {
        get() { return info[name]; },
        configurable: true,
        enumerable: true,
      });
    }
    let onchange = null;
    Object.defineProperty(NetworkInformation.prototype, 'onchange', {
      get() { return onchange; },
      set(handler) {
        if (onchange)
          this.removeEventListener('change', onchange);
        onchange = typeof handler === 'function' ? handler : null;
        if (onchange)
          this.addEventListener('change', onchange);
      },
      configurable: true,
      enumerable: true,
    });
    const connection = Reflect.construct(EventTarget, [], NetworkInformation);
    // Fetch the host's values on the first read only (not in every frame at start)
    let asked = false;
    const ask = () => {
      if (asked)
        return;
      asked = true;
      call('network-info').then((value) => {
        if (typeof value?.deviceMemory === 'number')
          memory = value.deviceMemory;
        if (!value?.connection)
          return;
        const changed = ['effectiveType', 'downlink', 'rtt', 'saveData'].some((name) => value.connection[name] !== undefined && value.connection[name] !== info[name]);
        Object.assign(info, value.connection);
        if (changed)
          connection.dispatchEvent(new Event('change'));
      }, () => {});
    };
    Object.defineProperty(Navigator.prototype, 'connection', { get() { ask(); return connection; }, configurable: true, enumerable: true });
    define(globalThis, 'NetworkInformation', NetworkInformation);
    let memory = 8;
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get() { ask(); return memory; }, configurable: true, enumerable: true });
  }

  // EyeDropper: color from the screen (in the host the page is just a canvas)
  if (enabled.has('eyedropper')) {
    lazy(['EyeDropper'], () => {
      class EyeDropper {
        open(options = {}) {
          if (options.signal?.aborted)
            return Promise.reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'));
          return call('eyedropper');
        }
      }
      defineValue(globalThis, 'EyeDropper', EyeDropper);
    });
  }

  // Battery Status API (Chromebooks have a battery)
  if (enabled.has('battery')) {
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
  }

  // Keyboard API: handle keys in fullscreen, keyboard layout
  if (enabled.has('keyboard') && !('keyboard' in Navigator.prototype)) {
    const keyboard = {
      lock(keyCodes) { return call('keyboard-lock', { keyCodes: keyCodes ? [...keyCodes] : null }).then(() => undefined); },
      unlock() { call('keyboard-unlock').catch(() => {}); },
      getLayoutMap() { return call('keyboard-layout').then((entries) => new Map(entries)); },
    };
    Object.defineProperty(Navigator.prototype, 'keyboard', { get: () => keyboard, configurable: true, enumerable: true });
  }

  // WebCodecs ImageDecoder: decoding uses the host's ImageDecoder, the images
  // come back as RGBA and become VideoFrames here
  if (enabled.has('image-decoder')) {
    lazy(['ImageDecoder', 'ImageTrack', 'ImageTrackList'], () => {
      if (typeof VideoFrame !== 'function')
        return;
      const toBase64 = (bytes) => {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(binary);
      };
      const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
      const readAll = async (data) => {
        if (data instanceof ArrayBuffer)
          return new Uint8Array(data.slice(0));
        if (ArrayBuffer.isView(data))
          return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        if (data && typeof data.getReader === 'function')
          return new Uint8Array(await new Response(data).arrayBuffer());
        throw new TypeError("Failed to construct 'ImageDecoder': The provided data is not a BufferSource or ReadableStream.");
      };
      const imageState = new WeakMap();
      // The decoder in the host lives until close() or until the GC collects the page's one
      const releaseDecoder = (decoder) => {
        if (decoder.closed)
          return;
        decoder.closed = true;
        decoder.open.then(() => call('image-close', { id: decoder.id })).catch(() => {});
      };
      const decoders = new FinalizationRegistry(releaseDecoder);
      class ImageTrack {
        constructor() {
          throw new TypeError('Illegal constructor');
        }
        get animated() { return imageState.get(this).animated; }
        get frameCount() { return imageState.get(this).frameCount; }
        get repetitionCount() { return imageState.get(this).repetitionCount; }
        get selected() { return imageState.get(this).selected; }
      }
      class ImageTrackList {
        constructor() {
          throw new TypeError('Illegal constructor');
        }
        get length() { return imageState.get(this).tracks.length; }
        get selectedIndex() { return imageState.get(this).tracks.findIndex((track) => track.selected); }
        get selectedTrack() { return imageState.get(this).tracks.find((track) => track.selected) ?? null; }
        get ready() { return imageState.get(this).ready; }
      }
      class ImageDecoder {
        constructor(init = {}) {
          if (typeof init.type !== 'string' || !init.type)
            throw new TypeError("Failed to construct 'ImageDecoder': Required member type is undefined.");
          this.type = init.type;
          const list = Object.create(ImageTrackList.prototype);
          const listState = { tracks: [] };
          imageState.set(list, listState);
          this.tracks = list;
          const decoder = { id: null, closed: false, complete: false };
          imageState.set(this, decoder);
          decoders.register(this, decoder);
          decoder.open = readAll(init.data).then((bytes) => call('image-open', { data: toBase64(bytes), type: init.type, preferAnimation: init.preferAnimation ?? null }));
          listState.ready = decoder.open.then((info) => {
            decoder.id = info.id;
            info.tracks.forEach((entry, index) => {
              const track = Object.create(ImageTrack.prototype);
              imageState.set(track, entry);
              listState.tracks.push(track);
              Object.defineProperty(list, index, { get: () => listState.tracks[index], configurable: true, enumerable: true });
            });
          });
          this.completed = listState.ready.then(() => {
            decoder.complete = true;
          });
          listState.ready.catch(() => {});
          this.completed.catch(() => {});
        }
        get complete() { return imageState.get(this).complete; }
        async decode(options = {}) {
          const decoder = imageState.get(this);
          if (decoder.closed)
            throw new DOMException('The decoder has been closed.', 'InvalidStateError');
          await this.tracks.ready;
          const frame = await call('image-decode', { id: decoder.id, frameIndex: options.frameIndex ?? 0 });
          const image = new VideoFrame(fromBase64(frame.data), { format: 'RGBA', codedWidth: frame.width, codedHeight: frame.height, timestamp: frame.timestamp ?? 0, duration: frame.duration ?? undefined });
          return { image, complete: true };
        }
        reset() {}
        close() {
          releaseDecoder(imageState.get(this));
        }
        static isTypeSupported(type) {
          return call('image-supported', { type: String(type) }).then((value) => !!value, () => false);
        }
      }
      defineValue(globalThis, 'ImageDecoder', ImageDecoder);
      defineValue(globalThis, 'ImageTrack', ImageTrack);
      defineValue(globalThis, 'ImageTrackList', ImageTrackList);
    });
  }

  // File System Access API: open and save files and folders of the host. The
  // host's handles stay in the host, only their id is here.
  if (enabled.has('fs-access')) {
    lazy(['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker'], () => {
      if (typeof FileSystemFileHandle !== 'function' || typeof FileSystemDirectoryHandle !== 'function')
        return;
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
      // A writable the page never closes locks the file in the host: collect it
      // like abort()
      const writables = new FinalizationRegistry((state) => {
        if (!state.done)
          call('fs-write', { id: state.id, op: 'abort' }).catch(() => {});
      });
      const makeWritable = (id) => {
        const state = { id, done: false };
        const send = (operation) => call('fs-write', Object.assign({ id }, operation)).then(() => undefined);
        const finish = (operation) => {
          state.done = true;
          return send(operation);
        };
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
          close: () => finish({ op: 'close' }),
          abort: () => finish({ op: 'abort' }),
        });
        writables.register(stream, state);
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
      // Only what the host can understand: types, multiple, name, start folder as text
      const pickerOptions = (options = {}) => ({
        types: Array.isArray(options.types) ? options.types.map((type) => ({ description: type?.description ? String(type.description) : undefined, accept: type?.accept })) : undefined,
        excludeAcceptAllOption: !!options.excludeAcceptAllOption,
        multiple: !!options.multiple,
        suggestedName: options.suggestedName ? String(options.suggestedName) : undefined,
        id: options.id ? String(options.id) : undefined,
        startIn: typeof options.startIn === 'string' ? options.startIn : undefined,
        mode: options.mode === 'readwrite' ? 'readwrite' : undefined,
      });
      defineValue(globalThis, 'showOpenFilePicker', async (options) => (await call('fs-open', pickerOptions(options))).map(makeHandle));
      defineValue(globalThis, 'showSaveFilePicker', async (options) => makeHandle(await call('fs-save', pickerOptions(options))));
      defineValue(globalThis, 'showDirectoryPicker', async (options) => makeHandle(await call('fs-directory', pickerOptions(options))));
    });
  }
})JS";

// ---------------------------------------------------------------- Host bridge

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

// Only these host APIs can be reached by a page through the polyfills, each
// only with its feature
bool isAllowedHostCall(const String& name)
{
    static constexpr std::pair<ASCIILiteral, Feature> allowed[] = {
        { "eyedropper"_s, Feature::EyeDropper }, { "battery"_s, Feature::Battery },
        { "keyboard-lock"_s, Feature::Keyboard }, { "keyboard-unlock"_s, Feature::Keyboard }, { "keyboard-layout"_s, Feature::Keyboard },
        { "fs-open"_s, Feature::FileSystemAccess }, { "fs-save"_s, Feature::FileSystemAccess }, { "fs-directory"_s, Feature::FileSystemAccess },
        { "fs-file"_s, Feature::FileSystemAccess }, { "fs-writable"_s, Feature::FileSystemAccess }, { "fs-write"_s, Feature::FileSystemAccess },
        { "fs-child"_s, Feature::FileSystemAccess }, { "fs-list"_s, Feature::FileSystemAccess }, { "fs-remove"_s, Feature::FileSystemAccess },
        { "fs-resolve"_s, Feature::FileSystemAccess }, { "fs-same"_s, Feature::FileSystemAccess }, { "fs-permission"_s, Feature::FileSystemAccess },
        { "rtc-create"_s, Feature::WebRTC }, { "rtc-op"_s, Feature::WebRTC }, { "rtc-poll"_s, Feature::WebRTC }, { "rtc-send"_s, Feature::WebRTC },
        { "rtc-channel"_s, Feature::WebRTC }, { "rtc-channel-close"_s, Feature::WebRTC }, { "rtc-close"_s, Feature::WebRTC },
        { "rtc-close-all"_s, Feature::WebRTC }, { "rtc-receive"_s, Feature::WebRTC }, { "rtc-track"_s, Feature::WebRTC },
        { "pip-enter"_s, Feature::PictureInPicture }, { "pip-exit"_s, Feature::PictureInPicture }, { "pip-wait"_s, Feature::PictureInPicture },
        { "image-open"_s, Feature::ImageDecoder }, { "image-decode"_s, Feature::ImageDecoder }, { "image-close"_s, Feature::ImageDecoder },
        { "image-supported"_s, Feature::ImageDecoder }, { "network-info"_s, Feature::NetworkInfo },
    };
    for (auto& [entry, feature] : allowed) {
        if (name == entry)
            return featureEnabled(feature);
    }
    return false;
}

}

// ---------------------------------------------------------------- Prototypes on demand

// Entries of the polyfills for DOM prototypes the window has not created yet
// (class name -> properties). Stored under a private name on the global object,
// the page does not see it.
static const JSC::Identifier& pendingPrototypeExtensionsName()
{
    static NeverDestroyed<JSC::Identifier> name = JSC::Identifier::fromUid(JSC::PrivateName(JSC::PrivateName::PrivateSymbol, "blPendingPrototypeExtensions"_s));
    return name;
}

// Like Object.defineProperties it reads the descriptors (page code may run
// meanwhile) and stores them as objects without prototype only the engine
// knows: name -> descriptor, fields like in Object.defineProperty
static JSC::JSObject* readDescriptors(JSC::JSGlobalObject& globalObject, JSC::JSObject& descriptors)
{
    auto& vm = globalObject.vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto& names = vm.propertyNames;
    JSC::PropertyNameArrayBuilder propertyNames(vm, JSC::PropertyNameMode::StringsAndSymbols, JSC::PrivateSymbolMode::Exclude);
    descriptors.methodTable()->getOwnPropertyNames(&descriptors, &globalObject, propertyNames, JSC::DontEnumPropertiesMode::Exclude);
    RETURN_IF_EXCEPTION(scope, nullptr);
    auto* entries = JSC::constructEmptyObject(vm, globalObject.nullPrototypeObjectStructure());
    for (auto& name : propertyNames) {
        // Polyfills need no numbers as names
        if (JSC::parseIndex(name))
            continue;
        auto value = descriptors.get(&globalObject, name);
        RETURN_IF_EXCEPTION(scope, nullptr);
        JSC::PropertyDescriptor descriptor;
        bool valid = JSC::toPropertyDescriptor(&globalObject, value, descriptor);
        RETURN_IF_EXCEPTION(scope, nullptr);
        if (!valid)
            return nullptr;
        auto* entry = JSC::constructEmptyObject(vm, globalObject.nullPrototypeObjectStructure());
        if (descriptor.value())
            entry->putDirect(vm, names->value, descriptor.value());
        if (descriptor.getterPresent())
            entry->putDirect(vm, names->get, descriptor.getter());
        if (descriptor.setterPresent())
            entry->putDirect(vm, names->set, descriptor.setter());
        if (descriptor.writablePresent())
            entry->putDirect(vm, names->writable, JSC::jsBoolean(descriptor.writable()));
        if (descriptor.enumerablePresent())
            entry->putDirect(vm, names->enumerable, JSC::jsBoolean(descriptor.enumerable()));
        if (descriptor.configurablePresent())
            entry->putDirect(vm, names->configurable, JSC::jsBoolean(descriptor.configurable()));
        entries->putDirect(vm, name, entry);
    }
    return entries;
}

// Puts the entries of readDescriptors on the prototype. No page code runs here:
// the engine created the objects, they are only read directly.
static void defineProperties(JSC::JSGlobalObject& globalObject, JSC::JSObject& target, JSC::JSObject& entries)
{
    auto& vm = globalObject.vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto& names = vm.propertyNames;
    JSC::PropertyNameArrayBuilder propertyNames(vm, JSC::PropertyNameMode::StringsAndSymbols, JSC::PrivateSymbolMode::Exclude);
    entries.getOwnNonIndexPropertyNames(&globalObject, propertyNames, JSC::DontEnumPropertiesMode::Exclude);
    RETURN_IF_EXCEPTION(scope, void());
    for (auto& name : propertyNames) {
        auto* entry = asObject(entries.getDirect(vm, name));
        JSC::PropertyDescriptor descriptor;
        if (auto value = entry->getDirect(vm, names->value))
            descriptor.setValue(value);
        if (auto getter = entry->getDirect(vm, names->get))
            descriptor.setGetter(getter);
        if (auto setter = entry->getDirect(vm, names->set))
            descriptor.setSetter(setter);
        if (auto writable = entry->getDirect(vm, names->writable))
            descriptor.setWritable(writable.isTrue());
        if (auto enumerable = entry->getDirect(vm, names->enumerable))
            descriptor.setEnumerable(enumerable.isTrue());
        if (auto configurable = entry->getDirect(vm, names->configurable))
            descriptor.setConfigurable(configurable.isTrue());
        target.methodTable()->defineOwnProperty(&target, &globalObject, name, descriptor, false);
        RETURN_IF_EXCEPTION(scope, void());
    }
}

// WebCore creates the structure of a DOM class (domStructureCreatedHook, patch
// 0037). Page code never runs here, not even an error event.
static void domStructureCreated(JSDOMGlobalObject& globalObject, JSC::Structure& structure, const JSC::ClassInfo* classInfo)
{
    // Entries only exist in windows (main thread)
    if (!isMainThread())
        return;
    auto& vm = globalObject.vm();
    auto pending = globalObject.getDirect(vm, pendingPrototypeExtensionsName());
    if (!pending)
        return;
    auto entries = asObject(pending)->getDirect(vm, JSC::Identifier::fromString(vm, classInfo->className));
    if (!entries)
        return;
    auto scope = DECLARE_TOP_EXCEPTION_SCOPE(vm);
    // An exception from before belongs to the caller
    if (scope.exception())
        return;
    defineProperties(globalObject, *structure.storedPrototypeObject(), *asObject(entries));
    if (auto* exception = scope.exception(); exception && !vm.isTerminationException(exception)) {
        log("Polyfill: prototype %s not extended", classInfo->className.characters());
        scope.clearException();
    }
}

// extendPrototype(className, descriptors) for the polyfills: the properties go
// on the prototype of the DOM class as soon as the window creates it (or right
// away if it exists). New classes and prototypes cost time in every frame, even
// if the page never needs them.
static JSC::JSObject* createPrototypeExtender(JSC::JSGlobalObject& globalObject)
{
    static bool hookInstalled;
    if (!std::exchange(hookInstalled, true))
        domStructureCreatedHook = domStructureCreated;
    auto& vm = globalObject.vm();
    return JSC::JSNativeStdFunction::create(vm, &globalObject, 2, "extendPrototype"_s, [](JSC::JSGlobalObject* lexicalGlobalObject, JSC::CallFrame* callFrame) -> JSC::EncodedJSValue {
        auto* globalObject = dynamicDowncast<JSDOMGlobalObject>(lexicalGlobalObject);
        auto& vm = lexicalGlobalObject->vm();
        auto scope = DECLARE_THROW_SCOPE(vm);
        auto className = callFrame->argument(0).toWTFString(lexicalGlobalObject);
        RETURN_IF_EXCEPTION(scope, { });
        auto* descriptors = callFrame->argument(1).getObject();
        if (!globalObject || !descriptors)
            return JSC::JSValue::encode(JSC::jsUndefined());
        auto classIdentifier = JSC::Identifier::fromString(vm, className);
        if (JSC::parseIndex(classIdentifier))
            return JSC::JSValue::encode(JSC::jsUndefined());
        auto* entries = readDescriptors(*globalObject, *descriptors);
        RETURN_IF_EXCEPTION(scope, { });
        if (!entries)
            return JSC::JSValue::encode(JSC::jsUndefined());
        JSC::JSObject* prototype = nullptr;
        for (auto& entry : std::as_const(*globalObject).structures()) {
            if (className == entry.key->className) {
                prototype = entry.value->storedPrototypeObject();
                break;
            }
        }
        if (prototype) {
            scope.release();
            defineProperties(*globalObject, *prototype, *entries);
            return JSC::JSValue::encode(JSC::jsUndefined());
        }
        auto pending = globalObject->getDirect(vm, pendingPrototypeExtensionsName());
        if (!pending) {
            pending = JSC::constructEmptyObject(vm, globalObject->nullPrototypeObjectStructure());
            globalObject->putDirect(vm, pendingPrototypeExtensionsName(), pending, static_cast<unsigned>(JSC::PropertyAttribute::DontEnum));
        }
        asObject(pending)->putDirect(vm, classIdentifier, entries);
        return JSC::JSValue::encode(JSC::jsUndefined());
    });
}

// host(name, payload, callback) for the polyfills: the host runs the call and
// answers with bl_host_call_result (hostCallFinished)
static JSC::JSObject* createHostCaller(JSC::JSGlobalObject& globalObject, int viewId)
{
    auto& vm = globalObject.vm();
    return JSC::JSNativeStdFunction::create(vm, &globalObject, 3, "host"_s, [viewId](JSC::JSGlobalObject* globalObject, JSC::CallFrame* callFrame) -> JSC::EncodedJSValue {
        auto& vm = globalObject->vm();
        auto scope = DECLARE_THROW_SCOPE(vm);
        auto name = callFrame->argument(0).toWTFString(globalObject);
        RETURN_IF_EXCEPTION(scope, { });
        auto payload = callFrame->argument(1).toWTFString(globalObject);
        RETURN_IF_EXCEPTION(scope, { });
        auto* callback = callFrame->argument(2).getObject();
        if (!callback || !callback->isCallable())
            return JSC::JSValue::encode(JSC::jsUndefined());
        static uint64_t nextIdentifier;
        auto identifier = ++nextIdentifier;
        pendingHostCalls().add(identifier, PendingHostCall { { vm, globalObject }, { vm, callback } });
        // Rejected like the host rejects (asynchronously), so the page's promise settles
        if (!isAllowedHostCall(name)) {
            hostCallFinished(identifier, false, "{\"name\":\"NotSupportedError\",\"message\":\"Not supported\"}"_s);
            return JSC::JSValue::encode(JSC::jsUndefined());
        }
        // The origin of the page: the host hands out handles (files) only to it again
        String origin;
        if (auto* domGlobalObject = dynamicDowncast<WebCore::JSDOMGlobalObject>(globalObject)) {
            if (RefPtr context = domGlobalObject->scriptExecutionContext())
                origin = context->securityOrigin() ? context->securityOrigin()->toString() : String { };
        }
        notifyHost(viewId, "host-call", makeString("{\"id\":"_s, identifier, ",\"name\":\""_s, jsonEscape(name), "\",\"origin\":\""_s, jsonEscape(origin), "\",\"payload\":\""_s, jsonEscape(payload), "\"}"_s));
        return JSC::JSValue::encode(JSC::jsUndefined());
    });
}

void callEngineFunction(JSC::JSGlobalObject& globalObject, const String& source, const JSC::ArgList& arguments)
{
    JSC::JSLockHolder lock(globalObject.vm());
    NakedPtr<JSC::Exception> exception;
    auto function = JSC::evaluate(&globalObject, JSC::makeSource(source, { }, JSC::SourceTaintedOrigin::Untainted, "browser-lite"_s), JSC::JSValue(), exception);
    if (!exception) {
        auto callData = JSC::getCallData(function);
        if (callData.type != JSC::CallData::Type::None)
            JSC::call(&globalObject, function, callData, JSC::jsUndefined(), arguments, exception);
    }
    if (exception)
        reportException(&globalObject, exception);
}

// Marks a window whose extensions are installed: the window object can be
// announced as cleared more than once
static const JSC::Identifier& extensionsInstalledName()
{
    static NeverDestroyed<JSC::Identifier> name = JSC::Identifier::fromUid(JSC::PrivateName(JSC::PrivateName::PrivateSymbol, "blExtensionsInstalled"_s));
    return name;
}

void installPageExtensions(JSC::JSGlobalObject& globalObject, int viewId)
{
    auto& vm = globalObject.vm();
    JSC::JSLockHolder lock(vm);
    if (globalObject.getDirect(vm, extensionsInstalledName()))
        return;
    globalObject.putDirect(vm, extensionsInstalledName(), JSC::jsBoolean(true), static_cast<unsigned>(JSC::PropertyAttribute::DontEnum));

    auto* features = JSC::constructEmptyArray(&globalObject, nullptr);
    if (!features)
        return;
    for (auto& name : enabledFeatureNames())
        features->push(&globalObject, JSC::jsString(vm, name));
    auto* bridge = JSC::constructEmptyObject(vm, globalObject.nullPrototypeObjectStructure());
    bridge->putDirect(vm, JSC::Identifier::fromString(vm, "host"_s), createHostCaller(globalObject, viewId));
    bridge->putDirect(vm, JSC::Identifier::fromString(vm, "extendPrototype"_s), createPrototypeExtender(globalObject));
    bridge->putDirect(vm, JSC::Identifier::fromString(vm, "features"_s), features);
    if (featureEnabled(Feature::WebRTC) || featureEnabled(Feature::PictureInPicture))
        bridge->putDirect(vm, JSC::Identifier::fromString(vm, "media"_s), MediaStreams::createBridge(globalObject));
    JSC::MarkedArgumentBuffer arguments;
    arguments.append(bridge);
    if (featureEnabled(Feature::WebRTC) || featureEnabled(Feature::PictureInPicture))
        callEngineFunction(globalObject, String::fromUTF8(webrtcPolyfillSource), arguments);
    callEngineFunction(globalObject, String::fromUTF8(polyfillSource), arguments);
}

// The answer arrives as a task in the event loop of the document: if it is gone,
// the answer expires, in the back/forward cache it waits until the page is back.
// Called like WebCore's callbacks: the microtasks (the page's promise) run
// afterwards, errors go to the page's console.
void hostCallFinished(uint64_t identifier, bool ok, const String& resultJSON)
{
    auto call = pendingHostCalls().take(identifier);
    auto* globalObject = dynamicDowncast<JSDOMGlobalObject>(call.globalObject.get());
    RefPtr context = globalObject ? globalObject->scriptExecutionContext() : nullptr;
    if (!context || !call.callback)
        return;
    context->eventLoop().queueTask(TaskSource::Networking, [call = WTF::move(call), ok, resultJSON] {
        auto* globalObject = call.globalObject.get();
        auto& vm = globalObject->vm();
        JSC::JSLockHolder lock(vm);
        auto callData = JSC::getCallData(call.callback.get());
        JSC::MarkedArgumentBuffer arguments;
        arguments.append(JSC::jsBoolean(ok));
        arguments.append(JSC::jsString(vm, resultJSON));
        NakedPtr<JSC::Exception> exception;
        JSExecState::profiledCall(globalObject, JSC::ProfilingReason::Other, call.callback.get(), callData, JSC::jsUndefined(), arguments, exception);
        if (exception)
            reportException(globalObject, exception);
    });
}

} // namespace BrowserLite