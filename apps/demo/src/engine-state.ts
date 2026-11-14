import { showStartNote } from './engine-message.js';
import { runtime } from './runtime.js';
import { isNewTabPage } from './util.js';

/**
 * What the tabs do while no engine runs: while it starts, and after a crash until the restart.
 * Like Chrome on a crashed tab, Reload, a new tab and an address still act: after a crash they
 * start the engine again (like the Restart of the message) and the start carries them out.
 */

/** The page asked for while no engine ran, empty without; the start opens it in front. */
let pending = '';
/** After a crash: what the Restart of the message does, null otherwise. */
let crashRestart: (() => void) | null = null;

/** True while the engine runs and takes the actions of the tabs. */
export function engineRunning(): boolean {
  return runtime.browser?.state === 'ready';
}

/** The engine crashed and `restart` starts it again; null once the restart begins. */
export function setCrashRestart(restart: (() => void) | null): void {
  crashRestart = restart;
}

/** After a crash: starts the engine again like the Restart of the message. */
export function restartAfterCrash(): void {
  const restart = crashRestart;
  crashRestart = null;
  restart?.();
}

/**
 * Opens url (also the new tab page) in a new tab in front once the engine runs, in front of the
 * restored session; after a crash it starts the engine again. The last request wins.
 */
export function openOnStart(url: string): void {
  pending = url;
  showStartNote(
    isNewTabPage(url)
      ? 'A new tab opens as soon as the engine runs.'
      : `${url} opens as soon as the engine runs.`,
  );
  restartAfterCrash();
}

/** The page asked for while no engine ran (empty without), once. */
export function takeOpenOnStart(): string {
  const url = pending;
  pending = '';
  showStartNote('');
  return url;
}
