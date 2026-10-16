// Gemeinsames Geruest der End-to-End Tests: Relay und Oberflaeche auf freien
// Ports starten (Tests laufen auch parallel), Hilfsprozesse bei jedem Ende
// beenden, Chromium starten, RESULT-Zeilen der Seite sammeln, check()/finish().
//
// Umgebung: E2E_TIMEOUT (ms, Standard 180000), E2E_VERBOSE=1 (Konsole der Seite
// und der Server ausgeben, Ablauf der Engine mit ?debug=1), CHROMIUM_PATH.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
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
const killChildren = () => {
  for (const child of children)
    child.kill();
};
process.on('exit', killChildren);
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]])
  process.on(signal, () => process.exit(code));

// Nie ewig haengen: harte Grenze fuer den ganzen Test
export function timeLimit(ms = TIMEOUT + 120000) {
  setTimeout(() => {
    console.log('FAIL Zeitlimit fuer den ganzen Test');
    process.exit(1);
  }, ms).unref();
}

let failed = 0;
export function check(name, ok, info = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok)
    failed++;
}
export function finish() {
  console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
  process.exit(failed ? 1 : 0);
}

// Node-Skript als Kindprozess, fertig wenn stdout `ready` zeigt. Scheitert, wenn
// es vorher endet (z.B. Port belegt) oder nach `ms` noch nicht bereit ist.
export function start(script, args, env, { ready = /laeuft|browser-lite auf/, ms = 30000 } = {}) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const name = path.basename(script);
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${name} nach ${ms / 1000} s nicht bereit`));
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
      reject(new Error(`${name} beendet (${signal || code}), bevor es bereit war`));
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

function relayEnv(token, allowLocal, port) {
  return { RELAY_TOKEN: token, PORT: String(port), HOST: '127.0.0.1', ...(allowLocal ? { RELAY_ALLOW_LOCAL: '1' } : {}) };
}

// Relay (Wisp) und Oberflaeche (web/serve.mjs). allowLocal erlaubt dem Relay
// lokale Adressen (die Testserver), ohne laeuft es wie auf dem Server.
export async function startStack({ token, allowLocal = true, engine = engineDir } = {}) {
  const relayScript = path.join(root, 'relay', 'server.mjs');
  const relay = await startOnFreePort((port) => start(relayScript, [], relayEnv(token, allowLocal, port)));
  const ui = await startOnFreePort((port) => start(path.join(root, 'web', 'serve.mjs'), [String(port), engine], {}));
  const stack = {
    token,
    relay: relay.child,
    ui: ui.child,
    relayPort: relay.port,
    uiPort: ui.port,
    relayURL: `ws://127.0.0.1:${relay.port}/wisp/`,
    uiURL: `http://localhost:${ui.port}/`,
    // Adresse der Oberflaeche mit diesem Relay und Token, dazu weitere Parameter (url, debug, ...)
    app(params = {}) {
      const query = new URLSearchParams({ relay: stack.relayURL, token, ...(VERBOSE ? { debug: '1' } : {}), ...params });
      return `${stack.uiURL}?${query}`;
    },
    // Relay faellt aus und kommt auf demselben Port wieder
    async restartRelay() {
      const { relay } = stack;
      if (relay.exitCode === null && relay.signalCode === null) {
        const exited = new Promise((resolve) => relay.once('exit', resolve));
        relay.kill();
        await exited;
      }
      stack.relay = await start(relayScript, [], relayEnv(token, allowLocal, stack.relayPort));
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
    page.on('pageerror', (error) => console.log('   Seitenfehler:', error.message));
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

// Linke obere Ecke des sichtbaren Tab-Canvas im Fenster
export function canvasOrigin(page) {
  return page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none');
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });
}

// Bildschirmfoto der Oberflaeche nach build/e2e-<name>.png (CI-Artefakt)
export const screenshot = (page, name) => page.screenshot({ path: path.join(root, 'build', `e2e-${name}.png`) }).catch(() => {});
