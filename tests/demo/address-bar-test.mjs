// Typing in the address bar like Chrome: a visited site completes inline as soon as the typed text
// starts its host (selected, so typing goes on over it, Backspace removes it) and Enter opens it
// with the scheme it was visited with; Alt+Enter opens the address in a new tab in front,
// Ctrl+Enter makes a name without a dot a .com site with www. Like Chrome localhost and IP
// addresses without a scheme load over http://, other sites over https:// with a fallback to
// http:// (unit tests of the core). The address and the find text stay
// when Safari brings the demo back from its page cache (WebKit resets fields with autocomplete=off).
// Every tab keeps an unfinished edit across a tab switch, the first Escape after choosing a row
// with the arrow keys returns to the typed text, and after a javascript: address the field shows
// the page's address again.
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
// The page sees Ctrl+F first; the find bar opens when it did not prevent it
await page.waitForFunction(() => document.activeElement?.id === 'find-input', null, {
  timeout: TIMEOUT,
});
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

// Without a scheme localhost and IP addresses load over http:// like in Chrome (the test server
// has no https://, which ended on the error page)
for (const [name, typed] of [
  ['four', `${host}/four`],
  ['five', `localhost:${new URL(siteURL).port}/five`],
]) {
  results.delete('ready');
  await typeIn(typed);
  await page.keyboard.press('Enter');
  const loaded = await results.wait('ready', TIMEOUT);
  const shown = await page.evaluate(() => document.getElementById('address').value);
  check(
    `${typed} without a scheme loads over http://`,
    loaded === name && shown === `http://${typed}`,
    `${loaded} ${shown}`,
  );
}

// Like Chrome every tab keeps an unfinished edit and the keyboard in the field across a switch
const fiveURL = `http://localhost:${new URL(siteURL).port}/five`;
const state = () =>
  page.evaluate(() => {
    const address = document.getElementById('address');
    return {
      value: address.value,
      focused: document.activeElement === address,
      open: !document.getElementById('suggestions').hidden,
    };
  });
await typeIn('half typed');
await page.keyboard.press('Control+1');
const other = await state();
check('the other tab shows its own address', other.value === siteURL, JSON.stringify(other));
await page.keyboard.press('Control+2');
const back = await state();
check(
  'back on the tab its edit is still in the focused field',
  back.value === 'half typed' && back.focused && !back.open,
  JSON.stringify(back),
);
await page.keyboard.press('Escape');
const reverted = await state();
check(
  'Escape goes back to the address',
  reverted.value === fiveURL && !reverted.focused,
  JSON.stringify(reverted),
);

// The first Escape after choosing a row with the arrow keys returns to the typed text, the
// second to the address
await typeIn('five');
await page.keyboard.press('ArrowDown');
const chosen = await state();
await page.keyboard.press('Escape');
const firstEscape = await state();
check(
  'first Escape: the typed text, the suggestions closed, still editing',
  chosen.value === fiveURL &&
    firstEscape.value === 'five' &&
    firstEscape.focused &&
    !firstEscape.open,
  JSON.stringify([chosen, firstEscape]),
);
await page.keyboard.press('Escape');
const secondEscape = await state();
check(
  'second Escape: the address',
  secondEscape.value === fiveURL && !secondEscape.focused,
  JSON.stringify(secondEscape),
);

// A javascript: address runs in the page; the field shows the page's address again
await typeIn("javascript:void(document.title='X')");
await page.keyboard.press('Enter');
await page.waitForFunction(
  () => document.querySelector('#tab-list .tab.active .title')?.textContent === 'X',
  null,
  { timeout: TIMEOUT },
);
const afterScript = await state();
check(
  'after a javascript: address the field shows the page address',
  afterScript.value === fiveURL,
  JSON.stringify(afterScript),
);

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
check('Ctrl+Enter: wikipedia opens www.wikipedia.com', dotCom === 'www.wikipedia.com', dotCom);
const withPath = await ctrlEnter('example:8080/path');
check('Ctrl+Enter: with port and path', withPath === 'www.example.com:8080/path', withPath);
const withDot = await ctrlEnter(prefix);
check(
  'Ctrl+Enter: the typed text without the completion, a name with a dot stays',
  withDot === prefix,
  withDot,
);

await browser.close();
finish();
