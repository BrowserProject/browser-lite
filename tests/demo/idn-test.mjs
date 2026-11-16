// Internationalized hosts and escaped UTF-8 characters in paths (Z%C3%BCrich) show in Unicode like
// in Chrome: address bar (also while editing and on a phone, where it shows only the host), tab
// label of a page without a title, history panel, suggestions, the link status bubble and the
// engine's error page (its title names the tab and the visit); the stored address stays the ASCII
// one the engine loaded, and copying the whole address copies that. A host that could pass for
// another one (Latin with a Cyrillic letter) and an escaped bidi control stay escaped.
// The test page lies at <label>.localhost, which resolves to this machine.
//
//   node tests/demo/idn-test.mjs [engine-dir]
import http from 'node:http';
import {
  TIMEOUT,
  check,
  collect,
  finish,
  launch,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

// Both address families: <label>.localhost may resolve to ::1 or 127.0.0.1
const server = http.createServer((req, res) => {
  const name = req.url.slice(1);
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(
      `<!doctype html><a id="link" href="/linked/Z%C3%BCrich" style="display:block;width:300px;height:100px">link</a><script>console.log('RESULT ready=${name}')</script>`,
    );
});
await new Promise((resolve) => server.listen(0, '::', resolve));
const port = server.address().port;
// A port without a server: the error page
const closed = http.createServer();
await new Promise((resolve) => closed.listen(0, '::', resolve));
const closedPort = closed.address().port;
await new Promise((resolve) => closed.close(resolve));

const unicode = `http://例え.localhost:${port}`; // a Japanese word
const ascii = new URL(unicode).origin;
const spoof = `http://аpple.localhost:${port}`; // Cyrillic a, then Latin
const spoofASCII = new URL(spoof).origin;
check('test hosts are internationalized', ascii.includes('xn--') && spoofASCII.includes('xn--'));

const stack = await startStack({ app: 'demo', token: 'idn-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
watchErrors(page);
const results = collect(page);

const readyIs = async (name) => {
  for (const end = Date.now() + TIMEOUT; Date.now() < end; ) {
    if (results.get('ready') === name) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};
const typeAddress = async (text, name) => {
  results.delete('ready');
  await page.click('#address');
  await page.fill('#address', text);
  await page.press('#address', 'Enter');
  return readyIs(name);
};
const shown = () =>
  page.evaluate(() => ({
    address: document.getElementById('address').value,
    tab: document.querySelector('#tab-list .tab.active .title')?.textContent,
    title: document.title,
  }));

await page.goto(stack.app());
await page.waitForSelector('#tab-list .tab.active');

check('typed Unicode address loads', await typeAddress(`${unicode}/one/Zürich`, 'one/Z%C3%BCrich'));
let now = await shown();
check(
  'address bar shows the host and path in Unicode',
  await waitFor(async () => (await shown()).address === `${unicode}/one/Zürich`, 5000),
  (now = await shown()).address,
);
check('tab label shows the host in Unicode', now.tab === `${unicode}/one/Zürich`, now.tab);
check('window title too', now.title.startsWith(`${unicode}/one/Zürich`), now.title);
const stored = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('bl-history') ?? '[]').map((visit) => visit.url),
);
check(
  'history keeps the ASCII address',
  stored.includes(`${ascii}/one/Z%C3%BCrich`),
  JSON.stringify(stored),
);

// While editing the same text; Escape restores it, Enter on it loads the same address
await page.click('#address');
check(
  'editing: Unicode too',
  (await page.inputValue('#address')) === `${unicode}/one/Zürich`,
  await page.inputValue('#address'),
);
// Copy and cut of the whole address put the loaded address on the clipboard, like Chrome
const clipboard = (type) =>
  page.evaluate((type) => {
    const field = document.getElementById('address');
    field.select();
    const event = new ClipboardEvent(type, {
      clipboardData: new DataTransfer(),
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(event);
    return { data: event.clipboardData.getData('text/plain'), value: field.value };
  }, type);
let copied = await clipboard('copy');
check(
  'copy: the escaped address',
  copied.data === `${ascii}/one/Z%C3%BCrich` && copied.value === `${unicode}/one/Zürich`,
  JSON.stringify(copied),
);
copied = await clipboard('cut');
check(
  'cut: the escaped address, the field empty',
  copied.data === `${ascii}/one/Z%C3%BCrich` && copied.value === '',
  JSON.stringify(copied),
);
await page.keyboard.press('Escape');
await page.click('#address');
check(
  'Escape after the cut: the address again',
  (await page.inputValue('#address')) === `${unicode}/one/Zürich`,
  await page.inputValue('#address'),
);
// Enter on the shown text loads the same address
check(
  'Enter on it: same page',
  await typeAddress(await page.inputValue('#address'), 'one/Z%C3%BCrich'),
);
await page.click('#address');
await page.keyboard.press('Escape');
check(
  'Escape: Unicode',
  (await shown()).address === `${unicode}/one/Zürich`,
  (await shown()).address,
);

// The link under the mouse
await page.mouse.move(100, 200);
const bubble = page.locator('.bl-link-status');
check(
  'link status bubble shows the host and path in Unicode',
  await waitFor(async () => (await bubble.textContent()) === `${unicode}/linked/Zürich`, 5000),
  await bubble.textContent(),
);

// Suggestions: typing the Unicode host finds the visited page and completes it
check('second page', await typeAddress(`${ascii}/two/%C3%A9t%C3%A9`, 'two/%C3%A9t%C3%A9'));
await page.click('#address');
await page.keyboard.type('例');
const suggestion = () =>
  page.evaluate(() => document.querySelector('#suggestions .suggestion-url')?.textContent ?? '');
check(
  'suggestion shows the host in Unicode',
  await waitFor(async () => (await suggestion()).startsWith(unicode), 5000),
  await suggestion(),
);
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
// Typing a decoded path finds the page too
await page.click('#address');
await page.keyboard.type('été');
const suggestionURLs = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#suggestions .suggestion-url')].map((row) => row.textContent),
  );
check(
  'suggestion found by its path in Unicode',
  await waitFor(async () => (await suggestionURLs()).includes(`${unicode}/two/été`), 5000),
  JSON.stringify(await suggestionURLs()),
);
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');

// History panel
await page.keyboard.press('Control+h');
const panelURLs = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#side-panel .panel-row')].map(
      (row) =>
        `${row.querySelector('.panel-title').textContent}|${row.querySelector('.panel-url').textContent}`,
    ),
  );
check(
  'history panel rows show the host in Unicode',
  await waitFor(
    async () => (await panelURLs()).includes(`${unicode}/two/été|${unicode}/two/été`),
    5000,
  ),
  JSON.stringify(await panelURLs()),
);
await page.keyboard.press('Control+h');

// A host that mixes Cyrillic and Latin stays in xn--, an escaped bidi control stays escaped
check('mixed script host loads', await typeAddress(`${spoof}/three%E2%80%AE`, 'three%E2%80%AE'));
now = await shown();
check(
  'address bar keeps a mixed script host in xn-- and a bidi control escaped',
  now.address === `${spoofASCII}/three%E2%80%AE`,
  now.address,
);
check('tab label too', now.tab === `${spoofASCII}/three%E2%80%AE`, now.tab);

// The error page names the host in Unicode, its title is the tab's and the visit's
await page.click('#address');
await page.fill('#address', `http://\u4f8b\u3048.localhost:${closedPort}/`);
await page.press('#address', 'Enter');
const errorTitle = '\u4f8b\u3048.localhost';
check(
  'error page: tab label is the host in Unicode',
  await waitFor(async () => (await shown()).tab === errorTitle, TIMEOUT),
  (await shown()).tab,
);
const visit = await page.evaluate(
  (url) =>
    JSON.parse(localStorage.getItem('bl-history') ?? '[]').find((entry) => entry.url === url),
  new URL(`http://\u4f8b\u3048.localhost:${closedPort}/`).href,
);
check('error page: the visit has that title', visit?.title === errorTitle, JSON.stringify(visit));

// A phone shows only the host
const phone = await browser.newContext({ viewport: { width: 393, height: 700 }, hasTouch: true });
const phonePage = await phone.newPage();
watchErrors(phonePage);
const phoneResults = collect(phonePage);
await phonePage.goto(stack.app({ url: `${ascii}/four` }));
const phoneReady = await waitFor(() => phoneResults.get('ready') === 'four', TIMEOUT);
check('phone: page', phoneReady);
check(
  'phone: address bar shows the host in Unicode',
  await waitFor(
    async () => (await phonePage.inputValue('#address')) === `例え.localhost:${port}`,
    5000,
  ),
  await phonePage.inputValue('#address'),
);

await browser.close();
server.close();
finish();
