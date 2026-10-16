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
