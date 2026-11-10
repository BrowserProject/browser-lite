// Background tabs in the demo UI (the engine side is tests/core/background-test.mjs): under memory
// pressure the demo discards the least recently used background tab (titles stay, a discarded
// tab loads again when clicked at its scroll position, also a reopened one and the tabs of a
// restored session, with none left to discard and memory critical the message names the page,
// with memory only above the budget no message), never a tab with a picture-in-picture window;
// the hang message after an input without an answer for 10 s goes away when the watchdog stops
// the script; a long alert does not count as a hang.
//
//   node tests/demo/background-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  TIMEOUT,
  VERBOSE,
  answerPageDialogs,
  canvasOrigin,
  check,
  finish,
  launch,
  recordClip,
  serve,
  serveBytes,
  startStack,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 240000);

const PAGES = {
  empty:
    '<!doctype html><title>empty</title><p>empty<script>console.log("RESULT loaded=empty")</script>',
  // Loop in mousedown: blocks the engine thread until the watchdog stops it
  stuck: `<!doctype html><title>stuck</title><body style="margin:0"><div style="width:400px;height:300px;background:#cde"></div>
<script>document.body.onmousedown = () => { if (location.hash === '#go') for (;;); };
console.log('RESULT loaded=stuck')</script>`,
  // alert from keydown, then some more work
  dialog: `<!doctype html><title>dialog</title><body style="margin:0"><div style="width:400px;height:300px;background:#cde"></div>
<script>document.onkeydown = (e) => { if (e.key !== 'a') return; alert('hello'); const end = Date.now() + 300; while (Date.now() < end); console.log('RESULT alerted=1'); };
console.log('RESULT loaded=dialog')</script>`,
  // A muted video, a click sends it into the PiP window
  pip: `<!doctype html><title>pip</title><body style="margin:0"><video src="/clip.webm" muted loop autoplay playsinline style="display:block;width:400px;height:300px"></video>
<script>const video = document.querySelector('video');
video.onplaying = () => console.log('RESULT playing=' + document.visibilityState);
video.onpause = () => console.log('RESULT pause=' + document.visibilityState);
document.onclick = () => video.requestPictureInPicture().then(() => console.log('RESULT pip=ok'), (e) => console.log('RESULT pip=' + e.name));
console.log('RESULT loaded=pip')</script>`,
  // For memory pressure: reports when the tab is discarded
  memory: `<!doctype html><title>memory</title><p>memory<script>const name = location.search.slice(1);
addEventListener('pagehide', () => console.log('RESULT gone=' + name));
console.log('RESULT loaded=' + name)</script>`,
  // Reports where it stops after a scroll and where it is a second after loading
  long: `<!doctype html><title>long</title><body style="margin:0"><div style="height:20000px;background:linear-gradient(#fff,#36c)"></div>
<script>let timer;
addEventListener('scroll', () => { clearTimeout(timer); timer = setTimeout(() => console.log('RESULT scrolled=' + Math.round(scrollY)), 300); });
addEventListener('load', () => setTimeout(() => console.log('RESULT at=' + Math.round(scrollY)), 1000));
addEventListener('pagehide', () => console.log('RESULT left=' + Math.round(scrollY)));
console.log('RESULT loaded=long')</script>`,
};
const browser = await launch({
  args: [...SWIFTSHADER, '--autoplay-policy=no-user-gesture-required'],
});
const CLIP = await recordClip(browser, 4);
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/clip.webm') return serveBytes(req, res, CLIP, 'video/webm');
  const page = PAGES[new URL(req.url, siteURL).pathname.slice(1)];
  if (!page) return res.writeHead(404).end();
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(page);
});

const stack = await startStack({ app: 'demo', token: 'background-token-0123456789ab' });

// The demo in a new context; results: [viewId, key, value] in order
async function openApp(params) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  const results = [];
  watchErrors(page);
  page.on('console', (msg) => {
    const text = msg.text();
    if (VERBOSE) console.log('   ', text);
    const match = /\[page (\d+)\] RESULT (\w+)=(\S*)/.exec(text);
    if (match) results.push([Number(match[1]), match[2], match[3]]);
  });
  const wait = async (key, value = null, ms = 30000) => {
    for (
      const end = Date.now() + ms;
      Date.now() < end;
      await new Promise((r) => setTimeout(r, 100))
    ) {
      const found = results.find((r) => r[1] === key && (value === null || r[2] === value));
      if (found) {
        results.splice(results.indexOf(found), 1);
        return found;
      }
    }
    return null;
  };
  await page.goto(stack.app(params));
  await page.waitForFunction(() => document.getElementById('boot').hidden, null, {
    timeout: TIMEOUT,
  });
  const go = async (address) => {
    await page.click('#address');
    await page.fill('#address', address);
    await page.press('#address', 'Enter');
  };
  // A new tab in front with an address; the previous one goes to the background
  const newTab = async (address) => {
    await page.click('#new-tab');
    await go(address);
  };
  const selectTab = (index) => page.click(`#tab-list .tab:nth-child(${index}) .title`);
  return { context, page, results, wait, go, newTab, selectTab };
}

// Memory pressure: over the limit the engine reports at every growth by 32 MB, the demo discards
// the least recently used background tab each time. The limit is just above the memory of the
// same session without pressure.
async function memorySession(params) {
  const app = await openApp({ url: `${siteURL}memory?one`, ...params });
  await app.wait('loaded', 'one');
  await app.newTab(`${siteURL}memory?two`);
  await app.wait('loaded', 'two');
  await app.newTab(`${siteURL}memory?three`);
  await app.wait('loaded', 'three');
  await app.page.waitForTimeout(1000);
  return app;
}
const probe = await memorySession({});
const baseMB = Math.ceil((await probe.page.evaluate(() => window.blTest.memory())) / 2 ** 20);
await probe.context.close();
const app = await memorySession({ env: `BL_MEMORY_PRESSURE_MB=${baseMB + 96}` });
check(
  'memory pressure: no tab discarded before',
  !app.results.some((r) => r[1] === 'gone'),
  `limit ${baseMB + 96} MB`,
);
const allocate = (mb) =>
  app.page.evaluate(
    (size) =>
      window.blTest.eval(
        `(window.big ||= []).push(new Uint8Array(${size} << 20).fill(1)); console.log("RESULT allocated=" + big.length)`,
      ),
    mb,
  );
const gone = [];
for (let i = 0; i < 12 && gone.length < 2; i++) {
  await allocate(64);
  await app.wait('allocated');
  await app.page.waitForTimeout(500);
  for (let found; (found = await app.wait('gone', null, 10)); ) gone.push(found[2]);
}
check(
  'memory pressure: both background tabs discarded, the oldest first',
  gone.join() === 'one,two',
  gone.join(),
);
await allocate(64);
await app.page.waitForTimeout(1000);
const titles = await app.page.locator('#tab-list .tab .title').allTextContents();
check(
  'memory pressure: the active tab stays, the titles of the discarded ones stay',
  !(await app.wait('gone', null, 500)) && titles.join() === 'memory,memory,memory',
  titles.join(),
);
// Discarded tabs hold no page: closing them would free nothing, so the message names the page
const status = await app.page.evaluate(() => document.getElementById('status').textContent);
check(
  'memory pressure with only discarded background tabs: the message names the page',
  /Memory is almost full: this page/.test(status),
  status,
);
await app.selectTab(1);
check('memory pressure: a discarded tab loads when clicked', !!(await app.wait('loaded', 'one')));
await app.context.close();

// One tab above the budget with its malloc area free again after the release (the footprint
// never shrinks, #497): the engine reports 'moderate', the demo has nothing to discard and shows
// no message
const single = await openApp({
  url: `${siteURL}memory?single`,
  env: `BL_MEMORY_PRESSURE_MB=${baseMB}`,
  log: '1',
});
const engineLog = [];
single.page.on('console', (msg) => engineLog.push(msg.text()));
await single.wait('loaded', 'single');
// Garbage the release after this task collects
await single.page.evaluate(() => window.blTest.eval('new Uint8Array(256 << 20).fill(1).length'));
const pressureLogged = () => engineLog.some((line) => line.includes('Memory pressure'));
for (let i = 0; i < 100 && !pressureLogged(); i++) await single.page.waitForTimeout(100);
await single.page.waitForTimeout(500);
const singleStatus = await single.page.evaluate(
  () => document.getElementById('status').textContent,
);
check(
  'memory pressure above the budget with the area free again: moderate, no message',
  engineLog.some((line) => line.includes('Memory pressure (moderate)')) &&
    !/Memory is almost full/.test(singleStatus),
  `${engineLog.filter((line) => /Memory (released|pressure)/.test(line)).join(' | ')}; status "${singleStatus}"`,
);
await single.context.close();

// Like Chrome a discarded tab and a reopened one (Ctrl+Shift+T) come back at their scroll position
const long = await openApp({ url: `${siteURL}long` });
await long.wait('at', '0');
const longOrigin = await canvasOrigin(long.page);
await long.page.mouse.move(longOrigin.x + 300, longOrigin.y + 300);
for (let i = 0; i < 10; i++) await long.page.mouse.wheel(0, 300);
const scrolled = Number((await long.wait('scrolled'))?.[2]);
// The engine reports the position at most once a second
await long.page.waitForTimeout(1500);
await long.newTab(`${siteURL}empty`);
await long.wait('loaded', 'empty');
const discardedLong = await long.page.evaluate(() => window.blTest.checkMemory());
await long.selectTab(1);
await long.wait('loaded', 'long');
const restoredAt = (await long.wait('at'))?.[2];
check(
  'memory pressure: a discarded tab comes back at its scroll position',
  discardedLong > 0 && scrolled > 1000 && Number(restoredAt) === scrolled,
  `discarded ${discardedLong}, scrolled to ${scrolled}, back at ${restoredAt}`,
);
// Scrolled further and closed at once, before the engine's report a second after the scroll:
// closing the view brings it
await long.page.waitForTimeout(1500);
long.results.length = 0;
await long.page.mouse.move(longOrigin.x + 300, longOrigin.y + 300);
for (let i = 0; i < 5; i++) await long.page.mouse.wheel(0, 300);
await long.page.click('#address');
await long.page.keyboard.press('Control+w');
await long.page.waitForFunction(() => document.querySelectorAll('#tab-list .tab').length === 1);
await long.page.keyboard.press('Control+Shift+T');
await long.wait('loaded', 'long');
const reopenedAt = (await long.wait('at'))?.[2];
const closedAt = Number((await long.wait('left'))?.[2]);
check(
  'Ctrl+Shift+T: a tab closed right after a scroll comes back at its scroll position',
  closedAt > scrolled && Number(reopenedAt) === closedAt,
  `scrolled to ${scrolled}, then to ${closedAt}, back at ${reopenedAt}`,
);
await long.context.close();

// Like Chrome a restored session brings a background tab back at its scroll position: scrolled
// in tab 2, tab 1 in front, the demo page reloaded at once (before the engine's report a second
// after the scroll, the page hide brings it), then tab 2 clicked
const restore = await openApp({ url: `${siteURL}empty` });
await restore.wait('loaded', 'empty');
await restore.newTab(`${siteURL}long`);
await restore.wait('at', '0');
const restoreOrigin = await canvasOrigin(restore.page);
await restore.page.mouse.move(restoreOrigin.x + 300, restoreOrigin.y + 300);
for (let i = 0; i < 10; i++) await restore.page.mouse.wheel(0, 300);
const restoreScrolled = Number((await restore.wait('scrolled'))?.[2]);
await restore.selectTab(1);
await restore.page.goto(stack.app());
await restore.page.waitForFunction(() => document.getElementById('boot').hidden, null, {
  timeout: TIMEOUT,
});
await restore.wait('loaded', 'empty');
await restore.selectTab(2);
await restore.wait('loaded', 'long');
const sessionAt = (await restore.wait('at'))?.[2];
check(
  'session: a restored tab comes back at its scroll position',
  restoreScrolled > 1000 && Number(sessionAt) === restoreScrolled,
  `scrolled to ${restoreScrolled}, back at ${sessionAt}`,
);
await restore.context.close();

// A hang after an input: the engine thread finishes no task any more
const hang = await openApp({ url: `${siteURL}stuck`, scripttimeout: '20' });
await hang.wait('loaded', 'stuck');
const origin = await canvasOrigin(hang.page);
const boot = () =>
  hang.page.evaluate(() =>
    document.getElementById('boot').hidden ? '' : document.getElementById('boot').textContent,
  );
await hang.page.mouse.click(origin.x + 100, origin.y + 100);
await hang.page.waitForTimeout(11500);
check('click without a hang: no message', (await boot()) === '', await boot());
await hang.page.evaluate(() => window.blTest.eval('location.hash = "go"'));
await hang.page.waitForTimeout(500);
const clicked = Date.now();
await hang.page.mouse.click(origin.x + 100, origin.y + 100);
const shownHang = await hang.page
  .waitForFunction(
    () =>
      document.getElementById('boot').textContent.includes('not responding') &&
      !document.getElementById('boot').hidden,
    null,
    { timeout: 14000 },
  )
  .then(
    () => true,
    () => false,
  );
check(
  'click into a hanging page: message after 10 s',
  shownHang && Date.now() - clicked >= 9500,
  `${Date.now() - clicked} ms, ${await boot()}`,
);
const recovered = await hang.page
  .waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: 15000 })
  .then(
    () => true,
    () => false,
  );
check('hang after a click: the message goes when the watchdog stops the script', recovered);
await hang.context.close();

// The time a dialog waits for the answer does not count as a hang, even when the input is still
// open
const dialog = await openApp({ url: `${siteURL}dialog` });
await dialog.wait('loaded', 'dialog');
let alerts = 0;
await answerPageDialogs(dialog.page, async (type) => {
  if (type !== 'alert') return 'dismiss';
  alerts++;
  await new Promise((r) => setTimeout(r, 12000));
  return 'accept';
});
await dialog.page.evaluate(() => {
  window.blHangSeen = 0;
  const box = document.getElementById('boot');
  new MutationObserver(() => {
    if (!box.hidden && box.textContent.includes('not responding')) window.blHangSeen++;
  }).observe(box, { attributes: true, childList: true, subtree: true, characterData: true });
});
const dialogOrigin = await canvasOrigin(dialog.page);
await dialog.page.mouse.click(dialogOrigin.x + 100, dialogOrigin.y + 100);
await dialog.page.waitForTimeout(500);
dialog.page.keyboard.press('a').catch(() => {});
const alerted = await dialog.wait('alerted', null, 30000);
await dialog.page.waitForTimeout(2500);
const hangSeen = await dialog.page.evaluate(() => window.blHangSeen);
check(
  'long alert after a key: no "not responding" message',
  alerts === 1 && !!alerted && hangSeen === 0,
  `${alerts} dialogs, message ${hangSeen}x`,
);
await dialog.context.close();

// A tab with a picture-in-picture window is never discarded, even when it is the oldest
const pip = await openApp({ url: `${siteURL}pip` });
await pip.wait('loaded', 'pip');
check('PiP: muted video plays', !!(await pip.wait('playing', 'visible')));
// Firefox has no picture-in-picture API (the pages do not see it either, core/media-test.mjs)
if (await pip.page.evaluate(() => 'requestPictureInPicture' in HTMLVideoElement.prototype)) {
  const pipOrigin = await canvasOrigin(pip.page);
  await pip.page.mouse.click(pipOrigin.x + 100, pipOrigin.y + 100);
  check(
    'PiP: video in the PiP window',
    (await pip.wait('pip'))?.[2] === 'ok' &&
      (await pip.page.evaluate(() => !!document.pictureInPictureElement)),
  );
  // Only what comes from here on (autoplay also reports pause at the start)
  pip.results.length = 0;
  await pip.newTab(`${siteURL}empty`);
  await pip.wait('loaded', 'empty');
  await pip.newTab(`${siteURL}memory?new`);
  await pip.wait('loaded', 'new');
  const discarded = await pip.page.evaluate(() => window.blTest.checkMemory());
  const pipTitles = await pip.page.locator('#tab-list .tab .title').allTextContents();
  check(
    'memory pressure: the tab with the PiP window stays',
    discarded > 0 &&
      (await pip.page.evaluate(() => !!document.pictureInPictureElement)) &&
      !pip.results.some((r) => r[1] === 'pause'),
    `discarded ${discarded}, tabs ${pipTitles}`,
  );
  await pip.page.evaluate(() => document.exitPictureInPicture().catch(() => {}));
} else console.log('skip PiP tab and memory pressure (the host has no picture-in-picture)');
await pip.context.close();

await browser.close();
finish();
