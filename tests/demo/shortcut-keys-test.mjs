// Keys typed right after a shortcut the page gets first (Ctrl+L, Ctrl+F) while the page is busy:
// they wait in the host until the engine answered the shortcut's keydown, like in Chrome, and go
// to whatever has the focus then. The address and find bars get every letter and the page none;
// when the page handles the shortcut itself, the letters after it reach the page in order.
//
//   node tests/demo/shortcut-keys-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

// The page logs every key and keeps the engine thread busy for 600 ms on a shortcut, like a busy
// site; it handles Ctrl+K itself.
const PAGE = `<!doctype html><title>keys</title><body style="height:2000px"><p>keys</p><script>
let keys = '';
addEventListener('keydown', (e) => {
  keys += e.key.length === 1 && !e.ctrlKey ? e.key : '';
  console.log('RESULT keys=' + keys);
  if (e.ctrlKey) {
    if (e.key === 'k') e.preventDefault();
    const start = performance.now();
    while (performance.now() - start < 600) {}
  }
});
console.log('RESULT ready=1');
</script>`;
const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

const stack = await startStack({ app: 'demo', token: 'shortcut-keys-token-0123456789abcdef' });
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(page);
await page.goto(stack.app({ url: siteURL }));
check('page loaded', (await results.wait('ready', TIMEOUT)) === '1');
const box = await canvasOrigin(page);

const bars = () =>
  page.evaluate(() => ({
    active: document.activeElement?.id ?? '',
    address: document.getElementById('address')?.value ?? '',
    find: document.getElementById('find-input')?.value ?? '',
  }));

// Types `text` right after `combo` into the page and returns what the page and the bars got
async function typeAfter(combo, text) {
  await page.mouse.click(box.x + 300, box.y + 300);
  await page.waitForTimeout(300);
  const before = results.get('keys') ?? '';
  await page.keyboard.press(combo);
  await page.keyboard.type(text, { delay: 40 });
  await page.waitForTimeout(1500);
  const keys = results.get('keys') ?? '';
  return { page: keys.slice(before.length), ...(await bars()) };
}

const address = await typeAfter('Control+l', 'example.org');
check(
  'letters after Ctrl+L all go to the address bar',
  address.page === '' && address.active === 'address' && address.address === 'example.org',
  JSON.stringify(address),
);
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');

const find = await typeAfter('Control+f', 'lake');
check(
  'letters after Ctrl+F all go to the find bar',
  find.page === '' && find.active === 'find-input' && find.find === 'lake',
  JSON.stringify(find),
);
await page.keyboard.press('Escape');

const own = await typeAfter('Control+k', 'abc');
check(
  'letters after a shortcut the page handles reach the page in order',
  own.page === 'abc' && own.active !== 'address',
  JSON.stringify(own),
);

await browser.close();
finish();
