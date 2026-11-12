import { storage } from './util.js';

const RESTART_KEY = 'bl-restart';
const RUNNING_KEY = 'bl-running';
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

/**
 * Marks the demo of this tab as running until its page is hidden. True when the last page of the
 * tab ended without being hidden: the host browser ended it, as iOS does with a page that uses
 * too much memory before Safari loads it again.
 */
export function watchUnexpectedEnd(): boolean {
  const ended = !!storage(RUNNING_KEY, undefined, true);
  storage(RUNNING_KEY, '1', true);
  addEventListener('pagehide', () => storage(RUNNING_KEY, null, true));
  addEventListener('pageshow', (event) => {
    if (event.persisted) storage(RUNNING_KEY, '1', true);
  });
  return ended;
}
