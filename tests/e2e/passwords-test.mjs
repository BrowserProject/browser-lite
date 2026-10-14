// End-to-End Test fuer den Passwort-Speicher (engine/src/Passwords.cpp,
// web/passwords.js): Anmelden -> "Passwort speichern?" -> beim naechsten
// Besuch fuellt der Browser beim Fokus aus. Dazu: Passwort geaendert ->
// "aktualisieren?", anderer Ursprung bekommt nichts, gespeichert wird
// verschluesselt, Liste im Menue.
//
//   cd tests/e2e && node passwords-test.mjs [engine-ordner]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'passwords-token-0123456789abcdef';
const RELAY_PORT = 15851;
const UI_PORT = 15852;
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 120000);

setTimeout(() => {
  console.log('FAIL Zeitlimit fuer den ganzen Test');
  process.exit(1);
}, TIMEOUT + 90000).unref();

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok)
    failed++;
};

// Anmeldeseite: Benutzername hat autofocus (wie viele echte Seiten)
const LOGIN = (visit) => `<!doctype html><title>Anmelden</title>
<style>body { margin: 0; font: 16px sans-serif } input { position: absolute; left: 20px; width: 240px; height: 30px } #user { top: 20px } #pass { top: 70px } #search { top: 160px } button { position: absolute; left: 20px; top: 115px }</style>
<form action="/welcome" method="post">
<input id="user" name="user" autocomplete="username" autofocus>
<input id="pass" name="pass" type="password">
<button>Anmelden</button>
</form>
<input id="search" type="search">
<script>
const log = (key, value) => console.log('RESULT ${visit}' + key + '=' + String(value).replace(/\\s/g, '_'));
const user = document.getElementById('user');
const pass = document.getElementById('pass');
pass.addEventListener('input', () => log('filled', user.value + ':' + pass.value + ':' + pass.matches(':autofill')));
log('ready', 1);
</script>`;

const site = http.createServer((req, res) => {
  if (req.url.startsWith('/welcome')) {
    let body = '';
    req.on('data', (d) => body += d);
    req.on('end', () => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(`<!doctype html><title>Willkommen</title><script>console.log('RESULT welcome=' + ${JSON.stringify(new URLSearchParams(body).get('user') || '')})</script>`));
    return;
  }
  const visit = new URL(req.url, 'http://x').searchParams.get('v') || '';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(LOGIN(visit));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const port = site.address().port;
const siteURL = `http://127.0.0.1:${port}/login`;

function start(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => child.stdout.on('data', (d) => {
    if (/laeuft|browser-lite auf/.test(d.toString()))
      resolve(child);
  }));
}
const relay = await start(path.join(root, 'relay', 'server.mjs'), [],
  { RELAY_TOKEN: TOKEN, PORT: String(RELAY_PORT), HOST: '127.0.0.1', RELAY_ALLOW_LOCAL: '1' });
const ui = await start(path.join(root, 'web', 'serve.mjs'), [String(UI_PORT), engineDir], {});
process.on('exit', () => {
  relay.kill();
  ui.kill();
});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = new Map();
page.on('console', (msg) => {
  const match = /RESULT (\w+)=(\S*)/.exec(msg.text());
  if (match)
    results.set(match[1], match[2]);
  if (process.env.E2E_VERBOSE)
    console.log('   ', msg.text());
});
async function result(key, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (results.has(key))
      return results.get(key);
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}
async function at(x, y) {
  const box = await page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none');
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });
  return [box.x + x, box.y + y];
}
const navigate = (url) => page.evaluate((url) => window.__blEval(`location.href = ${JSON.stringify(url)}`), url);
const promptText = () => page.evaluate(() => {
  const prompt = document.getElementById('password-prompt');
  return prompt && !prompt.hidden ? prompt.textContent : '';
});
async function waitPrompt(ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const text = await promptText();
    if (text)
      return text;
    await page.waitForTimeout(100);
  }
  return '';
}
async function login(visit, user, pass) {
  await page.mouse.click(...await at(100, 35));
  if (user !== null) {
    await page.keyboard.press('Control+a');
    await page.keyboard.type(user);
  }
  await page.mouse.click(...await at(100, 85));
  await page.keyboard.press('Control+a');
  await page.keyboard.type(pass);
  results.delete('welcome');
  await page.keyboard.press('Enter');
  return result('welcome');
}

const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: siteURL + '?v=a' });
await page.goto(`http://localhost:${UI_PORT}/?${query}`);
check('Anmeldeseite geladen', await result('aready', TIMEOUT) === '1');
check('nichts gespeichert: kein Ausfuellen beim ersten Besuch', !results.has('afilled'));

// 1. Anmelden -> Abfrage "speichern?" -> Speichern
check('Formular abgeschickt', await login('a', 'anna', 'Geheim-123') === 'anna');
let text = await waitPrompt();
check('Abfrage "Passwort speichern?" mit Benutzername', /speichern\?/.test(text) && text.includes('anna'), text);
await page.click('#password-prompt button.primary');

// gespeichert und verschluesselt (kein Klartext in der Datenbank)
const readStored = () => page.evaluate(() => new Promise((resolve) => {
  const request = indexedDB.open('bl-passwords');
  request.onsuccess = () => {
    const get = request.result.transaction('logins').objectStore('logins').getAll();
    get.onsuccess = () => resolve(get.result.map((l) => ({ origin: l.origin, username: l.username, plain: new TextDecoder().decode(l.data).includes('Geheim'), keys: Object.keys(l).join(',') })));
  };
  request.onerror = () => resolve(null);
}));
let stored = await readStored();
for (let i = 0; i < 25 && !stored?.length; i++) {
  await page.waitForTimeout(200);
  stored = await readStored();
}
check('eine Anmeldung gespeichert, Passwort verschluesselt', stored?.length === 1 && stored[0].username === 'anna' && !stored[0].plain && !('password' in stored[0]), JSON.stringify(stored));

// 2. Neuer Besuch: autofocus auf dem Benutzernamen -> ausgefuellt
await navigate(siteURL + '?v=b');
check('zweiter Besuch geladen', await result('bready') === '1');
const filled = await result('bfilled', 10000);
check('Benutzername und Passwort ausgefuellt (:autofill)', filled === 'anna:Geheim-123:true', filled);

// gleiches Passwort nochmals abschicken: keine Abfrage
check('mit gespeichertem Passwort angemeldet', await login('b', null, 'Geheim-123') === 'anna');
await page.waitForTimeout(1500);
check('unveraendertes Passwort: keine Abfrage', !(await promptText()));

// 3. Passwort geaendert -> "aktualisieren?"
await navigate(siteURL + '?v=c');
await result('cready');
await result('cfilled', 10000);
check('mit neuem Passwort angemeldet', await login('c', null, 'Neu-456') === 'anna');
text = await waitPrompt();
check('Abfrage "aktualisieren?"', /aktualisieren\?/.test(text), text);
await page.click('#password-prompt button.primary');
await page.waitForTimeout(500);

await navigate(siteURL + '?v=d');
await result('dready');
check('neues Passwort wird ausgefuellt', await result('dfilled', 10000) === 'anna:Neu-456:true', results.get('dfilled'));

// 4. Anderer Ursprung (localhost statt 127.0.0.1): nichts ausfuellen
await navigate(`http://localhost:${port}/login?v=e`);
check('anderer Ursprung geladen', await result('eready') === '1');
await page.mouse.click(...await at(100, 85));
await page.waitForTimeout(2000);
check('anderer Ursprung: nicht ausgefuellt', !results.has('efilled'), results.get('efilled'));

// 5. Liste im Menue
await page.click('#menu-button');
await page.click('text=Passwörter');
await page.waitForSelector('#side-panel .panel-title');
const listed = await page.evaluate(() => [...document.querySelectorAll('#side-panel .panel-row')].map((r) => r.textContent).join('|'));
check('Liste der Passwoerter im Menue', listed.includes(`127.0.0.1:${port}`) && listed.includes('anna') && !listed.includes('Neu-456'), listed);
await page.click('#side-panel .panel-action');
await page.waitForTimeout(300);
check('Anzeigen zeigt das Passwort', (await page.evaluate(() => document.querySelector('#side-panel .panel-row').textContent)).includes('Neu-456'));

await page.screenshot({ path: path.join(root, 'build', 'e2e-passwords.png') });
await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
