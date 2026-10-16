// End-to-End Test fuer Eingabe und Oberflaeche im echten Chromium:
// Tippen (auch Umlaute), Klicken, Scrollen, Popup als neuer Tab, Download
// und Datei-Upload. Die Testseite meldet Ergebnisse ueber console.log
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
</style></head>
<body>
<input id="text" autocomplete="off">
<button id="button">Klick</button>
<a id="popup" href="/popup.html" target="_blank">Popup</a>
<a id="download" href="/datei.txt">Download</a>
<input id="file" type="file">
<button id="fs">Vollbild</button>
<select id="sel"><option value="a">Eins</option><optgroup label="Gruppe"><option value="b">Zwei</option><option value="c">Drei</option></optgroup></select>
<a id="hoverlink" href="/ziel" title="Ein Tipp">Darueber fahren</a>
<input id="color" type="color" value="#112233">
<input id="date" type="date" value="2026-10-12">
<div id="own-menu" style="position:absolute;left:400px;top:20px;width:150px;height:60px;background:#ddd">eigenes Menue</div>
<script>
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
    const file = e.target.files[0];
    console.log('RESULT fileread=' + (await file.text()).trim());
    const form = new FormData();
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

const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  } else if (req.url === '/popup.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(POPUP);
  } else if (req.url === '/datei.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="gruezi.txt"' }).end('Inhalt vom Download\n');
  } else if (req.url === '/upload' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(body.includes('Upload-Inhalt 123') ? 'angekommen' : 'fehlt');
    });
  } else {
    res.writeHead(404).end();
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

// 4) Datei-Upload
const uploadFile = path.join(root, 'build', 'e2e-upload.txt');
writeFileSync(uploadFile, 'Upload-Inhalt 123\n');
const chooserPromise = page.waitForEvent('filechooser', { timeout: 30000 }).catch(() => null);
await page.mouse.click(...await at(60, 220));
const chooser = await chooserPromise;
if (chooser) {
  await chooser.setFiles(uploadFile);
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

// 5b) Rechtsklick: eigenes Menue der Seite bekommt das Event, unser Menue bleibt zu
await page.mouse.click(...await at(470, 50), { button: 'right' });
check('Rechtsklick: Menue der Seite', (await result('ownmenu')) === '1');
await page.waitForTimeout(500);
check('Rechtsklick: unser Menue bleibt zu', await page.evaluate(() => document.getElementById('context-menu').hidden));

// 5c) Rechtsklick auf den Link: unser Menue, "Link in neuem Tab oeffnen"
await page.mouse.click(...await at(40, 138), { button: 'right' });
const menuItem = page.locator('#context-menu button', { hasText: 'Link in neuem Tab öffnen' });
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
  return page.waitForSelector('#select-popup:not([hidden]) .option', { timeout: 10000 }).then(() => true, () => false);
};
let popupShown = await selectPopup();
const popupRows = await page.evaluate(() => [...document.querySelectorAll('#select-popup > div')].map((d) => d.classList[0] + ':' + d.textContent.trim()).join('|'));
check('select: Liste geht auf', popupShown && popupRows === 'option:Eins|group:Gruppe|option:Zwei|option:Drei', popupRows);
if (popupShown) {
  await page.locator('#select-popup .option', { hasText: 'Drei' }).click();
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
check('select: Esc schliesst ohne Auswahl', popupShown && !results.has('select') && await page.evaluate(() => document.getElementById('select-popup').hidden));

// 5e) Link unter der Maus: Adresse unten links, title als Tooltip
await page.mouse.move(...await at(40, 352));
const linkShown = await page.waitForFunction(() => {
  const status = document.getElementById('link-status');
  return !status.hidden && status.textContent.endsWith('/ziel');
}, null, { timeout: 10000 }).then(() => true, () => false);
check('Link-Adresse unten links', linkShown);
const tooltip = await page.evaluate(() => [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none').title);
check('Tooltip (title)', tooltip === 'Ein Tipp', JSON.stringify(tooltip));
await page.mouse.move(...await at(600, 600));
check('Link-Adresse geht wieder weg', await page.waitForFunction(() => document.getElementById('link-status').hidden, null, { timeout: 10000 }).then(() => true, () => false));

// 5f) Farbe: verstecktes Farbfeld des Host-Browsers, Wert geht an die Seite
await page.mouse.click(...await at(50, 395));
const colorPicker = await page.waitForSelector('input.host-picker[type=color]', { state: 'attached', timeout: 10000 }).then(() => true, () => false);
check('Farbauswahl geht auf', colorPicker);
if (colorPicker) {
  const startValue = await page.evaluate(() => document.querySelector('input.host-picker').value);
  await page.evaluate(() => {
    const input = document.querySelector('input.host-picker');
    input.value = '#445566';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  check('Farbe kommt bei der Seite an', startValue === '#112233' && (await result('color')) === '#445566', `${startValue} -> ${results.get('color')}`);
}

// 5g) Datum: verstecktes Datumsfeld des Host-Browsers
await page.mouse.click(...await at(165, 443));
const datePicker = await page.waitForSelector('input.host-picker[type=date]', { state: 'attached', timeout: 10000 }).then(() => true, () => false);
check('Datumsauswahl geht auf', datePicker);
if (datePicker) {
  await page.evaluate(() => {
    const input = document.querySelector('input.host-picker');
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
const findCount = await page.waitForFunction(() => document.getElementById('find-count').textContent.includes('von'), null, { timeout: 10000 })
  .then(() => page.evaluate(() => document.getElementById('find-count').textContent), () => null);
check('Suchen auf der Seite', findOpen && findCount === '1 von 1', String(findCount));
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

// 5j) Zwei-Finger-Zoom auf dem Touchpad: viele kleine wheel-Ereignisse mit
// ctrlKey ergeben zusammen eine Stufe (nicht eine pro Ereignis)
await page.evaluate(() => {
  const canvas = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none');
  const rect = canvas.getBoundingClientRect();
  for (let i = 0; i < 20; i++)
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -2.5, ctrlKey: true, clientX: rect.left + 300, clientY: rect.top + 300, bubbles: true, cancelable: true }));
});
check('Touchpad-Pinch: eine Zoom-Stufe', await page.evaluate(() => document.getElementById('zoom').textContent) === '110 %', await page.evaluate(() => document.getElementById('zoom').textContent));
results.delete('width');
await page.keyboard.press('Control+0');
await result('width', 10000);

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
const hostFullscreen = await page.waitForFunction(() => document.fullscreenElement?.id === 'viewport', null, { timeout: 10000 }).then(() => true, () => false);
check('Vollbild (requestFullscreen)', fullscreen === 'ok' && (await result('fson')) === '1' && hostFullscreen, `Klick: ${fullscreenClick}, Seite: ${fullscreen}, Host: ${hostFullscreen}`);
await page.evaluate(() => document.exitFullscreen().catch(() => {}));
check('Vollbild beenden kommt bei der Seite an', (await result('fsoff')) === '1');

await screenshot(page, 'input');
await browser.close();
finish();
