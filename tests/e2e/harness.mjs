// Common frame of the end-to-end tests: builds the demo (apps/demo) once, starts the demo server
// and the relay (both browser-lite-server) on free ports, ends helper processes on every exit,
// starts Chromium, collects RESULT lines of the pages, check()/finish().
//
// Environment: E2E_TIMEOUT (ms, default 180000), E2E_VERBOSE=1 (console of the pages and the
// servers, engine log with ?log=1), E2E_SITE_DIR (a packaged demo with engine/, see
// tools/package-demo.sh, instead of building one), CHROMIUM_PATH.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '..', '..');
export const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
export const TIMEOUT = Number(process.env.E2E_TIMEOUT || 180000);
export const VERBOSE = !!process.env.E2E_VERBOSE;
// Headless Chromium hat sonst kein WebGL
export const SWIFTSHADER = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const children = new Set();
const tempDirs = new Set();
process.on('exit', () => {
  for (const child of children)
    child.kill();
  for (const dir of tempDirs)
    fs.rmSync(dir, { recursive: true, force: true });
});
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]])
  process.on(signal, () => process.exit(code));

// Never hang forever: hard limit for the whole test
export function timeLimit(ms = TIMEOUT + 120000) {
  setTimeout(() => {
    console.log('FAIL time limit of the whole test');
    process.exit(1);
  }, ms).unref();
}

let failed = 0;
// Ein Absturz der Engine (Trap, abort) in einer beobachteten Seite ist immer
// ein Fehler, auch wenn die Pruefungen danach noch gruen sind. Gibt eine
// Funktion zurueck, die das Beobachten beendet (vor einem gewollten Absturz).
const engineCrashes = [];
export function watchErrors(page, prefix = '   Seitenfehler:') {
  const onError = (error) => {
    console.log(prefix, error.message);
    if (/^Aborted\(/.test(error.message) || /engine\.wasm/.test(error.stack || ''))
      engineCrashes.push(`${error.message} (${(error.stack || '').split('\n')[1]?.trim() || ''})`);
  };
  page.on('pageerror', onError);
  return () => page.off('pageerror', onError);
}

export function check(name, ok, info = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok)
    failed++;
}
export function finish() {
  if (engineCrashes.length)
    check('Engine without crash', false, engineCrashes.join(' | '));
  console.log(failed ? `${failed} check(s) failed` : 'All checks ok');
  process.exit(failed ? 1 : 0);
}

// Node-Skript als Kindprozess, fertig wenn stdout `ready` zeigt. Scheitert, wenn
// es vorher endet (z.B. Port belegt) oder nach `ms` noch nicht bereit ist.
export function start(script, args, env, { ready = /listening on/, ms = 30000 } = {}) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const name = path.basename(script);
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${name} not ready after ${ms / 1000} s`));
    }, ms);
    child.stdout.on('data', (data) => {
      if (VERBOSE)
        process.stdout.write(`[${name}] ${data}`);
      if (output !== null && ready.test(output += data)) {
        output = null;
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`${name} ended (${signal || code}) before it was ready`));
    });
  });
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Zwischen freePort() und dem Start kann ein paralleler Test den Port nehmen:
// dann mit einem neuen Port nochmal
async function startOnFreePort(launch) {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    try {
      return { port, child: await launch(port) };
    } catch (error) {
      if (attempt === 3)
        throw error;
    }
  }
}

// The pages come from the demo server, another origin than the relay
function relayEnv(token, allowLocal, port, origin) {
  return { RELAY_TOKEN: token, PORT: String(port), HOST: '127.0.0.1', RELAY_ALLOWED_ORIGINS: origin, ...(allowLocal ? { RELAY_ALLOW_LOCAL: '1' } : {}) };
}

async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
}

const serverScript = path.join(root, 'packages', 'server', 'dist', 'bin', 'browser-lite-server.js');
const sites = new Map();

// The demo for an engine: E2E_SITE_DIR, or the Vite build of apps/demo (packages built with
// npm run build) in a temporary folder whose engine/ links to the engine folder
function demoSite(engine) {
  if (process.env.E2E_SITE_DIR)
    return path.resolve(process.env.E2E_SITE_DIR);
  if (sites.has(engine))
    return sites.get(engine);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-e2e-site-'));
  tempDirs.add(dir);
  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const build = spawnSync(process.execPath, [vite, 'build', path.join(root, 'apps', 'demo'), '--outDir', dir, '--emptyOutDir', '--logLevel', 'warn'],
    { stdio: 'inherit', env: { ...process.env, VITE_ENGINE_BASE: 'engine/' } });
  if (build.status !== 0)
    throw new Error('vite build of apps/demo failed');
  fs.symlinkSync(engine, path.join(dir, 'engine'));
  sites.set(engine, dir);
  return dir;
}

// Relay and demo (browser-lite-server with SITE_DIR and the profile on the server in a new empty
// folder, stack.profileDir). A second device is a second browser (launchProfile) at the same
// stack. allowLocal lets the relay reach local addresses (the test servers); without it, it runs
// like on the server.
export async function startStack({ token, allowLocal = true, engine = engineDir } = {}) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-e2e-server-profile-'));
  tempDirs.add(profileDir);
  const site = demoSite(engine);
  const ui = await startOnFreePort((port) => start(serverScript, [], { SITE_DIR: site, PROFILE_DIR: profileDir, PORT: String(port), HOST: '127.0.0.1' }));
  const origin = `http://localhost:${ui.port}`;
  const relay = await startOnFreePort((port) => start(serverScript, [], relayEnv(token, allowLocal, port, origin)));
  const stack = {
    token,
    profileDir,
    relay: relay.child,
    ui: ui.child,
    relayPort: relay.port,
    uiPort: ui.port,
    relayURL: `ws://127.0.0.1:${relay.port}/wisp/`,
    uiURL: `http://localhost:${ui.port}/`,
    // Address of the demo with this relay and token and further parameters (url, env, ...).
    // debug=1: window.blTest, browser.debug and the engine test hooks; ?relay= needs it
    app(params = {}) {
      const query = new URLSearchParams({ relay: stack.relayURL, token, debug: '1', ...(VERBOSE ? { log: '1' } : {}), ...params });
      return `${stack.uiURL}?${query}`;
    },
    // The relay fails and comes back on the same port
    async restartRelay() {
      await stop(stack.relay);
      stack.relay = await start(serverScript, [], relayEnv(token, allowLocal, stack.relayPort, origin));
    },
  };
  return stack;
}

// Testserver der Seiten auf 127.0.0.1 mit freiem Port; url endet mit /
export async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

export function launch({ args = [], ...options } = {}) {
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args, ...options });
}

// Chromium mit eigenem Profil auf der Platte, wie ein normaler Browser. Ein
// Kontext von newContext() ist wie inkognito: dort liegt das OPFS im RAM, und
// Chromium lehnt Schreiben ab, wenn der Rechner wenig freien Speicher hat
// (mehrere Tests parallel)
export function launchProfile({ args = [], ...options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-e2e-profile-'));
  tempDirs.add(dir);
  return chromium.launchPersistentContext(dir, { executablePath: process.env.CHROMIUM_PATH || undefined, args, ...options });
}

// Antwort mit data wie ein Server fuer Medien, mit Range (206). Gibt den Bereich
// [start, end] zurueck, null ohne Range
export function serveBytes(req, res, data, type) {
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Accept-Ranges': 'bytes' }).end(data);
    return null;
  }
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : data.length - 1, data.length - 1);
  res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Accept-Ranges': 'bytes' })
    .end(data.subarray(start, end + 1));
  return [start, end];
}

// WAV (16 Bit, mono) mit einem Sinus, frequency 0 ist Stille
export function wav(seconds, { rate = 22050, frequency = 440, amplitude = 8000 } = {}) {
  const frames = Math.round(seconds * rate);
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; frequency && i < frames; i++)
    buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / rate) * amplitude), 44 + i * 2);
  return buffer;
}

// WebM (VP8, ohne Ton) aus einem roten Canvas, aufgenommen im Chromium des Tests
export async function recordClip(browser, seconds = 3) {
  const recorder = await browser.newPage();
  await recorder.goto('about:blank');
  const bytes = await recorder.evaluate(async (ms) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    const media = new MediaRecorder(canvas.captureStream(25), { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    media.ondataavailable = (e) => chunks.push(e.data);
    const timer = setInterval(() => {
      ctx.fillStyle = '#e00000';
      ctx.fillRect(0, 0, 320, 240);
    }, 40);
    media.start(500);
    await new Promise((r) => setTimeout(r, ms));
    await new Promise((r) => { media.onstop = r; media.stop(); });
    clearInterval(timer);
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  }, seconds * 1000);
  await recorder.close();
  return Buffer.from(bytes);
}

// Sammelt "RESULT name=wert" aus der Konsole einer oder mehrerer Seiten
// (die Oberflaeche gibt die Konsole des Tabs weiter). logs hat alle Zeilen.
export class Results extends Map {
  constructor(pattern = /RESULT (\w+)=(\S*)/) {
    super();
    this.pattern = pattern;
    this.logs = [];
  }

  watch(page) {
    page.on('console', (msg) => {
      const text = msg.text();
      this.logs.push(text);
      if (VERBOSE)
        console.log('   ', text);
      const match = this.pattern.exec(text);
      if (match)
        this.set(match[1], match[2]);
    });
    watchErrors(page);
    return this;
  }

  // Wert von key, null nach ms oder sobald stop() wahr ist
  async wait(key, ms = TIMEOUT, stop = () => false) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.has(key))
        return this.get(key);
      if (stop())
        return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }
}
export const collect = (page, pattern) => new Results(pattern).watch(page);

// Top left corner of the visible view canvas in the window
export function canvasOrigin(page) {
  return page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas[data-bl-view]')].find((c) => c.style.display !== 'none');
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });
}

// Color [r, g, b] of the visible page at x, y (window.blTest of the demo), null without a view
export const pagePixel = (page, x, y) => page.evaluate(([x, y]) => (window.blTest.view() ? window.blTest.pagePixel(x, y) : null), [x, y]);

// Farbe ungefaehr gleich: jeder Kanal hoechstens tolerance daneben
export const near = (pixel, rgb, tolerance = 40) => !!pixel && rgb.every((value, i) => Math.abs(pixel[i] - value) <= tolerance);

// Bis condition() wahr ist, hoechstens ms (fuer Zustaende ohne eigenes Ereignis, z.B. ein Bild)
export async function waitFor(condition, ms = 20000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition())
      return true;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return false;
}

// Bildschirmfoto der Oberflaeche nach build/e2e-<name>.png (CI-Artefakt)
export const screenshot = (page, name) => page.screenshot({ path: path.join(root, 'build', `e2e-${name}.png`) }).catch(() => {});
