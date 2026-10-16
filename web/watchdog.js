// Absturz und Haengen der Engine. Eine Engine fuehrt alle Tabs: bricht sie ab
// (abort, kein Speicher mehr, WASM-Trap) oder steckt ihr Thread fest (z.B. eine
// Endlosschleife in einer Seite), steht alles. Dann kommt eine Meldung ueber
// den Seitenbereich mit "Neu starten", die Sitzung (library.js) bringt die
// Tabs zurueck. Ein Skript, das zu lange laeuft, bricht die Engine selber ab
// (Watchdog in engine/src/EngineLoop.cpp), dann geht die Meldung wieder weg.

import { storage } from './util.js';

const HANG_TIMEOUT = 10000;
// Stuerzt sie so kurz nach dem letzten Absturz wieder ab, laden die Tabs nach
// dem Neustart erst beim Anklicken (sonst gleich wieder dieselbe Seite)
const REPEAT_WINDOW = 60000;
const CRASH_KEY = 'bl-crash-time';
const SAFE_START_KEY = 'bl-safe-start';

let onFailed = null;
let failed = false;
let waitingSince = 0;
let hangShown = false;

// Meldung ueber dem Seitenbereich, auch fuer das Laden und Fehler beim Start.
// actions: [[Beschriftung, Funktion], ...]
export function showEngineMessage(text, details = [], actions = []) {
  const box = document.getElementById('boot');
  const title = document.createElement('p');
  title.textContent = text;
  box.replaceChildren(title);
  for (const line of details) {
    const detail = document.createElement('p');
    detail.className = 'detail';
    detail.textContent = line;
    box.append(detail);
  }
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'actions';
    for (const [label, action] of actions) {
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('click', action);
      row.append(button);
    }
    row.lastChild.className = 'primary';
    box.append(row);
  }
  box.hidden = false;
}

function hideEngineMessage() {
  document.getElementById('boot').hidden = true;
}

export function engineFailed() {
  return failed;
}

// Vor dem Start der Engine. failed() ruft die Oberflaeche nach einem Absturz.
export function watchEngine(module, failedCallback) {
  onFailed = failedCallback;
  // Emscripten leitet onAbort aus den Threads der Engine hierher weiter
  module.onAbort = (what) => engineCrashed(String(what));
  setInterval(checkHang, 1000);
}

// Vor jedem Aufruf, auf den sich die Engine sicher meldet (progress,
// navigation, find). Kommt danach lange gar nichts mehr, haengt ihr Thread.
export function expectAnswer() {
  if (!waitingSince)
    waitingSince = Date.now();
}

// Jede Meldung der Engine an die Oberflaeche
export function engineAnswered() {
  waitingSince = 0;
  if (hangShown) {
    hangShown = false;
    if (!failed)
      hideEngineMessage();
  }
}

// Einmal nach einem Neustart: die Tabs nur im Hintergrund wiederherstellen
export function takeSafeStart() {
  const safe = !!storage(SAFE_START_KEY, undefined, true);
  storage(SAFE_START_KEY, null, true);
  return safe;
}

function restart(safe) {
  if (safe)
    storage(SAFE_START_KEY, '1', true);
  // Ohne ?url=, sonst oeffnet der Start diese Adresse statt der Sitzung
  const url = new URL(location.href);
  url.searchParams.delete('url');
  url.hash = '';
  location.replace(url);
}

function checkHang() {
  if (failed || hangShown || !waitingSince || Date.now() - waitingSince < HANG_TIMEOUT)
    return;
  hangShown = true;
  showEngineMessage('Die Seite reagiert nicht.', ['Ein Skript blockiert die Engine und damit alle Tabs. Läuft es zu lange, bricht die Engine es ab.'], [
    ['Warten', () => {
      hangShown = false;
      waitingSince = Date.now();
      hideEngineMessage();
    }],
    ['Neu starten', () => restart(true)],
  ]);
}

function engineCrashed(reason) {
  if (failed)
    return;
  failed = true;
  console.error('Engine abgestuerzt:', reason);
  const now = Date.now();
  const repeated = now - (Number(storage(CRASH_KEY, undefined, true)) || 0) < REPEAT_WINDOW;
  storage(CRASH_KEY, String(now), true);
  onFailed?.();
  showEngineMessage('Die Engine ist abgestürzt.', [
    repeated ? 'Schon wieder kurz nach dem letzten Absturz: nach dem Neustart laden die Tabs erst beim Anklicken.' : 'Nach dem Neustart sind alle Tabs wieder da.',
    reason,
  ], [['Neu starten', () => restart(repeated)]]);
}

// Ein Trap im WASM, oder ein Fehler aus einem Thread der Engine: Emscripten
// wirft das ErrorEvent des Workers im Haupt-Thread weiter
function isEngineError(error) {
  return error instanceof WebAssembly.RuntimeError || error instanceof ErrorEvent;
}

window.addEventListener('error', (event) => {
  if (onFailed && isEngineError(event.error))
    engineCrashed(event.error.message || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  if (onFailed && isEngineError(event.reason))
    engineCrashed(event.reason.message);
});
