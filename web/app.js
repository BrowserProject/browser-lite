// browser-lite Oberflaeche: Tabs, Adressleiste und die Verbindung zur Engine.
//
// Die Engine (engine/engine.js + engine.wasm) laeuft in einem eigenen Worker.
// Wir rufen ihre C-Funktionen (_bl_...) auf, sie meldet sich ueber die
// Callbacks onEngine... zurueck (siehe engine/src/Host.cpp).

import { WispTransport } from './transport.js';
import { audioState, onEngineAudio } from './audio.js';
import { initMedia, mediaState, onEngineMedia, onEngineMediaFetch } from './media.js';
import { initCapture, onCaptureStart, onCaptureStop } from './capture.js';
import { initDevices, clearPermissions, onPermissionRequest, onGeolocationStart, onGeolocationStop, onSensorStart, onSensorStop, onHostCall, onNotification, onNotificationClose, onGamepadMonitor, onGamepadEffect, onSpeak, onSpeechCommand, onSpeechRecognition, attachTouch } from './devices.js';
import { initLibrary, addressToURL, saveSession, sessionToRestore, recordVisit, toggleBookmark, updateStar, togglePanel, refreshDownloadsPanel, suggestions, settings, panelIsOpen } from './library.js';
import { initPickers, showSelectPopup, hideSelectPopup, showColorPicker, showDateTimePicker, hidePicker, showHover, clearHover } from './pickers.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const START_URL = params.get('url') || 'https://example.com/';
// Ordner der Engine. tools/package-site.sh ersetzt das durch engine/<version>/,
// damit nach einem Update nie eine alte .wasm aus dem Cache kommt.
const ENGINE_BASE = 'engine/';

// Relay (Wisp-Server). Standard: auf dem gleichen Server unter /wisp/.
// Der Zugangs-Token wird einmal mit ?token=... gesetzt und im Browser gespeichert.
function storage(key, value) {
  try {
    if (value !== undefined)
      localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return value ?? null;
  }
}
if (params.get('token'))
  storage('bl-relay-token', params.get('token'));
if (params.get('relay'))
  storage('bl-relay-url', params.get('relay'));

function relayURL() {
  const base = storage('bl-relay-url') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/wisp/`;
  const token = storage('bl-relay-token');
  return token ? base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : base;
}

let engine = null;
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
    $('boot').textContent = 'Fehler: Die Seite braucht die Header COOP/COEP (SharedArrayBuffer fehlt).';
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
      // Zum Testen: ?env=JSC_verifyGC=1,BL_DEBUG=1 setzt Umgebungsvariablen
      for (const pair of (params.get('env') || '').split(',')) {
        const at = pair.indexOf('=');
        if (at > 0)
          (module || engine).ENV[pair.slice(0, at)] = pair.slice(at + 1);
      }
    }],
  };
  engine = module;
  const mediaReady = initMedia(module);
  await window.createBrowserLiteEngine(module);
  await mediaReady;
}

// ------------------------------------------------------------ Speicher
// Cookies, localStorage und IndexedDB der Seiten liegen in der Engine unter
// /data. Das ist ein IDBFS: beim Start aus der IndexedDB des Browsers laden,
// danach alle paar Sekunden und beim Verlassen der Seite zurueckschreiben.

let storageReady = false;
let storageSyncing = false;
let storageSyncAgain = false;

function mountStorage(module) {
  module = module || engine;
  const fs = module.FS;
  const IDBFS = fs.filesystems?.IDBFS;
  if (!IDBFS || !window.indexedDB)
    return;
  fs.mkdirTree('/data');
  fs.mount(IDBFS, {}, '/data');
  module.addRunDependency('bl-storage');
  fs.syncfs(true, (error) => {
    if (error)
      console.warn('Gespeicherte Daten konnten nicht geladen werden:', error);
    storageReady = true;
    module.removeRunDependency('bl-storage');
  });
}

function saveStorage() {
  if (!storageReady)
    return;
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
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase('/data');
    request.onsuccess = request.onerror = request.onblocked = resolve;
  });
  location.reload();
}

// Zusaetzliche CA-Zertifikate (PEM), z.B. eine Firmen-CA oder fuer Tests.
// Die Engine haengt sie an das Mozilla-Bundle an (CurlSSLHandleWasm.cpp).
function installExtraCA(module) {
  const pem = window.__blExtraCA || storage('bl-extra-ca');
  if (!pem)
    return;
  const fs = (module || engine).FS;
  fs.mkdirTree('/etc/ssl/certs');
  fs.writeFile('/etc/ssl/certs/extra-ca.crt', pem);
}

// Bildschirm, Farbschema (prefers-color-scheme) und Touchscreen wie im Host
const darkScheme = matchMedia('(prefers-color-scheme: dark)');
function sendScreen() {
  const flags = (darkScheme.matches ? 1 : 0) | (navigator.maxTouchPoints > 0 ? 2 : 0);
  engine._bl_set_screen(screen.width, screen.height, screen.availWidth, screen.availHeight, flags);
}

function onEngineReady() {
  $('boot').hidden = true;
  sendScreen();
  darkScheme.addEventListener('change', sendScreen);
  initDevices({ engine: () => engine, toUTF8, tabs: () => tabs, activeTab: () => activeTab, activateTab: (tab) => activateTab(tab), focusPage: () => focusPage() });
  initCapture({ engine: () => engine, engineWorker: () => engine.blEngineWorker?.() });
  initLibrary({ openURL, activeTab: () => activeTab, tabs: () => tabs, downloadsList: () => downloadHistory, find: () => openFind(), print: () => printTab(activeTab) });
  // ?url= hat Vorrang, sonst die Tabs vom letzten Mal (wie Chrome "Weitermachen, wo ich aufgehoert habe")
  const session = params.get('url') ? null : sessionToRestore();
  if (session) {
    const restored = session.map((entry) => restoredTab(entry));
    activateTab(restored[Math.max(0, session.findIndex((entry) => entry.active))]);
  } else {
    newTab(START_URL);
  }
}

// Link/Lesezeichen oeffnen: im aktiven Tab oder in einem neuen
function openURL(url, inNewTab) {
  if (inNewTab || !activeTab) {
    newTab(url || settings().homePage || 'about:blank');
    if (!url)
      $('address').focus();
    return;
  }
  engine._bl_load_url(activeTab.id, toUTF8(url));
  focusPage();
}

function persistSession() {
  saveSession([...tabs.values()], activeTab);
}

const toUTF8 = (text) => engine.stringToNewUTF8(text ?? '');
initPickers({ engine: () => engine, toUTF8, focusPage: () => focusPage() });

// --------------------------------------------------------------------- Tabs

class Tab {
  // viewId gesetzt: die Engine hat den View schon geoeffnet (Popup).
  // lazy: erst laden, wenn der Tab angeklickt wird (wiederhergestellte Tabs)
  constructor(url, viewId = 0, lazy = null) {
    this.id = viewId || nextViewId++;
    this.title = lazy?.title || 'Neuer Tab';
    this.url = url;
    this.canGoBack = false;
    this.canGoForward = false;
    this.loading = false;
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
    if (lazy)
      this.pendingURL = url;
    else if (url)
      engine._bl_load_url(this.id, toUTF8(url));
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
  const tab = new Tab(url, viewId);
  tabs.set(tab.id, tab);
  activateTab(tab);
  return tab;
}

function openBackgroundTab(url) {
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
  engine._bl_load_html(tab.id, toUTF8(html), toUTF8('view-source:' + url));
}

// Wiederhergestellter Tab im Hintergrund: laedt erst beim ersten Anklicken
function restoredTab(entry) {
  const tab = new Tab(entry.url, 0, { title: entry.title });
  tabs.set(tab.id, tab);
  return tab;
}

function activateTab(tab) {
  if (activeTab === tab)
    return;
  if (activeTab) {
    activeTab.canvas.style.display = 'none';
    activeTab.element.classList.remove('active');
    engine._bl_focus(activeTab.id, 0);
  }
  activeTab = tab;
  clearHover();
  updateStar(tab.url);
  if (tab.pendingURL) {
    engine._bl_load_url(tab.id, toUTF8(tab.pendingURL));
    tab.pendingURL = null;
  }
  persistSession();
  tab.canvas.style.display = 'block';
  tab.element.classList.add('active');
  engine._bl_focus(tab.id, 1);
  focusPage();
  updateToolbar();
  tab.updateTitle();
}

function closeTab(tab) {
  onGeolocationStop(tab);
  onSensorStop(tab, { kind: 'orientation' });
  onSensorStop(tab, { kind: 'motion' });
  setTimeout(persistSession);
  engine._bl_destroy_view(tab.id);
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
  const tab = tabs.get(viewId);
  const data = payload ? JSON.parse(payload) : {};
  if (type === 'console') {
    const method = data.level >= 3 ? 'error' : data.level === 2 ? 'warn' : 'log';
    console[method](`[seite ${viewId}] ${data.message}`, data.source ? `(${data.source}:${data.line})` : '');
    return;
  }
  if (type === 'clipboard') {
    navigator.clipboard?.writeText(data.text).catch(() => {});
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
  case 'notification':
    onNotification(tab, data);
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
    if (data.url !== tab.url)
      recordVisit(data.url, '');
    tab.url = data.url;
    tab.canGoBack = data.canGoBack;
    tab.canGoForward = data.canGoForward;
    tab.loading = data.loading;
    if (tab === activeTab)
      updateStar(tab.url);
    persistSession();
    break;
  case 'title':
    tab.title = data.title;
    tab.updateTitle();
    recordVisit(tab.url, data.title);
    persistSession();
    break;
  case 'progress':
    if (tab === activeTab)
      setProgress(data.progress);
    break;
  case 'load':
    tab.loading = false;
    window.__blLoaded = true; // fuer die Tests (tests/e2e)
    if (tab === activeTab)
      setStatus('');
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

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.ceil(bytes / 1024) + ' kB';
}

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
  add('Neu laden', () => engine._bl_reload(tab.id));
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

let uploadCounter = 0;

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
  input.addEventListener('change', async () => {
    const paths = [];
    for (const file of input.files) {
      const dir = '/tmp/uploads/' + (++uploadCounter);
      engine.FS.mkdirTree(dir);
      const path = dir + '/' + file.name.replace(/[\/\n]/g, '_');
      engine.FS.writeFile(path, new Uint8Array(await file.arrayBuffer()));
      paths.push(path);
    }
    answer(paths);
  });
  input.addEventListener('cancel', () => answer([]));
  input.click();
}

// alert/confirm/prompt der Seite
function engineDialog(type, message, defaultValue) {
  if (type === 0) {
    alert(message);
    return 0;
  }
  if (type === 1)
    return confirm(message) ? 1 : 0;
  const answer = prompt(message, defaultValue);
  return answer === null ? 0 : engine.stringToNewUTF8(answer);
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
  canvas.addEventListener('pointerdown', (e) => {
    focusPage();
    canvas.setPointerCapture(e.pointerId);
    engine._bl_mouse(tab.id, 0, e.button, ...position(e), Math.max(1, e.detail), modifierBits(e));
    e.preventDefault();
  });
  canvas.addEventListener('pointerup', (e) => {
    engine._bl_mouse(tab.id, 1, e.button, ...position(e), Math.max(1, e.detail), modifierBits(e));
  });
  canvas.addEventListener('pointermove', (e) => {
    // Gedrueckte Taste mitgeben (e.buttons: 1 links, 2 rechts, 4 Mitte), sonst kein Ziehen
    const button = e.buttons & 1 ? 0 : e.buttons & 4 ? 1 : e.buttons & 2 ? 2 : -1;
    engine._bl_mouse_move(tab.id, ...position(e), e.movementX || 0, e.movementY || 0, button, modifierBits(e));
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    engine._bl_context_menu(tab.id, ...position(e));
  });
  canvas.addEventListener('wheel', (e) => {
    // Strg + Mausrad (und Zwei-Finger-Zoom auf dem Touchpad): Zoom wie in Chrome
    if (e.ctrlKey && !e.altKey && e.deltaY) {
      changeZoom(tab, e.deltaY < 0 ? 1 : -1);
      e.preventDefault();
      return;
    }
    let factor = 1;
    if (e.deltaMode === 1) factor = 40;       // Zeilen
    else if (e.deltaMode === 2) factor = 800; // Seiten
    engine._bl_wheel(tab.id, ...position(e), e.deltaX * factor, e.deltaY * factor, modifierBits(e));
    e.preventDefault();
  }, { passive: false });
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
ime.addEventListener('compositionend', (e) => {
  composing = false;
  if (activeTab && e.data)
    engine._bl_insert_text(activeTab.id, toUTF8(e.data));
  ime.value = '';
});
ime.addEventListener('input', (e) => {
  if (composing || e.isComposing)
    return;
  if (activeTab && e.data && (e.inputType === 'insertText' || e.inputType === 'insertReplacementText'))
    engine._bl_insert_text(activeTab.id, toUTF8(e.data));
  ime.value = '';
});
ime.addEventListener('paste', (e) => {
  if (!activeTab)
    return;
  const text = e.clipboardData?.getData('text/plain') ?? '';
  engine._bl_set_clipboard_text(toUTF8(text));
  const fake = { key: 'v', code: 'KeyV', keyCode: 86, repeat: false, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };
  sendKey(activeTab, 0, fake);
  sendKey(activeTab, 1, fake);
  e.preventDefault();
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
  engine._bl_load_url(activeTab.id, toUTF8(url));
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
    engine._bl_reload(activeTab.id);
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

new ResizeObserver(() => {
  if (!engine || !engine._bl_resize)
    return;
  const { width, height } = viewportSize();
  for (const tab of tabs.values())
    engine._bl_resize(tab.id, width, height, devicePixelRatio);
}).observe($('viewport'));

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
  if (activeTab)
    engine._bl_find(activeTab.id, toUTF8(findInput.value), backwards ? 1 : 0, again ? 1 : 0);
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
    case 'r': if (tab) engine._bl_reload(tab.id); return true;
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
    case 'F5': if (tab) engine._bl_reload(tab.id); return true;
    case 'F6': $('address').focus(); $('address').select(); return true;
    case 'F3': if (findBar.hidden) openFind(); else runFind(e.shiftKey, true); return true;
    }
  }
  return false;
}

let swallowKeyUp = null;
window.addEventListener('keydown', (e) => {
  if (!engine || e.isComposing)
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
  $('boot').textContent = 'Fehler beim Starten: ' + error.message;
  console.error(error);
});
