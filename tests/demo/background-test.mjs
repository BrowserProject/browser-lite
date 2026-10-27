// Background tabs in the demo UI (the engine side is tests/core/background-test.mjs): under memory
// pressure the demo discards the least recently used background tab (titles stay, a discarded
// tab loads again when clicked), never a tab with a picture-in-picture window; the hang message
// after an input without an answer for 10 s goes away when the watchdog stops the script; a long
// alert does not count as a hang.
//
//   node tests/demo/background-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  TIMEOUT,
  VERBOSE,
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
await app.selectTab(1);
check('memory pressure: a discarded tab loads when clicked', !!(await app.wait('loaded', 'one')));
await app.context.close();

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

// A dialog stops the main thread of the demo: the time until the answer does not count as a hang,
// even when the input is still open
const dialog = await openApp({ url: `${siteURL}dialog` });
await dialog.wait('loaded', 'dialog');
let alerts = 0;
dialog.page.on('dialog', async (d) => {
  if (d.type() !== 'alert') return d.dismiss();
  alerts++;
  await new Promise((r) => setTimeout(r, 12000));
  await d.accept();
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
