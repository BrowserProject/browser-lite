// browser-lite Oberflaeche: Tabs, Adressleiste und die Verbindung zur Engine.
//
// Die Engine (engine/engine.js + engine.wasm) laeuft in einem eigenen Worker.
// Wir rufen ihre C-Funktionen (_bl_...) auf, sie meldet sich ueber die
// Callbacks onEngine... zurueck (siehe engine/src/Host.cpp).

import { WispTransport, installTransportSocket, setTransport } from './transport.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const START_URL = params.get('url') || 'https://example.com/';

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
  await loadScript('engine/engine.js');
  const module = {
    locateFile: (path) => 'engine/' + path,
    print: (text) => console.log('[engine]', text),
    printErr: (text) => console.warn('[engine]', text),
    onEngineReady,
    onEngineEvent,
    onEngineFrame,
    onEngineNeedsFrame,
    engineDialog,
    preRun: [installExtraCA],
  };
  engine = module;
  await window.createBrowserLiteEngine(module);
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
  constructor(url) {
    this.id = nextViewId++;
    this.title = 'Neuer Tab';
    this.url = url;
    this.canGoBack = false;
    this.canGoForward = false;
    this.loading = false;
    this.frameRequested = false;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'page';
    this.canvas.tabIndex = 0;
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;outline:none;display:none';
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    $('viewport').appendChild(this.canvas);
    attachInput(this);

    this.element = document.createElement('div');
    this.element.className = 'tab';
    this.element.innerHTML = '<span class="title"></span><button class="close" title="Tab schliessen">&#215;</button>';
    this.element.addEventListener('mousedown', (e) => {
      if (!e.target.classList.contains('close'))
        activateTab(this);
    });
    this.element.querySelector('.close').addEventListener('click', () => closeTab(this));
    $('tab-list').appendChild(this.element);
    this.updateTitle();

    const { width, height } = viewportSize();
    engine._bl_create_view(this.id, width, height, devicePixelRatio);
    if (url)
      engine._bl_load_url(this.id, toUTF8(url));
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

function newTab(url) {
  const tab = new Tab(url);
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
  tab.canvas.focus();
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
  if (!tab)
    return;
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
    canvas.focus();
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
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    let factor = 1;
    if (e.deltaMode === 1) factor = 40;       // Zeilen
    else if (e.deltaMode === 2) factor = 800; // Seiten
    engine._bl_wheel(tab.id, ...position(e), e.deltaX * factor, e.deltaY * factor, modifierBits(e));
    e.preventDefault();
  }, { passive: false });

  const isPasteShortcut = (e) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v';
  canvas.addEventListener('keydown', (e) => {
    // Einfuegen: erst das paste-Event abwarten, dort kennen wir den Inhalt
    if (isPasteShortcut(e))
      return;
    sendKey(tab, 0, e);
    // Browser-Kurzbefehle wie Tab, Backspace, Leertaste nicht an die UI weitergeben
    if (!(e.key === 'F5' || e.key === 'F12'))
      e.preventDefault();
  });
  canvas.addEventListener('keyup', (e) => {
    if (isPasteShortcut(e))
      return;
    sendKey(tab, 1, e);
    e.preventDefault();
  });
  canvas.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    engine._bl_set_clipboard_text(toUTF8(text));
    const fake = { key: 'v', code: 'KeyV', keyCode: 86, repeat: false, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };
    sendKey(tab, 0, fake);
    sendKey(tab, 1, fake);
    e.preventDefault();
  });
}

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
  activeTab.canvas.focus();
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
