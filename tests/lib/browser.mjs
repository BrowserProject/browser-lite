// The browser of the tests, from Playwright: BL_BROWSER=chromium (default) or firefox.
// CHROMIUM_PATH or FIREFOX_PATH start another executable. Firefox runs headed when DISPLAY is set
// (`xvfb-run -a`): headless Firefox has no WebGL, headed under Xvfb it has WebGL 2 (llvmpipe).
import { chromium, firefox } from 'playwright';
import { tempDir } from './processes.mjs';

/** Name of the browser under test. */
export const BROWSER = process.env.BL_BROWSER || 'chromium';
if (BROWSER !== 'chromium' && BROWSER !== 'firefox')
  throw new Error(`BL_BROWSER=${BROWSER}: chromium or firefox`);
const FIREFOX = BROWSER === 'firefox';

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
// Permissions Playwright grants in Firefox; the others come from the preferences above
const FIREFOX_PERMISSIONS = new Set(['geolocation', 'notifications', 'persistent-storage', 'push']);

/** Launch options of the browser under test; args are Chromium switches. */
function launchOptions(args, options) {
  if (!FIREFOX) return { executablePath: process.env.CHROMIUM_PATH || undefined, args, ...options };
  return {
    executablePath: process.env.FIREFOX_PATH || undefined,
    headless: !process.env.DISPLAY,
    firefoxUserPrefs: Object.assign({}, FIREFOX_BASE_PREFS, ...args.map((a) => FIREFOX_PREFS[a])),
    ...options,
  };
}

/** The browser with an incognito-like default context; args are Chromium switches. */
export function launch({ args = [], ...options } = {}) {
  return (FIREFOX ? firefox : chromium).launch(launchOptions(args, options));
}

/**
 * The browser with its own profile on disk, like a normal browser. In a context of newContext()
 * the OPFS lives in memory, and Chromium refuses writes when the machine has little free memory.
 * `dir` starts again with the profile of an earlier launch (closed before).
 */
export function launchProfile({ args = [], dir = tempDir('profile'), ...options } = {}) {
  return (FIREFOX ? firefox : chromium).launchPersistentContext(dir, launchOptions(args, options));
}

/** The permissions of list the browser under test can grant (newContext, grantPermissions). */
export const permissions = (list) =>
  FIREFOX ? list.filter((name) => FIREFOX_PERMISSIONS.has(name)) : list;

/**
 * True in Chromium. Elsewhere prints that the check name is skipped and returns false: for checks
 * that need a Chromium-only API (CDP sessions, V8 tracing).
 */
export function chromiumOnly(name) {
  if (!FIREFOX) return true;
  console.log(`skip ${name} (skipped in ${BROWSER})`);
  return false;
}

/**
 * For a context with hasTouch: Playwright's touch emulation in Firefox reports no touch points
 * (navigator.maxTouchPoints, which the core reads), so pages there report five like Chromium.
 */
export async function emulateTouchPoints(context) {
  if (FIREFOX)
    await context.addInitScript(() =>
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 }),
    );
}
