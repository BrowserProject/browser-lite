// Absturz und Haengen der Engine. Eine Engine fuehrt alle Tabs: bricht sie ab
// (abort, kein Speicher mehr, WASM-Trap) oder steckt ihr Thread fest (z.B. eine
// Endlosschleife in einer Seite), steht alles. Dann kommt eine Meldung ueber
// den Seitenbereich mit "Neu starten", die Sitzung (library.js) bringt die
// Tabs zurueck. Ein Skript, das zu lange laeuft, bricht die Engine selber ab
// (Watchdog in engine/src/EngineLoop.cpp), dann geht die Meldung wieder weg.

import { restartUI, storage } from './util.js';

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
let engineModule = null;
// Eingaben: zuletzt geschickte Marke, seit wann eine unbeantwortet ist
let inputMark = 0;
let inputSince = 0;
let inputMarkAddress = 0;

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
  engineModule = module;
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

// Marke, die der Engine-Thread nach der letzten bearbeiteten Eingabe ablegt
// (bl_input_mark, engine/src/EngineLoop.cpp), direkt aus ihrem Speicher
function handledInputMark() {
  if (!inputMarkAddress)
    inputMarkAddress = engineModule._bl_input_mark_address();
  const heap = engineModule.HEAPU8;
  const at = inputMarkAddress;
  return (heap[at] | heap[at + 1] << 8 | heap[at + 2] << 16 | heap[at + 3] << 24) >>> 0;
}

// Nach jeder Eingabe an eine Seite (Maus, Tasten), die keine Antwort bekommt
export function inputSent() {
  if (!inputSince)
    inputSince = Date.now();
  inputMark = (inputMark + 1) >>> 0;
  engineModule._bl_input_mark(inputMark);
}

// Jede Meldung der Engine an die Oberflaeche
export function engineAnswered() {
  waitingSince = 0;
  if (hangShown && !inputSince) {
    hangShown = false;
    if (!failed)
      hideEngineMessage();
  }
}

// Nach "Warten" und nach einem Dialog der Seite: alert/confirm/prompt halten
// den Haupt-Thread der Oberflaeche an, die Zeit bis zur Antwort zaehlt nicht
export function restartWait() {
  waitingSince = waitingSince && Date.now();
  inputSince = inputSince && Date.now();
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
  restartUI();
}

function checkHang() {
  if (inputSince && handledInputMark() === inputMark) {
    inputSince = 0;
    if (!waitingSince)
      engineAnswered();
  }
  const since = Math.min(waitingSince || Infinity, inputSince || Infinity);
  if (failed || hangShown || since === Infinity || Date.now() - since < HANG_TIMEOUT)
    return;
  hangShown = true;
  showEngineMessage('Die Seite reagiert nicht.', ['Ein Skript blockiert die Engine und damit alle Tabs. Läuft es zu lange, bricht die Engine es ab.'], [
    ['Warten', () => {
      hangShown = false;
      restartWait();
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
