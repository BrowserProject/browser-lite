// Typing in the address bar like Chrome: a visited site completes inline as soon as the typed text
// starts its host (selected, so typing goes on over it, Backspace removes it) and Enter opens it
// with the scheme it was visited with; Alt+Enter opens the address in a new tab in front,
// Ctrl+Enter makes a name without a dot a .com site with www. The address and the find text stay
// when Safari brings the demo back from its page cache (WebKit resets fields with autocomplete=off).
//
//   node tests/demo/address-bar-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  collect,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const { url: siteURL } = await serve((req, res) => {
  const name = req.url.slice(1) || 'start';
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(
      `<!doctype html><title>${name}</title><p>${name}<script>console.log('RESULT ready=${name}')</script>`,
    );
});
const host = new URL(siteURL).host;

const stack = await startStack({ app: 'demo', token: 'address-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
watchErrors(page);
const results = collect(page);

/** Types text key by key into the emptied address bar, like a user. */
async function typeIn(text) {
  await page.click('#address');
  await page.fill('#address', '');
  await page.keyboard.type(text);
}
const field = () =>
  page.evaluate(() => {
    const address = document.getElementById('address');
    return {
      value: address.value,
      selection: [address.selectionStart, address.selectionEnd],
      first: document.querySelector('#suggestions:not([hidden]) .suggestion-title')?.textContent,
    };
  });
const titles = () => page.locator('#tab-list .tab .title').allTextContents();
const activeTitle = () =>
  page.evaluate(() => document.querySelector('#tab-list .tab.active .title')?.textContent);

await page.goto(stack.app({ url: `${siteURL}one` }));
check('first page', (await results.wait('ready', TIMEOUT)) === 'one');
results.delete('ready');
await typeIn(`${siteURL}two`);
await page.keyboard.press('Enter');
check('an address with a path: typed, never completed', (await results.wait('ready')) === 'two');

// The typed text starts the host of the visited site: completed inline, the rest selected
const prefix = host.slice(0, -3);
await typeIn(prefix);
const completed = await field();
check(
  'inline completion of the visited host, the completed part selected, first row',
  completed.value === host &&
    completed.selection.join() === `${prefix.length},${host.length}` &&
    completed.first === host,
  JSON.stringify(completed),
);
// Typing goes on over the selected completion
await page.keyboard.type(host.at(-3));
const onward = await field();
check(
  'typing on keeps the completion',
  onward.value === host && onward.selection.join() === `${prefix.length + 1},${host.length}`,
  JSON.stringify(onward),
);
results.delete('ready');
await page.keyboard.press('Enter');
check(
  'Enter opens the completed site with the scheme it was visited with',
  (await results.wait('ready')) === 'start',
  results.logs.filter((line) => line.includes('RESULT')).join(' | '),
);

// Backspace removes the completion and does not bring it back
await typeIn(prefix);
await page.keyboard.press('Backspace');
const deleted = await field();
check(
  'Backspace removes the completion',
  deleted.value === prefix && deleted.first !== host,
  JSON.stringify(deleted),
);
await page.keyboard.press('Escape');

// Alt+Enter: a new tab in front, the page behind stays
results.delete('ready');
await typeIn(`${siteURL}three`);
await page.keyboard.press('Alt+Enter');
check('Alt+Enter loads the address', (await results.wait('ready')) === 'three');
check(
  'Alt+Enter: in a new tab in front, the old tab keeps its page',
  (await titles()).join() === 'start,three' && (await activeTitle()) === 'three',
  `${await titles()} ${await activeTitle()}`,
);

// Back from the page cache WebKit resets fields with autocomplete=off (reset() of the form
// control, after pageshow): the address bar and the find text keep what they show
await page.keyboard.press('Control+f');
await page.keyboard.type('three');
await page.evaluate(() => {
  document.getElementById('address-form').reset();
  const find = document.getElementById('find-input');
  const form = document.createElement('form');
  find.replaceWith(form);
  form.append(find);
  form.reset();
  form.replaceWith(find);
});
const restored = await page.evaluate(() => [
  document.getElementById('address').value,
  document.getElementById('find-input').value,
]);
check(
  'reset as after a return from the page cache: the address and the find text stay',
  restored.join() === `${siteURL}three,three`,
  JSON.stringify(restored),
);
await page.keyboard.press('Escape');

// Ctrl+Enter: www. and .com around a name, without the inline completion. The view of the tab
// only records the address (no load into the internet)
await page.evaluate(() => {
  const view = window.blTest.view();
  view.load = (url) => {
    window.loadedAddress = url;
  };
});
async function ctrlEnter(text) {
  await typeIn(text);
  await page.keyboard.press('Control+Enter');
  return page.evaluate(() => window.loadedAddress);
}
const dotCom = await ctrlEnter('wikipedia');
check(
  'Ctrl+Enter: wikipedia opens www.wikipedia.com',
  dotCom === 'https://www.wikipedia.com',
  dotCom,
);
const withPath = await ctrlEnter('example:8080/path');
check('Ctrl+Enter: with port and path', withPath === 'https://www.example.com:8080/path', withPath);
const withDot = await ctrlEnter(prefix);
check(
  'Ctrl+Enter: the typed text without the completion, a name with a dot stays',
  withDot === `https://${prefix}`,
  withDot,
);

await browser.close();
finish();
