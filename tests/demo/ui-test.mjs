// The demo UI (apps/demo): history, bookmarks, suggestions in the address bar, search engine,
// session restore (background tabs load only when clicked), discarding tabs, Ctrl and middle
// click, the security indicator, pushState, view source, print preview, ?relay=/?token=/?env= of
// the URL, a hanging engine (message, the JSC watchdog stops the script, the time in a dialog
// does not count), a real crash (abort, WASM trap) with a restart in the page (also from the
// hang), back/forward that fails and stop, beforeunload (navigation, reload, closing a tab and
// the host tab, loop) and window.focus().
//
//   node tests/demo/ui-test.mjs [engine-dir]
import {
  TIMEOUT,
  VERBOSE,
  check,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const loads = new Map();
// A long page to print: three sections with page breaks, one part only on screen
const PRINT_PAGE = `<!doctype html><title>Page print</title><style>@media print { .screen { display: none } } section { break-after: page }</style>
<div class="screen">Screen only</div><section>First printed page</section><section>Second printed page</section><section>Third printed page</section>
<script>addEventListener('beforeprint', () => console.log('RESULT print=before')); addEventListener('afterprint', () => console.log('RESULT print=after')); console.log('RESULT loaded=' + document.title)</script>`;
const page = (title) =>
  title === 'Page print'
    ? PRINT_PAGE
    : title === 'Page links'
      ? `<!doctype html><title>${title}</title><body style="margin:0"><a id="l" href="/target" style="display:block;width:300px;height:60px;background:#9cf">Link</a><script>console.log('RESULT loaded=' + document.title)</script>`
      : `<!doctype html><title>${title}</title><h1>${title}</h1><script>console.log('RESULT loaded=' + document.title); addEventListener('pageshow', (e) => { if (e.persisted) console.log('RESULT loaded=' + document.title + ' [cache]'); })</script>`;
let failNavA = false;
let slowResponse = null;
const { url: siteURL } = await serve((req, res) => {
  const name = req.url.slice(1) || 'start';
  loads.set(name, (loads.get(name) || 0) + 1);
  // Back/forward that fails: not in the HTTP cache, then the server aborts
  if (name === 'nav-a') {
    if (failNavA) req.socket.destroy();
    else
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(page('Page ' + name));
    return;
  }
  // The page is visible, the rest never comes (stop)
  if (name === 'slow') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.write(
      '<!doctype html><title>Page slow</title><p>Start' +
        ' '.repeat(4096) +
        '<script>console.log("RESULT loaded=Page slow")</script>',
    );
    slowResponse = res;
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Page ' + name));
});

const stack = await startStack({ app: 'demo', token: 'ui-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const tab = await context.newPage();
const stopWatchingTab = watchErrors(tab);
let loaded = [];
const printEvents = [];
const loadedPattern = /RESULT loaded=(.*?)(\s+\(|$)/;
const pageErrors = [];
tab.on('console', (msg) => {
  if (msg.text().includes('Script terminated')) pageErrors.push(msg.text());
  const printMatch = /RESULT print=(\w+)/.exec(msg.text());
  if (printMatch) printEvents.push(printMatch[1]);
  if (VERBOSE) console.log('   ', msg.text());
  const match = loadedPattern.exec(msg.text());
  if (match) loaded.push(match[1].trim());
});
// Loaded or shown from the back/forward cache ("title [cache]")
async function waitLoaded(title, timeout = 30000, list = loaded) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (list.includes(title) || list.includes(title + ' [cache]')) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
async function go(address, page = tab) {
  await page.click('#address');
  await page.fill('#address', address);
  await page.press('#address', 'Enter');
}

await tab.goto(stack.app({ url: siteURL + 'one' }));
check('first page', await waitLoaded('Page one', TIMEOUT));
await go(siteURL + 'two');
check('second page through the address bar', await waitLoaded('Page two'));
// Back and forward (buttons of the demo)
await tab
  .waitForFunction(() => !document.getElementById('back').disabled, null, { timeout: 10000 })
  .catch(() => {});
check('back button enabled', await tab.evaluate(() => !document.getElementById('back').disabled));
loaded = [];
const oneLoads = loads.get('one') || 0;
await tab.click('#back');
check(
  'back: first page right away from the back/forward cache (pageshow persisted, no reload)',
  (await waitLoaded('Page one [cache]')) && (loads.get('one') || 0) === oneLoads,
  `${loaded.join('|')}, ${loads.get('one')} requests`,
);
await tab
  .waitForFunction(() => !document.getElementById('forward').disabled, null, { timeout: 10000 })
  .catch(() => {});
loaded = [];
await tab.click('#forward');
check(
  'forward: second page from the cache',
  await waitLoaded('Page two [cache]'),
  loaded.join('|'),
);

// History (Ctrl+H): both pages, newest first
await tab.keyboard.press('Control+h');
const history = await tab.locator('#side-panel .panel-title').allTextContents();
// one, two, back to one, forward to two (newest first)
check(
  'history',
  JSON.stringify(history.slice(0, 4)) ===
    JSON.stringify(['Page two', 'Page one', 'Page two', 'Page one']),
  JSON.stringify(history.slice(0, 4)),
);
await tab.keyboard.press('Escape');
check(
  'panel closed with Esc',
  await tab.evaluate(() => document.getElementById('side-panel').hidden),
);

// Bookmarks (star), panel Ctrl+Shift+O
await tab.click('#bookmark');
check(
  'star active',
  await tab.evaluate(() => document.getElementById('bookmark').classList.contains('active')),
);
await tab.keyboard.press('Control+Shift+O');
const bookmarks = await tab.locator('#side-panel .panel-title').allTextContents();
check(
  'bookmark in the panel',
  bookmarks.length === 1 && bookmarks[0] === 'Page two',
  JSON.stringify(bookmarks),
);
await tab.keyboard.press('Escape');

// Suggestions: typing "one" finds the first page in the history
await tab.click('#address');
await tab.fill('#address', '');
await tab.type('#address', 'one');
const suggestion = await tab
  .locator('#suggestions:not([hidden]) .suggestion-url')
  .first()
  .textContent({ timeout: 5000 })
  .catch(() => null);
check('suggestion from the history', suggestion === siteURL + 'one', String(suggestion));
loaded = [];
await tab.keyboard.press('ArrowDown');
await tab.keyboard.press('Enter');
check('open the suggestion', await waitLoaded('Page one'));

// Search engine in the settings: text without a dot becomes a search
await tab.click('#menu-button');
await tab.locator('#side-panel .panel-menu-item', { hasText: 'Settings' }).click();
check(
  'settings as a whole page',
  await tab.evaluate(
    () => document.getElementById('settings').open && document.getElementById('side-panel').hidden,
  ),
);
await tab.selectOption('#setting-search', 'google');
const searchURL = await tab.evaluate(() => window.blTest.addressToURL('weather bern'));
check('search engine', searchURL === 'https://www.google.com/search?q=weather%20bern', searchURL);
await tab.keyboard.press('Escape');
check(
  'settings closed with Esc',
  await tab
    .waitForFunction(() => !document.getElementById('settings').open, null, { timeout: 5000 })
    .then(
      () => true,
      () => false,
    ),
);

// Session: a second tab, then open the demo again without ?url=
await tab.click('#new-tab');
await go(siteURL + 'three');
check('third page in a new tab', await waitLoaded('Page three'));
await tab.waitForTimeout(500);
const loadsBefore = loads.get('one') || 0;
loaded = [];
await tab.goto(stack.app());
check('session: the active tab loads again', await waitLoaded('Page three', TIMEOUT));
const titles = await tab.locator('#tab-list .tab .title').allTextContents();
check(
  'session: both tabs there',
  titles.length === 2 && titles[0] === 'Page one' && titles[1] === 'Page three',
  JSON.stringify(titles),
);
await tab.waitForTimeout(1500);
check(
  'session: the background tab does not load yet',
  (loads.get('one') || 0) === loadsBefore,
  `${loads.get('one')} requests`,
);
await tab.click('#tab-list .tab:first-child .title');
check('session: the background tab loads when clicked', await waitLoaded('Page one'));
// Back/forward of the tab as before the restart (one -> two -> one)
await tab
  .waitForFunction(() => !document.getElementById('back').disabled, null, { timeout: 10000 })
  .catch(() => {});
check(
  'session: back works after the restart',
  await tab.evaluate(() => !document.getElementById('back').disabled),
);
loaded = [];
await tab.click('#back');
check('session: back loads the previous page', await waitLoaded('Page two'));
loaded = [];
await tab.click('#forward');
check('session: forward loads the last page again', await waitLoaded('Page one'));

// Little memory: the background tab is discarded and loads again when clicked
const threeBefore = loads.get('three') || 0;
const discarded = await tab.evaluate(() => window.blTest.checkMemory());
const titlesAfter = await tab.locator('#tab-list .tab .title').allTextContents();
check(
  'memory low: background tab discarded, the title stays',
  discarded > 0 && JSON.stringify(titlesAfter) === JSON.stringify(['Page one', 'Page three']),
  `${discarded} ${JSON.stringify(titlesAfter)}`,
);
check(
  'the active tab is never discarded',
  (await tab.evaluate(() => window.blTest.checkMemory())) === 0,
);
loaded = [];
await tab.click('#tab-list .tab:nth-child(2) .title');
check(
  'a discarded tab loads again when clicked',
  (await waitLoaded('Page three')) && (loads.get('three') || 0) === threeBefore + 1,
  `${loads.get('three')} requests`,
);
await tab.click('#tab-list .tab:first-child .title');
check(
  'back to the first tab',
  (await tab.evaluate(
    () => document.querySelector('#tab-list .tab.active .title')?.textContent,
  )) === 'Page one',
);

// Links: Ctrl+click and middle click each open a tab in the background
await go(siteURL + 'links');
check('page with a link', await waitLoaded('Page links'));
const tabCount = () => tab.locator('#tab-list .tab').count();
const before = await tabCount();
const box = await tab.evaluate(() => {
  const rect = [...document.querySelectorAll('canvas[data-bl-view]')]
    .find((c) => c.style.display !== 'none')
    .getBoundingClientRect();
  return { x: rect.left + 100, y: rect.top + 30 };
});
await tab.keyboard.down('Control');
await tab.mouse.click(box.x, box.y);
await tab.keyboard.up('Control');
await tab.waitForTimeout(1500);
check(
  'Ctrl+click: a new tab in the background',
  (await tabCount()) === before + 1 &&
    (await tab.evaluate(
      () => document.querySelector('#tab-list .tab.active .title')?.textContent,
    )) === 'Page links',
  `${await tabCount()} tabs`,
);
await tab.mouse.click(box.x, box.y, { button: 'middle' });
await tab.waitForTimeout(1500);
check(
  'middle click: exactly one new tab',
  (await tabCount()) === before + 2,
  `${await tabCount()} tabs`,
);
check(
  'security indicator with HTTP',
  await tab.evaluate(
    () =>
      !document.getElementById('security').hidden &&
      document.getElementById('security').textContent === 'Not secure',
  ),
);

// history.pushState/replaceState (SPA): address bar, back and session follow without a reload
// of the page; history.back() goes back through popstate
const address = () => tab.evaluate(() => document.getElementById('address').value);
const waitAddress = (url) =>
  tab
    .waitForFunction((u) => document.getElementById('address').value === u, url, { timeout: 10000 })
    .then(
      () => true,
      () => false,
    );
const sessionURL = () =>
  tab.evaluate(() => JSON.parse(localStorage.getItem('bl-session')).tabs.find((t) => t.active).url);
await tab.evaluate(() => window.blTest.eval('history.pushState({}, "", "/spa/two-a")'));
check('pushState: address bar', await waitAddress(siteURL + 'spa/two-a'), await address());
check(
  'pushState: back enabled, session, no load',
  (await tab.evaluate(() => !document.getElementById('back').disabled)) &&
    (await sessionURL()) === siteURL + 'spa/two-a' &&
    !loads.has('spa/two-a'),
  await sessionURL(),
);
await tab.evaluate(() => window.blTest.eval('history.replaceState({}, "", "/spa/two-b")'));
check('replaceState: address bar', await waitAddress(siteURL + 'spa/two-b'), await address());
await tab.evaluate(() => window.blTest.eval('history.back()'));
check('history.back() after pushState', await waitAddress(siteURL + 'links'), await address());
await tab.evaluate(() => window.blTest.eval('history.forward()'));
check(
  'history.forward() to the replaced address',
  await waitAddress(siteURL + 'spa/two-b'),
  await address(),
);

// Page source (Ctrl+U): a new tab with the HTML of the page
await tab.locator('#tab-list .tab.active .title').click();
await tab.keyboard.press('Control+u');
const sourceTab = await tab
  .waitForFunction(
    () =>
      document
        .querySelector('#tab-list .tab.active .title')
        ?.textContent?.startsWith('view-source:'),
    null,
    { timeout: 15000 },
  )
  .then(
    () => true,
    () => false,
  );
check(
  'view source (Ctrl+U)',
  sourceTab,
  await tab.evaluate(() => document.querySelector('#tab-list .tab.active .title')?.textContent),
);

// Print: window.print() of the page and Ctrl+P show the preview with the PDF of the engine
await tab.locator('#tab-list .tab.active .title').click();
await go(siteURL + 'print');
check('page to print', await waitLoaded('Page print'));
await tab.evaluate(() => window.blTest.eval('window.print()'));
const preview = tab.locator('#print-preview:not([hidden]) iframe');
const previewShown = await preview.waitFor({ state: 'attached', timeout: 20000 }).then(
  () => true,
  () => false,
);
const pdf = previewShown
  ? await tab.evaluate(async () => {
      const src = document.querySelector('#print-preview iframe').src;
      const text = new TextDecoder('latin1').decode(await (await fetch(src)).arrayBuffer());
      return { header: text.slice(0, 5), pages: (text.match(/\/Type\s*\/Page\b/g) || []).length };
    })
  : null;
check(
  'window.print(): print preview with a PDF',
  pdf && pdf.header === '%PDF-',
  JSON.stringify(pdf),
);
check(
  'PDF has three pages (break-after, @media print)',
  pdf && pdf.pages === 3,
  JSON.stringify(pdf),
);
check(
  'beforeprint and afterprint',
  printEvents.join(',') === 'before,after',
  printEvents.join(','),
);
await tab.keyboard.press('Escape');
check(
  'preview closed with Esc',
  await tab.evaluate(() => document.getElementById('print-preview').hidden),
);
await tab.locator('#tab-list .tab.active .title').click();
await tab.keyboard.press('Control+p');
check(
  'Ctrl+P shows the preview',
  await preview.waitFor({ state: 'attached', timeout: 20000 }).then(
    () => true,
    () => false,
  ),
);
await tab.evaluate(() => document.querySelector('#print-preview .print-close').click());

// ?relay= (only with ?debug=1) applies to this load only and is never stored, the token belongs
// to exactly this relay
const relayState = await tab.evaluate(
  (host) => ({
    local: localStorage.getItem('bl-relay-url'),
    session: sessionStorage.getItem('bl-relay-url'),
    token: localStorage.getItem('bl-relay-token ' + host),
    relay: window.blTest.relay,
  }),
  `127.0.0.1:${stack.relayPort}`,
);
check(
  '?relay= only for this load, stored nowhere',
  relayState.local === null &&
    relayState.session === null &&
    relayState.relay.url === stack.relayURL,
  JSON.stringify(relayState),
);
check(
  'the token belongs to this relay',
  relayState.token === stack.token && relayState.relay.token,
  JSON.stringify(relayState),
);
// Without ?token= the stored token goes to the relay (it refuses connections without it)
loaded = [];
await tab.goto(
  `${stack.origin}/?debug=1&relay=${encodeURIComponent(stack.relayURL)}&url=${encodeURIComponent(siteURL + 'with-token')}`,
);
check(
  'the stored token goes to the relay: the page loads',
  await waitLoaded('Page with-token', TIMEOUT),
  loaded.join('|'),
);
// Empty ?relay= takes the own relay without a foreign token. ?env= sets only engine switches.
await tab.goto(
  `${stack.origin}/?debug=1&relay=&env=BL_EXTRA_CA=x,SSLKEYLOGFILE=/tmp/keys,https_proxy=http://evil,BL_TEST_FLAG=1,BL_SCRIPT_TIMEOUT=9&url=about:blank`,
);
await tab.waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: TIMEOUT });
const envState = await tab.evaluate(() => ({
  engine: window.blTest.options.engine,
  relay: window.blTest.relay,
}));
check(
  '?env=BL_EXTRA_CA and foreign variables are ignored',
  JSON.stringify(envState.engine) ===
    JSON.stringify({ scriptTimeoutSeconds: 9, env: { BL_TEST_FLAG: '1' } }),
  JSON.stringify(envState),
);
check(
  'empty ?relay=: own relay without a token',
  envState.relay.url === `${stack.origin.replace('http', 'ws')}/wisp/` && !envState.relay.token,
  JSON.stringify(envState.relay),
);
// BL_SCRIPT_TIMEOUT=9 of ?env= reaches the engine: its watchdog stops an endless loop after 9 s
loaded = [];
await tab.evaluate(() =>
  window.blTest.eval('(() => { console.log("RESULT loaded=env-loop"); for (;;); })()'),
);
const envLoop = await waitLoaded('env-loop', 10000);
const loopStart = Date.now();
await tab.evaluate(() =>
  window.blTest.eval('setTimeout(() => console.log("RESULT loaded=env-after"), 0)'),
);
const envAfter = envLoop && (await waitLoaded('env-after', 20000));
const loopSeconds = (Date.now() - loopStart) / 1000;
check(
  '?env=BL_SCRIPT_TIMEOUT=9 stops the loop after about 9 s',
  envAfter && loopSeconds > 6 && loopSeconds < 13,
  `${loopSeconds.toFixed(1)} s ${loaded.join('|')}`,
);
pageErrors.length = 0;
// Without ?debug=1 ?relay= and ?env= do nothing: the own relay of the demo server allows no local
// addresses, so the test page cannot load, and there are no test hooks
loaded = [];
await tab.goto(
  `${stack.origin}/?relay=${encodeURIComponent(stack.relayURL)}&env=BL_TEST_FLAG=1&url=${encodeURIComponent(siteURL + 'without-debug')}`,
);
await tab.waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: TIMEOUT });
check(
  'without ?debug=1: no ?relay=, no test hooks',
  !(await waitLoaded('Page without-debug', 8000)) &&
    (await tab.evaluate(() => window.blTest === undefined)) &&
    !loads.has('without-debug'),
  loaded.join('|'),
);

// Two tabs for hang and crash (intended, not watched from here on)
stopWatchingTab();
loaded = [];
await tab.goto(stack.app({ url: siteURL + 'before', env: 'BL_SCRIPT_TIMEOUT=15' }));
check('crash: first tab', await waitLoaded('Page before', TIMEOUT));
await tab.click('#new-tab');
await go(siteURL + 'after');
check('crash: second tab', await waitLoaded('Page after'));
await tab.waitForTimeout(500);
const bootText = () =>
  tab.evaluate(() =>
    document.getElementById('boot').hidden ? '' : document.getElementById('boot').textContent,
  );
const waitBoot = (text, timeout) =>
  tab
    .waitForFunction(
      (t) =>
        !document.getElementById('boot').hidden &&
        document.getElementById('boot').textContent.includes(t),
      text,
      { timeout },
    )
    .then(
      () => true,
      () => false,
    );

// Hang: an endless loop blocks the engine thread, reload gets no answer. After 15 s (set here)
// the watchdog (engine/src/EngineLoop.cpp) stops it. Click only when the loop runs.
loaded = [];
await tab.evaluate(() =>
  window.blTest.eval('(() => { console.log("RESULT loaded=Loop"); for (;;); })()'),
);
check('hang: the loop runs', await waitLoaded('Loop', 30000), loaded.join('|'));
loaded = [];
await tab.click('#reload');
check(
  'hang: message after 10 s without an answer',
  await waitBoot('not responding', 14000),
  await bootText(),
);
check(
  'hang: the message goes as soon as the watchdog stops the script',
  await tab
    .waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: 15000 })
    .then(
      () => true,
      () => false,
    ),
);
const abortLogged = () => pageErrors.some((text) => /\[page \d+\] Script terminated/.test(text));
for (const end = Date.now() + 20000; !abortLogged() && Date.now() < end; )
  await tab.waitForTimeout(200);
check('hang: message in the console of the page', abortLogged(), pageErrors.join(' | '));
check('hang: afterwards the tab reloads', await waitLoaded('Page after'), loaded.join('|'));
await tab.evaluate(() =>
  window.blTest.eval('setTimeout(() => console.log("RESULT loaded=Timer after abort"), 10)'),
);
check('hang: timers go on', await waitLoaded('Timer after abort', 10000));

// Crash: WASM trap in the engine thread (Emscripten rethrows the error of the worker in the main
// thread)
await tab.evaluate(() => window.blTest.crash('trap'));
check(
  'crash: message with restart',
  (await waitBoot('crashed', 10000)) &&
    (await tab.locator('#boot button.primary').textContent()) === 'Restart',
  await bootText(),
);
loaded = [];
const beforeLoads = loads.get('before') || 0;
await tab.click('#boot button.primary');
check('crash: the restart loads the active tab again', await waitLoaded('Page after', TIMEOUT));
const restartURL = new URL(tab.url());
const restoredTitles = await tab
  .waitForFunction(
    () => {
      const titles = [...document.querySelectorAll('#tab-list .tab .title')].map(
        (t) => t.textContent,
      );
      return titles.join('|') === 'Page before|Page after' && titles;
    },
    null,
    { timeout: 10000 },
  )
  .then(
    (h) => h.jsonValue(),
    () => tab.locator('#tab-list .tab .title').allTextContents(),
  );
check(
  'crash: restart without ?url=, with the session',
  !restartURL.searchParams.has('url') && restoredTitles.join('|') === 'Page before|Page after',
  `${restartURL.search} ${JSON.stringify(restoredTitles)}`,
);
check('crash: the background tab does not load yet', (loads.get('before') || 0) === beforeLoads);

// Another crash right away (abort() in the engine thread): afterwards the tabs load only when
// clicked
const afterLoads = loads.get('after') || 0;
await tab
  .waitForFunction(
    () => window.blTest?.browser?.state === 'ready' && document.getElementById('boot').hidden,
    null,
    { timeout: 10000 },
  )
  .catch(() => {});
await tab.evaluate(() => window.blTest.crash('abort'));
check('second crash: message', await waitBoot('again', 5000), await bootText());
await tab.click('#boot button.primary');
await tab
  .waitForFunction(
    () =>
      document.getElementById('boot').hidden &&
      document.querySelectorAll('#tab-list .tab').length === 3,
    null,
    { timeout: TIMEOUT },
  )
  .catch(() => {});
await tab.waitForTimeout(1500);
const safeTitles = await tab.locator('#tab-list .tab .title').allTextContents();
check(
  'second crash: tabs there, but not loaded',
  safeTitles.length === 3 &&
    safeTitles[0] === 'Page before' &&
    safeTitles[1] === 'Page after' &&
    (loads.get('after') || 0) === afterLoads &&
    (loads.get('before') || 0) === beforeLoads,
  `${JSON.stringify(safeTitles)} ${loads.get('after')}`,
);
const safeStatus = await tab.locator('#status').textContent();
check(
  'second crash: note in the status line',
  safeStatus === 'After the restart the tabs load only when clicked',
  safeStatus,
);

// Restart from a hang: destroy() while the engine thread is stuck in the loop, then a new browser
// starts in the page
await tab.evaluate(() => {
  window.hungBrowser = window.blTest.browser;
});
await tab.evaluate(() => document.getElementById('status').replaceChildren());
loaded = [];
await tab.evaluate(() =>
  window.blTest.eval('(() => { console.log("RESULT loaded=Loop 2"); for (;;); })()'),
);
check('hang and restart: the loop runs', await waitLoaded('Loop 2', 30000), loaded.join('|'));
await tab.click('#reload');
check('hang and restart: message', await waitBoot('not responding', 14000), await bootText());
await tab.click('#boot button.primary', { timeout: 3000 }).catch(() => {});
const hangRestart = await tab
  .waitForFunction(
    () =>
      window.blTest.browser &&
      window.blTest.browser !== window.hungBrowser &&
      window.blTest.browser.state === 'ready' &&
      document.getElementById('boot').hidden,
    null,
    { timeout: TIMEOUT },
  )
  .then(
    () => true,
    () => false,
  );
check('hang and restart: a new browser runs', hangRestart, await bootText());
const hangStatus = await tab.locator('#status').textContent();
check(
  'hang and restart: note in the status line',
  hangStatus === 'After the restart the tabs load only when clicked',
  hangStatus,
);

// Stop while the page is already visible: no error and no 'load', only loading ends. Then
// back/forward to an entry that is no longer in the back/forward cache (at most 3 pages), and the
// server aborts (curl tries again on a new connection): error page under the address of the
// entry, the tab no longer loads.
const navTab = await (
  await browser.newContext({ viewport: { width: 1100, height: 700 } })
).newPage();
watchErrors(navTab);
const navLoaded = [];
navTab.on('console', (msg) => {
  const match = loadedPattern.exec(msg.text());
  if (match) navLoaded.push(match[1].trim());
});
const navState = () =>
  navTab.evaluate(() => ({
    status: document.getElementById('status').textContent,
    button: document.getElementById('reload').title,
    loaded: window.blTest?.flags.loaded,
  }));
await navTab.goto(stack.app({ url: siteURL + 'nav-a' }));
let navPages = await waitLoaded('Page nav-a', TIMEOUT, navLoaded);
// pushState in an iframe adds an entry of the whole page: back gets enabled, the entry has the
// address of the page, not the one of the iframe
await navTab.evaluate(() =>
  window.blTest.eval(`const frame = document.createElement('iframe');
  frame.src = '/frame';
  frame.onload = () => frame.contentWindow.history.pushState({}, '', '/frame-2');
  document.body.append(frame);`),
);
const framePush = await navTab
  .waitForFunction(() => !document.getElementById('back').disabled, null, { timeout: 10000 })
  .then(
    () => true,
    () => false,
  );
const frameEntries = await navTab.evaluate(() =>
  JSON.parse(localStorage.getItem('bl-session'))
    .tabs.find((t) => t.active)
    .history.entries.map((e) => e.url),
);
check(
  'pushState in an iframe: back enabled, entry of the page',
  framePush &&
    JSON.stringify(frameEntries) === JSON.stringify([siteURL + 'nav-a', siteURL + 'nav-a']),
  JSON.stringify(frameEntries),
);
for (const name of ['nav-b', 'nav-c', 'nav-d']) {
  await go(siteURL + name, navTab);
  navPages = navPages && (await waitLoaded('Page ' + name, 30000, navLoaded));
}
check('stop/back: four pages loaded', navPages, navLoaded.join('|'));
await go(siteURL + 'slow', navTab);
check(
  'stop: page visible, still loading',
  (await waitLoaded('Page slow', 30000, navLoaded)) && (await navState()).button === 'Stop',
  JSON.stringify(await navState()),
);
await navTab.evaluate(() => {
  window.blTest.flags.loaded = false;
});
await navTab.click('#reload');
const stopped = await navTab
  .waitForFunction(() => document.getElementById('reload').title === 'Reload', null, {
    timeout: 10000,
  })
  .then(
    () => true,
    () => false,
  );
await navTab.waitForTimeout(500);
const afterStop = await navState();
check(
  'stop: loading ended, no error, no load',
  stopped && afterStop.status === '' && afterStop.loaded === false,
  JSON.stringify(afterStop),
);
slowResponse?.end();
failNavA = true;
await navTab.evaluate(() => window.blTest.eval('history.go(-4)'));
const backFailed = await navTab
  .waitForFunction(
    (url) =>
      document.getElementById('address').value === url &&
      document.querySelector('#tab-list .tab.active .title')?.textContent ===
        new URL(url).hostname &&
      document.getElementById('reload').title === 'Reload',
    siteURL + 'nav-a',
    { timeout: 15000 },
  )
  .then(
    () => true,
    () => false,
  );
check(
  'back/forward fails: error page, the tab no longer loads',
  backFailed && (loads.get('nav-a') || 0) >= 2,
  `${JSON.stringify(await navState())}, ${loads.get('nav-a')} requests`,
);

// The time confirm() waits for the user does not count for the watchdog (2 s here): the script
// goes on after the answer, an endless loop afterwards is still stopped. An own context, so the
// session above stays untouched.
const dialogTab = await (
  await browser.newContext({ viewport: { width: 1100, height: 700 } })
).newPage();
watchErrors(dialogTab);
const dialogLines = [];
dialogTab.on('console', (msg) => dialogLines.push(msg.text()));
dialogTab.on('dialog', (dialog) => setTimeout(() => dialog.accept(), 3500));
async function dialogLine(pattern, timeout) {
  for (
    const end = Date.now() + timeout;
    Date.now() < end;
    await new Promise((r) => setTimeout(r, 100))
  ) {
    const line = dialogLines.findIndex((text) => pattern.test(text));
    if (line >= 0) return line;
  }
  return -1;
}
await dialogTab.goto(stack.app({ url: siteURL + 'dialog', env: 'BL_SCRIPT_TIMEOUT=2' }));
check('dialog: page loaded', (await dialogLine(/RESULT loaded=Page dialog/, TIMEOUT)) >= 0);
await dialogTab.evaluate(() =>
  window.blTest.eval('console.log("RESULT confirm=" + confirm("Continue?")); for (;;);'),
);
const answered = await dialogLine(/RESULT confirm=true/, 15000);
const aborted = await dialogLine(/Script terminated/, 10000);
check(
  'dialog: the script goes on after 3.5 s in confirm()',
  answered >= 0 && (aborted < 0 || aborted > answered),
  dialogLines.filter((line) => /confirm|terminated/.test(line)).join(' | '),
);
check('dialog: endless loop afterwards stopped', aborted > answered && answered >= 0);

// beforeunload like in Chrome: a question only after a user action in the page, when navigating
// away, reloading and closing the tab (a background tab comes to the front for it, without a
// user action not), no question from a background tab and not endlessly in a loop. The host tab
// asks only while a tab with a listener had a user action. Then window.focus() from the opener:
// the popup tab comes to the front, the window itself may not from the background.
const unloadLoads = new Map();
const { url: unloadURL } = await serve((req, res) => {
  const name = req.url.slice(1);
  unloadLoads.set(name, (unloadLoads.get(name) || 0) + 1);
  const body =
    name === 'unload'
      ? `<script>addEventListener('beforeunload', (e) => { console.log('RESULT beforeunload=' + Date.now()); e.preventDefault(); })</script>`
      : name === 'opener'
        ? `<script>addEventListener('click', () => { window.popup = open('/popup'); })</script>`
        : '';
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(
      `<!doctype html><title>Page ${name}</title><body style="margin:0;height:600px">${body}<script>addEventListener('click', () => console.log('RESULT clicked=Page ${name}')); console.log('RESULT loaded=Page ${name}')</script>`,
    );
});
const unloadTab = await (
  await browser.newContext({ viewport: { width: 1100, height: 700 } })
).newPage();
watchErrors(unloadTab);
const unloadLines = [];
let unloadLoaded = [];
unloadTab.on('console', (msg) => {
  unloadLines.push(msg.text());
  const match = loadedPattern.exec(msg.text());
  if (match) unloadLoaded.push(match[1].trim());
});
const unloadDialogs = [];
let dialogAnswer = 'dismiss';
unloadTab.on('dialog', (dialog) => {
  unloadDialogs.push(dialog.type() + ':' + dialog.message());
  dialog[dialogAnswer]().catch(() => {});
});
const tabTitles = () =>
  unloadTab.evaluate(() =>
    [...document.querySelectorAll('#tab-list .tab')].map(
      (el) => (el.classList.contains('active') ? '*' : '') + el.querySelector('.title').textContent,
    ),
  );
const activateUnloadPage = async () => {
  const canvas = await unloadTab.evaluate(() => {
    const rect = [...document.querySelectorAll('canvas[data-bl-view]')]
      .find((c) => c.style.display !== 'none')
      .getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });
  const clicked = unloadLines.length;
  await unloadTab.mouse.click(canvas.x + 300, canvas.y + 300);
  // only when the page had the click does WebCore ask on beforeunload
  for (
    let i = 0;
    i < 100 && !unloadLines.slice(clicked).some((line) => line.includes('RESULT clicked='));
    i++
  )
    await unloadTab.waitForTimeout(100);
};
// The listener reaches the demo one engine step after "RESULT loaded="
const waitHostAsks = () =>
  unloadTab
    .waitForFunction(() => typeof window.onbeforeunload === 'function', null, { timeout: 10000 })
    .catch(() => {});
const LEAVE = 'Changes that you made may not be saved.';
await unloadTab.goto(stack.app({ url: unloadURL + 'unload' }));
check('beforeunload: page loaded', await waitLoaded('Page unload', TIMEOUT, unloadLoaded));
await go(unloadURL + 'one', unloadTab);
check(
  'beforeunload: no question without a user action',
  (await waitLoaded('Page one', 30000, unloadLoaded)) &&
    unloadDialogs.length === 0 &&
    unloadLines.some((line) => line.includes('RESULT beforeunload=')),
  JSON.stringify(unloadDialogs),
);
unloadLoaded = [];
await go(unloadURL + 'unload', unloadTab);
check('beforeunload: loaded again', await waitLoaded('Page unload', 30000, unloadLoaded));
await activateUnloadPage();
await go(unloadURL + 'two', unloadTab);
await unloadTab.waitForTimeout(2000);
check(
  'beforeunload: navigating away asks, cancel stays',
  JSON.stringify(unloadDialogs) === JSON.stringify(['confirm:Leave site?\n\n' + LEAVE]) &&
    !unloadLoaded.includes('Page two') &&
    !unloadLoads.has('two'),
  JSON.stringify(unloadDialogs),
);
const unloadCount = unloadLoads.get('unload');
await unloadTab.click('#reload');
await unloadTab.waitForTimeout(2000);
check(
  'beforeunload: reload asks, cancel stays',
  unloadDialogs[1] === 'confirm:Reload site?\n\n' + LEAVE &&
    unloadLoads.get('unload') === unloadCount,
  JSON.stringify(unloadDialogs),
);
check(
  'beforeunload: the host tab asks when closed',
  await unloadTab.evaluate(() => typeof window.onbeforeunload === 'function'),
);
// Navigation from the background: without a question
await unloadTab.evaluate(() =>
  window.blTest.eval('setTimeout(() => { location.href = "/three"; }, 2000)'),
);
await unloadTab.click('#new-tab');
await unloadTab.keyboard.press('Escape');
check(
  'beforeunload: navigation in a background tab without a question',
  (await waitLoaded('Page three', 30000, unloadLoaded)) && unloadDialogs.length === 2,
  JSON.stringify(unloadDialogs),
);
await unloadTab
  .waitForFunction(() => window.onbeforeunload === null, null, { timeout: 10000 })
  .catch(() => {});
check(
  'beforeunload: without a listener the host tab no longer asks',
  await unloadTab.evaluate(() => window.onbeforeunload === null),
);
// Closing a background tab with a listener: comes to the front and asks
unloadLoaded = [];
await go(unloadURL + 'unload', unloadTab);
check('beforeunload: second tab loaded', await waitLoaded('Page unload', 30000, unloadLoaded));
await activateUnloadPage();
await waitHostAsks();
await unloadTab.click('#tab-list .tab:first-child .title');
await unloadTab.click('#tab-list .tab:nth-child(2) .close');
await unloadTab.waitForTimeout(1500);
check(
  'beforeunload: closing asks, the tab in front and stays',
  unloadDialogs[2] === 'confirm:Leave site?\n\n' + LEAVE &&
    JSON.stringify(await tabTitles()) === JSON.stringify(['Page three', '*Page unload']),
  `${JSON.stringify(unloadDialogs)} ${JSON.stringify(await tabTitles())}`,
);
dialogAnswer = 'accept';
await unloadTab.click('#tab-list .tab:nth-child(2) .close');
await unloadTab
  .waitForFunction(() => document.querySelectorAll('#tab-list .tab').length === 1, null, {
    timeout: 10000,
  })
  .catch(() => {});
check(
  'beforeunload: leave closes the tab',
  unloadDialogs.length === 4 &&
    JSON.stringify(await tabTitles()) === JSON.stringify(['*Page three']),
  `${JSON.stringify(unloadDialogs)} ${JSON.stringify(await tabTitles())}`,
);
// A background tab with a listener, but without a user action: the listener runs without a
// question, the tab does not come to the front, the active one stays
await unloadTab.click('#new-tab');
await unloadTab.keyboard.press('Escape');
unloadLoaded = [];
await go(unloadURL + 'unload', unloadTab);
check(
  'beforeunload: tab without a user action loaded',
  await waitLoaded('Page unload', 30000, unloadLoaded),
);
// The listener arrives one engine step after loading (without a user action the host tab does
// not ask)
await unloadTab.waitForTimeout(1500);
await unloadTab.click('#tab-list .tab:first-child .title');
const listenerRuns = unloadLines.filter((line) => line.includes('RESULT beforeunload=')).length;
await unloadTab.click('#tab-list .tab:nth-child(2) .close');
await unloadTab
  .waitForFunction(() => document.querySelectorAll('#tab-list .tab').length === 1, null, {
    timeout: 10000,
  })
  .catch(() => {});
check(
  'beforeunload: background tab without a user action closed, the active tab stays',
  unloadDialogs.length === 4 &&
    unloadLines.filter((line) => line.includes('RESULT beforeunload=')).length > listenerRuns &&
    JSON.stringify(await tabTitles()) === JSON.stringify(['*Page three']),
  `${JSON.stringify(unloadDialogs)} ${JSON.stringify(await tabTitles())}`,
);
// When the page navigates in a loop, every "cancel" would bring the next question right away
// (each blocks the whole demo): after two it may go
dialogAnswer = 'dismiss';
unloadLoaded = [];
await go(unloadURL + 'unload', unloadTab);
check(
  'beforeunload: page for the loop loaded',
  await waitLoaded('Page unload', 30000, unloadLoaded),
);
await activateUnloadPage();
const dialogsBeforeLoop = unloadDialogs.length;
await unloadTab.evaluate(() =>
  window.blTest.eval('setInterval(() => { location.href = "/loop"; }, 100)'),
);
check(
  'beforeunload: loop at most two questions, then gone',
  (await waitLoaded('Page loop', 15000, unloadLoaded)) &&
    unloadDialogs.length - dialogsBeforeLoop === 2,
  JSON.stringify(unloadDialogs.slice(dialogsBeforeLoop)),
);
dialogAnswer = 'accept';
// window.focus(): a popup from a click, the opener brings it back to the front
await go(unloadURL + 'opener', unloadTab);
check('focus: opener loaded', await waitLoaded('Page opener', 30000, unloadLoaded));
await activateUnloadPage();
check('focus: popup loaded', await waitLoaded('Page popup', 30000, unloadLoaded));
await unloadTab
  .waitForFunction(
    () => document.querySelector('#tab-list .tab.active .title')?.textContent === 'Page popup',
    null,
    { timeout: 10000 },
  )
  .catch(() => {});
await unloadTab.evaluate(() =>
  window.blTest.eval(
    'setTimeout(() => { window.focus(); console.log("RESULT selffocus=1"); }, 1500)',
  ),
);
await unloadTab.click('#tab-list .tab:first-child .title');
await unloadTab.waitForTimeout(3000);
check(
  'focus: a window in the background does not bring itself to the front',
  unloadLines.some((line) => line.includes('RESULT selffocus=1')) &&
    JSON.stringify(await tabTitles()) === JSON.stringify(['*Page opener', 'Page popup']),
  JSON.stringify(await tabTitles()),
);
await unloadTab.evaluate(() => window.blTest.eval('window.popup.focus()'));
const popupFront = await unloadTab
  .waitForFunction(
    () => document.querySelector('#tab-list .tab.active .title')?.textContent === 'Page popup',
    null,
    { timeout: 10000 },
  )
  .then(
    () => true,
    () => false,
  );
check(
  'focus: window.focus() from the opener brings the popup tab to the front',
  popupFront,
  JSON.stringify(await tabTitles()),
);
// Close the host tab: with a listener and a user action the host asks
unloadLoaded = [];
await go(unloadURL + 'unload', unloadTab);
check(
  'beforeunload: page for the host tab loaded',
  await waitLoaded('Page unload', 30000, unloadLoaded),
);
await activateUnloadPage();
await waitHostAsks();
dialogAnswer = 'dismiss';
const dialogsBeforeHost = unloadDialogs.length;
await unloadTab.close({ runBeforeUnload: true });
await new Promise((resolve) => setTimeout(resolve, 2000));
check(
  'beforeunload: the host asks when closing, cancel stays',
  unloadDialogs[dialogsBeforeHost]?.startsWith('beforeunload:') && !unloadTab.isClosed(),
  JSON.stringify(unloadDialogs.slice(dialogsBeforeHost)),
);
// Clearing site data reloads the demo on purpose: without a question of the host
dialogAnswer = 'accept';
const dialogsBeforeClear = unloadDialogs.length;
const clearReload = unloadTab.waitForEvent('load', { timeout: 30000 }).then(
  () => true,
  () => false,
);
await unloadTab.click('#clear-data');
await unloadTab.click('#settings-clear-site-data');
check(
  'beforeunload: clearing site data reloads without a question of the host',
  (await clearReload) &&
    unloadDialogs.slice(dialogsBeforeClear).length === 1 &&
    unloadDialogs[dialogsBeforeClear].startsWith('confirm:Delete site data?'),
  JSON.stringify(unloadDialogs.slice(dialogsBeforeClear)),
);

await browser.close();
finish();
