// End-to-End Test fuer die Oberflaeche (web/library.js): Verlauf, Lesezeichen,
// Vorschlaege in der Adressleiste, Suchmaschine, Sitzung wiederherstellen
// (Hintergrund-Tabs laden erst beim Anklicken), ?relay=/?token=/?env= aus der URL,
// Haengen der Engine (Meldung, der Watchdog von JSC bricht das Skript ab, die
// Zeit in einem Dialog zaehlt nicht), echter Absturz (abort, WASM-Trap) mit
// Neustart (web/watchdog.js), Zurueck/Vor, das scheitert, und Stopp.
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
let failNavA = false;
let slowResponse = null;
const { url: siteURL } = await serve((req, res) => {
  const name = req.url.slice(1) || 'start';
  loads.set(name, (loads.get(name) || 0) + 1);
  // Zurueck/Vor, das scheitert: nicht im HTTP-Cache, dann bricht der Server ab
  if (name === 'nav-a') {
    if (failNavA)
      req.socket.destroy();
    else
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page('Seite ' + name));
    return;
  }
  // Die Seite ist zu sehen, der Rest kommt nie (Stopp)
  if (name === 'langsam') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.write('<!doctype html><title>Seite langsam</title><p>Anfang' + ' '.repeat(4096) + '<script>console.log("RESULT loaded=Seite langsam")</script>');
    slowResponse = res;
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Seite ' + name));
});

const stack = await startStack({ token: 'ui-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const tab = await context.newPage();
let loaded = [];
const printEvents = [];
const loadedPattern = /RESULT loaded=(.*?)(\s+\(|$)/;
const pageErrors = [];
tab.on('console', (msg) => {
  if (msg.text().includes('Skript abgebrochen'))
    pageErrors.push(msg.text());
  const printMatch = /RESULT print=(\w+)/.exec(msg.text());
  if (printMatch)
    printEvents.push(printMatch[1]);
  if (VERBOSE)
    console.log('   ', msg.text());
  const match = loadedPattern.exec(msg.text());
  if (match)
    loaded.push(match[1].trim());
});
// Geladen oder aus dem Back/Forward-Cache gezeigt ("Titel [cache]")
async function waitLoaded(title, timeout = 30000, list = loaded) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (list.includes(title) || list.includes(title + ' [cache]'))
      return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
async function go(address, page = tab) {
  await page.click('#address');
  await page.fill('#address', address);
  await page.press('#address', 'Enter');
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

// history.pushState/replaceState (SPA): Adressleiste, Zurueck und Sitzung folgen,
// ohne dass die Seite neu laedt; history.back() geht ueber popstate zurueck
const address = () => tab.evaluate(() => document.getElementById('address').value);
const waitAddress = (url) => tab.waitForFunction((u) => document.getElementById('address').value === u, url, { timeout: 10000 }).then(() => true, () => false);
const sessionURL = () => tab.evaluate(() => JSON.parse(localStorage.getItem('bl-session')).tabs.find((t) => t.active).url);
await tab.evaluate(() => window.__blEval('history.pushState({}, "", "/spa/eins")'));
check('pushState: Adressleiste', await waitAddress(siteURL + 'spa/eins'), await address());
check('pushState: Zurueck aktiv, Sitzung, kein Laden', await tab.evaluate(() => !document.getElementById('back').disabled)
  && await sessionURL() === siteURL + 'spa/eins' && !loads.has('spa/eins'), await sessionURL());
await tab.evaluate(() => window.__blEval('history.replaceState({}, "", "/spa/zwei")'));
check('replaceState: Adressleiste', await waitAddress(siteURL + 'spa/zwei'), await address());
await tab.evaluate(() => window.__blEval('history.back()'));
check('history.back() nach pushState', await waitAddress(siteURL + 'links'), await address());
await tab.evaluate(() => window.__blEval('history.forward()'));
check('history.forward() zur ersetzten Adresse', await waitAddress(siteURL + 'spa/zwei'), await address());

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
// BL_TEST_HOOKS: bl_crash_for_testing geht nur damit
await tab.goto(stack.app({ url: siteURL + 'vorher', env: 'BL_TEST_HOOKS=1,BL_SCRIPT_TIMEOUT=15' }));
check('Absturz: erster Tab', await waitLoaded('Seite vorher', TIMEOUT));
await tab.click('#new-tab');
await go(siteURL + 'nachher');
check('Absturz: zweiter Tab', await waitLoaded('Seite nachher'));
await tab.waitForTimeout(500);
const bootText = () => tab.evaluate(() => (document.getElementById('boot').hidden ? '' : document.getElementById('boot').textContent));
const waitBoot = (text, timeout) => tab.waitForFunction((t) => !document.getElementById('boot').hidden && document.getElementById('boot').textContent.includes(t), text, { timeout }).then(() => true, () => false);

// Haengen: eine Endlosschleife blockiert den Engine-Thread, Neu laden bekommt
// keine Antwort. Nach 15 s (hier eingestellt) bricht der Watchdog
// (engine/src/EngineLoop.cpp) sie ab.
await tab.evaluate(() => window.__blEval('(() => { for (;;); })()'));
await tab.waitForTimeout(300);
loaded = [];
await tab.click('#reload');
check('Haengen: Meldung nach 10 s ohne Antwort', await waitBoot('reagiert nicht', 14000), await bootText());
check('Haengen: Meldung geht weg, sobald der Watchdog das Skript abbricht', await tab.waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: 15000 }).then(() => true, () => false));
check('Haengen: Meldung in der Konsole der Seite', pageErrors.some((text) => /\[seite \d+\] Skript abgebrochen/.test(text)), pageErrors.join(' | '));
check('Haengen: danach laedt der Tab neu', await waitLoaded('Seite nachher'), loaded.join('|'));
await tab.evaluate(() => window.__blEval('setTimeout(() => console.log("RESULT loaded=Timer nach Abbruch"), 10)'));
check('Haengen: Timer laufen weiter', await waitLoaded('Timer nach Abbruch', 10000));

// Absturz: WASM-Trap im Engine-Thread (Emscripten wirft den Fehler des Workers im Haupt-Thread weiter)
await tab.evaluate(() => window.__blEngine()._bl_crash_for_testing(1));
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

// Gleich wieder ein Absturz (abort() im Engine-Thread): danach laden die Tabs erst beim Anklicken
const nachherLoads = loads.get('nachher') || 0;
await tab.waitForFunction(() => window.__blEngine?.()?._bl_crash_for_testing && document.getElementById('boot').hidden, null, { timeout: 10000 }).catch(() => {});
await tab.evaluate(() => window.__blEngine()._bl_crash_for_testing(0));
check('Zweiter Absturz: Meldung', await waitBoot('Schon wieder', 5000), await bootText());
await tab.click('#boot button.primary');
await tab.waitForFunction(() => document.getElementById('boot').hidden && document.querySelectorAll('#tab-list .tab').length === 3, null, { timeout: TIMEOUT }).catch(() => {});
await tab.waitForTimeout(1500);
const safeTitles = await tab.locator('#tab-list .tab .title').allTextContents();
check('Zweiter Absturz: Tabs da, aber nicht geladen', safeTitles.length === 3 && safeTitles[0] === 'Seite vorher' && safeTitles[1] === 'Seite nachher'
  && (loads.get('nachher') || 0) === nachherLoads && (loads.get('vorher') || 0) === vorherLoads, `${JSON.stringify(safeTitles)} ${loads.get('nachher')}`);
const safeStatus = await tab.locator('#status').textContent();
check('Zweiter Absturz: Hinweis in der Statuszeile', safeStatus === 'Nach dem Neustart laden die Tabs erst beim Anklicken', safeStatus);

// Stopp, waehrend die Seite schon zu sehen ist: kein Fehler und kein 'load',
// nur das Laden ist zu Ende. Danach Zurueck/Vor auf einen Eintrag, der nicht
// mehr im Back/Forward-Cache liegt (hoechstens 3 Seiten), und der Server
// bricht ab (curl versucht es auf neuer Verbindung nochmals): Fehler in der
// Statuszeile, der Tab laedt nicht mehr.
const navTab = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
const navLoaded = [];
navTab.on('console', (msg) => {
  const match = loadedPattern.exec(msg.text());
  if (match)
    navLoaded.push(match[1].trim());
});
const navState = () => navTab.evaluate(() => ({ status: document.getElementById('status').textContent, button: document.getElementById('reload').title, loaded: window.__blLoaded }));
await navTab.goto(stack.app({ url: siteURL + 'nav-a' }));
let navPages = await waitLoaded('Seite nav-a', TIMEOUT, navLoaded);
// pushState in einem Iframe legt einen Eintrag der ganzen Seite an: Zurueck
// wird aktiv, der Eintrag hat die Adresse der Seite, nicht die des Iframes
await navTab.evaluate(() => window.__blEval(`const frame = document.createElement('iframe');
  frame.src = '/rahmen';
  frame.onload = () => frame.contentWindow.history.pushState({}, '', '/rahmen-2');
  document.body.append(frame);`));
const framePush = await navTab.waitForFunction(() => !document.getElementById('back').disabled, null, { timeout: 10000 }).then(() => true, () => false);
const frameEntries = await navTab.evaluate(() => JSON.parse(localStorage.getItem('bl-session')).tabs.find((t) => t.active).history.entries.map((e) => e.url));
check('pushState im Iframe: Zurueck aktiv, Eintrag der Seite', framePush && JSON.stringify(frameEntries) === JSON.stringify([siteURL + 'nav-a', siteURL + 'nav-a']), JSON.stringify(frameEntries));
for (const name of ['nav-b', 'nav-c', 'nav-d']) {
  await go(siteURL + name, navTab);
  navPages = navPages && await waitLoaded('Seite ' + name, 30000, navLoaded);
}
check('Stopp/Zurueck: vier Seiten geladen', navPages, navLoaded.join('|'));
await go(siteURL + 'langsam', navTab);
check('Stopp: Seite zu sehen, laedt noch', await waitLoaded('Seite langsam', 30000, navLoaded)
  && (await navState()).button === 'Stoppen', JSON.stringify(await navState()));
await navTab.evaluate(() => { window.__blLoaded = false; });
await navTab.click('#reload');
const stopped = await navTab.waitForFunction(() => document.getElementById('reload').title === 'Neu laden', null, { timeout: 10000 }).then(() => true, () => false);
await navTab.waitForTimeout(500);
const afterStop = await navState();
check('Stopp: Laden zu Ende, kein Fehler, kein load', stopped && afterStop.status === '' && afterStop.loaded === false, JSON.stringify(afterStop));
slowResponse?.end();
failNavA = true;
await navTab.evaluate(() => window.__blEval('history.go(-4)'));
const backFailed = await navTab.waitForFunction(() => document.getElementById('status').textContent.startsWith('Fehler')
  && document.getElementById('reload').title === 'Neu laden', null, { timeout: 15000 }).then(() => true, () => false);
check('Zurueck/Vor scheitert: Fehler, Tab laedt nicht mehr', backFailed && (loads.get('nav-a') || 0) >= 2, `${JSON.stringify(await navState())}, ${loads.get('nav-a')} Aufrufe`);

// Die Zeit, in der confirm() auf den Nutzer wartet, zaehlt nicht fuer den
// Watchdog (hier 2 s): das Skript laeuft nach der Antwort weiter, eine
// Endlosschleife danach bricht er trotzdem ab. Eigener Kontext, damit die
// Sitzung oben unberuehrt bleibt.
const dialogTab = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
const dialogLines = [];
dialogTab.on('console', (msg) => dialogLines.push(msg.text()));
dialogTab.on('dialog', (dialog) => setTimeout(() => dialog.accept(), 3500));
async function dialogLine(pattern, timeout) {
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const line = dialogLines.findIndex((text) => pattern.test(text));
    if (line >= 0)
      return line;
  }
  return -1;
}
await dialogTab.goto(stack.app({ url: siteURL + 'dialog', env: 'BL_SCRIPT_TIMEOUT=2' }));
check('Dialog: Seite geladen', await dialogLine(/RESULT loaded=Seite dialog/, TIMEOUT) >= 0);
await dialogTab.evaluate(() => window.__blEval('console.log("RESULT confirm=" + confirm("Weiter?")); for (;;);'));
const answered = await dialogLine(/RESULT confirm=true/, 15000);
const aborted = await dialogLine(/Skript abgebrochen/, 10000);
check('Dialog: Skript laeuft nach 3,5 s im confirm() weiter', answered >= 0 && (aborted < 0 || aborted > answered), dialogLines.filter((line) => /confirm|abgebrochen/.test(line)).join(' | '));
check('Dialog: Endlosschleife danach abgebrochen', aborted > answered && answered >= 0);

await browser.close();
finish();
