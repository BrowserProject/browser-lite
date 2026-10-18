import { storage } from './util.js';

const RESTART_KEY = 'bl-restart';
let reloading = false;

/** True while the demo reloads itself on purpose (no beforeunload question of the host). */
export const uiReloading = (): boolean => reloading;

/** Reloads the demo on purpose (restart, site data deleted). */
export function reloadUI(url?: URL): void {
  reloading = true;
  if (url) location.replace(url);
  else location.reload();
}

/** The address of the demo without `?url=`, so a start restores the session instead. */
export function addressWithoutUrl(): URL {
  const url = new URL(location.href);
  url.searchParams.delete('url');
  url.hash = '';
  return url;
}

/** Marks the next start as a restart: it keeps the session (and its cookies) in any case. */
export function markRestart(): void {
  storage(RESTART_KEY, '1', true);
}

/** Restart with the session, also without "Restore tabs at start". */
export function restartUI(): void {
  markRestart();
  reloadUI(addressWithoutUrl());
}

/** True once after markRestart. */
export function takeRestart(): boolean {
  const restart = !!storage(RESTART_KEY, undefined, true);
  storage(RESTART_KEY, null, true);
  return restart;
}
