// Kleine Helfer fuer mehrere Module der Oberflaeche.

// localStorage, mit session sessionStorage. value null loescht. Ist der
// Speicher gesperrt (privater Modus, Einstellungen), merkt sich nichts.
export function storage(key, value, session = false) {
  try {
    const area = session ? sessionStorage : localStorage;
    if (value === null)
      area.removeItem(key);
    else if (value !== undefined)
      area.setItem(key, value);
    return area.getItem(key);
  } catch {
    return value ?? null;
  }
}

// Zugangs-Token fuer den Server unter host (?token=..., app.js): Relay und Profil
export const tokenKey = (host) => 'bl-relay-token ' + host;

// Absichtliches Neuladen der Oberflaeche (Neustart, Daten loeschen): dann
// fragt der Host nicht nach beforeunload der Seiten (app.js)
let reloading = false;
export const uiReloading = () => reloading;
export function reloadUI(url) {
  reloading = true;
  if (url)
    location.replace(url);
  else
    location.reload();
}

// Neustart mit der Sitzung, auch ohne "Tabs beim Start wiederherstellen" (takeRestart). Ohne
// ?url=, sonst oeffnet der Start diese Adresse statt der Sitzung.
const RESTART_KEY = 'bl-restart';
export function restartUI() {
  storage(RESTART_KEY, '1', true);
  const url = new URL(location.href);
  url.searchParams.delete('url');
  url.hash = '';
  reloadUI(url);
}

// Einmal nach restartUI wahr
export function takeRestart() {
  const restart = !!storage(RESTART_KEY, undefined, true);
  storage(RESTART_KEY, null, true);
  return restart;
}

// Fehler mit DOMException-Namen fuer die Polyfills der Seite (Host-Bruecke)
export function domError(name, message) {
  return Object.assign(new Error(message), { name });
}

export function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === 'function')
    return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(text) {
  if (typeof Uint8Array.fromBase64 === 'function')
    return Uint8Array.fromBase64(text);
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export function formatSize(bytes) {
  if (bytes == null)
    return '?';
  if (bytes < 1024)
    return bytes + ' B';
  if (bytes < 1024 * 1024)
    return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

export function formatTime(time) {
  return new Date(time).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' });
}

// Element mit Eigenschaften (textContent, className, ...) und Kindern
export function element(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}
