// Lazy fonts of other scripts (#255 in docs/decisions.md, setLazyWaitLimit in
// engine/src/LazyFiles.cpp): a page whose text needs one that is still on the way does not wait
// for it longer than the wait limit; once the font arrives, only the text that may take it is
// laid out again (engine/src/FontArrival.cpp), also in a page that waits in the back/forward
// cache meanwhile.
//
//   node tests/core/fonts-test.mjs [engine-dir]
import {
  check,
  chromiumOnly,
  collect,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

// The width of the text tells which font it has: RESULT <name>first=, then <name>laidout= once
// it changes. Many paragraphs of Latin text around it, which no font arrival changes.
const latin = Array.from(
  { length: 300 },
  (_, i) => `<p>Paragraph ${i} of Latin text that keeps its fonts.</p>`,
).join('');
const page = (name, text) => `<!doctype html><title>${name}</title><body style="margin:20px">
${latin}<span id="text" style="font:40px sans-serif">${text}</span>${latin}
<script>
const text = document.getElementById('text');
const first = text.getBoundingClientRect().width;
console.log('RESULT ${name}first=' + first);
const timer = setInterval(() => {
  const width = text.getBoundingClientRect().width;
  if (width !== first) {
    clearInterval(timer);
    console.log('RESULT ${name}laidout=' + width);
  }
}, 100);
addEventListener('pageshow', (event) => {
  if (event.persisted) console.log('RESULT ${name}restored=' + text.getBoundingClientRect().width);
});
</script>`;
// Thai and Georgian: not in the fonts of engine.data, from lazy/fonts/scripts
const PAGES = {
  '/': page('thai', 'สวัสดีครับ'),
  '/georgian': page('georgian', 'გამარჯობა'),
  '/other': '<!doctype html><title>Other</title><script>console.log("RESULT other=1")</script>',
};
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGES[req.url] ?? '');
});

const stack = await startStack();
const browser = await launch();
const context = await browser.newContext();
const tab = await context.newPage();
watchErrors(tab);
const results = collect(tab);
// "Lazy fonts arrived: text of <n> elements laid out again" (engine log)
const arrivals = () =>
  results.logs
    .map((line) => /Lazy fonts arrived: text of (\d+) elements/.exec(line)?.[1])
    .filter((blocks) => blocks !== undefined)
    .map(Number);

// A font of lazy/fonts/scripts: every request waits until released
const HOLD_MS = 5000;
function holdFont(name) {
  const font = { requests: 0, releasedAt: 0, release: () => {} };
  const released = new Promise((resolve) => {
    font.release = resolve;
  }).then(() => {
    font.releasedAt = Date.now();
  });
  context.route(`**/lazy/fonts/scripts/${name}-*`, async (route) => {
    font.requests++;
    await released;
    await route.continue();
  });
  return font;
}

const thai = holdFont('NotoSansThai');
check('browser starts', await openHost(tab, stack.app({ url: siteURL, log: '1' })));
const first = await results.wait('thaifirst', HOLD_MS + 10000);
check(
  'the text is laid out while its font is held back',
  first !== null && !thai.releasedAt,
  first,
);
check('the font was requested', thai.requests >= 1, `${thai.requests} requests`);
setTimeout(thai.release, HOLD_MS);
// Playwright holds back the synchronous request of the engine thread only in Chromium: in Firefox
// the font is there at once
if (chromiumOnly('relayout once the font is there (route of a synchronous request)')) {
  const laidOut = await results.wait('thailaidout', 20000);
  check(
    'once the font is there the text is laid out again with it',
    laidOut !== null && thai.releasedAt > 0,
    `${first} -> ${laidOut}`,
  );
  check(
    'only the element with that text is laid out again, not the Latin paragraphs',
    arrivals().length === 1 && arrivals()[0] === 1,
    `elements per arrival: ${arrivals().join(', ')}`,
  );

  // A page left for another one before its font arrives comes back from the back/forward cache
  // with its text laid out with the font
  const georgian = holdFont('NotoSansGeorgian');
  await tab.evaluate((url) => window.blTest.load(url), `${siteURL}georgian`);
  const before = await results.wait('georgianfirst', HOLD_MS + 10000);
  check(
    'the second page goes on without its font',
    before !== null && !georgian.releasedAt,
    before,
  );
  await tab.evaluate((url) => window.blTest.load(url), `${siteURL}other`);
  check('another page loads', (await results.wait('other', 20000)) !== null);
  georgian.release();
  const end = Date.now() + 20000;
  while (arrivals().length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  check('the font arrives while the page is in the cache', arrivals().length === 2, arrivals());
  await tab.evaluate(() => window.blTest.view().back());
  const restored = await results.wait('georgianrestored', 20000);
  check(
    'back from the cache its text is laid out with the font',
    restored !== null && restored !== before,
    `${before} -> ${restored}`,
  );
} else {
  await results.wait('thailaidout', 20000);
}

await browser.close();
finish();
