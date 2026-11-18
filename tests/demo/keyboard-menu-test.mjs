// The context menu from the keyboard like Chrome on Linux: the menu key and Shift+F10 send the
// page a contextmenu event for the focused element, the selection or the corner of the view, and
// open the menu there unless the page handles the key or the event. Without a focused element the
// event comes at the visible corner, also on a scrolled page. Firefox on Linux sends no keydown for
// these keys but a contextmenu event of the focused element, the core's input field: the page gets
// the menu key from the core instead.
//
//   node tests/demo/keyboard-menu-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  screenshot,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>Keyboard menu</title>
<style>
body { margin: 0; height: 3000px; font: 20px sans-serif }
a, input, #own, #keys { position: absolute; left: 20px }
a { top: 20px } input { top: 70px; width: 300px; font: inherit } #own { top: 120px } #keys { top: 170px }
</style>
<a id="link" href="/next">A link</a>
<input id="field" value="some words">
<div id="own" tabindex="0">Own menu</div>
<div id="keys" tabindex="0">Takes keys</div>
<script>
let count = 0;
let menuKeys = 0;
addEventListener('keydown', (e) => e.key === 'ContextMenu' && console.log('RESULT menukeys=' + ++menuKeys));
addEventListener('contextmenu', (e) => {
  count++;
  const target = e.target.id || e.target.tagName;
  console.log('RESULT menu' + count + '=' + target + ':' + e.button + ':' + Math.round(e.clientX) + ',' + Math.round(e.clientY));
  console.log('RESULT count=' + count);
});
own.addEventListener('contextmenu', (e) => e.preventDefault());
keys.addEventListener('keydown', (e) => {
  if (e.key !== 'ContextMenu' && e.key !== 'F10') return;
  e.preventDefault();
  console.log('RESULT taken=' + e.key);
});
addEventListener('focusin', (e) => console.log('RESULT focus=' + e.target.id));
addEventListener('scroll', () => console.log('RESULT scrolled=' + scrollY));
console.log('RESULT ready=1');
</script>`;

const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/') res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
  else res.writeHead(404).end();
});

const stack = await startStack({ app: 'demo', token: 'keyboard-menu-token-0123456789abcd' });
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(page);
await page.goto(stack.app({ url: siteURL }));
check('page ready', (await results.wait('ready', TIMEOUT)) === '1');

const box = await canvasOrigin(page);
const at = (x, y) => [box.x + x, box.y + y];
const count = () => Number(results.get('count') ?? 0);
const menuItems = () =>
  page
    .locator('.bl-context-menu .bl-menu-item')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.blItem));
// Presses the key (or runs the action) and returns the page's next contextmenu event, our menu's items and where it
// opened in the view (a screenshot of it as e2e-<shot>.png)
const press = async (key, shot = '') => {
  const before = count();
  await (typeof key === 'function' ? key() : page.keyboard.press(key));
  await waitFor(async () => count() > before, 5000);
  const event = count() > before ? results.get(`menu${count()}`) : '';
  const shown = await page
    .waitForSelector('.bl-context-menu', { timeout: event ? 5000 : 1000 })
    .then(() => true)
    .catch(() => false);
  const items = shown ? await menuItems() : [];
  const where = shown ? await page.locator('.bl-context-menu').boundingBox() : null;
  if (shown && shot) await screenshot(page, shot);
  if (shown) await page.keyboard.press('Escape');
  await page.waitForSelector('.bl-context-menu', { state: 'detached', timeout: 5000 });
  return { event, items, at: where && [where.x - box.x, where.y - box.y].map(Math.round) };
};

// No focused element: the event at the corner of the view (WebCore puts it 1 px inside), the menu
// of the page
await page.mouse.click(...at(600, 400));
let menu = await press('Shift+F10');
check('Shift+F10: contextmenu at the corner', menu.event === 'BODY:2:1,1', menu.event);
check('Shift+F10: menu of the page', menu.items.includes('reload'), menu.items.join(' '));
menu = await press('ContextMenu');
check('menu key: contextmenu at the corner', menu.event === 'BODY:2:1,1', menu.event);
check('menu key: menu of the page', menu.items.includes('reload'), menu.items.join(' '));

// Scrolled: still the visible corner, not the document's corner above the view
await page.mouse.move(...at(600, 400));
await page.mouse.wheel(0, 800);
await waitFor(async () => Number(results.get('scrolled') ?? 0) >= 400, 10000);
menu = await press('ContextMenu');
check('scrolled: contextmenu at the visible corner', menu.event === 'BODY:2:1,1', menu.event);
check('scrolled: menu of the page', menu.items.includes('reload'), menu.items.join(' '));
await page.keyboard.press('Home');
await waitFor(async () => results.get('scrolled') === '0', 10000);

// The focused link: the event on the link, the menu of a link
await page.keyboard.press('Tab');
menu = await press('ContextMenu', 'keyboard-menu-link');
check('focused link: contextmenu on the link', menu.event.startsWith('link:2:'), menu.event);
check('focused link: link menu', menu.items.includes('open-link'), menu.items.join(' '));
const [, linkX, linkY] = menu.event.match(/:(\d+),(\d+)$/) ?? [];
check(
  'focused link: the menu opens at the event',
  menu.at && Math.abs(menu.at[0] - linkX) <= 8 && Math.abs(menu.at[1] - linkY) <= 8,
  `${menu.at} for ${linkX},${linkY}`,
);

// Selected text in a field: the event on the field, the edit menu with Copy
await page.keyboard.press('Tab');
await page.keyboard.press('ControlOrMeta+A');
menu = await press('Shift+F10');
check('field: contextmenu on the field', menu.event.startsWith('field:2:'), menu.event);
check(
  'field with a selection: edit menu with Copy',
  menu.items.includes('copy') && menu.items.includes('select-all'),
  menu.items.join(' '),
);

// The page handles the contextmenu event: the event, but no menu of ours
await page.keyboard.press('Tab');
menu = await press('ContextMenu');
check('own menu: contextmenu on the element', menu.event.startsWith('own:2:'), menu.event);
check('own menu: our menu stays closed', menu.items.length === 0, menu.items.join(' '));

// The page cancels the keydown: neither the event nor the menu
await page.keyboard.press('Tab');
menu = await press('ContextMenu');
check('cancelled keydown reached the page', results.get('taken') === 'ContextMenu');
check('cancelled keydown: no contextmenu', menu.event === '', menu.event);
check('cancelled keydown: no menu', menu.items.length === 0, menu.items.join(' '));

// Other modifiers are other shortcuts
await page.keyboard.press('Shift+Tab');
menu = await press('Control+Shift+F10');
check('Ctrl+Shift+F10 on the element: no contextmenu', menu.event === '', results.get('focus'));

// The host's contextmenu of the core's input field, as Firefox on Linux sends it for the menu key
const hostMenu = () =>
  page.evaluate(
    () =>
      document.activeElement?.hasAttribute('data-bl-ime') &&
      !document.activeElement.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      ),
  );
await page.keyboard.press('Shift+Tab');
const menuKeys = () => Number(results.get('menukeys') ?? 0);
let keysBefore = menuKeys();
let cancelled = false;
menu = await press(async () => {
  cancelled = await hostMenu();
});
check('host contextmenu of the input field: cancelled', cancelled);
check('host contextmenu: the page gets the menu key', menuKeys() === keysBefore + 1);
check('host contextmenu: contextmenu on the field', menu.event.startsWith('field:2:'), menu.event);
check('host contextmenu: edit menu', menu.items.includes('paste'), menu.items.join(' '));
// After a menu key the page got, the host's contextmenu (Firefox on Windows) opens nothing more
keysBefore = menuKeys();
const countBefore = count();
await page.keyboard.press('ContextMenu');
await page.waitForSelector('.bl-context-menu', { timeout: 5000 }).catch(() => {});
cancelled = await hostMenu();
await page.waitForTimeout(1000);
check('menu key and host contextmenu: one menu key', menuKeys() === keysBefore + 1);
check('menu key and host contextmenu: one contextmenu', count() === countBefore + 1);
check(
  'menu key and host contextmenu: one menu',
  (await page.locator('.bl-context-menu').count()) === 1 && cancelled,
);
await page.keyboard.press('Escape');

await browser.close();
await finish();
