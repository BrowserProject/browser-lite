#include "config.h"
#include "WebPlatformExtras.h"

#include "Engine.h"
#include "FileSystemStorageWasm.h"
#include "Host.h"
#include "MediaStreamWasm.h"

#include <JavaScriptCore/CallData.h>
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
  const defineValue = (target, name, value) => Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  // Erst beim ersten Zugriff bauen (Getter auf globalThis): die Klassen kosten
  // sonst in jedem Frame Zeit, auch wenn die Seite sie nie braucht. Wer nichts
  // definiert, hinterlaesst keinen Getter.
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

  // navigator.vibrate: Chrome auf dem Desktop hat es, ohne Motor passiert nichts
  if (typeof Navigator === 'function')
    define(Navigator.prototype, 'vibrate', function vibrate() { return true; });

  // WebSocketStream (Chrome): Streams ueber einem normalen WebSocket. Ein
  // WebSocket kann nicht pausieren, darum ohne Gegendruck beim Lesen.
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

  // APIs des Host-Browsers ueber die Oberflaeche (installHostBridge, web/devices.js).
  // Die Bruecke ist nur hier sichtbar, die Seite sieht sie nicht.
  const host = globalThis.__blHost;
  delete globalThis.__blHost;
  delete globalThis.__blExtendPrototype;
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

  // Network Information API und navigator.deviceMemory mit den Werten des Host
  // (Seiten laden damit z.B. kleinere Bilder bei langsamer Verbindung)
  if (!('connection' in Navigator.prototype)) {
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
    // Werte des Host erst beim ersten Lesen holen (nicht in jedem Frame beim Start)
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

  // EyeDropper: Farbe vom Bildschirm (die Seite ist im Host ja ein Canvas)
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

  // WebCodecs ImageDecoder: dekodiert wird mit dem ImageDecoder des Host, die
  // Bilder kommen als RGBA zurueck und werden hier VideoFrames
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
    // Der Decoder im Host lebt bis close() oder bis der GC den der Seite einsammelt
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

  // File System Access API: Dateien und Ordner des Host oeffnen und speichern.
  // Die Handles des Host bleiben in der Oberflaeche, hier nur ihre id.
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
    // Ein Writable, das die Seite nie schliesst, sperrt die Datei im Host:
    // einsammeln wie abort()
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
    defineValue(globalThis, 'showOpenFilePicker', async (options) => (await call('fs-open', pickerOptions(options))).map(makeHandle));
    defineValue(globalThis, 'showSaveFilePicker', async (options) => makeHandle(await call('fs-save', pickerOptions(options))));
    defineValue(globalThis, 'showDirectoryPicker', async (options) => makeHandle(await call('fs-directory', pickerOptions(options))));
  });
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
        "rtc-create"_s, "rtc-op"_s, "rtc-poll"_s, "rtc-send"_s, "rtc-channel"_s, "rtc-channel-close"_s, "rtc-close"_s, "rtc-close-all"_s, "rtc-receive"_s, "rtc-track"_s,
        "pip-enter"_s, "pip-exit"_s, "pip-wait"_s,
        "image-open"_s, "image-decode"_s, "image-close"_s, "image-supported"_s, "network-info"_s,
    };
    for (auto entry : allowed) {
        if (name == entry)
            return true;
    }
    return false;
}

}

// ---------------------------------------------------------------- Prototypen bei Bedarf

// Eintraege der Polyfills fuer DOM-Prototypen, die das Fenster noch nicht
// angelegt hat (Klassenname -> Properties). Liegt unter einem privaten Namen
// am globalen Objekt, die Seite sieht es nicht.
static const JSC::Identifier& pendingPrototypeExtensionsName()
{
    static NeverDestroyed<JSC::Identifier> name = JSC::Identifier::fromUid(JSC::PrivateName(JSC::PrivateName::PrivateSymbol, "blPendingPrototypeExtensions"_s));
    return name;
}

// Wie Object.defineProperties liest es die Deskriptoren (dabei kann Code der
// Seite laufen) und legt sie als Objekte ohne Prototyp an, die nur die Engine
// kennt: Name -> Deskriptor, Felder wie bei Object.defineProperty
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
        // Zahlen als Namen braucht kein Polyfill
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

// Die Eintraege von readDescriptors auf den Prototyp. Hier laeuft kein Code der
// Seite: die Objekte hat die Engine angelegt, es wird nur direkt gelesen.
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

// WebCore legt die Structure einer DOM-Klasse an (domStructureCreatedHook,
// Patch 0037). Hier laeuft nie Code der Seite, auch kein Fehler-Ereignis.
static void domStructureCreated(JSDOMGlobalObject& globalObject, JSC::Structure& structure, const JSC::ClassInfo* classInfo)
{
    // Eintraege gibt es nur in Fenstern (Haupt-Thread)
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
    // Eine Ausnahme von vorher gehoert dem Aufrufer
    if (scope.exception())
        return;
    defineProperties(globalObject, *structure.storedPrototypeObject(), *asObject(entries));
    if (auto* exception = scope.exception(); exception && !vm.isTerminationException(exception)) {
        log("Polyfill: Prototyp %s nicht erweitert", classInfo->className.characters());
        scope.clearException();
    }
}

// __blExtendPrototype(klasse, deskriptoren) fuer die Polyfills: die Properties
// kommen auf den Prototyp der DOM-Klasse, sobald das Fenster ihn anlegt (oder
// gleich, wenn es ihn schon gibt). Neue Klassen und Prototypen kosten in jedem
// Frame Zeit, auch wenn die Seite sie nie braucht.
static void installPrototypeExtensions(JSC::JSGlobalObject& globalObject)
{
    static bool hookInstalled;
    if (!std::exchange(hookInstalled, true))
        domStructureCreatedHook = domStructureCreated;
    auto& vm = globalObject.vm();
    auto* function = JSC::JSNativeStdFunction::create(vm, &globalObject, 2, "__blExtendPrototype"_s, [](JSC::JSGlobalObject* lexicalGlobalObject, JSC::CallFrame* callFrame) -> JSC::EncodedJSValue {
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
    globalObject.putDirect(vm, JSC::Identifier::fromString(vm, "__blExtendPrototype"_s), function, static_cast<unsigned>(JSC::PropertyAttribute::DontEnum));
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
    MediaStreams::installBridge(globalObject);
    installPrototypeExtensions(globalObject);
}

// Die Antwort kommt als Aufgabe in den Event-Loop des Dokuments: ist es weg,
// verfaellt sie, im Back/Forward-Cache wartet sie, bis die Seite wieder da ist.
// Aufruf wie bei den Callbacks von WebCore: danach laufen die Microtasks (das
// Promise der Seite), Fehler kommen in die Konsole der Seite.
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
