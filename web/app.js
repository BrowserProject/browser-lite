// browser-lite Oberflaeche: Tabs, Adressleiste und die Verbindung zur Engine.
//
// Die Engine (engine/engine.js + engine.wasm) laeuft in einem eigenen Worker.
// Wir rufen ihre C-Funktionen (_bl_...) auf, sie meldet sich ueber die
// Callbacks onEngine... zurueck (siehe engine/src/Host.cpp).

import { WispTransport, installTransportSocket, setTransport } from './transport.js';
import { audioState, onEngineAudio } from './audio.js';
import { initMedia, mediaState, onEngineMedia, onEngineMediaFetch } from './media.js';

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
  setTransport(new WispTransport(relayURL()));
  installTransportSocket();
  await loadScript(ENGINE_BASE + 'engine.js');
  const module = {
    locateFile: (path) => ENGINE_BASE + path,
    print: (text) => console.log('[engine]', text),
    printErr: (text) => console.warn('[engine]', text),
    onEngineReady,
    onEngineEvent,
    onEngineFrame,
    onEngineNeedsFrame,
    onEngineDownloadData,
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
      // GC an sicheren Punkten in JS: ?safepointgc=0 aus, =debug mit Ausgabe
      if (params.get('safepointgc'))
        (module || engine).ENV.BL_SAFEPOINT_GC = params.get('safepointgc');
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

function onEngineReady() {
  $('boot').hidden = true;
  engine._bl_set_screen(screen.width, screen.height, screen.availWidth, screen.availHeight);
  newTab(START_URL);
}

const toUTF8 = (text) => engine.stringToNewUTF8(text ?? '');

// --------------------------------------------------------------------- Tabs

class Tab {
  // viewId gesetzt: die Engine hat den View schon geoeffnet (Popup)
  constructor(url, viewId = 0) {
    this.id = viewId || nextViewId++;
    this.title = 'Neuer Tab';
    this.url = url;
    this.canGoBack = false;
    this.canGoForward = false;
    this.loading = false;
    this.frameRequested = false;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'page';
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;outline:none;display:none';
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    $('viewport').appendChild(this.canvas);
    attachInput(this);

    this.element = document.createElement('div');
    this.element.className = 'tab';
    this.element.innerHTML = '<img class="icon" alt="" hidden><span class="title"></span><button class="close" title="Tab schliessen">&#215;</button>';
    this.iconURL = null;
    this.element.addEventListener('mousedown', (e) => {
      if (!e.target.classList.contains('close'))
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
    if (url)
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

function activateTab(tab) {
  if (activeTab === tab)
    return;
  if (activeTab) {
    activeTab.canvas.style.display = 'none';
    activeTab.element.classList.remove('active');
    engine._bl_focus(activeTab.id, 0);
  }
  activeTab = tab;
  tab.canvas.style.display = 'block';
  tab.element.classList.add('active');
  engine._bl_focus(tab.id, 1);
  focusPage();
  updateToolbar();
  tab.updateTitle();
}

function closeTab(tab) {
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
  if (document.activeElement !== $('address'))
  $('address').value = tab.url === 'about:blank' ? '' : tab.url;
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
  if (type === 'download-start' || type === 'download-done') {
    onDownloadEvent(type, data);
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
  if (type === 'fullscreen') {
    setFullscreen(tab, data.on);
    return;
  }
  switch (type) {
  case 'navigation':
    tab.url = data.url;
    tab.canGoBack = data.canGoBack;
    tab.canGoForward = data.canGoForward;
    tab.loading = data.loading;
    break;
  case 'title':
    tab.title = data.title;
    tab.updateTitle();
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
  if (tab) {
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

function onDownloadEvent(type, data) {
  if (type === 'download-start') {
    downloads.set(data.id, { filename: data.filename, mime: data.mime, chunks: [], received: 0, size: data.size });
    setStatus('Download: ' + data.filename);
    return;
  }
  const download = downloads.get(data.id);
  downloads.delete(data.id);
  if (!download)
    return;
  if (data.error) {
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
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  setStatus('Download fertig: ' + download.filename + ' (' + formatSize(blob.size) + ')');
}

function onEngineDownloadData(id, bytes) {
  const download = downloads.get(id);
  if (!download)
    return;
  download.chunks.push(bytes);
  download.received += bytes.length;
  const total = download.size > 0 ? ' von ' + formatSize(download.size) : '';
  setStatus('Download: ' + download.filename + ' ' + formatSize(download.received) + total);
}

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
    engine._bl_mouse(tab.id, 2, -1, ...position(e), 0, modifierBits(e));
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    engine._bl_context_menu(tab.id, ...position(e));
  });
  canvas.addEventListener('wheel', (e) => {
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
  let url = $('address').value.trim();
  if (!url)
    return;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    // Ohne Punkt und ohne Schema ist es wohl eine Suche
    url = /^[^\s]+\.[^\s]+$/.test(url) ? 'https://' + url : 'https://duckduckgo.com/html/?q=' + encodeURIComponent(url);
  }
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
$('new-tab').addEventListener('click', () => {
  newTab('about:blank');
  $('address').focus();
});

new ResizeObserver(() => {
  if (!engine || !engine._bl_resize)
    return;
  const { width, height } = viewportSize();
  for (const tab of tabs.values())
    engine._bl_resize(tab.id, width, height, devicePixelRatio);
}).observe($('viewport'));

$('screen').remove(); // Platzhalter, jeder Tab hat sein eigenes Canvas
startEngine().catch((error) => {
  $('boot').textContent = 'Fehler beim Starten: ' + error.message;
  console.error(error);
});
