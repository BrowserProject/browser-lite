// Chromium of Playwright for the tests (CHROMIUM_PATH: another Chromium).
import { chromium } from 'playwright';
import { tempDir } from './processes.mjs';

/** Headless Chromium has no WebGL without these flags. */
export const SWIFTSHADER = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

/** A Chromium with an incognito-like default context. */
export function launch({ args = [], ...options } = {}) {
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args,
    ...options,
  });
}

/**
 * Chromium with its own profile on disk, like a normal browser. In a context of newContext() the
 * OPFS lives in memory, and Chromium refuses writes when the machine has little free memory.
 * `dir` starts again with the profile of an earlier launch (closed before).
 */
export function launchProfile({ args = [], dir = tempDir('chromium-profile'), ...options } = {}) {
  return chromium.launchPersistentContext(dir, {
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args,
    ...options,
  });
}
