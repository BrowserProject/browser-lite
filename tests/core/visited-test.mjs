// :visited (engine/src/VisitedLinks.cpp): links to the addresses a view loaded and to those the
// host added with addVisitedLinks get the :visited style, also in the page that is open and in the
// page that comes back from the back/forward cache after one of its links was followed;
// clearVisitedLinks takes it away again. getComputedStyle keeps reporting the unvisited style, like
// in every browser. Before the engine had its own store, WebCore's empty one answered "not
// visited" for every link.
//
//   node tests/core/visited-test.mjs [engine-dir]
import {
  check,
  collect,
  evalPage,
  finish,
  launch,
  load,
  openHost,
  pagePixel,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit();

const LINKS = ['first', 'seeded', 'later', 'never'];
const PAGE = `<!doctype html><title>links</title>
<style>
  body { margin: 0; }
  a { display: block; width: 200px; height: 80px; background-color: rgb(0, 0, 255); }
  a:visited { background-color: rgb(255, 0, 0); }
</style>
${LINKS.map((name) => `<a id="${name}" href="/${name}">${name}</a>`).join('\n')}
<script>
addEventListener('pageshow', (event) => console.log('RESULT links=' + event.persisted));
</script>`;
const { url } = await serve((req, res) => {
  const name = req.url.slice(1);
  const body =
    name === 'links'
      ? PAGE
      : `<!doctype html><title>${name}</title><script>console.log('RESULT ${name}=1')</script>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
});

const stack = await startStack();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const results = collect(page);
check('host page starts', await openHost(page, stack.app({ url: `${url}first`, log: '1' })));
await results.wait('first');
await load(page, `${url}links`);
check('links page loads', (await results.wait('links')) === 'false');

/**
 * Checks that the links painted in the :visited color become `expected` (names, comma separated).
 * A restyle may first wait for a deferred chunk of the engine (#238), which can take seconds.
 */
async function checkVisited(name, expected) {
  let names = [];
  await waitFor(async () => {
    names = [];
    for (const [index, name] of LINKS.entries()) {
      const pixel = await pagePixel(page, 50, 40 + 80 * index);
      if (pixel && pixel[0] > 200 && pixel[2] < 50) names.push(name);
    }
    return names.join() === expected;
  }, 30000);
  check(name, names.join() === expected, `[${names.join()}]`);
}

await checkVisited('a link to a loaded address is visited', 'first');

await page.evaluate((link) => window.blTest.browser.addVisitedLinks([link]), `${url}seeded`);
await checkVisited('addVisitedLinks restyles the open page', 'first,seeded');

await evalPage(
  page,
  `console.log('RESULT computed=' + getComputedStyle(document.getElementById('first')).backgroundColor.replaceAll(' ', ''))`,
);
check(
  'getComputedStyle reports the unvisited style',
  (await results.wait('computed')) === 'rgb(0,0,255)',
);

await load(page, `${url}later`);
await results.wait('later');
results.delete('links');
await page.evaluate(() => window.blTest.view().back());
check(
  'links page comes back from the back/forward cache',
  (await results.wait('links')) === 'true',
);
await checkVisited('the link followed meanwhile is visited after going back', 'first,seeded,later');

await page.evaluate(() => window.blTest.browser.clearVisitedLinks());
await checkVisited('clearVisitedLinks restyles the open page', '');

await browser.close();
finish();
