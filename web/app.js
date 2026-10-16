// browser-lite Oberflaeche: Tabs, Adressleiste und die Verbindung zur Engine.
//
// Die Engine (engine/engine.js + engine.wasm) laeuft in einem eigenen Worker.
// Wir rufen ihre C-Funktionen (_bl_...) auf, sie meldet sich ueber die
// Callbacks onEngine... zurueck (siehe engine/src/Host.cpp).

import { WispTransport } from './transport.js';
import { audioState, onEngineAudio } from './audio.js';
import { initMedia, mediaState, onEngineMedia, onEngineMediaFetch } from './media.js';
import { initCapture, onCaptureStart, onCaptureStop } from './capture.js';
import { initDevices, clearPermissions, forgetTab, onPermissionRequest, onGeolocationStart, onGeolocationStop, onSensorStart, onSensorStop, onHostCall, onNotification, onNotificationClose, onGamepadMonitor, onGamepadEffect, onSpeak, onSpeechCommand, onSpeechRecognition, attachTouch } from './devices.js';
import { initLibrary, addressToURL, saveSession, sessionToRestore, recordVisit, toggleBookmark, updateStar, togglePanel, refreshDownloadsPanel, suggestions, settings, panelIsOpen, formatSize } from './library.js';
import { initPickers, closePickers, showSelectPopup, hideSelectPopup, showColorPicker, showDateTimePicker, hidePicker, showHover, clearHover } from './pickers.js';
import { engineAnswered, engineFailed, expectAnswer, showEngineMessage, takeSafeStart, watchEngine } from './watchdog.js';
import { storage } from './util.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const START_URL = params.get('url') || 'https://example.com/';
// Ordner der Engine. tools/package-site.sh ersetzt das durch engine/<version>/,
// damit nach einem Update nie eine alte .wasm aus dem Cache kommt.
const ENGINE_BASE = 'engine/';

// Relay (Wisp-Server). Standard: auf dem gleichen Server unter /wisp/.
// ?relay=... gilt nur fuer diese Sitzung des Browser-Tabs, ein leeres ?relay=
// nimmt wieder den Standard. Ein Link kann so den Verkehr nie dauerhaft umleiten.
if (params.has('relay'))
  storage('bl-relay-url', params.get('relay') || null, true);
const RELAY_BASE = storage('bl-relay-url', undefined, true) || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/wisp/`;
// Der Zugangs-Token (einmal ?token=...) gilt nur fuer das Relay, mit dem er
// gesetzt wurde. Ein anderes Relay bekommt ihn nie zu sehen.
const RELAY_TOKEN_KEY = 'bl-relay-token ' + URL.parse(RELAY_BASE)?.host;
if (params.get('token'))
  storage(RELAY_TOKEN_KEY, params.get('token'));

function relayURL() {
  const token = storage(RELAY_TOKEN_KEY);
  return token ? RELAY_BASE + (RELAY_BASE.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : RELAY_BASE;
}

let engine = null;
// Erst nach onEngineReady und nur bis zu einem Absturz (watchdog.js)
let engineReady = false;
window.__blAudioState = audioState; // fuer die Tests (tests/e2e)
window.__blMediaState = mediaState;
// Speicher der Engine (Tests): Groesse, mit report=true auch Bericht in der Konsole
window.__blEngine = () => engine; // Fehlersuche: Emscripten-Modul (FS, Exporte)
// Fehlersuche: JS in der Seite des aktiven Tabs, Ergebnis in der Konsole ([eval])
window.__blEval = (source) => engine._bl_eval_script(activeTab.id, toUTF8(source));
window.__blMemory = (report) => {
  if (report && engine && engine._bl_memory_report)
    engine._bl_memory_report(report === 2 ? 2 : report === 3 ? 0 : report === 4 ? 3 : 1);
  return engine && engine.HEAPU8 ? engine.HEAPU8.length : 0;
};
let nextViewId = 1;
const tabs = new Map(); // viewId -> Tab
let activeTab = null;

// ---------------------------------------------------------------- Engine laden

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Konnte ' + src + ' nicht laden'));
    document.head.appendChild(script);
  });
}

async function startEngine() {
  if (!crossOriginIsolated) {
    showEngineMessage('Fehler: Die Seite braucht die Header COOP/COEP (SharedArrayBuffer fehlt).');
    return;
  }
  await loadScript(ENGINE_BASE + 'engine.js');
  const module = {
    // Netzwerk der Engine (engine/js/sockets.js): TCP-Verbindungen ueber Wisp
    blTransport: new WispTransport(relayURL()),
    // ?httpcache=0 schaltet den dauerhaften HTTP-Cache aus (zum Testen)
    blHttpCacheDisabled: params.get('httpcache') === '0',
    locateFile: (path) => ENGINE_BASE + path,
    print: (text) => console.log('[engine]', text),
    printErr: (text) => console.warn('[engine]', text),
    onEngineReady,
    onEngineEvent,
    onEngineFrame,
    onEngineNeedsFrame,
    onEngineDownloadData,
    onEnginePrint,
    onEngineIcon: (viewId, url, mime, bytes) => tabs.get(viewId)?.setIcon(mime, bytes),
    onEngineAudio: (...args) => onEngineAudio(engine, ...args),
    onEngineMedia,
    onEngineMediaFetch,
    engineDialog,
    preRun: [mountStorage, installExtraCA, (module) => {
      // ?debug=1: Zeitstempel und Ablauf der Engine in der Konsole
      if (params.get('debug'))
        (module || engine).ENV.BL_DEBUG = '1';
      if (params.get('fcdebug'))
        (module || engine).ENV.FC_DEBUG = params.get('fcdebug');
      // Skia malt ueber WebGL 2 (GPU); ?gpu=0 malt auf der CPU
      if (params.get('gpu'))
        (module || engine).ENV.BL_GPU = params.get('gpu');
      // Compositing mit Ebenen (Standard mit GPU): ?compositing=0 schaltet ab
      if (params.get('compositing'))
        (module || engine).ENV.BL_COMPOSITING = params.get('compositing');
      // GC an sicheren Punkten in JS: ?safepointgc=0 aus, =debug mit Ausgabe
      if (params.get('safepointgc'))
        (module || engine).ENV.BL_SAFEPOINT_GC = params.get('safepointgc');
      // Zum Testen: ?env=JSC_verifyGC=1,BL_DEBUG=1 setzt Umgebungsvariablen.
      // Nur Schalter der Engine: BL_EXTRA_CA (installExtraCA) oder Variablen
      // von curl/OpenSSL (Proxy, Zertifikate, Schluessel-Log) darf ein Link nie setzen.
      for (const pair of (params.get('env') || '').split(',')) {
        const at = pair.indexOf('=');
        const key = pair.slice(0, at);
        if (at > 0 && /^(BL|JSC|FC)_/.test(key) && key !== 'BL_EXTRA_CA')
          (module || engine).ENV[key] = pair.slice(at + 1);
      }
    }],
  };
  watchEngine(module, () => {
    engineReady = false;
  });
  engine = module;
  const mediaReady = initMedia(module);
  await window.createBrowserLiteEngine(module);
  await mediaReady;
}

// ------------------------------------------------------------ Speicher
// Cookies, localStorage und IndexedDB der Seiten liegen in der Engine unter
// /data. Mit WasmFS (Standard) ist das ein Verzeichnis im OPFS des Browsers,
// die Engine liest und schreibt es selber (engine/src/Storage.cpp); hier wird
// nur alle paar Sekunden und beim Verlassen der Seite das Schreiben der
// Datenbanken angestossen. Aeltere Engine-Builds ohne WasmFS haben ein IDBFS:
// beim Start aus der IndexedDB laden, danach regelmaessig zurueckschreiben.

let storageReady = false;
let storageSyncing = false;
let storageSyncAgain = false;
let storageNotice = '';
const clearDataFlag = 'bl-clear-data';

// Nur ein Tab der Oberflaeche darf /data im OPFS haben, sonst schreiben beide
// ihre Datenbanken abwechselnd ueber die des anderen. Die Sperre gilt, bis die
// Seite geht; nach einem Neuladen gibt die alte Seite sie erst kurz danach frei.
const dataLockedNotice = 'browser-lite ist schon in einem anderen Tab offen, hier wird nichts gespeichert';
function holdDataLock() {
  if (!navigator.locks)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = AbortSignal.timeout(3000);
    navigator.locks.request('bl-data', { signal: timeout }, () => {
      resolve(true);
      return new Promise(() => {});
    }).catch(() => resolve(false));
  });
}

// Alles im OPFS loeschen, solange die Engine noch nicht laeuft (sie haelt
// sonst Dateien offen)
async function clearOPFS() {
  const root = await navigator.storage.getDirectory();
  for await (const name of root.keys())
    await root.removeEntry(name, { recursive: true }).catch((error) => console.warn('OPFS:', name, error));
}

function deleteLegacyStorage() {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase('/data');
    request.onsuccess = request.onerror = request.onblocked = resolve;
  });
}

// Daten aus dem IDBFS frueherer Versionen lesen; die Engine uebernimmt sie
// beim Start einmal nach /data und meldet sich dann (onLegacyStorageMigrated)
async function readLegacyStorage() {
  if (!indexedDB.databases || !(await indexedDB.databases()).some((db) => db.name === '/data'))
    return [];
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('/data');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (!db.objectStoreNames.contains('FILE_DATA'))
      return [];
    const store = db.transaction('FILE_DATA', 'readonly').objectStore('FILE_DATA');
    const [keys, values] = await Promise.all(['getAllKeys', 'getAll'].map((method) => new Promise((resolve, reject) => {
      const request = store[method]();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })));
    return keys.map((path, i) => [path, values[i]?.contents]).filter(([path, contents]) => typeof path === 'string' && contents instanceof Uint8Array);
  } finally {
    db.close();
  }
}

function mountStorage(module) {
  module = module || engine;
  const fs = module.FS;
  const IDBFS = fs.filesystems?.IDBFS;
  if (!IDBFS) {
    // WasmFS: vor dem Start der Engine aufraeumen bzw. alte Daten lesen
    storageReady = true;
    module.addRunDependency('bl-storage');
    (async () => {
      if (!(await holdDataLock())) {
        module.ENV.BL_OPFS = '0';
        storageNotice = dataLockedNotice;
        return;
      }
      if (storage(clearDataFlag)) {
        await clearOPFS().catch((error) => console.warn('OPFS konnte nicht geleert werden:', error));
        await deleteLegacyStorage();
        storage(clearDataFlag, null);
      } else if (window.indexedDB) {
        module.blLegacyStorage = await readLegacyStorage().catch((error) => {
          console.warn('Alte Daten konnten nicht gelesen werden:', error);
          return [];
        });
        module.onLegacyStorageMigrated = deleteLegacyStorage;
      }
    })().finally(() => module.removeRunDependency('bl-storage'));
    return;
  }
  if (!window.indexedDB)
    return;
  module.addRunDependency('bl-storage');
  holdDataLock().then((locked) => {
    // Ohne Sperre bleibt /data im Speicher und storageReady aus (kein syncfs)
    if (!locked) {
      storageNotice = dataLockedNotice;
      module.removeRunDependency('bl-storage');
      return;
    }
    fs.mkdirTree('/data');
    fs.mount(IDBFS, {}, '/data');
    fs.syncfs(true, (error) => {
      if (error)
        console.warn('Gespeicherte Daten konnten nicht geladen werden:', error);
      storageReady = true;
      module.removeRunDependency('bl-storage');
    });
  });
}

function saveStorage() {
  if (!storageReady || !engineReady)
    return;
  // WasmFS: die Engine schreibt die Datenbanken im eigenen Thread nach /data
  if (!engine.FS.syncfs) {
    engine._bl_storage_flush();
    return;
  }
  if (storageSyncing) {
    storageSyncAgain = true;
    return;
  }
  storageSyncing = true;
  // Datenbanken liegen in der Engine im Speicher (engine/src/MemoryVFS.cpp),
  // zuerst ins Dateisystem schreiben
  if (engine._bl_storage_flush)
    engine._bl_storage_flush();
  engine.FS.syncfs(false, (error) => {
    storageSyncing = false;
    if (error)
      console.warn('Daten konnten nicht gespeichert werden:', error);
    if (storageSyncAgain) {
      storageSyncAgain = false;
      saveStorage();
    }
  });
}

setInterval(saveStorage, 5000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden)
    saveStorage();
});
window.addEventListener('pagehide', saveStorage);

async function clearStorage() {
  if (!confirm('Alle gespeicherten Daten (Cookies, Logins, Website-Daten) löschen?'))
    return;
  storageReady = false; // nichts mehr zurueckschreiben
  clearPermissions();
  // HTTP-Cache der Engine (Cache API, engine/js/http-cache.js)
  await engine?.blClearHttpCache?.().catch(() => {});
  // Bytecode der Skripte (engine/js/bytecode-cache.js)
  await engine?.blClearBytecodeCache?.().catch(() => {});
  if (engine && !engine.FS.syncfs) {
    // WasmFS: das OPFS beim naechsten Start leeren, bevor die Engine laeuft
    storage(clearDataFlag, '1');
  } else
    await deleteLegacyStorage();
  location.reload();
}

// Zusaetzliche CA-Zertifikate (PEM), z.B. eine Firmen-CA oder fuer Tests.
// Die Engine haengt sie an das Mozilla-Bundle an (CurlSSLHandleWasm.cpp).
function installExtraCA(module) {
  const pem = window.__blExtraCA || storage('bl-extra-ca');
  if (!pem)
    return;
  // Die Engine schreibt sie beim Start nach /etc/ssl/certs/extra-ca.crt (main.cpp)
  (module || engine).ENV.BL_EXTRA_CA = pem;
}

// navigator.onLine der Seiten: Netz des Host-Browsers und Verbindung zum Relay.
// Die Engine beginnt mit online.
function watchOnLine() {
  let onLine = true;
  const update = () => {
    const now = navigator.onLine && engine.blTransport.connected;
    if (now === onLine || !engineReady)
      return;
    onLine = now;
    engine._bl_set_online(now ? 1 : 0);
  };
  engine.blTransport.onconnectedchange = update;
  addEventListener('online', update);
  addEventListener('offline', update);
  update();
}

// Bildschirm, Farbschema (prefers-color-scheme) und Touchscreen wie im Host
const darkScheme = matchMedia('(prefers-color-scheme: dark)');
function sendScreen() {
  const flags = (darkScheme.matches ? 1 : 0) | (navigator.maxTouchPoints > 0 ? 2 : 0);
  engine._bl_set_screen(screen.width, screen.height, screen.availWidth, screen.availHeight, flags);
}

function onEngineReady() {
  engineReady = true;
  $('boot').hidden = true;
  sendScreen();
  darkScheme.addEventListener('change', sendScreen);
  watchOnLine();
  watchPixelRatio();
  initDevices({ engine: () => engine, toUTF8, tabs: () => tabs, activeTab: () => activeTab, activateTab: (tab) => activateTab(tab), focusPage: () => focusPage() });
  initCapture({ engine: () => engine, engineWorker: () => engine.blEngineWorker?.() });
  initLibrary({ openURL, activeTab: () => activeTab, tabs: () => tabs, downloadsList: () => downloadHistory, find: () => openFind(), print: () => printTab(activeTab) });
  // ?url= hat Vorrang, sonst die Tabs vom letzten Mal (wie Chrome "Weitermachen, wo ich aufgehoert habe")
  const session = params.get('url') ? null : sessionToRestore();
  if (session) {
    const restored = session.map((entry) => restoredTab(entry));
    if (takeSafeStart())
      newTab('about:blank').notice = 'Nach dem Neustart laden die Tabs erst beim Anklicken';
    else
      activateTab(restored[Math.max(0, session.findIndex((entry) => entry.active))]);
  } else {
    newTab(START_URL);
  }
  if (storageNotice && activeTab)
    activeTab.notice = storageNotice;
}

// Link/Lesezeichen oeffnen: im aktiven Tab oder in einem neuen
function openURL(url, inNewTab) {
  if (inNewTab || !activeTab) {
    newTab(url || settings().homePage || 'about:blank');
    if (!url)
      $('address').focus();
    return;
  }
  loadURL(activeTab, url);
  focusPage();
}

// Auf Laden und Neu laden meldet sich die Engine immer (watchdog.js)
function loadURL(tab, url) {
  expectAnswer();
  engine._bl_load_url(tab.id, toUTF8(url));
}

function reloadTab(tab) {
  expectAnswer();
  engine._bl_reload(tab.id);
}

// Nach einem Absturz nicht mehr: der letzte gute Stand bleibt fuer den Neustart
function persistSession() {
  if (engineReady)
    saveSession([...tabs.values()], activeTab);
}

const toUTF8 = (text) => engine.stringToNewUTF8(text ?? '');

// Datei ins Dateisystem der Engine schreiben. Das passiert im Engine-Thread
// (bl_write_file), nicht hier: so wartet die Oberflaeche nie auf Locks des
// Dateisystems, und die Datei ist vor dem naechsten Aufruf an die Engine da.
function writeEngineFile(path, bytes) {
  const data = engine._malloc(Math.max(bytes.length, 1));
  engine.HEAPU8.set(bytes, data);
  engine._bl_write_file(toUTF8(path), data, bytes.length);
}
initPickers({ engine: () => engine, toUTF8, focusPage: () => focusPage() });

// --------------------------------------------------------------------- Tabs

class Tab {
  // viewId gesetzt: die Engine hat den View schon geoeffnet (Popup).
  // lazy: erst laden, wenn der Tab angeklickt wird (wiederhergestellte Tabs)
  constructor(url, viewId = 0, lazy = null) {
    this.id = viewId || nextViewId++;
    this.title = lazy?.title || 'Neuer Tab';
    // Zurueck/Vor des Tabs ({ entries: [{ url, title }], index }), fuer die Sitzung
    this.history = lazy?.history || null;
    this.url = url;
    this.canGoBack = false;
    this.canGoForward = false;
    this.loading = false;
    // Steht nach dem naechsten Laden in der Statuszeile
    this.notice = null;
    this.frameRequested = false;
    this.zoom = 1;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'page';
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;outline:none;display:none;touch-action:none';
    $('viewport').appendChild(this.canvas);
    // Das Canvas geht an den Worker des Compositors (sonst des Engine-Threads),
    // der malt selber hinein. Nur wo das nicht geht, kopieren wir die Pixel
    // hier (onEngineFrame).
    const worker = typeof this.canvas.transferControlToOffscreen === 'function' && (engine.blPresenterWorker || engine.blEngineWorker)?.();
    if (worker) {
      const offscreen = this.canvas.transferControlToOffscreen();
      worker.postMessage({ blCanvas: offscreen, viewId: this.id }, [offscreen]);
      this.ctx = null;
    } else {
      this.ctx = this.canvas.getContext('2d', { alpha: false });
    }
    attachInput(this);

    this.element = document.createElement('div');
    this.element.className = 'tab';
    this.element.innerHTML = '<img class="icon" alt="" hidden><span class="title"></span><span class="recording" title="Kamera, Mikrofon oder Bildschirm in Gebrauch" hidden>&#9679;</span><button class="audio" hidden></button><button class="close" title="Tab schliessen">&#215;</button>';
    this.audible = false;
    this.muted = false;
    // Lautsprecher wie in Chrome: zeigt Ton an, Klick schaltet den Tab stumm
    this.element.querySelector('.audio').addEventListener('click', () => this.setMuted(!this.muted));
    this.iconURL = null;
    this.element.addEventListener('mousedown', (e) => {
      if (!e.target.classList.contains('close') && !e.target.classList.contains('audio'))
        activateTab(this);
    });
    this.element.querySelector('.close').addEventListener('click', () => closeTab(this));
    $('tab-list').appendChild(this.element);
    this.updateTitle();

    const { width, height } = viewportSize();
    if (viewId) {
      engine._bl_resize(this.id, width, height, devicePixelRatio);
      return;
    }
    engine._bl_create_view(this.id, width, height, devicePixelRatio);
    if (lazy) {
      this.pendingURL = url;
      this.pendingHistory = lazy.history?.entries?.length ? lazy.history : null;
    }
    else if (url)
      loadURL(this, url);
  }

  // Favicon: die Engine hat es geladen, wir bekommen die Bytes
  setIcon(mime, bytes) {
    if (this.iconURL)
      URL.revokeObjectURL(this.iconURL);
    this.iconURL = bytes.length ? URL.createObjectURL(new Blob([bytes], { type: mime || 'image/x-icon' })) : null;
    const img = this.element.querySelector('.icon');
    img.hidden = !this.iconURL;
    if (this.iconURL)
      img.src = this.iconURL;
    else
      img.removeAttribute('src');
    img.onerror = () => { img.hidden = true; };
  }

  setAudible(audible) {
    this.audible = audible;
    this.updateAudio();
  }

  setMuted(muted) {
    this.muted = muted;
    engine._bl_set_muted(this.id, muted ? 1 : 0);
    this.updateAudio();
  }

  updateAudio() {
    const button = this.element.querySelector('.audio');
    button.hidden = !this.audible && !this.muted;
    button.textContent = this.muted ? '\u{1F507}' : '\u{1F50A}';
    button.title = this.muted ? 'Ton für diesen Tab einschalten' : 'Diesen Tab stummschalten';
    button.classList.toggle('muted', this.muted);
  }

  updateTitle() {
    this.element.querySelector('.title').textContent = this.title || this.url || 'Neuer Tab';
    this.element.title = this.title;
    if (this === activeTab)
      document.title = (this.title ? this.title + ' - ' : '') + 'browser-lite';
  }
}

function viewportSize() {
  const rect = $('viewport').getBoundingClientRect();
  return { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
}

function newTab(url, viewId = 0) {
  if (!engineReady)
    return null;
  const tab = new Tab(url, viewId);
  tabs.set(tab.id, tab);
  activateTab(tab);
  return tab;
}

function openBackgroundTab(url) {
  if (!engineReady)
    return null;
  const tab = new Tab(url);
  tabs.set(tab.id, tab);
  persistSession();
  return tab;
}

// Quelltext einer Seite (Strg+U): die Engine laedt die Adresse wie einen
// Download, wir zeigen den Text mit Zeilennummern in einem neuen Tab
function showSource(url, bytes, mime) {
  const charset = /charset=([\w-]+)/i.exec(mime || '')?.[1] || 'utf-8';
  let text;
  try {
    text = new TextDecoder(charset).decode(bytes);
  } catch {
    text = new TextDecoder().decode(bytes);
  }
  const escape = (line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const lines = text.split(/\r?\n/).map((line) => '<li>' + escape(line) + '</li>').join('');
  const html = '<!doctype html><meta charset="utf-8"><title>view-source:' + escape(url) + '</title>'
    + '<style>body{margin:8px 0;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all}'
    + 'ol{margin:0;padding-left:5em}li{padding-left:1em}li::marker{color:#999}</style><ol>' + lines + '</ol>';
  const tab = newTab('');
  expectAnswer();
  engine._bl_load_html(tab.id, toUTF8(html), toUTF8('view-source:' + url));
}

// Wiederhergestellter Tab im Hintergrund: laedt erst beim ersten Anklicken
function restoredTab(entry) {
  const tab = new Tab(entry.url, 0, { title: entry.title, history: entry.history });
  tabs.set(tab.id, tab);
  return tab;
}

function activateTab(tab) {
  if (activeTab === tab)
    return;
  tab.lastActive = Date.now();
  if (activeTab) {
    activeTab.lastActive = Date.now();
    activeTab.canvas.style.display = 'none';
    activeTab.element.classList.remove('active');
    engine._bl_focus(activeTab.id, 0);
  }
  activeTab = tab;
  clearHover();
  updateStar(tab.url);
  if (tab.pendingURL) {
    // Mit Verlauf (Zurueck/Vor) wie vor dem Neustart bzw. Verwerfen
    if (tab.pendingHistory) {
      expectAnswer();
      engine._bl_restore_history(tab.id, toUTF8(JSON.stringify(tab.pendingHistory)));
    } else
      loadURL(tab, tab.pendingURL);
    tab.pendingURL = null;
    tab.pendingHistory = null;
  }
  persistSession();
  tab.canvas.style.display = 'block';
  tab.element.classList.add('active');
  engine._bl_focus(tab.id, 1);
  focusPage();
  updateToolbar();
  tab.updateTitle();
}

// Wie Chrome bei wenig Speicher: alle Tabs teilen sich den WASM-Speicher der
// Engine (hoechstens 4 GB, er schrumpft nie). Wird er knapp, ersetzen wir den
// am laengsten nicht benutzten Hintergrund-Tab durch einen, der erst beim
// Anklicken neu laedt. Tabs mit Ton oder Kamera/Mikrofon bleiben.
let discardLimit = 2.5 * 1024 ** 3;
function checkMemory() {
  if (!engineReady || engine._bl_memory_used() < discardLimit)
    return null;
  const candidates = [...tabs.values()].filter((tab) => tab !== activeTab && !tab.pendingURL && !tab.audible
    && !tab.capturing && /^(https?|file):/.test(tab.url || ''));
  candidates.sort((a, b) => (a.lastActive || 0) - (b.lastActive || 0));
  return candidates.length ? discardTab(candidates[0]) : null;
}
setInterval(checkMemory, 15000);
// Fuer Tests: Grenze setzen und sofort pruefen
window.__blCheckMemory = (limit) => {
  if (limit !== undefined)
    discardLimit = limit;
  return checkMemory()?.id ?? 0;
};

function discardTab(tab) {
  const fresh = new Tab(tab.url, 0, { title: tab.title, history: tab.history });
  fresh.lastActive = tab.lastActive;
  tab.element.before(fresh.element);
  // Favicon uebernehmen (die Blob-URL gehoert jetzt dem neuen Tab)
  if (tab.iconURL) {
    fresh.iconURL = tab.iconURL;
    tab.iconURL = null;
    const img = fresh.element.querySelector('.icon');
    img.src = fresh.iconURL;
    img.hidden = false;
  }
  tabs.set(fresh.id, fresh);
  closeTab(tab);
  return fresh;
}

function closeTab(tab) {
  forgetTab(tab);
  closePickers(tab);
  if (fullscreenTab === tab)
    setFullscreen(tab, false);
  if (tab.iconURL)
    URL.revokeObjectURL(tab.iconURL);
  setTimeout(persistSession);
  engine._bl_destroy_view(tab.id);
  engine._bl_remove_path(toUTF8(uploadDirectory(tab)));
  tab.canvas.remove();
  tab.element.remove();
  tabs.delete(tab.id);
  if (activeTab === tab) {
    activeTab = null;
    const next = [...tabs.values()].pop();
    if (next)
      activateTab(next);
    else
      newTab('about:blank');
  }
}

function updateToolbar() {
  const tab = activeTab;
  if (!tab)
    return;
  $('back').disabled = !tab.canGoBack;
  $('forward').disabled = !tab.canGoForward;
  $('reload').innerHTML = tab.loading ? '&#215;' : '&#8635;';
  $('reload').title = tab.loading ? 'Stoppen' : 'Neu laden';
  $('zoom').hidden = tab.zoom === 1;
  $('zoom').textContent = Math.round(tab.zoom * 100) + ' %';
  if (document.activeElement !== $('address'))
    $('address').value = tab.url === 'about:blank' ? '' : tab.url;
  updateSecurity(tab.url);
}

// Sicherheitsanzeige wie Chrome: Schloss bei HTTPS (die Engine prueft das
// Zertifikat selber, ohne gueltiges Zertifikat laedt die Seite gar nicht),
// "Nicht sicher" bei HTTP
function updateSecurity(url) {
  const security = $('security');
  const form = $('address-form');
  const https = /^https:/.test(url || '');
  const http = /^http:/.test(url || '');
  security.hidden = !https && !http;
  security.textContent = https ? '\u{1F512}' : http ? 'Nicht sicher' : '';
  security.title = https ? 'Verbindung ist sicher (TLS)' : http ? 'Die Verbindung zu dieser Seite ist nicht verschlüsselt' : '';
  security.classList.toggle('insecure', http);
  form.classList.toggle('with-security', https || http);
  form.classList.toggle('insecure', http);
}

// --------------------------------------------------------- Vollbild
// Die Seite ruft element.requestFullscreen() auf: wir machen den Seitenbereich
// im Host-Browser gross. Die neue Groesse geht wie sonst ueber bl_resize an
// die Engine. Beendet der Benutzer das Vollbild (Esc), sagen wir es der Engine.

let fullscreenTab = null;

function setFullscreen(tab, on) {
  if (on) {
    fullscreenTab = tab;
    if (document.fullscreenElement !== $('viewport')) {
      $('viewport').requestFullscreen?.().catch(() => {
        // Ohne Benutzer-Aktion erlaubt der Browser es nicht
        fullscreenTab = null;
        engine._bl_exit_fullscreen(tab.id);
      });
    }
  } else {
    fullscreenTab = null;
    if (document.fullscreenElement)
      document.exitFullscreen().catch(() => {});
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && fullscreenTab) {
    const tab = fullscreenTab;
    fullscreenTab = null;
    engine._bl_exit_fullscreen(tab.id);
  }
});

// --------------------------------------------------------- Meldungen der Engine

function onEngineEvent(viewId, type, payload) {
  engineAnswered();
  const tab = tabs.get(viewId);
  const data = payload ? JSON.parse(payload) : {};
  if (type === 'console') {
    // Reihenfolge von JSC::MessageLevel
    const method = ['log', 'warn', 'error', 'debug', 'info'][data.level] || 'log';
    console[method](`[seite ${viewId}] ${data.message}`, data.source ? `(${data.source}:${data.line})` : '');
    return;
  }
  if (type === 'caret') {
    // Eingabefeld an den Cursor: dort zeigt die Eingabemethode ihre Vorschlaege
    if (tab) {
      tab.caret = data;
      if (tab === activeTab)
        placeIme(tab);
    }
    return;
  }
  if (type === 'clipboard') {
    // Mit HTML (formatierter Text) wie in Chrome, sonst nur Text
    if (data.html && typeof ClipboardItem === 'function') {
      const item = new ClipboardItem({
        'text/plain': new Blob([data.text || ''], { type: 'text/plain' }),
        'text/html': new Blob([data.html], { type: 'text/html' }),
      });
      navigator.clipboard?.write([item]).catch(() => navigator.clipboard?.writeText(data.text || '').catch(() => {}));
    } else
      navigator.clipboard?.writeText(data.text || '').catch(() => {});
    return;
  }
  // Fuer alle Tabs: Gamepads und Sprachausgabe (web/devices.js)
  switch (type) {
  case 'gamepad-monitor':
    onGamepadMonitor(data);
    return;
  case 'gamepad-effect':
    onGamepadEffect(data);
    return;
  case 'speak':
    onSpeak(data);
    return;
  case 'capture-start':
    onCaptureStart(data);
    return;
  case 'capture-stop':
    onCaptureStop(data);
    return;
  case 'speech-command':
    onSpeechCommand(data);
    return;
  case 'speech-recognition':
    onSpeechRecognition(tab, data);
    return;
  case 'notification':
    // Auch ohne Tab: aus einem Service Worker (showNotification)
    onNotification(tab, data);
    return;
  case 'notification-close':
    onNotificationClose(data);
    return;
  }
  if (type === 'download-start' || type === 'download-done') {
    onDownloadEvent(type, data);
    return;
  }
  if (type === 'open-tab') {
    // Strg/Cmd+Klick oder Mittelklick auf einen Link: neuer Tab im Hintergrund
    openBackgroundTab(data.url);
    return;
  }
  if (type === 'external-url') {
    // mailto:, tel:, App-Links: der Host-Browser gibt sie an das System
    // (mit seiner Rueckfrage), die Oberflaeche selber bleibt
    window.open(data.url, '_blank', 'noopener');
    setStatus('Extern geöffnet: ' + data.url);
    return;
  }
  if (type === 'newview') {
    // window.open / target=_blank: die Engine hat schon einen View geoeffnet
    newTab('', viewId);
    return;
  }
  if (!tab)
    return;
  if (type === 'close') {
    closeTab(tab);
    return;
  }
  if (type === 'contextmenu') {
    showContextMenu(tab, data);
    return;
  }
  if (type === 'filechooser') {
    openFileChooser(tab, data);
    return;
  }
  // <select>, <input type=color/date>, Link unter der Maus (web/pickers.js)
  switch (type) {
  case 'popup':
    showSelectPopup(tab, data);
    return;
  case 'popup-hide':
    hideSelectPopup();
    return;
  case 'colorpicker':
    showColorPicker(tab, data);
    return;
  case 'datetimepicker':
    showDateTimePicker(tab, data);
    return;
  case 'picker-hide':
    hidePicker();
    return;
  case 'hover':
    showHover(tab, data, tab === activeTab);
    return;
  case 'takefocus':
    // Tab ueber das letzte Element der Seite hinaus: zur Adressleiste
    if (tab === activeTab) {
      $('address').focus();
      $('address').select();
    }
    return;
  case 'find':
    if (tab === activeTab)
      showFindCount(data);
    return;
  case 'permission':
    onPermissionRequest(tab, data);
    return;
  case 'geolocation-start':
    onGeolocationStart(tab, data);
    return;
  case 'geolocation-stop':
    onGeolocationStop(tab);
    return;
  case 'sensor-start':
    onSensorStart(tab, data);
    return;
  case 'host-call':
    onHostCall(tab, data);
    return;
  case 'sensor-stop':
    onSensorStop(tab, data);
    return;
  case 'touch-result':
    tab.onTouchResult?.(data);
    return;
  case 'pointerlock':
    setPointerLock(tab, data.on);
    return;
  }
  if (type === 'fullscreen') {
    setFullscreen(tab, data.on);
    return;
  }
  switch (type) {
  case 'navigation':
    // Titel aus dem Verlaufseintrag: aus dem Back/Forward-Cache kommt er vor
    // dieser Meldung
    if (data.url !== tab.url) {
      const entry = data.history?.entries?.[data.history.index];
      recordVisit(data.url, entry && entry.url === data.url ? entry.title : '');
      if (entry?.title && entry.url === data.url) {
        tab.title = entry.title;
        tab.updateTitle();
      }
    }
    tab.url = data.url;
    tab.canGoBack = data.canGoBack;
    tab.canGoForward = data.canGoForward;
    tab.loading = data.loading;
    if (data.history)
      tab.history = data.history;
    if (tab === activeTab)
      updateStar(tab.url);
    persistSession();
    break;
  case 'title':
    tab.title = data.title;
    tab.updateTitle();
    // Nur zum Eintrag der Adresse, zu der der Titel gehoert
    if (!data.url || data.url === tab.url)
      recordVisit(tab.url, data.title);
    persistSession();
    break;
  case 'progress':
    if (tab === activeTab)
      setProgress(data.progress);
    break;
  case 'commit':
    // Neues Dokument: Dialoge wieder erlaubt (engineDialog)
    tab.dialogsBlocked = tab.dialogsAsked = false;
    tab.dialogBurst = 0;
    break;
  case 'first-layout':
    window.__blFirstLayout = true; // fuer die Tests (tests/e2e)
    break;
  case 'load':
    tab.loading = false;
    window.__blLoaded = true; // fuer die Tests (tests/e2e)
    if (tab === activeTab)
      setStatus(tab.notice || '');
    tab.notice = null;
    break;
  case 'error':
    tab.loading = false;
    if (tab === activeTab)
      setStatus('Fehler: ' + data.description);
    break;
  case 'media-state':
    tab.setAudible(!!data.audio);
    return;
  case 'capture-state':
    tab.capturing = !!data.active;
    tab.element.querySelector('.recording').hidden = !data.active;
    return;
  case 'cursor':
    tab.canvas.style.cursor = data.cursor;
    break;
  }
  if (tab === activeTab)
    updateToolbar();
}

function setStatus(text) {
  $('status').textContent = text;
}

function setProgress(value) {
  const bar = $('progress');
  bar.style.opacity = value >= 1 ? '0' : '1';
  bar.style.width = Math.round(value * 100) + '%';
}

// Ein Bild ist fertig: Pixel aus dem gemeinsamen Speicher ins Canvas kopieren
function onEngineFrame(viewId, ptr, width, height, dirtyX, dirtyY, dirtyWidth, dirtyHeight) {
  engineAnswered();
  const tab = tabs.get(viewId);
  if (tab && tab.ctx) {
    const canvas = tab.canvas;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      dirtyX = 0; dirtyY = 0; dirtyWidth = width; dirtyHeight = height;
    }
    if (dirtyWidth > 0 && dirtyHeight > 0) {
      // ImageData darf nicht direkt auf SharedArrayBuffer zeigen: Zeilen kopieren
      const pixels = new Uint8ClampedArray(dirtyWidth * dirtyHeight * 4);
      const heap = engine.HEAPU8;
      for (let row = 0; row < dirtyHeight; row++) {
        const start = ptr + ((dirtyY + row) * width + dirtyX) * 4;
        pixels.set(heap.subarray(start, start + dirtyWidth * 4), row * dirtyWidth * 4);
      }
      tab.ctx.putImageData(new ImageData(pixels, dirtyWidth, dirtyHeight), dirtyX, dirtyY);
    }
  }
  engine._bl_frame_presented(viewId);
}

// Fuer Tests: Farbe [r, g, b] an einer Stelle der sichtbaren Seite (CSS-Pixel).
// Das Canvas gehoert meist dem Engine-Worker, darum ueber drawImage statt
// getImageData.
window.blPagePixel = (x, y) => {
  if (!activeTab)
    return null;
  const rect = activeTab.canvas.getBoundingClientRect();
  const probe = document.createElement('canvas');
  probe.width = Math.ceil(rect.width);
  probe.height = Math.ceil(rect.height);
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(activeTab.canvas, 0, 0, probe.width, probe.height);
  return [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)];
};
// Fuer Tests: eine ganze Zeile auf einmal (gleiches Bild fuer alle Punkte)
window.blPageRow = (y) => {
  if (!activeTab)
    return null;
  const rect = activeTab.canvas.getBoundingClientRect();
  const probe = document.createElement('canvas');
  probe.width = Math.ceil(rect.width);
  probe.height = Math.ceil(rect.height);
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(activeTab.canvas, 0, 0, probe.width, probe.height);
  const data = ctx.getImageData(0, Math.round(y), probe.width, 1).data;
  const row = [];
  for (let i = 0; i < data.length; i += 4)
    row.push([data[i], data[i + 1], data[i + 2]]);
  return row;
};

// Engine moechte ein neues Bild: beim naechsten Bildschirm-Refresh
function onEngineNeedsFrame(viewId) {
  engineAnswered();
  const tab = tabs.get(viewId);
  if (!tab || tab.frameRequested)
    return;
  tab.frameRequested = true;
  requestAnimationFrame(() => {
    tab.frameRequested = false;
    if (tabs.has(viewId))
      engine._bl_frame(viewId);
  });
}

// ----------------------------------------------------------------- Downloads
// Die Engine laedt die Datei und schickt die Daten in Stuecken. Am Ende
// wird daraus ein Blob, den der Browser normal speichert.

const downloads = new Map(); // id -> { filename, chunks, received, size }

// Liste fuer das Download-Panel (Strg+J), nur fuer diese Sitzung
const downloadHistory = [];

function onDownloadEvent(type, data) {
  if (type === 'download-start') {
    const download = { filename: data.filename, mime: data.mime, chunks: [], received: 0, size: data.size, viewSource: data.viewSource, sourceURL: data.url };
    downloads.set(data.id, download);
    if (download.viewSource)
      return;
    downloadHistory.push(download);
    refreshDownloadsPanel();
    setStatus('Download: ' + data.filename);
    return;
  }
  const download = downloads.get(data.id);
  downloads.delete(data.id);
  if (!download)
    return;
  if (download.viewSource) {
    if (!data.error)
      new Blob(download.chunks).arrayBuffer().then((buffer) => showSource(download.sourceURL, new Uint8Array(buffer), download.mime));
    return;
  }
  if (data.error) {
    download.error = data.error;
    download.chunks = [];
    refreshDownloadsPanel();
    setStatus('Download fehlgeschlagen: ' + download.filename + ' (' + data.error + ')');
    return;
  }
  const blob = new Blob(download.chunks, { type: download.mime || 'application/octet-stream' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = download.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  download.url = link.href;
  download.done = true;
  download.size = blob.size;
  download.chunks = [];
  // Alte Downloads aus dem Speicher werfen (die Liste behaelt nur den Namen)
  const kept = downloadHistory.filter((d) => d.url);
  if (kept.length > 10) {
    URL.revokeObjectURL(kept[0].url);
    kept[0].url = null;
  }
  refreshDownloadsPanel();
  setStatus('Download fertig: ' + download.filename + ' (' + formatSize(blob.size) + ')');
}

function onEngineDownloadData(id, bytes) {
  const download = downloads.get(id);
  if (!download)
    return;
  download.chunks.push(bytes);
  download.received += bytes.length;
  if (download.viewSource)
    return;
  const total = download.size > 0 ? ' von ' + formatSize(download.size) : '';
  setStatus('Download: ' + download.filename + ' ' + formatSize(download.received) + total);
}

// ------------------------------------------------------------ Drucken
// Die Engine baut ein PDF (engine/src/Printing.cpp). Wir zeigen es wie die
// Druckvorschau von Chrome an und oeffnen gleich den Druckdialog des Host.

const printPreview = $('print-preview');
let printURL = null;

function printTab(tab) {
  if (!tab || !engine)
    return;
  setStatus('Druckvorschau wird erstellt …');
  engine._bl_print(tab.id);
}

function closePrintPreview() {
  printPreview.hidden = true;
  printPreview.querySelector('iframe')?.remove();
  if (printURL)
    URL.revokeObjectURL(printURL);
  printURL = null;
  focusPage();
}

function onEnginePrint(viewId, bytes, title) {
  if (tabs.get(viewId) !== activeTab)
    return;
  setStatus('');
  closePrintPreview();
  printURL = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const name = (title || 'Seite').replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.pdf';
  printPreview.querySelector('.print-title').textContent = title || 'Drucken';
  const save = printPreview.querySelector('.print-save');
  save.href = printURL;
  save.download = name;
  const frame = document.createElement('iframe');
  frame.title = 'Druckvorschau';
  frame.src = printURL;
  // Wie window.print() in Chrome: der Druckdialog kommt gleich
  frame.addEventListener('load', () => {
    try {
      frame.contentWindow.print();
    } catch (e) {}
  }, { once: true });
  printPreview.append(frame);
  printPreview.hidden = false;
}

printPreview.querySelector('.print-close').addEventListener('click', closePrintPreview);
printPreview.querySelector('.print-now').addEventListener('click', () => {
  try {
    printPreview.querySelector('iframe')?.contentWindow.print();
  } catch (e) {}
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !printPreview.hidden) {
    closePrintPreview();
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);

// ------------------------------------------------------------ Kontextmenue
// Die Engine schickt nach einem Rechtsklick, was unter der Maus ist (Link,
// Bild, Auswahl). Hat die Seite ein eigenes Menue, kommt nichts.

const menu = $('context-menu');

function hideContextMenu() {
  menu.hidden = true;
  menu.replaceChildren();
}

function showContextMenu(tab, data) {
  hideContextMenu();
  const items = [];
  const add = (label, action, enabled = true) => items.push({ label, action, enabled });
  const separator = () => items.length && items[items.length - 1] !== null && items.push(null);
  if (data.link) {
    add('Link in neuem Tab öffnen', () => newTab(data.link));
    add('Link-Adresse kopieren', () => navigator.clipboard?.writeText(data.link));
    separator();
  }
  if (data.image) {
    add('Bild in neuem Tab öffnen', () => newTab(data.image));
    add('Bild-Adresse kopieren', () => navigator.clipboard?.writeText(data.image));
    separator();
  }
  if (data.selection)
    add('Kopieren', () => engine._bl_command(tab.id, toUTF8('Copy')));
  if (data.editable) {
    add('Ausschneiden', () => engine._bl_command(tab.id, toUTF8('Cut')), !!data.selection);
    add('Einfügen', async () => {
      const text = await navigator.clipboard?.readText().catch(() => null);
      if (text != null)
        engine._bl_set_clipboard_text(toUTF8(text));
      engine._bl_command(tab.id, toUTF8('Paste'));
    });
  }
  add('Alles auswählen', () => engine._bl_command(tab.id, toUTF8('SelectAll')));
  separator();
  add('Zurück', () => engine._bl_go_back(tab.id), data.canGoBack);
  add('Vorwärts', () => engine._bl_go_forward(tab.id), data.canGoForward);
  add('Neu laden', () => reloadTab(tab));
  add('Drucken …', () => printTab(tab));
  add('Seitenquelltext anzeigen', () => engine._bl_view_source(tab.id), /^https?:/.test(tab.url || ''));

  for (const item of items) {
    if (!item) {
      menu.appendChild(document.createElement('hr'));
      continue;
    }
    const button = document.createElement('button');
    button.textContent = item.label;
    button.disabled = !item.enabled;
    button.addEventListener('click', () => {
      hideContextMenu();
      item.action();
      focusPage();
    });
    menu.appendChild(button);
  }
  menu.hidden = false;
  // Position im Fenster, nicht ueber den Rand hinaus
  const rect = tab.canvas.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = Math.min(rect.left + data.x, window.innerWidth - width - 4) + 'px';
  menu.style.top = Math.min(rect.top + data.y, window.innerHeight - height - 4) + 'px';
}

window.addEventListener('pointerdown', (e) => {
  if (!menu.hidden && !menu.contains(e.target))
    hideContextMenu();
}, true);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menu.hidden)
    hideContextMenu();
}, true);
window.addEventListener('blur', hideContextMenu);

// ------------------------------------------------------------- Datei-Upload
// <input type=file> der Seite: echten Dateidialog zeigen, die Dateien ins
// virtuelle Dateisystem der Engine schreiben und die Pfade zurueckgeben.

const MAX_UPLOAD = 512 * 1024 * 1024;
let uploadCounter = 0;

// Ordner mit den Dateien eines Tabs. Die Seite liest sie, solange sie ihre
// File-Objekte hat (auch nach dem Navigieren, Back/Forward-Cache), darum erst
// beim Schliessen des Tabs geloescht.
const uploadDirectory = (tab) => '/tmp/uploads/' + tab.id;

// Dateien (Upload, Ablegen, Einfuegen) ins Dateisystem der Engine, gibt die
// Pfade zurueck. Was sich nicht lesen laesst (weg, zu gross), faellt weg.
async function writeUploads(tab, files) {
  const paths = [];
  const skipped = [];
  for (const file of files) {
    // Ein eingefuegtes Bild hat in Chrome den Namen "image.png"
    const name = (file.name || 'image.png').replace(/[\/\n]/g, '_');
    if (file.size > MAX_UPLOAD) {
      skipped.push(name + ' (zu gross, höchstens ' + formatSize(MAX_UPLOAD) + ')');
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Tab inzwischen zu: sein Upload-Ordner ist schon geloescht
      if (!tabs.has(tab.id))
        return [];
      const path = uploadDirectory(tab) + '/' + (++uploadCounter) + '/' + name;
      writeEngineFile(path, bytes);
      paths.push(path);
    } catch (error) {
      console.warn('Datei nicht lesbar:', name, error);
      skipped.push(name);
    }
  }
  if (skipped.length)
    setStatus('Nicht übernommen: ' + skipped.join(', '));
  return paths;
}

function openFileChooser(tab, data) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = data.multiple;
  if (data.accept)
    input.accept = data.accept;
  let answered = false;
  const answer = (paths) => {
    if (answered)
      return;
    answered = true;
    engine._bl_choose_files(tab.id, toUTF8(paths.join('\n')));
  };
  input.addEventListener('change', () => writeUploads(tab, input.files).then(answer, () => answer([])));
  input.addEventListener('cancel', () => answer([]));
  input.click();
}

// alert/confirm/prompt der Seite, wie Chrome mit der Herkunft ("<host> meldet:").
// Hintergrund-Tabs bekommen sofort "Abbrechen". Kommen viele Dialoge kurz
// nacheinander (Schleife), fragt die Oberflaeche einmal, ob der Tab weitere
// zeigen darf: sonst bliebe nur der Haken des Host-Browsers, und der sperrt
// die Dialoge aller Seiten.
function engineDialog(viewId, type, origin, message, defaultValue) {
  engineAnswered();
  const tab = tabs.get(viewId);
  if (!tab || tab !== activeTab || tab.dialogsBlocked)
    return 0;
  let host = '';
  try {
    host = new URL(origin).host;
  } catch {}
  host = host || (origin && origin !== 'null' ? origin : 'Diese Seite');
  const now = Date.now();
  tab.dialogBurst = now - (tab.lastDialog || 0) < 1000 ? (tab.dialogBurst || 0) + 1 : 1;
  if (tab.dialogBurst > 3 && !tab.dialogsAsked) {
    tab.dialogsAsked = true;
    if (!confirm(host + ' zeigt viele Dialoge. Weitere Dialoge dieser Seite zulassen?')) {
      tab.dialogsBlocked = true;
      return 0;
    }
  }
  const text = host + ' meldet:\n\n' + message;
  let result = 0;
  if (type === 1)
    result = confirm(text) ? 1 : 0;
  else if (type === 2) {
    const answer = prompt(text, defaultValue);
    result = answer === null ? 0 : engine.stringToNewUTF8(answer);
  } else
    alert(text);
  tab.lastDialog = Date.now();
  return result;
}

// ------------------------------------------------------------------- Eingabe

function modifierBits(e) {
  return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0)
    | (e.getModifierState?.('CapsLock') ? 16 : 0);
}

function attachInput(tab) {
  const canvas = tab.canvas;
  const position = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  // Finger zuerst: Touch-Events, Scrollen mit Schwung, Antippen (web/devices.js)
  attachTouch(tab, canvas, position, modifierBits);
  // Zwei-Finger-Zoom auf dem Touchpad kommt als viele kleine wheel-Ereignisse
  // mit ctrlKey (bruchzahlige Deltas): wie Chrome nur die Ansicht skalieren
  // (engine/src/PinchZoom.h), um den Mauszeiger. Die Geste endet, wenn eine
  // Weile nichts mehr kommt oder vor einer anderen Eingabe (die Engine
  // uebernimmt das Ziel dann vor ihr, ein Klick trifft, was zu sehen ist).
  let pinch = null; // { x, y, timer }
  const endPinch = () => {
    if (!pinch)
      return;
    clearTimeout(pinch.timer);
    engine._bl_pinch(tab.id, 2, 1, pinch.x, pinch.y);
    pinch = null;
  };
  // Klickzahl (Doppel-/Dreifachklick: Wort/Absatz markieren, dblclick)
  // selber zaehlen: PointerEvent.detail ist in Chrome immer 0
  let lastDown = { time: 0, x: 0, y: 0, button: -1, count: 0 };
  canvas.addEventListener('pointerdown', (e) => {
    focusPage();
    endPinch();
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = position(e);
    const repeated = e.button === lastDown.button && e.timeStamp - lastDown.time < 500
      && Math.abs(x - lastDown.x) <= 4 && Math.abs(y - lastDown.y) <= 4;
    lastDown = { time: e.timeStamp, x, y, button: e.button, count: repeated ? lastDown.count + 1 : 1 };
    engine._bl_mouse(tab.id, 0, e.button, x, y, lastDown.count, modifierBits(e));
    e.preventDefault();
  });
  canvas.addEventListener('pointerup', (e) => {
    endPinch();
    engine._bl_mouse(tab.id, 1, e.button, ...position(e), e.button === lastDown.button ? lastDown.count : 1, modifierBits(e));
  });
  canvas.addEventListener('pointermove', (e) => {
    // Gedrueckte Taste mitgeben (e.buttons: 1 links, 2 rechts, 4 Mitte), sonst kein Ziehen
    const button = e.buttons & 1 ? 0 : e.buttons & 4 ? 1 : e.buttons & 2 ? 2 : -1;
    engine._bl_mouse_move(tab.id, ...position(e), e.movementX || 0, e.movementY || 0, button, modifierBits(e));
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    endPinch();
    engine._bl_context_menu(tab.id, ...position(e));
  });
  canvas.addEventListener('wheel', (e) => {
    if (e.ctrlKey && !e.altKey && e.deltaY) {
      e.preventDefault();
      // Strg + Mausrad: eine Zoom-Stufe pro Raste wie in Chrome
      if (e.deltaMode !== 0 || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50)) {
        changeZoom(tab, e.deltaY < 0 ? 1 : -1);
        return;
      }
      if (!pinch) {
        const [x, y] = position(e);
        pinch = { x, y, timer: 0 };
        engine._bl_pinch(tab.id, 0, 1, x, y);
      }
      clearTimeout(pinch.timer);
      pinch.timer = setTimeout(endPinch, 200);
      engine._bl_pinch(tab.id, 1, Math.exp(-e.deltaY / 100), pinch.x, pinch.y);
      return;
    }
    endPinch();
    let factor = 1;
    if (e.deltaMode === 1) factor = 40;       // Zeilen
    else if (e.deltaMode === 2) factor = 800; // Seiten
    engine._bl_wheel(tab.id, ...position(e), e.deltaX * factor, e.deltaY * factor, modifierBits(e));
    e.preventDefault();
  }, { passive: false });

  // Drag & Drop aus dem System oder einem anderen Fenster (Dateien, Text,
  // Links). Beim Ziehen sieht die Seite wie in Chrome nur die Typen und die
  // Anzahl Dateien, beim Ablegen kommen die Daten (Dateien ins Dateisystem
  // der Engine wie beim Upload, engine/src/WebView.cpp hostDrag).
  const dragSummary = (dataTransfer) => {
    const summary = { fileCount: 0 };
    for (const item of dataTransfer.items || []) {
      if (item.kind === 'file')
        summary.fileCount++;
    }
    const types = [...(dataTransfer.types || [])];
    if (types.includes('text/plain'))
      summary.text = '';
    if (types.includes('text/html'))
      summary.html = '';
    if (types.includes('text/uri-list'))
      summary.uriList = '';
    return summary;
  };
  const sendDrag = (phase, e, data) => engine._bl_drag(tab.id, phase, ...position(e), modifierBits(e), toUTF8(JSON.stringify(data)));
  canvas.addEventListener('dragenter', (e) => e.preventDefault());
  canvas.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    sendDrag(0, e, dragSummary(e.dataTransfer));
  });
  canvas.addEventListener('dragleave', (e) => sendDrag(1, e, {}));
  canvas.addEventListener('drop', async (e) => {
    e.preventDefault();
    const dataTransfer = e.dataTransfer;
    const data = { files: [] };
    for (const [key, type] of [['text', 'text/plain'], ['html', 'text/html'], ['uriList', 'text/uri-list']]) {
      const value = dataTransfer.getData(type);
      if (value)
        data[key] = value;
    }
    // Nach einem await sind die Daten des Ereignisses weg
    const files = [...dataTransfer.files];
    const point = position(e);
    const modifiers = modifierBits(e);
    data.files = await writeUploads(tab, files);
    data.fileCount = data.files.length;
    engine._bl_drag(tab.id, 2, ...point, modifiers, toUTF8(JSON.stringify(data)));
  });
}

// Tastatur: Ein unsichtbares Textfeld (#ime) hat den Fokus, nicht das Canvas.
// Normale Tasten gehen direkt als keydown/keyup an die Engine. Text, der erst
// zusammengesetzt wird (tote Tasten wie ^ und ` auf der Schweizer Tastatur,
// IME fuer Chinesisch/Japanisch, Bildschirmtastatur), kommt ueber die
// input/composition-Events und wird als fertiger Text eingefuegt.
const ime = $('ime');
let composing = false;

function focusPage() {
  ime.focus({ preventScroll: true });
}

function placeIme(tab) {
  const caret = tab.caret;
  if (!caret || !tab.canvas)
    return;
  const rect = tab.canvas.getBoundingClientRect();
  ime.style.left = `${rect.left + caret.x}px`;
  ime.style.top = `${rect.top + caret.y}px`;
  ime.style.height = `${Math.max(caret.height, 10)}px`;
}

const isPasteShortcut = (e) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v';
const isTextInput = (e) => e.isComposing || composing || e.key === 'Dead' || e.key === 'Process'
  || e.key === 'Unidentified' || e.keyCode === 229;

ime.addEventListener('keydown', (e) => {
  // Einfuegen: erst das paste-Event abwarten, dort kennen wir den Inhalt
  if (!activeTab || isPasteShortcut(e) || isTextInput(e))
    return;
  sendKey(activeTab, 0, e);
  // Browser-Kurzbefehle wie Tab, Backspace, Leertaste nicht an die UI weitergeben
  if (!(e.key === 'F5' || e.key === 'F12'))
    e.preventDefault();
});
ime.addEventListener('keyup', (e) => {
  if (!activeTab || isPasteShortcut(e) || isTextInput(e))
    return;
  sendKey(activeTab, 1, e);
  e.preventDefault();
});
ime.addEventListener('compositionstart', () => {
  composing = true;
});
// Vorschau wie in Chrome: der Text der Eingabemethode steht unterstrichen in
// der Seite (compositionstart/-update/-end auch fuer die Seite)
ime.addEventListener('compositionupdate', (e) => {
  if (activeTab)
    engine._bl_set_composition(activeTab.id, toUTF8(e.data || ''), (e.data || '').length, (e.data || '').length);
});
ime.addEventListener('compositionend', (e) => {
  composing = false;
  if (activeTab)
    engine._bl_confirm_composition(activeTab.id, toUTF8(e.data || ''));
  ime.value = '';
});
ime.addEventListener('input', (e) => {
  if (composing || e.isComposing)
    return;
  if (activeTab && e.data && (e.inputType === 'insertText' || e.inputType === 'insertReplacementText'))
    engine._bl_insert_text(activeTab.id, toUTF8(e.data));
  ime.value = '';
});
// Einfuegen: Text, HTML (formatierter Text) und Dateien/Bilder (z.B. ein
// Screenshot) wie in Chrome. Dateien kommen wie beim Upload ins Dateisystem
// der Engine, die Seite bekommt sie in clipboardData.files.
ime.addEventListener('paste', async (e) => {
  if (!activeTab)
    return;
  e.preventDefault();
  const tab = activeTab;
  const clipboardData = e.clipboardData;
  const data = { text: clipboardData?.getData('text/plain') ?? '', files: [] };
  const html = clipboardData?.getData('text/html');
  if (html)
    data.html = html;
  // Nach einem await sind die Daten des Ereignisses weg
  const files = [...(clipboardData?.files || [])];
  data.files = await writeUploads(tab, files);
  engine._bl_set_clipboard(toUTF8(JSON.stringify(data)));
  const fake = { key: 'v', code: 'KeyV', keyCode: 86, repeat: false, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };
  sendKey(tab, 0, fake);
  sendKey(tab, 1, fake);
});

function keyText(e) {
  if (e.ctrlKey || e.metaKey)
    return '';
  if (e.key.length === 1)
    return e.key;
  if (e.key === 'Enter')
    return '\r';
  if (e.key === 'Tab')
    return '\t';
  return '';
}

function sendKey(tab, type, e) {
  engine._bl_key(tab.id, type, toUTF8(e.key), toUTF8(e.code), toUTF8(keyText(e)), e.keyCode || 0, e.repeat ? 1 : 0, modifierBits(e));
}

// ------------------------------------------------------------------ Werkzeuge

$('address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!activeTab)
    return;
  hideSuggestions();
  const url = addressToURL($('address').value);
  if (!url)
    return;
  loadURL(activeTab, url);
  focusPage();
});
$('back').addEventListener('click', () => activeTab && engine._bl_go_back(activeTab.id));
$('forward').addEventListener('click', () => activeTab && engine._bl_go_forward(activeTab.id));
$('reload').addEventListener('click', () => {
  if (!activeTab)
    return;
  if (activeTab.loading)
    engine._bl_stop(activeTab.id);
  else
    reloadTab(activeTab);
});
$('clear-data').addEventListener('click', clearStorage);
$('new-tab').addEventListener('click', () => openURL('', true));

// --------------------------------------------------- Vorschlaege der Adressleiste

const suggestionBox = document.createElement('div');
suggestionBox.id = 'suggestions';
suggestionBox.hidden = true;
document.body.appendChild(suggestionBox);
let suggestionIndex = -1;

function hideSuggestions() {
  suggestionBox.hidden = true;
  suggestionIndex = -1;
}

function showSuggestions() {
  const list = suggestions($('address').value);
  suggestionBox.textContent = '';
  suggestionIndex = -1;
  if (!list.length) {
    hideSuggestions();
    return;
  }
  for (const entry of list) {
    const row = document.createElement('div');
    row.className = 'suggestion';
    const title = document.createElement('span');
    title.className = 'suggestion-title';
    title.textContent = entry.title || entry.url;
    const url = document.createElement('span');
    url.className = 'suggestion-url';
    url.textContent = entry.url;
    row.append(title, url);
    row.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      $('address').value = entry.url;
      hideSuggestions();
      $('address-form').requestSubmit();
    });
    suggestionBox.appendChild(row);
  }
  const rect = $('address').getBoundingClientRect();
  Object.assign(suggestionBox.style, { left: rect.left + 'px', top: rect.bottom + 2 + 'px', width: rect.width + 'px' });
  suggestionBox.hidden = false;
}

$('address').addEventListener('input', showSuggestions);
$('address').addEventListener('blur', () => setTimeout(hideSuggestions, 100));
$('address').addEventListener('keydown', (e) => {
  if (suggestionBox.hidden || !['ArrowDown', 'ArrowUp', 'Escape'].includes(e.key))
    return;
  e.preventDefault();
  if (e.key === 'Escape') {
    hideSuggestions();
    return;
  }
  const rows = [...suggestionBox.children];
  rows[suggestionIndex]?.classList.remove('selected');
  suggestionIndex = (suggestionIndex + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
  rows[suggestionIndex].classList.add('selected');
  $('address').value = rows[suggestionIndex].querySelector('.suggestion-url').textContent;
});

function resizeAllTabs() {
  if (!engineReady)
    return;
  const { width, height } = viewportSize();
  for (const tab of tabs.values())
    engine._bl_resize(tab.id, width, height, devicePixelRatio);
}
new ResizeObserver(resizeAllTabs).observe($('viewport'));

// Fenster auf einem Monitor mit anderer Pixeldichte: die Groesse in CSS-Pixeln
// bleibt gleich, der ResizeObserver merkt davon nichts
function watchPixelRatio() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => {
    resizeAllTabs();
    sendScreen();
    watchPixelRatio();
  }, { once: true });
}

// ------------------------------------------------------------ Pointer Lock
// Spiele/3D: die Maus bleibt im Canvas, die Seite bekommt nur movementX/Y.
// Esc beendet es (Host-Browser), das merkt dann auch die Seite.

function setPointerLock(tab, on) {
  if (!on) {
    if (document.pointerLockElement === tab.canvas)
      document.exitPointerLock();
    return;
  }
  Promise.resolve(tab.canvas.requestPointerLock?.({ unadjustedMovement: true })).catch(() => tab.canvas.requestPointerLock?.())
    .then(() => engine._bl_pointer_lock(tab.id, document.pointerLockElement === tab.canvas ? 1 : 0),
      () => engine._bl_pointer_lock(tab.id, 0));
}

let pointerLockTab = null;
document.addEventListener('pointerlockchange', () => {
  const tab = [...tabs.values()].find((t) => t.canvas === document.pointerLockElement);
  if (pointerLockTab && pointerLockTab !== tab)
    engine._bl_pointer_lock(pointerLockTab.id, 0);
  pointerLockTab = tab || null;
});

// ------------------------------------------------------------------ Zoom

const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

function setZoom(tab, zoom) {
  tab.zoom = zoom;
  engine._bl_set_zoom(tab.id, zoom);
  if (tab === activeTab)
    updateToolbar();
}

// direction: +1 groesser, -1 kleiner, 0 zuruecksetzen
function changeZoom(tab, direction) {
  if (!direction)
    return setZoom(tab, 1);
  const index = ZOOM_LEVELS.findIndex((level) => level >= tab.zoom - 0.001);
  const next = direction > 0
    ? ZOOM_LEVELS[Math.min(index + (ZOOM_LEVELS[index] > tab.zoom + 0.001 ? 0 : 1), ZOOM_LEVELS.length - 1)]
    : ZOOM_LEVELS[Math.max(index - 1, 0)];
  setZoom(tab, next);
}
$('zoom').addEventListener('click', () => activeTab && changeZoom(activeTab, 0));

// ------------------------------------------------------- Suchen auf der Seite

const findBar = $('find-bar');
const findInput = $('find-input');
let findTimer = 0;

function openFind() {
  if (!activeTab)
    return;
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
  if (findInput.value)
    runFind(false, false);
}

function runFind(backwards, again) {
  if (activeTab) {
    expectAnswer();
    engine._bl_find(activeTab.id, toUTF8(findInput.value), backwards ? 1 : 0, again ? 1 : 0);
  }
}

function closeFind() {
  if (findBar.hidden)
    return;
  findBar.hidden = true;
  $('find-count').textContent = '';
  if (activeTab)
    engine._bl_find_done(activeTab.id);
  focusPage();
}

function showFindCount(data) {
  $('find-count').textContent = findInput.value ? (data.matches ? `${data.index || 1} von ${data.matches}` : 'Keine Treffer') : '';
}

findInput.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => runFind(false, false), 150);
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    runFind(e.shiftKey, true);
    e.preventDefault();
  } else if (e.key === 'Escape') {
    closeFind();
    e.preventDefault();
  }
});
$('find-next').addEventListener('click', () => runFind(false, true));
$('find-prev').addEventListener('click', () => runFind(true, true));
$('find-close').addEventListener('click', closeFind);

// ------------------------------------------------------------ Tastenkuerzel
// Wie in Chrome. Manche (Strg+T/W/N/Tab) gibt Chrome nur in einem eigenen
// App-Fenster (installierte Web-App) an Seiten weiter, dann gehen sie auch hier.

function switchTab(offset) {
  const list = [...tabs.values()];
  if (list.length < 2 || !activeTab)
    return;
  const index = list.indexOf(activeTab);
  activateTab(list[(index + offset + list.length) % list.length]);
}

function shortcut(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const tab = activeTab;
  if (ctrl && e.shiftKey && key === 'o') {
    togglePanel('bookmarks');
    return true;
  }
  if (key === 'Escape' && panelIsOpen()) {
    togglePanel(null);
    return true;
  }
  if (ctrl && !e.altKey) {
    switch (key) {
    case 't': openURL('', true); return true;
    case 'h': togglePanel('history'); return true;
    case 'j': togglePanel('downloads'); return true;
    case 'd': if (tab) toggleBookmark(tab.url, tab.title); return true;
    case 'w': if (tab) closeTab(tab); return true;
    case 'l': $('address').focus(); $('address').select(); return true;
    case 'f':
    case 'g': if (key === 'g' && !findBar.hidden) runFind(e.shiftKey, true); else openFind(); return true;
    case 'r': if (tab) reloadTab(tab); return true;
    case 'u': if (tab) engine._bl_view_source(tab.id); return true;
    case 'p': printTab(tab); return true;
    case '+':
    case '=': if (tab) changeZoom(tab, 1); return true;
    case '-': if (tab) changeZoom(tab, -1); return true;
    case '0': if (tab) changeZoom(tab, 0); return true;
    case 'Tab': switchTab(e.shiftKey ? -1 : 1); return true;
    case 'PageDown': switchTab(1); return true;
    case 'PageUp': switchTab(-1); return true;
    }
    if (/^[1-9]$/.test(key)) {
      const list = [...tabs.values()];
      const target = key === '9' ? list[list.length - 1] : list[Number(key) - 1];
      if (target)
        activateTab(target);
      return true;
    }
    return false;
  }
  if (e.altKey && !ctrl && tab) {
    if (key === 'ArrowLeft') { engine._bl_go_back(tab.id); return true; }
    if (key === 'ArrowRight') { engine._bl_go_forward(tab.id); return true; }
    if (key === 'd') { $('address').focus(); $('address').select(); return true; }
  }
  if (!ctrl && !e.altKey) {
    switch (key) {
    case 'F5': if (tab) reloadTab(tab); return true;
    case 'F6': $('address').focus(); $('address').select(); return true;
    case 'F3': if (findBar.hidden) openFind(); else runFind(e.shiftKey, true); return true;
    }
  }
  return false;
}

let swallowKeyUp = null;
window.addEventListener('keydown', (e) => {
  if (!engineReady || e.isComposing)
    return;
  if (shortcut(e)) {
    swallowKeyUp = e.code;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);
window.addEventListener('keyup', (e) => {
  if (swallowKeyUp && e.code === swallowKeyUp) {
    swallowKeyUp = null;
    e.stopImmediatePropagation();
  }
}, true);

// Tab in der Adressleiste: Fokus in die Seite (erstes Element)
$('address').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !activeTab)
    return;
  e.preventDefault();
  focusPage();
  engine._bl_focus_initial(activeTab.id, e.shiftKey ? 0 : 1);
});

$('screen').remove(); // Platzhalter, jeder Tab hat sein eigenes Canvas
startEngine().catch((error) => {
  console.error(error);
  if (!engineFailed())
    showEngineMessage('Fehler beim Starten: ' + error.message);
});
