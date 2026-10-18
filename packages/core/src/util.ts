/** Error with a DOMException name for the polyfills of the page (host calls). */
export function domError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as { fromBase64?: (text: string) => Uint8Array<ArrayBuffer> })
    .fromBase64;
  if (typeof native === 'function') return native(text);
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** NaN for null and undefined (the engine takes NaN as "not available"). */
export const orNaN = (value: number | null | undefined): number => value ?? Number.NaN;

/** Languages of the host browser without suffixes like "@posix" the engine does not know. */
export function hostLanguages(): string[] {
  const list = navigator.languages?.length ? navigator.languages : [navigator.language];
  return list.map((language) => language.split('@')[0] ?? language).filter(Boolean);
}

export const hostTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
