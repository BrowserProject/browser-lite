// End-to-End Test fuer PDFs im Tab (engine/src/Clients.cpp startPDFView,
// web/app.js showPDF): ein PDF-Link oeffnet das PDF im Tab mit dem Viewer des
// Host-Browsers statt eines Downloads, Neu laden und Zurueck gehen, ein PDF mit
// Content-Disposition: attachment wird weiter heruntergeladen, ein PDF in einem
// iframe loest keinen Download aus. Ohne PDF-Viewer im Host (headless shell)
// wird wie in Chrome heruntergeladen.
//
//   cd tests/e2e && node pdf-test.mjs [engine-ordner]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'pdf-token-0123456789abcdef';
const RELAY_PORT = 15861;
const UI_PORT = 15862;
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

// Kleines gueltiges PDF mit einer Seite und Text
function makePDF(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 24 Tf 72 760 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
const PDF = makePDF('Hallo aus dem PDF');

const PAGE = `<!doctype html><title>Seite mit PDF</title>
<style>body { margin: 0; font: 20px sans-serif } a { position: absolute; left: 20px; top: 20px }</style>
<a href="/doc.pdf">Das PDF</a>
<script>console.log('RESULT page=' + (performance.getEntriesByType('navigation')[0]?.type || 'x'));</script>`;
const FRAME = `<!doctype html><title>PDF im iframe</title><iframe src="/doc.pdf"></iframe>
<script>console.log('RESULT frame=1')</script>`;

let pdfRequests = 0;
const site = http.createServer((req, res) => {
  if (req.url === '/doc.pdf') {
    pdfRequests++;
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': PDF.length }).end(PDF);
  } else if (req.url === '/attach.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="rechnung.pdf"' }).end(PDF);
  } else if (req.url === '/frame') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(FRAME);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  }
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

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

// Volles Chromium (mit PDF-Viewer), die headless shell hat keinen
const launchArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: launchArgs } : { channel: 'chromium', args: launchArgs });
const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, acceptDownloads: true });
let page = await context.newPage();
const results = new Map();
page.on('console', (msg) => {
  const match = /RESULT (\w+)=(\S*)/.exec(msg.text());
  if (match)
    results.set(match[1], match[2]);
  if (process.env.E2E_VERBOSE)
    console.log('   ', msg.text());
});
const downloads = [];
page.on('download', (download) => downloads.push(download.suggestedFilename()));
check('Host hat einen PDF-Viewer', await page.evaluate(() => navigator.pdfViewerEnabled));
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
// Zustand des aktiven Tabs: PDF-iframe, Adresse, Titel, Inhalt des PDFs
const state = () => page.evaluate(async () => {
  const frame = [...document.querySelectorAll('iframe.pdf-view')].find((f) => f.style.display !== 'none');
  let bytes = 0;
  let head = '';
  if (frame) {
    const data = new Uint8Array(await (await fetch(frame.src)).arrayBuffer());
    bytes = data.length;
    head = new TextDecoder().decode(data.slice(0, 8));
  }
  const canvas = [...document.querySelectorAll('canvas.page')].some((c) => c.style.display !== 'none');
  return { frames: document.querySelectorAll('iframe.pdf-view').length, bytes, head, canvas, address: document.getElementById('address').value,
    title: document.querySelector('.tab.active .title').textContent, back: !document.getElementById('back').disabled };
});
async function waitFor(predicate, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await state();
    if (predicate(last))
      return last;
    await page.waitForTimeout(200);
  }
  return last;
}
const typeAddress = async (url) => {
  await page.fill('#address', url);
  await page.press('#address', 'Enter');
};

const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: base + '/page' });
await page.goto(`http://localhost:${UI_PORT}/?${query}`);
check('Seite geladen', await result('page', TIMEOUT) !== null);

// 1. Link auf ein PDF: im Tab anzeigen, kein Download
await page.mouse.click(...await at(50, 32));
let s = await waitFor((s) => s.frames === 1);
check('PDF im Tab (iframe mit den Bytes des PDFs)', s.frames === 1 && s.bytes === PDF.length && s.head.startsWith('%PDF') && !s.canvas, JSON.stringify(s));
check('Adresse und Titel des PDFs, Zurueck moeglich', s.address === base + '/doc.pdf' && s.title === 'doc.pdf' && s.back, `${s.address} ${s.title}`);
check('kein Download', downloads.length === 0, downloads.join(','));
const viewer = await page.evaluate(() => {
  const frame = document.querySelector('iframe.pdf-view');
  try {
    return frame.contentDocument?.querySelector('embed')?.type || 'kein embed';
  } catch (e) {
    return 'kein Zugriff';
  }
});
check('Viewer des Host zeigt das PDF unter seinem Namen', viewer === 'application/pdf'
  && await page.evaluate(() => document.querySelector('iframe.pdf-view').src.endsWith('/doc.pdf')), viewer);

await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(root, 'build', 'e2e-pdf-viewer.png') });

// 2. Neu laden: PDF kommt nochmals vom Server
const before = pdfRequests;
await page.keyboard.press('F5');
s = await waitFor((s) => s.frames === 1 && pdfRequests > before);
check('Neu laden laedt das PDF neu', s.frames === 1 && pdfRequests > before && s.address === base + '/doc.pdf' && s.title === 'doc.pdf', JSON.stringify(s));

// 3. Zurueck: die Seite davor, ohne sie neu zu laden
results.delete('page');
await page.click('#back');
s = await waitFor((s) => s.frames === 0);
check('Zurueck schliesst das PDF', s.frames === 0 && s.canvas && s.address === base + '/page' && s.title === 'Seite mit PDF', JSON.stringify(s));
await page.waitForTimeout(500);
check('Seite davor nicht neu geladen', !results.has('page'));

// 4. Neue Adresse im PDF-Tab: PDF geht weg
await page.mouse.click(...await at(50, 32));
await waitFor((s) => s.frames === 1);
await typeAddress(base + '/page?2');
s = await waitFor((s) => s.frames === 0 && s.address.endsWith('?2'));
check('neue Navigation schliesst das PDF', s.frames === 0 && s.canvas && s.address === base + '/page?2', JSON.stringify(s));
await result('page');

// 5. Content-Disposition: attachment -> Download wie bisher
await typeAddress(base + '/attach.pdf');
const end = Date.now() + 15000;
while (!downloads.length && Date.now() < end)
  await page.waitForTimeout(200);
s = await state();
check('PDF als Anhang wird heruntergeladen', downloads[0] === 'rechnung.pdf' && s.frames === 0, downloads.join(','));

// 6. PDF im iframe: kein Download, Seite laedt
downloads.length = 0;
await typeAddress(base + '/frame');
check('Seite mit PDF-iframe geladen', await result('frame') === '1');
await page.waitForTimeout(2000);
check('PDF im iframe: kein Download', downloads.length === 0, downloads.join(','));

await page.screenshot({ path: path.join(root, 'build', 'e2e-pdf.png') });
await browser.close();

// 7. Host ohne PDF-Viewer: normaler Download mit dem richtigen Namen
const shell = await chromium.launch({ args: launchArgs });
page = await (await shell.newContext({ viewport: { width: 1000, height: 700 }, acceptDownloads: true })).newPage();
page.on('download', (download) => downloads.push(download.suggestedFilename()));
downloads.length = 0;
results.clear();
page.on('console', (msg) => {
  const match = /RESULT (\w+)=(\S*)/.exec(msg.text());
  if (match)
    results.set(match[1], match[2]);
});
await page.goto(`http://localhost:${UI_PORT}/?${query}`);
await result('page', TIMEOUT);
check('headless shell: kein PDF-Viewer', !(await page.evaluate(() => navigator.pdfViewerEnabled)));
await page.mouse.click(...await at(50, 32));
const end2 = Date.now() + 15000;
while (!downloads.length && Date.now() < end2)
  await page.waitForTimeout(200);
s = await state();
check('ohne Viewer: Download doc.pdf statt Anzeige', downloads.join(',') === 'doc.pdf' && s.frames === 0, downloads.join(','));
await shell.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
