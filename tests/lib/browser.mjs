// The browser of the tests, from Playwright: BL_BROWSER=chromium (default), firefox or webkit
// (the engine of Safari; on Linux it needs the libraries of Playwright's Docker image).
// CHROMIUM_PATH, FIREFOX_PATH or WEBKIT_PATH start another executable. Firefox runs headed when
// DISPLAY is set (`xvfb-run -a`): headless Firefox has no WebGL, headed under Xvfb it has WebGL 2
// (llvmpipe).
import { chromium, firefox, webkit } from 'playwright';
import { tempDir } from './processes.mjs';

/** Name of the browser under test. */
export const BROWSER = process.env.BL_BROWSER || 'chromium';
const BROWSERS = { chromium, firefox, webkit };
if (!BROWSERS[BROWSER]) throw new Error(`BL_BROWSER=${BROWSER}: chromium, firefox or webkit`);

/** Headless Chromium has no WebGL without these flags (ignored in Firefox). */
export const SWIFTSHADER = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

// Firefox preferences that stand in for the Chromium switches of the tests; other switches are
// dropped. Firefox has no clipboard permission, the testing pref lets pages read without a prompt.
// Sound starts without a gesture, like in headless Chromium.
const FIREFOX_BASE_PREFS = {
  'dom.events.testing.asyncClipboard': true,
  'media.autoplay.default': 0,
  'media.autoplay.blocking_policy': 0,
};
const FIREFOX_PREFS = {
  '--use-fake-device-for-media-stream': { 'media.navigator.streams.fake': true },
  '--use-fake-ui-for-media-stream': { 'media.navigator.permission.disabled': true },
  '--autoplay-policy=no-user-gesture-required': {
    'media.autoplay.default': 0,
    'media.autoplay.blocking_policy': 0,
  },
};
// Permissions Playwright grants in Firefox (the others come from the preferences above) and WebKit
const GRANTABLE = {
  firefox: new Set(['geolocation', 'notifications', 'persistent-storage', 'push']),
  webkit: new Set(['geolocation']),
};

/** Launch options of the browser under test; args are Chromium switches. */
function launchOptions(args, options) {
  if (BROWSER === 'chromium')
    return { executablePath: process.env.CHROMIUM_PATH || undefined, args, ...options };
  if (BROWSER === 'webkit')
    return { executablePath: process.env.WEBKIT_PATH || undefined, ...options };
  return {
    executablePath: process.env.FIREFOX_PATH || undefined,
    headless: !process.env.DISPLAY,
    firefoxUserPrefs: Object.assign({}, FIREFOX_BASE_PREFS, ...args.map((a) => FIREFOX_PREFS[a])),
    ...options,
  };
}

/** The browser with an incognito-like default context; args are Chromium switches. */
export function launch({ args = [], ...options } = {}) {
  return BROWSERS[BROWSER].launch(launchOptions(args, options));
}

/**
 * The browser with its own profile on disk, like a normal browser. In a context of newContext()
 * the OPFS lives in memory, and Chromium refuses writes when the machine has little free memory.
 * `dir` starts again with the profile of an earlier launch (closed before).
 */
export function launchProfile({ args = [], dir = tempDir('profile'), ...options } = {}) {
  return BROWSERS[BROWSER].launchPersistentContext(dir, launchOptions(args, options));
}

/** The permissions of list the browser under test can grant (newContext, grantPermissions). */
export const permissions = (list) =>
  GRANTABLE[BROWSER] ? list.filter((name) => GRANTABLE[BROWSER].has(name)) : list;

/**
 * True in Chromium. Elsewhere prints that the check name is skipped and returns false: for checks
 * that need a Chromium-only API (CDP sessions, V8 tracing).
 */
export function chromiumOnly(name) {
  if (BROWSER === 'chromium') return true;
  console.log(`skip ${name} (skipped in ${BROWSER})`);
  return false;
}

/**
 * For a context with hasTouch: Playwright's touch emulation in Firefox and WebKit reports no touch
 * points (navigator.maxTouchPoints, which the core reads), so pages there report five like Chromium.
 */
export async function emulateTouchPoints(context) {
  if (BROWSER !== 'chromium')
    await context.addInitScript(() =>
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 }),
    );
}
