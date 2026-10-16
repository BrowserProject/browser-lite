// End-to-End Test fuer die Oberflaeche (web/library.js): Verlauf, Lesezeichen,
// Vorschlaege in der Adressleiste, Suchmaschine, Sitzung wiederherstellen
// (Hintergrund-Tabs laden erst beim Anklicken), ?relay=/?token=/?env= aus der URL,
// Haengen und Absturz der Engine mit Neustart (web/watchdog.js).
//
//   cd tests/e2e && node ui-test.mjs [engine-ordner]
import { TIMEOUT, VERBOSE, check, finish, launch, serve, startStack, timeLimit } from './harness.mjs';

timeLimit();

const loads = new Map();
// Lange Seite zum Drucken: drei Abschnitte mit Seitenumbruch, ein Teil nur auf dem Bildschirm
const PRINT_PAGE = `<!doctype html><title>Seite drucken</title><style>@media print { .screen { display: none } } section { break-after: page }</style>
<div class="screen">Nur Bildschirm</div><section>Erste Druckseite</section><section>Zweite Druckseite</section><section>Dritte Druckseite</section>
<script>addEventListener('beforeprint', () => console.log('RESULT print=before')); addEventListener('afterprint', () => console.log('RESULT print=after')); console.log('RESULT loaded=' + document.title)</script>`;
const page = (title) => title === 'Seite drucken' ? PRINT_PAGE : title === 'Seite links'
  ? `<!doctype html><title>${title}</title><body style="margin:0"><a id="l" href="/ziel" style="display:block;width:300px;height:60px;background:#9cf">Link</a><script>console.log('RESULT loaded=' + document.title)</script>`
  : `<!doctype html><title>${title}</title><h1>${title}</h1><script>console.log('RESULT loaded=' + document.title); addEventListener('pageshow', (e) => { if (e.persisted) console.log('RESULT loaded=' + document.title + ' [cache]'); })</script>`;
const { url: siteURL } = await serve((req, res) => {
  const name = req.url.slice(1) || 'start';
  loads.set(name, (loads.get(name) || 0) + 1);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Seite ' + name));
});

const stack = await startStack({ token: 'ui-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const tab = await context.newPage();
let loaded = [];
const printEvents = [];
tab.on('console', (msg) => {
  const printMatch = /RESULT print=(\w+)/.exec(msg.text());
  if (printMatch)
    printEvents.push(printMatch[1]);
  if (VERBOSE)
    console.log('   ', msg.text());
  const match = /RESULT loaded=(.*?)(\s+\(|$)/.exec(msg.text());
  if (match)
    loaded.push(match[1]);
});
// Geladen oder aus dem Back/Forward-Cache gezeigt ("Titel [cache]")
async function waitLoaded(title, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (loaded.includes(title) || loaded.includes(title + ' [cache]'))
      return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
async function go(address) {
  await tab.click('#address');
  await tab.fill('#address', address);
  await tab.press('#address', 'Enter');
}

await tab.goto(stack.app({ url: siteURL + 'eins' }));
check('Erste Seite', await waitLoaded('Seite eins', TIMEOUT));
await go(siteURL + 'zwei');
check('Zweite Seite ueber die Adressleiste', await waitLoaded('Seite zwei'));
// Zurueck und Vor (Knoepfe der Oberflaeche)
await tab.waitForFunction(() => !document.getElementById('back').disabled, null, { timeout: 10000 }).catch(() => {});
check('Zurueck-Knopf aktiv', await tab.evaluate(() => !document.getElementById('back').disabled));
loaded = [];
const einsLoads = loads.get('eins') || 0;
await tab.click('#back');
check('Zurueck: erste Seite sofort aus dem Back/Forward-Cache (pageshow persisted, kein Neuladen)', await waitLoaded('Seite eins [cache]') && (loads.get('eins') || 0) === einsLoads, `${loaded.join('|')}, ${loads.get('eins')} Aufrufe`);
await tab.waitForFunction(() => !document.getElementById('forward').disabled, null, { timeout: 10000 }).catch(() => {});
loaded = [];
await tab.click('#forward');
check('Vor: zweite Seite aus dem Cache', await waitLoaded('Seite zwei [cache]'), loaded.join('|'));

// Verlauf (Strg+H): beide Seiten, neueste zuerst
await tab.keyboard.press('Control+h');
const history = await tab.locator('#side-panel .panel-title').allTextContents();
// eins, zwei, zurueck zu eins, vor zu zwei (neueste zuerst)
check('Verlauf', JSON.stringify(history.slice(0, 4)) === JSON.stringify(['Seite zwei', 'Seite eins', 'Seite zwei', 'Seite eins']), JSON.stringify(history.slice(0, 4)));
await tab.keyboard.press('Escape');
check('Panel mit Esc zu', await tab.evaluate(() => document.getElementById('side-panel').hidden));

// Lesezeichen (Stern), Panel Strg+Umschalt+O
await tab.click('#bookmark');
check('Stern aktiv', await tab.evaluate(() => document.getElementById('bookmark').classList.contains('active')));
await tab.keyboard.press('Control+Shift+O');
const bookmarks = await tab.locator('#side-panel .panel-title').allTextContents();
check('Lesezeichen im Panel', bookmarks.length === 1 && bookmarks[0] === 'Seite zwei', JSON.stringify(bookmarks));
await tab.keyboard.press('Escape');

// Vorschlaege: "eins" tippen findet die erste Seite aus dem Verlauf
await tab.click('#address');
await tab.fill('#address', '');
await tab.type('#address', 'eins');
const suggestion = await tab.locator('#suggestions:not([hidden]) .suggestion-url').first().textContent({ timeout: 5000 }).catch(() => null);
check('Vorschlag aus dem Verlauf', suggestion === siteURL + 'eins', String(suggestion));
loaded = [];
await tab.keyboard.press('ArrowDown');
await tab.keyboard.press('Enter');
check('Vorschlag oeffnen', await waitLoaded('Seite eins'));

// Suchmaschine in den Einstellungen: Text ohne Punkt wird eine Suche
await tab.click('#menu-button');
await tab.locator('#side-panel .panel-menu-item', { hasText: 'Einstellungen' }).click();
await tab.selectOption('#setting-search', 'google');
const searchURL = await tab.evaluate(async () => (await import('./library.js')).addressToURL('wetter bern'));
check('Suchmaschine', searchURL === 'https://www.google.com/search?q=wetter%20bern', searchURL);
await tab.keyboard.press('Escape');

// Sitzung: zweiter Tab, dann die Oberflaeche ohne ?url= neu oeffnen
await tab.click('#new-tab');
await go(siteURL + 'drei');
check('Dritte Seite im neuen Tab', await waitLoaded('Seite drei'));
await tab.waitForTimeout(500);
const loadsBefore = loads.get('eins') || 0;
loaded = [];
await tab.goto(stack.app());
check('Sitzung: aktiver Tab laedt wieder', await waitLoaded('Seite drei', TIMEOUT));
const titles = await tab.locator('#tab-list .tab .title').allTextContents();
check('Sitzung: beide Tabs da', titles.length === 2 && titles[0] === 'Seite eins' && titles[1] === 'Seite drei', JSON.stringify(titles));
await tab.waitForTimeout(1500);
check('Sitzung: Hintergrund-Tab laedt noch nicht', (loads.get('eins') || 0) === loadsBefore, `${loads.get('eins')} Aufrufe`);
await tab.click('#tab-list .tab:first-child .title');
check('Sitzung: Hintergrund-Tab laedt beim Anklicken', await waitLoaded('Seite eins'));
// Zurueck/Vor des Tabs wie vor dem Neustart (eins -> zwei -> eins)
await tab.waitForFunction(() => !document.getElementById('back').disabled, null, { timeout: 10000 }).catch(() => {});
check('Sitzung: Zurueck geht nach dem Neustart', await tab.evaluate(() => !document.getElementById('back').disabled));
loaded = [];
await tab.click('#back');
check('Sitzung: Zurueck laedt die vorige Seite', await waitLoaded('Seite zwei'));
loaded = [];
await tab.click('#forward');
check('Sitzung: Vor laedt wieder die letzte Seite', await waitLoaded('Seite eins'));

// Wenig Speicher: der Hintergrund-Tab wird verworfen und laedt beim Anklicken neu
const dreiBefore = loads.get('drei') || 0;
const discarded = await tab.evaluate(() => window.__blCheckMemory(1));
const titlesAfter = await tab.locator('#tab-list .tab .title').allTextContents();
check('Speicher knapp: Hintergrund-Tab verworfen, Titel bleibt', discarded > 0 && JSON.stringify(titlesAfter) === JSON.stringify(['Seite eins', 'Seite drei']), `${discarded} ${JSON.stringify(titlesAfter)}`);
check('Aktiver Tab wird nie verworfen', await tab.evaluate(() => window.__blCheckMemory()) === 0);
await tab.evaluate(() => window.__blCheckMemory(2.5 * 1024 ** 3));
loaded = [];
await tab.click('#tab-list .tab:nth-child(2) .title');
check('Verworfener Tab laedt beim Anklicken neu', await waitLoaded('Seite drei') && (loads.get('drei') || 0) === dreiBefore + 1, `${loads.get('drei')} Aufrufe`);
await tab.click('#tab-list .tab:first-child .title');
check('Zurueck zum ersten Tab', await tab.evaluate(() => document.querySelector('#tab-list .tab.active .title')?.textContent) === 'Seite eins');

// Links: Strg+Klick und Mittelklick oeffnen je einen Tab im Hintergrund
await go(siteURL + 'links');
check('Seite mit Link', await waitLoaded('Seite links'));
const tabCount = () => tab.locator('#tab-list .tab').count();
const before = await tabCount();
const box = await tab.evaluate(() => {
  const rect = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none').getBoundingClientRect();
  return { x: rect.left + 100, y: rect.top + 30 };
});
await tab.keyboard.down('Control');
await tab.mouse.click(box.x, box.y);
await tab.keyboard.up('Control');
await tab.waitForTimeout(1500);
check('Strg+Klick: neuer Tab im Hintergrund', (await tabCount()) === before + 1 && (await tab.evaluate(() => document.querySelector('#tab-list .tab.active .title')?.textContent)) === 'Seite links', `${await tabCount()} Tabs`);
await tab.mouse.click(box.x, box.y, { button: 'middle' });
await tab.waitForTimeout(1500);
check('Mittelklick: genau ein neuer Tab', (await tabCount()) === before + 2, `${await tabCount()} Tabs`);
check('Sicherheitsanzeige bei HTTP', await tab.evaluate(() => !document.getElementById('security').hidden && document.getElementById('security').textContent === 'Nicht sicher'));

// Quelltext (Strg+U): neuer Tab mit dem HTML der Seite
await tab.locator('#tab-list .tab.active .title').click();
await tab.keyboard.press('Control+u');
const sourceTab = await tab.waitForFunction(() => document.querySelector('#tab-list .tab.active .title')?.textContent?.startsWith('view-source:'), null, { timeout: 15000 }).then(() => true, () => false);
check('Quelltext anzeigen (Strg+U)', sourceTab, await tab.evaluate(() => document.querySelector('#tab-list .tab.active .title')?.textContent));

// Drucken: window.print() der Seite und Strg+P zeigen die Vorschau mit dem PDF der Engine
await tab.locator('#tab-list .tab.active .title').click();
await go(siteURL + 'drucken');
check('Seite zum Drucken', await waitLoaded('Seite drucken'));
await tab.evaluate(() => window.__blEval('window.print()'));
const preview = tab.locator('#print-preview:not([hidden]) iframe');
const previewShown = await preview.waitFor({ state: 'attached', timeout: 20000 }).then(() => true, () => false);
const pdf = previewShown ? await tab.evaluate(async () => {
  const src = document.querySelector('#print-preview iframe').src;
  const text = new TextDecoder('latin1').decode(await (await fetch(src)).arrayBuffer());
  return { header: text.slice(0, 5), pages: (text.match(/\/Type\s*\/Page\b/g) || []).length };
}) : null;
check('window.print(): Druckvorschau mit PDF', pdf && pdf.header === '%PDF-', JSON.stringify(pdf));
check('PDF hat drei Seiten (break-after, @media print)', pdf && pdf.pages === 3, JSON.stringify(pdf));
check('beforeprint und afterprint', printEvents.join(',') === 'before,after', printEvents.join(','));
await tab.keyboard.press('Escape');
check('Vorschau mit Esc zu', await tab.evaluate(() => document.getElementById('print-preview').hidden));
await tab.locator('#tab-list .tab.active .title').click();
await tab.keyboard.press('Control+p');
check('Strg+P zeigt die Vorschau', await preview.waitFor({ state: 'attached', timeout: 20000 }).then(() => true, () => false));
await tab.evaluate(() => document.querySelector('#print-preview .print-close').click());

// ?relay= gilt nur fuer diesen Browser-Tab, der Token nur fuer genau dieses Relay
const relayState = await tab.evaluate((host) => ({ local: localStorage.getItem('bl-relay-url'), session: sessionStorage.getItem('bl-relay-url'),
  token: localStorage.getItem('bl-relay-token ' + host), url: window.__blEngine().blTransport.url }), `127.0.0.1:${stack.relayPort}`);
check('?relay= nur fuer die Sitzung, nicht im localStorage', relayState.local === null && relayState.session === stack.relayURL, JSON.stringify(relayState));
check('Token gehoert zu diesem Relay', relayState.token === stack.token && relayState.url === `${stack.relayURL}?token=${stack.token}`, relayState.url);
// Leeres ?relay= nimmt wieder das eigene Relay, ohne fremden Token. ?env= setzt nur Schalter der Engine.
await tab.goto(`${stack.uiURL}?relay=&env=BL_EXTRA_CA=x,SSLKEYLOGFILE=/tmp/keys,https_proxy=http://boese,BL_TEST_FLAG=1&url=about:blank`);
await tab.waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: TIMEOUT });
const envState = await tab.evaluate(() => {
  const engine = window.__blEngine();
  return { ca: engine.ENV.BL_EXTRA_CA ?? null, keys: engine.ENV.SSLKEYLOGFILE ?? null, proxy: engine.ENV.https_proxy ?? null, flag: engine.ENV.BL_TEST_FLAG ?? null,
    url: engine.blTransport.url, session: sessionStorage.getItem('bl-relay-url') };
});
check('?env=BL_EXTRA_CA und fremde Variablen werden ignoriert', envState.ca === null && envState.keys === null && envState.proxy === null && envState.flag === '1', JSON.stringify(envState));
check('Leeres ?relay=: eigenes Relay ohne Token', envState.session === null && envState.url === `ws://localhost:${stack.uiPort}/wisp/`, envState.url);

// Zwei Tabs fuer Haengen und Absturz
loaded = [];
await tab.goto(stack.app({ url: siteURL + 'vorher' }));
check('Absturz: erster Tab', await waitLoaded('Seite vorher', TIMEOUT));
await tab.click('#new-tab');
await go(siteURL + 'nachher');
check('Absturz: zweiter Tab', await waitLoaded('Seite nachher'));
await tab.waitForTimeout(500);
const bootText = () => tab.evaluate(() => (document.getElementById('boot').hidden ? '' : document.getElementById('boot').textContent));
const waitBoot = (text, timeout) => tab.waitForFunction((t) => !document.getElementById('boot').hidden && document.getElementById('boot').textContent.includes(t), text, { timeout }).then(() => true, () => false);

// Haengen: ein Skript blockiert den Engine-Thread, Neu laden bekommt keine Antwort
await tab.evaluate(() => window.__blEval('(() => { const end = Date.now() + 16000; while (Date.now() < end); return 1; })()'));
await tab.waitForTimeout(300);
await tab.click('#reload');
check('Haengen: Meldung nach 10 s ohne Antwort', await waitBoot('reagiert nicht', 14000), await bootText());
check('Haengen: Meldung geht weg, sobald die Engine wieder antwortet', await tab.waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: 15000 }).then(() => true, () => false));

// Absturz: Fehler aus dem Engine-Thread (Emscripten wirft ihn im Haupt-Thread weiter)
await tab.evaluate(() => window.__blEngine().blEngineWorker().postMessage({ blSink: { id: 1, writable: {} } }));
check('Absturz: Meldung mit Neu starten', await waitBoot('abgestürzt', 10000) && await tab.locator('#boot button.primary').textContent() === 'Neu starten', await bootText());
loaded = [];
const vorherLoads = loads.get('vorher') || 0;
await tab.click('#boot button.primary');
check('Absturz: Neustart laedt den aktiven Tab wieder', await waitLoaded('Seite nachher', TIMEOUT));
const restartURL = new URL(tab.url());
const restoredTitles = await tab.waitForFunction(() => {
  const titles = [...document.querySelectorAll('#tab-list .tab .title')].map((t) => t.textContent);
  return titles.join('|') === 'Seite vorher|Seite nachher' && titles;
}, null, { timeout: 10000 }).then((h) => h.jsonValue(), () => tab.locator('#tab-list .tab .title').allTextContents());
check('Absturz: Neustart ohne ?url=, mit der Sitzung', !restartURL.searchParams.has('url') && restoredTitles.join('|') === 'Seite vorher|Seite nachher',
  `${restartURL.search} ${JSON.stringify(restoredTitles)}`);
check('Absturz: Hintergrund-Tab laedt noch nicht', (loads.get('vorher') || 0) === vorherLoads);

// Gleich wieder ein Absturz (abort der Engine): danach laden die Tabs erst beim Anklicken
const nachherLoads = loads.get('nachher') || 0;
await tab.waitForFunction(() => window.__blEngine?.()?.onAbort && document.getElementById('boot').hidden, null, { timeout: 10000 }).catch(() => {});
await tab.evaluate(() => window.__blEngine().onAbort('Test'));
check('Zweiter Absturz: Meldung', await waitBoot('Schon wieder', 5000), await bootText());
await tab.click('#boot button.primary');
await tab.waitForFunction(() => document.getElementById('boot').hidden && document.querySelectorAll('#tab-list .tab').length === 3, null, { timeout: TIMEOUT }).catch(() => {});
await tab.waitForTimeout(1500);
const safeTitles = await tab.locator('#tab-list .tab .title').allTextContents();
check('Zweiter Absturz: Tabs da, aber nicht geladen', safeTitles.length === 3 && safeTitles[0] === 'Seite vorher' && safeTitles[1] === 'Seite nachher'
  && (loads.get('nachher') || 0) === nachherLoads && (loads.get('vorher') || 0) === vorherLoads, `${JSON.stringify(safeTitles)} ${loads.get('nachher')}`);
const safeStatus = await tab.locator('#status').textContent();
check('Zweiter Absturz: Hinweis in der Statuszeile', safeStatus === 'Nach dem Neustart laden die Tabs erst beim Anklicken', safeStatus);

await browser.close();
finish();
