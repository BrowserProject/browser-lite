// After an engine crash the toolbar still acts (apps/demo/src/engine-state.ts): like Chrome on a
// crashed tab, Reload, + and an address typed into the address bar work, here by starting the
// engine again with the session and then carrying out the action (before, they did nothing until
// the Restart of the message was pressed):
// - Reload: the restart loads the tab in front again
// - +: the tabs come back and a new tab opens in front
// - Enter in the address bar: the tabs come back and the address opens in front, the crashed
//   page does not load again
//
//   node tests/demo/crash-actions-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  TIMEOUT,
  check,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit(TIMEOUT * 4 + 120000);

const { url: siteURL } = await serve((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1);
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(
      `<!doctype html><title>${name}</title><p>${name}<script>console.log("RESULT loaded=${name}")</script>`,
    );
});
const stack = await startStack({ app: 'demo', token: 'crash-actions-token-0123456789' });
const browser = await launch({ args: SWIFTSHADER });
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
const stopWatching = watchErrors(page);
const loaded = [];
page.on('console', (message) => {
  const match = /RESULT loaded=(\w+)/.exec(message.text());
  if (match) loaded.push(match[1]);
});
const waitLoaded = async (name, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(100)) {
    const index = loaded.indexOf(name);
    if (index >= 0) {
      loaded.splice(index, 1);
      return true;
    }
  }
  return false;
};
const started = () =>
  page.waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: TIMEOUT });
const titles = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#tab-list .tab .title')].map((t) => t.textContent),
  );
const activeTitle = () =>
  page.evaluate(() => document.querySelector('#tab-list .tab.active .title')?.textContent ?? '');
/** Crashes the engine and waits for its message; resolves to the browser that crashed. */
const crash = async (kind) => {
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    window.crashedBrowser = window.blTest.browser;
  });
  await page.evaluate((k) => window.blTest.crash(k), kind);
  return page
    .waitForFunction(
      () =>
        window.blTest.browser?.state === 'crashed' &&
        document.getElementById('boot').textContent.includes('crashed'),
      null,
      { timeout: 10000 },
    )
    .then(
      () => true,
      () => false,
    );
};
/** A new engine runs and its message is gone. */
const restarted = () =>
  page
    .waitForFunction(
      () =>
        window.blTest.browser &&
        window.blTest.browser !== window.crashedBrowser &&
        window.blTest.browser.state === 'ready' &&
        document.getElementById('boot').hidden,
      null,
      { timeout: TIMEOUT },
    )
    .then(
      () => true,
      () => false,
    );

await page.goto(stack.app({ url: `${siteURL}one` }));
await started();
check('first tab', await waitLoaded('one'));
await page.click('#new-tab');
await page.fill('#address', `${siteURL}two`);
await page.press('#address', 'Enter');
check('second tab', await waitLoaded('two'));

// Reload restarts, and the restart loads the tab in front again (the crashes are intended)
stopWatching();
check('crash: message', await crash('abort'));
loaded.length = 0;
await page.click('#reload');
check('reload after the crash starts the engine again', await restarted());
check('and loads the tab in front again', await waitLoaded('two'));
// The title of the tab in front comes with an event after its load
check(
  'the tabs are back',
  await waitFor(async () => (await titles()).join('|') === 'one|two', 10000),
  (await titles()).join('|'),
);

// + restarts and opens a new tab in front of the restored ones (a second crash within a minute:
// they load only when clicked)
check('second crash: message', await crash('trap'));
loaded.length = 0;
await page.click('#new-tab');
check('+ after the crash starts the engine again', await restarted());
const afterNew = await titles();
check(
  'the tabs are back and a new tab is in front',
  afterNew.join('|') === 'one|two|New tab' && (await activeTitle()) === 'New tab',
  `${afterNew.join('|')} active ${await activeTitle()}`,
);

// An address typed after the crash opens in front of the restored tabs; the crashed page does not
// load again
await page.click('#tab-list .tab:nth-child(2)');
check('the second tab loads when clicked', await waitLoaded('two'));
check('third crash: message', await crash('abort'));
loaded.length = 0;
await page.click('#address');
await page.fill('#address', `${siteURL}three`);
await page.press('#address', 'Enter');
check('Enter after the crash starts the engine again', await restarted());
check('the typed address loads', await waitLoaded('three'));
const afterTyped = await titles();
check(
  'in a tab in front of the restored ones',
  afterTyped.includes('one') && afterTyped.includes('two') && (await activeTitle()) === 'three',
  `${afterTyped.join('|')} active ${await activeTitle()}`,
);
await page.waitForTimeout(1500);
check('the crashed page does not load again', !loaded.includes('two'), loaded.join('|'));

await browser.close();
finish();
