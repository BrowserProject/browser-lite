// The tab overview of the phone layout closes a tab whose card is swiped sideways, like Chrome on
// Android and Safari on iOS: past a good third of the card's width or flung, the card slides out
// and its tab closes while the overview stays; a short slow swipe slides it back, and no swipe
// opens its tab. A vertical move leaves the card where it is, a tap still switches. A title that
// changes during a swipe keeps the card under the finger, also of the tab in front. A finger in Chromium (CDP touch events,
// so touch-action counts), the mouse elsewhere.
//
//   node tests/demo/tab-swipe-test.mjs [engine-dir]
import {
  BROWSER,
  TIMEOUT,
  check,
  collect,
  emulateTouchPoints,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const { url: siteURL } = await serve((req, res) => {
  const name = req.url.slice(1);
  if (!/^[a-e]$/.test(name)) return res.writeHead(404).end();
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(
      `<!doctype html><meta name="viewport" content="width=device-width"><title>${name.toUpperCase()}</title><p>${name}<script>console.log('RESULT ready=${name}')</script>`,
    );
});

const stack = await startStack({ app: 'demo', token: 'swipe-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  ...(BROWSER === 'chromium' ? { isMobile: true } : {}),
});
await emulateTouchPoints(context);
const page = await context.newPage();
watchErrors(page);
const results = collect(page);
const cdp = BROWSER === 'chromium' ? await context.newCDPSession(page) : null;

const titles = () => page.locator('.overview-card .overview-title').allTextContents();
const activeTitle = () =>
  page.evaluate(() => document.querySelector('.overview-card.active .overview-title')?.textContent);
const overviewOpen = () => page.evaluate(() => !document.getElementById('tab-overview').hidden);
const titlesAre = (expected) =>
  page
    .waitForFunction(
      (expected) =>
        [...document.querySelectorAll('.overview-card .overview-title')]
          .map((title) => title.textContent)
          .join('') === expected,
      expected,
      { timeout: 10000 },
    )
    .then(
      () => true,
      () => false,
    );
const cardBox = (title) =>
  page.locator('.overview-card', { hasText: new RegExp(`^${title}`) }).boundingBox();

/** Swipes from the middle of the card of title by dx, dy in steps of ms each, then lifts. */
async function swipe(title, dx, { dy = 0, steps = 10, ms = 30, beforeLift = null } = {}) {
  const box = await cardBox(title);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const at = (i) => ({ x: x + (dx * i) / steps, y: y + (dy * i) / steps });
  if (cdp) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(0)] });
    for (let i = 1; i <= steps; i++) {
      await page.waitForTimeout(ms);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(i)] });
    }
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.waitForTimeout(ms);
      await page.mouse.move(at(i).x, at(i).y);
    }
  }
  await beforeLift?.();
  if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  else await page.mouse.up();
}

// Five tabs A to E, E in front
await page.goto(stack.app({ url: `${siteURL}a` }));
check('first page', (await results.wait('ready', TIMEOUT)) === 'a');
for (const name of ['b', 'c', 'd', 'e']) {
  results.delete('ready');
  await page.evaluate((url) => window.blTest.open(url), `${siteURL}${name}`);
  await results.wait('ready');
}
await page.tap('#tab-count');
check('the overview shows five tabs', await titlesAre('ABCDE'), (await titles()).join(''));
const width = (await cardBox('B')).width;

// Slow, past 60 percent to the left: the tab closes, the overview stays, E stays in front
await swipe('B', -0.6 * width);
check('a swipe past a third of the card closes its tab', await titlesAre('ACDE'));
check(
  'after the swipe: the overview stays, the tab in front stays',
  (await overviewOpen()) && (await activeTitle()) === 'E',
  `${await overviewOpen()}, ${await activeTitle()}`,
);
check('the tab count follows', (await page.textContent('#tab-count')).trim() === '4');

// Short and slow to the right: the card slides back, nothing closes or opens
await swipe('C', 0.2 * width, { steps: 10, ms: 40, beforeLift: () => page.waitForTimeout(200) });
await page.waitForTimeout(800);
const back = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.overview-card')].find(
    (card) => card.querySelector('.overview-title').textContent === 'C',
  );
  const style = getComputedStyle(card);
  return { translate: style.translate, opacity: style.opacity, swiping: card.matches('.swiping') };
});
check(
  'a short slow swipe: the card slides back',
  ['none', '0px'].includes(back.translate) && back.opacity === '1' && !back.swiping,
  JSON.stringify(back),
);
check(
  'a short slow swipe: no tab closes, none opens',
  (await titles()).join('') === 'ACDE' && (await overviewOpen()) && (await activeTitle()) === 'E',
  `${(await titles()).join('')}, ${await overviewOpen()}, ${await activeTitle()}`,
);

// A short fast fling to the right closes
await swipe('C', 0.3 * width, { steps: 3, ms: 10 });
check('a fling closes the tab', await titlesAre('ADE'));

// A vertical move leaves the card
await swipe('D', 15, { dy: 120 });
await page.waitForTimeout(500);
check(
  'a vertical move: the card stays, nothing opens',
  (await titles()).join('') === 'ADE' && (await overviewOpen()),
  `${(await titles()).join('')}, ${await overviewOpen()}`,
);

// The page in front changes its title (by a timer) while the finger is on its card
await page.evaluate(() => {
  window.titleDuringSwipe = false;
  const watch = setInterval(() => {
    const card = document.querySelector('.overview-card.swiping');
    if (card?.querySelector('.overview-title').textContent !== 'E2') return;
    window.titleDuringSwipe = true;
    clearInterval(watch);
  }, 20);
  return window.blTest.eval("setTimeout(() => { document.title = 'E2' }, 300)");
});
await swipe('E', 0.6 * width, { beforeLift: () => page.waitForTimeout(1500) });
check(
  'a title change during the swipe: the card shows it',
  await page.evaluate(() => window.titleDuringSwipe),
);
check('a title change during the swipe: the swipe still closes', await titlesAre('AD'));

// A tap still switches
await page.locator('.overview-card', { hasText: /^D/ }).locator('.overview-open').tap();
const switched = await page
  .waitForFunction(() => window.blTest.view()?.url.endsWith('/d'), null, { timeout: 10000 })
  .then(
    () => true,
    () => false,
  );
check('a tap on a card switches and closes the overview', switched && !(await overviewOpen()));

await browser.close();
finish();
