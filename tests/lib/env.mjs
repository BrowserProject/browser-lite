// Paths and settings shared by the browser suites.
//
// Environment: E2E_TIMEOUT (ms per wait, default 180000), E2E_VERBOSE=1 (console of the pages and
// the servers), BL_ENGINE_DIR (engine folder when no argument is given); the browser: browser.mjs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root. */
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Engine folder (engine.js, engine.wasm, engine.data): first argument, BL_ENGINE_DIR or the build. */
export const engineDir = path.resolve(
  process.argv[2] &&
    !process.argv[2].startsWith('-') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(process.argv[2])
    ? process.argv[2]
    : process.env.BL_ENGINE_DIR || path.join(root, 'build', 'webcore', 'bin'),
);
export const TIMEOUT = Number(process.env.E2E_TIMEOUT || 180000);
export const VERBOSE = !!process.env.E2E_VERBOSE;
/** Output folder for screenshots and temporary test files. */
export const buildDir = path.join(root, 'build');
