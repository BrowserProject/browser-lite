// The pages the browser suites open: the core test host page (tests/core/host) or the demo
// (apps/demo), each as a folder for SITE_DIR of browser-lite-server.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './env.mjs';
import { tempDir } from './processes.mjs';

/**
 * Folder for the test host page of @browser-lite/core: the page at the root, the service worker
 * of the core next to it (its scope covers the page), the built packages under /packages/ (import
 * map of the page) and the engine under /engine/. Only links, so it costs nothing.
 */
export function coreSite(engine) {
  const dir = tempDir('core-site');
  const links = {
    'index.html': path.join(root, 'tests', 'core', 'host', 'index.html'),
    'host.js': path.join(root, 'tests', 'core', 'host', 'host.js'),
    'sw.js': path.join(root, 'packages', 'core', 'dist', 'sw', 'sw.js'),
    'media-sw.js': path.join(root, 'packages', 'core', 'dist', 'sw', 'media-sw.js'),
    packages: path.join(root, 'packages'),
    engine,
  };
  for (const [name, target] of Object.entries(links)) {
    if (!fs.existsSync(target)) throw new Error(`${target} missing (npm run build, engine build)`);
    fs.symlinkSync(target, path.join(dir, name));
  }
  return dir;
}

/**
 * Vite build of apps/demo (packages built with npm run build) into out, engine/ links to the
 * engine folder. tools/package-demo.sh builds the deployable variant (hashed, compressed).
 */
export function buildDemo(out, engine) {
  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const build = spawnSync(
    process.execPath,
    [
      vite,
      'build',
      path.join(root, 'apps', 'demo'),
      '--outDir',
      out,
      '--emptyOutDir',
      '--logLevel',
      'warn',
    ],
    { stdio: 'inherit', env: { ...process.env, VITE_ENGINE_BASE: 'engine/' } },
  );
  if (build.status !== 0) throw new Error('vite build of apps/demo failed');
  fs.symlinkSync(path.resolve(engine), path.join(out, 'engine'));
  return out;
}

let builtDemo = null;
/** The demo folder: E2E_SITE_DIR (built once per run by tests/run.mjs or CI), else a build now. */
export function demoSite(engine) {
  if (process.env.E2E_SITE_DIR) return path.resolve(process.env.E2E_SITE_DIR);
  builtDemo ??= buildDemo(tempDir('demo-site'), engine);
  return builtDemo;
}
