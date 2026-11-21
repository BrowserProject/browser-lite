// Back to a page in the back/forward cache styles and lays it out once (patch 0172). WebKit keeps
// no render tree in the cache: the restore builds it, with style and layout of every element, and
// then (CachedPage::restore) refreshed the style environment of all documents, which restyled and
// laid out the whole page a second time. On spiegel.de on an emulated phone Back took 7 to 9 s.
// Now the environment is refreshed before the tree is built. Checks:
//  - the navigation's step of the engine thread is in the debug log like a RunLoop step
//    ("RunLoop step took N ms (navigation)"); before, only RunLoop passes were logged
//  - Back until pageshow costs about one build of the page's render tree (display none and back,
//    measured in the page), not two
//  - the environment still counts: on a second Back a media query of the document and of a
//    shadow tree follow a view that got narrower while the page was cached
//
//   node tests/core/back-cache-restore-test.mjs [engine-dir]
import {
  check,
  collect,
  evalPage,
  finish,
  launch,
  load,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

// Cards with many custom properties and rules on every element, like a news front page built
// with a utility CSS framework: most of a restyle is resolving style, little is layout
const TOKENS = Array.from({ length: 40 }, (_, i) => `--t${i}: ${i}px;`).join(' ');
const RESETS = Array.from({ length: 30 }, (_, i) => `--r${i}: var(--t${i});`).join(' ');
const RULES = Array.from(
  { length: 300 },
  (_, i) =>
    `.k${i} > .t { color: hsl(${i} 50% 30%); padding: calc(var(--pad) + var(--r${i % 30})); border-left: var(--t${i % 5}) solid var(--line); --own${i % 20}: var(--r${i % 30}); }`,
).join('\n');
const CARDS = Array.from(
  { length: 3000 },
  (_, i) =>
    `<div class="card k${i % 300}" style="--i:${i}"><span class="t">Headline ${i}</span> <svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="var(--line)"/></svg><b>${i}</b></div>`,
).join('');
const HEAVY = `<!doctype html><title>heavy</title>
<style>
  :root { --pad: 2px; --line: #c00; --gap: calc(var(--pad) * 2); ${TOKENS} }
  *, ::before, ::after { ${RESETS} }
  body { margin: 0; font: 14px/1.4 sans-serif; }
  .card { display: flex; flex-wrap: wrap; gap: var(--gap); margin: var(--gap); width: calc(100% - 2 * var(--gap)); }
  #probe { color: rgb(0, 0, 255); }
  @media (max-width: 700px) { #probe { color: rgb(0, 128, 0); } }
  ${RULES}
</style>
<div id="probe">probe</div><div id="host"></div>
${CARDS}
<script>
  const shadow = document.getElementById('host').attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>span { color: rgb(0, 0, 255); } @media (max-width: 700px) { span { color: rgb(0, 128, 0); } }</style><span>shadow</span>';
  let shows = 0;
  addEventListener('pageshow', (event) => {
    shows++;
    const colors = getComputedStyle(document.getElementById('probe')).color + '/' + getComputedStyle(shadow.querySelector('span')).color;
    console.log('RESULT shown' + shows + '=' + event.persisted + '/' + colors.replaceAll(' ', ''));
  });
  // Tears the render tree down and builds it again: style and layout of every element
  window.rebuild = (n) => {
    const root = document.documentElement;
    root.style.display = 'none';
    root.offsetHeight;
    const start = performance.now();
    root.style.display = '';
    root.offsetHeight;
    console.log('RESULT rebuild' + n + '=' + Math.round(performance.now() - start));
  };
</script>`;
const { url: siteURL } = await serve((req, res) => {
  const html = {
    '/heavy': HEAVY,
    '/light':
      '<!doctype html><title>light</title><p>light<script>console.log("RESULT light=1")</script>',
  }[req.url];
  if (!html) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
});

const stack = await startStack({ token: 'back-cache-restore-token-0123456' });
const browser = await launch();
const tab = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(tab);
check('host page starts', await openHost(tab, stack.app({ url: 'about:blank', log: '1' })));

await load(tab, `${siteURL}heavy`);
check(
  'heavy page loads wide',
  (await results.wait('shown1')) === 'false/rgb(0,0,255)/rgb(0,0,255)',
  results.get('shown1'),
);
await tab.waitForTimeout(1000);
const rebuilds = [];
for (let n = 0; n < 3; n++) {
  await evalPage(tab, `rebuild(${n})`);
  rebuilds.push(Number(await results.wait(`rebuild${n}`)));
  await tab.waitForTimeout(300);
}
const rebuild = rebuilds.sort((a, b) => a - b)[1];

// Back to the cached heavy page; returns what its pageshow logged and the navigation steps
async function backToHeavy(show) {
  results.delete('light');
  await load(tab, `${siteURL}light`);
  check('light page loads', (await results.wait('light')) === '1');
  if (show === 3) {
    // Narrower than the media queries' 700 px while the heavy page is cached
    await tab.setViewportSize({ width: 640, height: 700 });
  }
  await tab.waitForTimeout(1000);
  const logged = results.logs.length;
  const backStart = Date.now();
  await tab.evaluate(() => window.blTest.view().back());
  const shown = await results.wait(`shown${show}`);
  const toPageshow = Date.now() - backStart;
  await tab.waitForTimeout(500);
  const steps = results.logs
    .slice(logged)
    .map((line) => /RunLoop step took (\d+) ms \(navigation\)/.exec(line))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  const stepLines = results.logs
    .slice(logged)
    .filter((l) => /step took/.test(l))
    .join(' | ');
  return { shown, toPageshow, steps, stepLines };
}

const same = await backToHeavy(2);
check('back comes from the cache', String(same.shown).startsWith('true/'), same.shown);
check('the navigation step is in the debug log', same.steps.length > 0, same.stepLines);
const back = Math.max(0, ...same.steps);
check(
  'back costs about one build of the render tree, not two',
  rebuild > 100 && same.toPageshow < 1.5 * rebuild,
  `back step ${back} ms (pageshow after ${same.toPageshow} ms), render tree build ${rebuild} ms (${rebuilds.join(', ')})`,
);

const narrower = await backToHeavy(3);
check(
  'back after the view got narrower takes the media queries of the narrower view',
  narrower.shown === 'true/rgb(0,128,0)/rgb(0,128,0)',
  `pageshow persisted/probe/shadow ${narrower.shown}`,
);

await browser.close();
finish();
