// End-to-End Test fuer Eingabe und Oberflaeche im echten Chromium:
// Tippen (auch Umlaute), Klicken, Scrollen, Popup als neuer Tab, Downloads
// (HTTP, blob:, data:, 404), mailto:, sandbox (tel:, Download), <a ping> mit
// Cookie, CSP-Report ohne Redirect, sendBeacon (Preflight, CORS und CSP bei
// Redirects), Favicon hinter einem Redirect, Dialoge
// (auch viele hintereinander), <object>/<embed> und Datei-Upload. Die Testseite meldet Ergebnisse ueber console.log
// ("RESULT name=wert"), die Oberflaeche gibt die Konsole der Seite weiter.
//
//   cd tests/e2e && node input-test.mjs [engine-ordner]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { TIMEOUT, canvasOrigin, check, collect, finish, launch, root, screenshot, serve, startStack, timeLimit } from './harness.mjs';

timeLimit(TIMEOUT + 240000);

// ------------------------------------------------------------ Testseiten

const PAGE = `<!doctype html>
<html><head><title>Eingabe-Test</title>
<style>
  body { margin: 0; font: 16px sans-serif; height: 3000px; }
  #text { position: absolute; left: 20px; top: 20px; width: 300px; height: 30px; font-size: 18px; }
  #button { position: absolute; left: 20px; top: 70px; width: 120px; height: 40px; }
  #popup { position: absolute; left: 20px; top: 130px; }
  #download { position: absolute; left: 20px; top: 170px; }
  #file { position: absolute; left: 20px; top: 210px; }
  #fs { position: absolute; left: 20px; top: 250px; width: 120px; height: 30px; }
  #sel { position: absolute; left: 20px; top: 300px; width: 120px; height: 26px; }
  #hoverlink { position: absolute; left: 20px; top: 345px; }
  #color { position: absolute; left: 20px; top: 380px; width: 60px; height: 30px; }
  #date { position: absolute; left: 20px; top: 430px; width: 160px; height: 26px; }
  #blob { position: absolute; left: 600px; top: 20px; width: 120px; height: 30px; }
  #data { position: absolute; left: 600px; top: 70px; }
  #missing { position: absolute; left: 600px; top: 110px; }
  #mail { position: absolute; left: 600px; top: 150px; }
  #pinglink { position: absolute; left: 600px; top: 190px; }
  #sandboxed, #sandboxed-tel { position: absolute; left: 600px; top: 230px; width: 160px; height: 40px; border: 0; }
  #sandboxed-tel { top: 280px; }
  #objects { position: absolute; left: 20px; top: 1200px; }
</style></head>
<body>
<input id="text" autocomplete="off">
<button id="button">Klick</button>
<a id="popup" href="/popup.html" target="_blank">Popup</a>
<a id="download" href="/datei.txt">Download</a>
<input id="file" type="file" multiple>
<button id="fs">Vollbild</button>
<select id="sel"><option value="a">Eins</option><optgroup label="Gruppe"><option value="b">Zwei</option><option value="c">Drei</option></optgroup></select>
<a id="hoverlink" href="/ziel" title="Ein Tipp">Darueber fahren</a>
<input id="color" type="color" value="#112233">
<input id="date" type="date" value="2026-10-12">
<div id="own-menu" style="position:absolute;left:400px;top:20px;width:150px;height:60px;background:#ddd">eigenes Menue</div>
<button id="blob">Blob speichern</button>
<a id="data" download="daten.csv" href="data:text/csv,a%2Cb%0A1%2C2%0A">data:</a>
<a id="missing" download href="/fehlt.txt">404</a>
<a id="mail" href="mailto:info@example.com?subject=Hallo">Mail</a>
<a id="pinglink" href="#gepingt" ping="/ping">Ping</a>
<iframe id="sandboxed" sandbox="allow-scripts" srcdoc="<body style='margin:0'><a href='tel:+41111111111' style='position:absolute;left:0;top:0;width:70px;height:40px'>tel</a><a download href='data:text/plain,x' style='position:absolute;left:80px;top:0;width:70px;height:40px'>dl</a>"></iframe>
<iframe id="sandboxed-tel" sandbox="allow-scripts allow-top-navigation-to-custom-protocols" srcdoc="<body style='margin:0'><a href='tel:+41222222222' style='display:block;height:40px'>tel</a>"></iframe>
<div id="objects">
  <object id="o-svg" data="/bild.svg" type="image/svg+xml"></object>
  <embed id="o-embed" src="/bild.svg">
  <object id="o-html" data="/seite.html"></object>
  <object id="o-gif" data="/punkt.gif" type="image/gif"></object>
  <object id="o-flash" data="/film.swf" type="application/x-shockwave-flash"><span id="fallback">Ersatz</span></object>
  <iframe src="/csp.html" width="20" height="20"></iframe>
</div>
<script>
  document.cookie = 'sitzung=42';
  // Wie viele Seiten: Blob bauen, Link anklicken, Adresse gleich wieder freigeben
  document.getElementById('blob').addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['Inhalt aus dem Blob\\n'], { type: 'text/plain' }));
    link.download = 'blob.txt';
    link.click();
    URL.revokeObjectURL(link.href);
  });
  addEventListener('load', () => {
    const svg = document.getElementById('o-svg').contentDocument?.documentElement?.localName;
    const embed = document.getElementById('o-embed').getSVGDocument?.()?.documentElement?.localName;
    const html = document.getElementById('o-html').contentDocument?.title;
    const gif = document.getElementById('o-gif');
    const fallback = document.getElementById('fallback').offsetWidth > 0;
    console.log('RESULT objects=' + [svg, embed, html, gif.offsetWidth + 'x' + gif.offsetHeight, fallback].join(','));
  });
  const text = document.getElementById('text');
  text.addEventListener('change', () => console.log('RESULT text=' + text.value));
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter') console.log('RESULT text=' + text.value); });
  document.getElementById('button').addEventListener('click', () => console.log('RESULT click=1'));
  let scrolled = false;
  window.addEventListener('scroll', () => {
    if (!scrolled && window.scrollY > 100) {
      scrolled = true;
      console.log('RESULT scroll=' + Math.round(window.scrollY));
    }
  });
  document.getElementById('file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    console.log('RESULT filetypes=' + files.map((f) => f.name.split('.').pop() + ':' + (f.type || '-')).join(','));
    console.log('RESULT fileread=' + (await files[0].text()).trim());
    const form = new FormData();
    for (const file of files)
      form.append('upload', file);
    const response = await fetch('/upload', { method: 'POST', body: form });
    console.log('RESULT upload=' + (await response.text()));
  });
  document.getElementById('own-menu').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    console.log('RESULT ownmenu=1');
  });
  document.getElementById('fs').addEventListener('click', () => {
    console.log('RESULT fsclick=' + document.fullscreenEnabled + ',' + typeof document.documentElement.requestFullscreen);
    document.documentElement.requestFullscreen().then(() => console.log('RESULT fs=ok'), (e) => console.log('RESULT fs=' + e.name));
  });
  document.addEventListener('fullscreenchange', () => {
    console.log(document.fullscreenElement ? 'RESULT fson=1' : 'RESULT fsoff=1');
  });
  const sel = document.getElementById('sel');
  sel.addEventListener('change', () => console.log('RESULT select=' + sel.value));
  const color = document.getElementById('color');
  color.addEventListener('input', () => console.log('RESULT colorinput=' + color.value));
  color.addEventListener('change', () => console.log('RESULT color=' + color.value));
  const date = document.getElementById('date');
  date.addEventListener('change', () => console.log('RESULT date=' + date.value));
  window.addEventListener('resize', () => console.log('RESULT width=' + window.innerWidth));
  console.log('RESULT ready=1');
</script>
</body></html>`;

const POPUP = '<!doctype html><title>Popup-Seite</title><p>Ich bin ein Popup</p><script>console.log("RESULT popup=" + document.title)</script>';

let resolvePing;
const pingArrived = new Promise((resolve) => { resolvePing = resolve; });
const cspRequests = [];
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  } else if (req.url === '/popup.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(POPUP);
  } else if (req.url === '/bild.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>');
  } else if (req.url === '/seite.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Eingebettet</title><p>Im object');
  } else if (req.url === '/punkt.gif') {
    res.writeHead(200, { 'Content-Type': 'image/gif' }).end(Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
  } else if (req.url === '/favicon.ico') {
    res.writeHead(301, { Location: '/punkt.gif' }).end();
  } else if (req.url === '/csp.html') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "img-src 'none'; report-uri /csp-report" }).end('<!doctype html><img src="/punkt.gif">');
  } else if (req.url === '/csp-report' || req.url === '/csp-ziel') {
    // Reports folgen keinem Redirect (sonst gingen Daten und Cookies an das Ziel)
    cspRequests.push(req.url);
    res.writeHead(307, { Location: '/csp-ziel' }).end();
  } else if (req.url === '/ping') {
    res.writeHead(307, { Location: '/ping-ziel' }).end();
  } else if (req.url === '/ping-ziel' && req.method === 'POST') {
    resolvePing({ cookie: req.headers.cookie || '', pingTo: req.headers['ping-to'] || '' });
    res.writeHead(204).end();
  } else if (req.url === '/beacon-csp.html') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "connect-src 'self'" })
      .end('<!doctype html><script>navigator.sendBeacon("/umleiten-fremd", "csp"); navigator.sendBeacon("/umleiten-eigen", "eigen");</script>');
  } else if (req.url === '/umleiten-fremd') {
    res.writeHead(307, { Location: foreignURL + 'csp-ziel' }).end();
  } else if (req.url === '/umleiten-eigen') {
    res.writeHead(307, { Location: '/beacon-eigen' }).end();
  } else if (req.url === '/beacon-eigen' && req.method === 'POST') {
    resolveOwnBeacon();
    res.writeHead(204).end();
  } else if (req.url === '/datei.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="gruezi.txt"' }).end('Inhalt vom Download\n');
  } else if (req.url === '/archiv.zip') {
    res.writeHead(200).end('PK');
  } else if (req.url === '/upload' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(body.includes('Upload-Inhalt 123') && body.includes('Content-Type: video/mp4') ? 'angekommen' : 'fehlt');
    });
  } else {
    res.writeHead(404).end();
  }
});

// Fremder Ursprung fuer sendBeacon (anderer Port, gleiche Cookies). Ein Blob
// mit application/json braucht einen Preflight.
const siteOrigin = siteURL.slice(0, -1);
const foreignRequests = [];
let resolveOwnBeacon, resolveAllowedBeacon;
const ownBeaconArrived = new Promise((resolve) => { resolveOwnBeacon = resolve; });
const allowedBeaconArrived = new Promise((resolve) => { resolveAllowedBeacon = resolve; });
const { url: foreignURL } = await serve((req, res) => {
  foreignRequests.push(req.method + ' ' + req.url);
  const cors = { 'Access-Control-Allow-Origin': siteOrigin, 'Access-Control-Allow-Credentials': 'true' };
  if (req.method === 'OPTIONS' && (req.url === '/erlaubt' || req.url === '/umleiten')) {
    res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type' }).end();
  } else if (req.method === 'POST' && req.url === '/erlaubt') {
    resolveAllowedBeacon({ cookie: req.headers.cookie || '', origin: req.headers.origin || '' });
    res.writeHead(204, cors).end();
  } else if (req.method === 'POST' && req.url === '/umleiten') {
    res.writeHead(307, { Location: '/umleiten-ziel' }).end();
  } else {
    res.writeHead(204).end();
  }
});

// ------------------------------------------------------- Relay + Oberflaeche

const stack = await startStack({ token: 'input-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, acceptDownloads: true });
const page = await context.newPage();
const results = collect(page, /RESULT (\w+)=(.*?)(\s+\(|$)/);
const result = (key, timeout = 30000) => results.wait(key, timeout);

await page.goto(stack.app({ url: siteURL }));
check('Seite bereit', (await result('ready', TIMEOUT)) === '1');

// Position im Canvas des aktiven Tabs -> Position im Fenster
async function at(x, y) {
  const box = await canvasOrigin(page);
  return [box.x + x, box.y + y];
}

// 1) Klick
await page.mouse.click(...await at(80, 90));
check('Klick auf Knopf', (await result('click')) === '1');

// 2) Tippen: normale Tasten (keydown) und Text ohne Taste (insertText, wie IME)
await page.mouse.click(...await at(100, 35));
await page.keyboard.type('Hallo Welt');
await page.keyboard.insertText(' Grüezi äöü €');
await page.keyboard.press('Backspace');
await page.keyboard.type('!');
await page.keyboard.press('Enter');
const typed = await result('text');
check('Tippen inkl. Umlaute', typed === 'Hallo Welt Grüezi äöü !', JSON.stringify(typed));

// 3) Download (Content-Disposition: attachment)
const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
await page.mouse.click(...await at(40, 178));
const download = await downloadPromise;
if (download) {
  const file = path.join(root, 'build', 'e2e-download.txt');
  mkdirSync(path.dirname(file), { recursive: true });
  await download.saveAs(file);
  check('Download', download.suggestedFilename() === 'gruezi.txt' && readFileSync(file, 'utf8') === 'Inhalt vom Download\n', download.suggestedFilename());
} else {
  check('Download', false, 'kein Download-Event');
}

// 3b) Downloads ohne Netz: blob: (gleich wieder freigegeben) und data: mit download=
async function downloadByClick(x, y) {
  const promise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
  await page.mouse.click(...await at(x, y));
  const event = await promise;
  if (!event)
    return null;
  const file = path.join(root, 'build', 'e2e-download-' + event.suggestedFilename());
  await event.saveAs(file);
  return { name: event.suggestedFilename(), text: readFileSync(file, 'utf8') };
}
const blobDownload = await downloadByClick(660, 35);
check('Download blob:', blobDownload?.name === 'blob.txt' && blobDownload.text === 'Inhalt aus dem Blob\n', JSON.stringify(blobDownload));
const dataDownload = await downloadByClick(615, 78);
check('Download data:', dataDownload?.name === 'daten.csv' && dataDownload.text === 'a,b\n1,2\n', JSON.stringify(dataDownload));

// 3c) 404: keine Datei, sondern ein Fehler wie in Chrome
let missingDownload = false;
const onMissing = () => { missingDownload = true; };
page.on('download', onMissing);
await page.mouse.click(...await at(610, 118));
const missingStatus = await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Download failed'), null, { timeout: 15000 })
  .then(() => page.evaluate(() => document.getElementById('status').textContent), () => null);
page.off('download', onMissing);
check('Download 404 wird Fehler', missingStatus === 'Download failed: fehlt.txt (HTTP 404)' && !missingDownload, String(missingStatus));

// 3c2) Ohne Content-Type gilt die Endung: ein Archiv wird ein Download, keine Seite
const zipPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
await page.evaluate(() => window.blTest.eval('location.href = "/archiv.zip"'));
const zipDownload = await zipPromise;
check('Ohne Content-Type: .zip wird ein Download', zipDownload?.suggestedFilename() === 'archiv.zip', String(zipDownload?.suggestedFilename()));

// 3d) mailto: geht an den Host-Browser (window.open mit noopener), die Seite
// bleibt und zeigt keinen Ladefehler. Ohne Klick wird tel: still verworfen.
await page.evaluate(() => {
  window.__opened = [];
  window.open = (...args) => { window.__opened.push(args); return null; };
});
await page.mouse.click(...await at(610, 158));
const opened = await page.waitForFunction(() => window.__opened.length > 0, null, { timeout: 10000 }).then(() => page.evaluate(() => window.__opened[0]), () => null);
check('mailto: an den Host-Browser', opened?.[0] === 'mailto:info@example.com?subject=Hallo' && opened?.[1] === '_blank' && opened?.[2] === 'noopener', JSON.stringify(opened));
await page.evaluate(() => window.blTest.eval('location.href = "tel:+41000000000"'));
await page.waitForTimeout(1000);
const external = await page.evaluate(() => ({ opened: window.__opened.length, status: document.getElementById('status').textContent }));
check('tel: ohne Klick: nichts geoeffnet, kein Fehler', external.opened === 1 && !external.status.startsWith('Error'), JSON.stringify(external));

// 3d2) Iframe mit sandbox="allow-scripts": kein tel: an den Host-Browser, kein
// Download (ohne allow-downloads). Mit allow-top-navigation-to-custom-protocols
// geht tel: nach einem Klick.
let sandboxDownload = false;
const onSandboxDownload = () => { sandboxDownload = true; };
page.on('download', onSandboxDownload);
await page.mouse.click(...await at(630, 250));
await page.mouse.click(...await at(710, 250));
await page.mouse.click(...await at(680, 300));
const sandboxOpened = await page.waitForFunction(() => window.__opened.length > 1, null, { timeout: 10000 }).catch(() => {})
  .then(() => page.waitForTimeout(1500)).then(() => page.evaluate(() => window.__opened.slice(1).map((args) => args[0])));
page.off('download', onSandboxDownload);
check('sandbox: tel: nur mit allow-top-navigation-to-custom-protocols', JSON.stringify(sandboxOpened) === '["tel:+41222222222"]'
  && results.logs.some((line) => line.includes('external URL from a sandboxed iframe')), JSON.stringify(sandboxOpened));
check('sandbox: kein Download ohne allow-downloads', !sandboxDownload && results.logs.some((line) => line.includes('Not allowed to download due to sandboxing')));

// 3e) <a ping>: mit den Cookies der Seite wie in Chrome, auch nach einem Redirect
await page.mouse.click(...await at(610, 198));
const ping = await Promise.race([pingArrived, new Promise((resolve) => setTimeout(() => resolve(null), 15000))]);
check('<a ping> mit Cookie nach Redirect', ping?.cookie === 'sitzung=42' && ping.pingTo === siteURL + '#gepingt', JSON.stringify(ping));
check('CSP-Report folgt keinem Redirect', cspRequests.length > 0 && !cspRequests.includes('/csp-ziel'), cspRequests.join(' '));

// 3e2) sendBeacon an einen fremden Ursprung: application/json nur nach einem
// erlaubten Preflight, dann mit Cookie und Origin. Ein Redirect ohne CORS-Header
// endet, connect-src der Seite gilt auch fuer das Ziel eines Redirects.
await page.evaluate((foreign) => window.blTest.eval(`
  const json = () => new Blob(['{}'], { type: 'application/json' });
  navigator.sendBeacon('${foreign}verboten', json());
  navigator.sendBeacon('${foreign}umleiten', json());
  navigator.sendBeacon('${foreign}erlaubt', json());
  document.body.appendChild(Object.assign(document.createElement('iframe'), { src: '/beacon-csp.html' }));`), foreignURL);
const within = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), 15000))]);
const allowedBeacon = await within(allowedBeaconArrived);
const ownBeacon = await within(ownBeaconArrived.then(() => true));
await page.waitForTimeout(2000);
const foreignLog = foreignRequests.join(' | ');
check('sendBeacon mit Preflight: Cookie und Origin', allowedBeacon?.cookie === 'sitzung=42' && allowedBeacon.origin === siteOrigin
  && foreignRequests.indexOf('OPTIONS /erlaubt') >= 0 && foreignRequests.indexOf('OPTIONS /erlaubt') < foreignRequests.indexOf('POST /erlaubt'), JSON.stringify(allowedBeacon) + ' ' + foreignLog);
check('sendBeacon: abgelehnter Preflight, kein POST', foreignRequests.includes('OPTIONS /verboten') && !foreignRequests.includes('POST /verboten'), foreignLog);
check('sendBeacon: Redirect ohne CORS-Header endet', foreignRequests.includes('POST /umleiten') && !foreignRequests.some((line) => line.endsWith('/umleiten-ziel')), foreignLog);
check('sendBeacon: connect-src gilt nach Redirect', ownBeacon === true && !foreignRequests.some((line) => line.endsWith('/csp-ziel')), foreignLog);

// 3f) Favicon: /favicon.ico leitet um, das Icon kommt trotzdem in den Tab
const icon = await page.waitForFunction(() => {
  const img = document.querySelector('#tab-list .tab .icon');
  return !img.hidden && img.src.startsWith('blob:') && img.naturalWidth === 1;
}, null, { timeout: 15000 }).then(() => true, () => false);
check('Favicon hinter einem Redirect', icon);

// 3g) <object>/<embed>: SVG und HTML als Frame, GIF als Bild, unbekanntes Plugin zeigt den Ersatzinhalt
const objects = await result('objects');
check('<object>/<embed>', objects === 'svg,svg,Eingebettet,1x1,true', objects);

// 4) Datei-Upload
const uploadFile = path.join(root, 'build', 'e2e-upload.txt');
writeFileSync(uploadFile, 'Upload-Inhalt 123\n');
// Typ nach der Endung wie in Chrome (File.type, Content-Type im Formular)
const uploadFiles = [uploadFile, ...['mp4', 'csv', 'docx', 'zip'].map((extension) => {
  const file = path.join(root, 'build', 'e2e-upload.' + extension);
  writeFileSync(file, 'x');
  return file;
})];
const chooserPromise = page.waitForEvent('filechooser', { timeout: 30000 }).catch(() => null);
await page.mouse.click(...await at(60, 220));
const chooser = await chooserPromise;
if (chooser) {
  await chooser.setFiles(uploadFiles);
  const types = await result('filetypes');
  check('Dateityp nach der Endung (File.type)', types === 'txt:text/plain,mp4:video/mp4,csv:text/csv,'
    + 'docx:application/vnd.openxmlformats-officedocument.wordprocessingml.document,zip:application/zip', types);
  check('Datei lesen (FileReader)', (await result('fileread')) === 'Upload-Inhalt 123');
  check('Datei hochladen (fetch + FormData)', (await result('upload')) === 'angekommen', results.get('upload'));
} else {
  check('Datei-Upload', false, 'kein Dateidialog');
}

// 5) Popup (target=_blank) wird ein neuer Tab
await page.mouse.click(...await at(40, 138));
const popup = await result('popup');
const tabCount = await page.evaluate(() => document.querySelectorAll('#tab-list .tab').length);
check('Popup als neuer Tab', popup === 'Popup-Seite' && tabCount === 2, `Titel ${popup}, ${tabCount} Tabs`);

// Zurueck zum ersten Tab
await page.click('#tab-list .tab:first-child .title');

// 5a) Dialoge: mit der Herkunft der Seite; aus einem Hintergrund-Tab gleich
// beantwortet, ohne Dialog
await page.evaluate(() => {
  window.__dialogs = [];
  window.confirm = (text) => { window.__dialogs.push(text); return true; };
  window.alert = (text) => { window.__dialogs.push(text); };
});
await page.evaluate(() => window.blTest.eval('console.log("RESULT confirm=" + confirm("Wirklich?"))'));
const confirmed = await result('confirm');
const dialogs = await page.evaluate(() => window.__dialogs);
check('confirm mit Herkunft', confirmed === 'true' && dialogs.length === 1 && dialogs[0] === new URL(siteURL).host + ' says:\n\nWirklich?', JSON.stringify(dialogs));
await page.evaluate(() => window.blTest.eval('setTimeout(() => console.log("RESULT bgalert=" + alert("Hintergrund")), 2000)'));
await page.click('#tab-list .tab:nth-child(2) .title');
const backgroundAlert = await result('bgalert');
check('alert aus Hintergrund-Tab ohne Dialog', backgroundAlert === 'undefined' && (await page.evaluate(() => window.__dialogs.length)) === 1, String(backgroundAlert));
// Zeichen am Tab, bis er wieder vorne ist
const dialogMarker = (n) => page.evaluate((n) => !document.querySelector(`#tab-list .tab:nth-child(${n}) .dialog-blocked`).hidden, n);
check('Unterdrueckter Dialog: Zeichen am Hintergrund-Tab', await dialogMarker(1));
await page.click('#tab-list .tab:first-child .title');
check('Unterdrueckter Dialog: Zeichen weg, wenn der Tab vorne ist', !await dialogMarker(1));

// 5a2) Viele Dialoge kurz hintereinander: nach drei fragt die Oberflaeche
// einmal, ob die Seite weitere zeigen darf. Nein sperrt den Tab, eine neue
// Seite gibt ihn wieder frei. Im Popup-Tab, die Seite hier bleibt.
await page.click('#tab-list .tab:nth-child(2) .title');
await page.evaluate(() => {
  window.__dialogs = [];
  window.alert = (text) => { window.__dialogs.push(text); };
  window.confirm = (text) => { window.__dialogs.push(text); return !text.includes('many dialogs'); };
});
await page.evaluate(() => window.blTest.eval('for (let i = 0; i < 6; i++) alert("Schleife " + i); console.log("RESULT loopdone=1")'));
await result('loopdone');
const loopDialogs = await page.evaluate(() => window.__dialogs.map((text) => text.split('\n').pop()));
check('Dialog-Schleife: drei Dialoge, eine Rueckfrage, dann gesperrt', loopDialogs.length === 4 && loopDialogs[2] === 'Schleife 2'
  && loopDialogs[3].includes('is showing many dialogs'), JSON.stringify(loopDialogs));
check('Dialog-Schleife: Zeichen am gesperrten Tab', await dialogMarker(2));
results.delete('popup');
await page.evaluate(() => window.blTest.eval('location.reload()'));
await result('popup');
await page.evaluate(() => window.blTest.eval('alert("Nach dem Neuladen"); console.log("RESULT reloaddone=1")'));
await result('reloaddone');
check('Dialog-Schleife: neue Seite gibt den Tab frei', (await page.evaluate(() => window.__dialogs.at(-1))).endsWith('Nach dem Neuladen') && !await dialogMarker(2));
await page.click('#tab-list .tab:first-child .title');

// 5b) Rechtsklick: eigenes Menue der Seite bekommt das Event, unser Menue bleibt zu
await page.mouse.click(...await at(470, 50), { button: 'right' });
check('Rechtsklick: Menue der Seite', (await result('ownmenu')) === '1');
await page.waitForTimeout(500);
check('Rechtsklick: unser Menue bleibt zu', await page.evaluate(() => !document.querySelector('.bl-context-menu')));

// 5c) Rechtsklick auf den Link: unser Menue, "Link in neuem Tab oeffnen"
await page.mouse.click(...await at(40, 138), { button: 'right' });
const menuItem = page.locator('.bl-context-menu button[data-bl-item=open-link]', { hasText: 'Open link in new tab' });
const menuShown = await menuItem.waitFor({ timeout: 10000 }).then(() => true, () => false);
check('Rechtsklick auf Link: Menue', menuShown);
if (menuShown) {
  await menuItem.click();
  await page.waitForFunction(() => document.querySelectorAll('#tab-list .tab').length === 3, null, { timeout: 30000 }).catch(() => {});
  check('Link in neuem Tab geoeffnet', (await page.evaluate(() => document.querySelectorAll('#tab-list .tab').length)) === 3);
  await page.click('#tab-list .tab:first-child .title');
}

// 5d) <select>: Klick oeffnet unsere Liste, die Auswahl kommt bei der Seite an
const selectPopup = async () => {
  await page.mouse.click(...await at(60, 312));
  return page.waitForSelector('.bl-select-popup .bl-option', { timeout: 10000 }).then(() => true, () => false);
};
let popupShown = await selectPopup();
const popupRows = await page.evaluate(() => [...document.querySelectorAll('.bl-select-popup > div')].map((d) => d.classList[0].replace('bl-', '') + ':' + d.textContent.trim()).join('|'));
check('select: Liste geht auf', popupShown && popupRows === 'option:Eins|group:Gruppe|option:Zwei|option:Drei', popupRows);
if (popupShown) {
  await page.locator('.bl-select-popup .bl-option', { hasText: 'Drei' }).click();
  check('select: Auswahl mit der Maus', (await result('select')) === 'c', results.get('select'));
}
results.delete('select');
popupShown = await selectPopup();
await page.keyboard.press('ArrowUp');
await page.keyboard.press('Enter');
check('select: Auswahl mit der Tastatur', popupShown && (await result('select')) === 'b', results.get('select'));
results.delete('select');
popupShown = await selectPopup();
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
check('select: Esc schliesst ohne Auswahl', popupShown && !results.has('select') && await page.evaluate(() => !document.querySelector('.bl-select-popup')));

// 5e) Link unter der Maus: Adresse unten links, title als Tooltip
await page.mouse.move(...await at(40, 352));
const linkShown = await page.waitForFunction(() => {
  const status = document.querySelector('.bl-link-status');
  return status && !status.hidden && status.textContent.endsWith('/ziel');
}, null, { timeout: 10000 }).then(() => true, () => false);
check('Link-Adresse unten links', linkShown);
const tooltip = await page.evaluate(() => [...document.querySelectorAll('canvas[data-bl-view]')].find((c) => c.style.display !== 'none').title);
check('Tooltip (title)', tooltip === 'Ein Tipp', JSON.stringify(tooltip));
await page.mouse.move(...await at(600, 600));
check('Link-Adresse geht wieder weg', await page.waitForFunction(() => document.querySelector('.bl-link-status')?.hidden, null, { timeout: 10000 }).then(() => true, () => false));

// 5f) Farbe: verstecktes Farbfeld des Host-Browsers, Wert geht an die Seite
await page.mouse.click(...await at(50, 395));
const colorPicker = await page.waitForSelector('input.bl-host-picker[type=color]', { state: 'attached', timeout: 10000 }).then(() => true, () => false);
check('Farbauswahl geht auf', colorPicker);
if (colorPicker) {
  const startValue = await page.evaluate(() => document.querySelector('input.bl-host-picker').value);
  await page.evaluate(() => {
    const input = document.querySelector('input.bl-host-picker');
    input.value = '#445566';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  check('Farbe kommt bei der Seite an', startValue === '#112233' && (await result('color')) === '#445566', `${startValue} -> ${results.get('color')}`);
}

// 5g) Datum: verstecktes Datumsfeld des Host-Browsers
await page.mouse.click(...await at(165, 443));
const datePicker = await page.waitForSelector('input.bl-host-picker[type=date]', { state: 'attached', timeout: 10000 }).then(() => true, () => false);
check('Datumsauswahl geht auf', datePicker);
if (datePicker) {
  await page.evaluate(() => {
    const input = document.querySelector('input.bl-host-picker');
    input.value = '2027-03-04';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  check('Datum kommt bei der Seite an', (await result('date')) === '2027-03-04', results.get('date'));
}

// 5h) Suchen auf der Seite (Strg+F): Treffer zaehlen, Esc schliesst
await page.mouse.click(...await at(600, 600));
await page.keyboard.press('Control+f');
const findOpen = await page.waitForSelector('#find-bar:not([hidden])', { timeout: 5000 }).then(() => true, () => false);
await page.keyboard.type('Darueber');
const findCount = await page.waitForFunction(() => document.getElementById('find-count').textContent.includes(' of '), null, { timeout: 10000 })
  .then(() => page.evaluate(() => document.getElementById('find-count').textContent), () => null);
check('Suchen auf der Seite', findOpen && findCount === '1 of 1', String(findCount));
await page.keyboard.press('Escape');
check('Suche schliessen', await page.evaluate(() => document.getElementById('find-bar').hidden));

// 5i) Zoom (Strg +): die Seite wird schmaler in CSS-Pixeln, Anzeige 110 %
results.delete('width');
await page.keyboard.press('Control+=');
const zoomWidth = await result('width', 10000);
const zoomLabel = await page.evaluate(() => document.getElementById('zoom').textContent);
check('Zoom', zoomLabel === '110 %' && Number(zoomWidth) < 950, `${zoomLabel}, innerWidth ${zoomWidth}`);
results.delete('width');
await page.keyboard.press('Control+0');
const resetWidth = await result('width', 10000);
check('Zoom zuruecksetzen', Number(resetWidth) >= 950 && await page.evaluate(() => document.getElementById('zoom').hidden), String(resetWidth));

// 6) Scrollen mit dem Mausrad
await page.mouse.move(...await at(500, 400));
await page.mouse.wheel(0, 600);
const scroll = await result('scroll');
check('Scrollen', Number(scroll) > 100, String(scroll));

// 7) Vollbild: die Seite fordert es an, die Oberflaeche macht den Bereich gross;
// beendet der Host-Browser es (wie mit Esc), merkt es auch die Seite
await page.mouse.wheel(0, -2000);
await page.waitForTimeout(500);
await page.mouse.click(...await at(60, 265));
const fullscreenClick = await result('fsclick', 10000);
const fullscreen = await result('fs');
const hostFullscreen = await page.waitForFunction(() => document.fullscreenElement?.id === 'pages', null, { timeout: 10000 }).then(() => true, () => false);
check('Vollbild (requestFullscreen)', fullscreen === 'ok' && (await result('fson')) === '1' && hostFullscreen, `Klick: ${fullscreenClick}, Seite: ${fullscreen}, Host: ${hostFullscreen}`);
await page.evaluate(() => document.exitFullscreen().catch(() => {}));
check('Vollbild beenden kommt bei der Seite an', (await result('fsoff')) === '1');

await screenshot(page, 'input');
await browser.close();
finish();
