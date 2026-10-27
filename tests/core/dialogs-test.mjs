// Page dialogs only hold their own page (#258): while a confirm of view A waits for the handler,
// view B loads, runs timers, requestAnimationFrame and fetch, and renders; A's timers and
// animation frames do not run inside its script and input to A is dropped. confirm and prompt
// return the answers afterwards, closing A during its alert ends the dialog, two dialogs of
// different views can be open at once, and the watchdog reports no hang.
//
//   node tests/core/dialogs-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  hostEvents,
  launch,
  openHost,
  pagePixel,
  serve,
  startStack,
  timeLimit,
  waitEvent,
  waitFor,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 240000);

// ask(kind, text, value) opens the dialog from a timer and logs answer, timer ticks and animation
// frames that ran inside the waiting script ("RESULT <prefix>_<text>=<answer>:<ticks>:<frames>")
const ASK = (prefix) => `
let ticks = 0, frames = 0;
setInterval(() => ticks++, 20);
const loop = () => { frames++; requestAnimationFrame(loop); };
requestAnimationFrame(loop);
window.ask = (kind, text, value) => setTimeout(() => {
  const t = ticks, f = frames;
  const answer = kind === 'confirm' ? confirm(text) : kind === 'prompt' ? prompt(text, value) : alert(text);
  console.log('RESULT ${prefix}_' + text + '=' + String(answer) + ':' + (ticks - t) + ':' + (frames - f));
}, 0);`;

const PAGES = {
  a: `<!doctype html><title>a</title><body style="margin:0;background:#c00"><script>${ASK('a')}
document.onmousedown = () => console.log('RESULT aClick=1');
console.log('RESULT aLoaded=1')</script>`,
  // Turns blue after 20 timer ticks, fetches, logs what ran after 1.5 s
  b: `<!doctype html><title>b</title><body style="margin:0;background:#0a0"><script>${ASK('b')}
setInterval(() => { if (ticks === 20) document.body.style.background = '#00f'; }, 20);
fetch('/data').then((r) => r.text()).then((t) => console.log('RESULT bFetch=' + t));
setTimeout(() => console.log('RESULT bRun=' + ticks + ':' + frames), 1500);
console.log('RESULT bLoaded=1')</script>`,
  data: 'ok',
};

const { url: siteURL } = await serve((req, res) => {
  const page = PAGES[new URL(req.url, siteURL).pathname.slice(1)];
  if (page === undefined) return res.writeHead(404).end();
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(page);
});

const browser = await launch({ args: SWIFTSHADER });
const stack = await startStack();
const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
const page = await context.newPage();
const results = collect(page);
const ok = await openHost(page, stack.app({ url: `${siteURL}a` }));
check('host page started a browser', ok === true);
await page.evaluate(() => {
  window.blHost.dialogMode = 'hold';
});

// Script in the view with this id, like the debug eval
const run = (id, source) =>
  page.evaluate(
    ([id, source]) =>
      window.blTest.browser.debug.eval(
        window.blTest.views().find((view) => view.id === id),
        source,
      ),
    [id, source],
  );
const answer = (message, value) =>
  page.evaluate(([message, value]) => window.blHost.answerDialog(message, value), [message, value]);
const dialogOpen = (message) => waitEvent(page, new RegExp(`^dialog:\\w+:${message}$`), 20000);
const parts = (value) => (value ?? '').split(':');

check('view A loaded', (await results.wait('aLoaded', 60000)) === '1');
const a = await page.evaluate(() => window.blTest.view().id);

// A confirm from a timer of A; A is active, a click into it is dropped
await run(a, "ask('confirm', 'first')");
check('A: confirm reaches the handler', !!(await dialogOpen('first')));
const origin = await canvasOrigin(page);
await page.mouse.click(origin.x + 50, origin.y + 50);

// Meanwhile view B opens, loads, runs and renders
const b = await page.evaluate((url) => window.blTest.open(url).id, `${siteURL}b`);
check('B loads while A waits', (await results.wait('bLoaded', 30000)) === '1');
check('B: fetch answers while A waits', (await results.wait('bFetch', 20000)) === 'ok');
const [bTicks, bFrames] = parts(await results.wait('bRun', 20000)).map(Number);
check(
  'B: timers and animation frames run while A waits',
  bTicks >= 20 && bFrames >= 10,
  `${bTicks} ticks, ${bFrames} frames`,
);
const blue = await waitFor(async () => {
  const [r, g, b] = (await pagePixel(page, 50, 50)) ?? [];
  return b > 200 && r < 60 && g < 60;
}, 10000);
check('B: renders while A waits', blue, JSON.stringify(await pagePixel(page, 50, 50)));
check('A: still waiting', !results.has('a_first'));

check('A: answer delivered', await answer('first', true));
const first = parts(await results.wait('a_first', 20000));
check(
  'A: confirm returns true, no timer or frame of A ran inside',
  first[0] === 'true' && first[1] === '0' && first[2] === '0',
  first.join(':'),
);
await page.waitForTimeout(500);
check('A: the click during the dialog was dropped', !results.has('aClick'));

// prompt and cancelled confirm (A is in the background now)
await run(a, "ask('prompt', 'second', 'def')");
await dialogOpen('second');
await answer('second', 'xyz');
check('A: prompt returns the answer', parts(await results.wait('a_second', 20000))[0] === 'xyz');
await run(a, "ask('confirm', 'third')");
await dialogOpen('third');
await answer('third', false);
check(
  'A: cancelled confirm returns false',
  parts(await results.wait('a_third', 20000))[0] === 'false',
);

// Two views with a dialog at once: B's opens while A's is open, both return their answers
await run(a, "ask('confirm', 'outer')");
await dialogOpen('outer');
await run(b, "ask('confirm', 'inner')");
check('B: dialog opens while A has one', !!(await dialogOpen('inner')));
await answer('outer', true);
await answer('inner', true);
check(
  'both dialogs return',
  parts(await results.wait('a_outer', 20000))[0] === 'true' &&
    parts(await results.wait('b_inner', 20000))[0] === 'true',
);

// Closing A while its alert is open ends the dialog, B goes on
await run(a, "ask('alert', 'last')");
await dialogOpen('last');
await page.evaluate(
  (id) =>
    window.blTest
      .views()
      .find((view) => view.id === id)
      .close(),
  a,
);
check('closing A aborts its dialog', !!(await waitEvent(page, 'dialog-aborted:last', 10000)));
results.delete('bRun');
await run(b, "setTimeout(() => console.log('RESULT bRun=' + ticks + ':' + frames), 300)");
check('B runs after A closed', !!(await results.wait('bRun', 20000)));
await page.waitForTimeout(1000);
const events = await hostEvents(page);
check(
  'no unresponsive event and no crash',
  !events.some((event) => event === 'unresponsive' || event.startsWith('crash:')),
  events.filter((event) => event === 'unresponsive' || event.startsWith('crash')).join(),
);

await browser.close();
finish();
