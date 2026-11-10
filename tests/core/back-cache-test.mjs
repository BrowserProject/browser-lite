// The back/forward cache through the automatic memory releases (engine/src/MemoryWatch.cpp): a
// release keeps the page left last, so going back to it shows it at once where it was scrolled to
// (pageshow persisted), instead of loading it again and restoring the scroll position only once
// the load is complete. Older pages and, when memory is short, every cached page go. Above the
// memory budget (BL_MEMORY_PRESSURE_MB, 512 MB on iPhone and iPad) memory is short only while the
// malloc area stays full after the release: its size never shrinks, so one heavy page left kept it
// above the budget and made every later release drop the cache (memory-pressure 'moderate'
// instead of 'critical').
//
//   node tests/core/back-cache-test.mjs [engine-dir]
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

const page = (
  name,
) => `<!doctype html><title>${name}</title><body style="height:8000px">${name}<script>
// Counts the shows of this page in the tab, also across loading it again. The scroll position is
// the one of the first frame shown (WebKit restores it after pageshow).
addEventListener('pageshow', (event) => {
  const shows = Number(sessionStorage['${name}'] || 0) + 1;
  sessionStorage['${name}'] = shows;
  requestAnimationFrame(() =>
    console.log('RESULT ${name}' + shows + '=' + event.persisted + '/' + Math.round(scrollY)));
});
const keep = [];
// Engine memory the page holds: malloc grows, the release follows after this task
window.allocate = (name, mb) => {
  keep.push(new Uint8Array(mb << 20).fill(1));
  console.log('RESULT ' + name + '=ok');
};
</script>`;
const { url: siteURL } = await serve((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1);
  if (!/^[a-z]+$/.test(name)) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(name));
});

const stack = await startStack();
const browser = await launch();

// Opens the pages one after the other, each scrolled to 3000 (the first holding heldMB of engine
// memory), then grows malloc in the last one until an automatic release ran. Returns pageshow of
// going back to each of the others in turn, and the level of the last memory-pressure event.
async function backAfterRelease(label, env, names, heldMB = 0) {
  const tab = await browser.newPage();
  const results = collect(tab);
  check(
    `${label}: host page starts`,
    await openHost(tab, stack.app({ url: 'about:blank', log: '1', env })),
  );
  for (const name of names) {
    await load(tab, `${siteURL}${name}`);
    check(`${label}: ${name} loads`, (await results.wait(`${name}1`)) === 'false/0');
    await evalPage(tab, 'scrollTo(0, 3000)');
    if (heldMB && name === names[0]) {
      await evalPage(tab, `allocate('held', ${heldMB})`);
      await results.wait('held');
    }
    await tab.waitForTimeout(500);
  }
  const released = () => results.logs.filter((line) => line.includes('Memory released')).length;
  const before = released();
  for (let i = 0; i < 6 && released() === before; i++) {
    await evalPage(tab, `allocate('grown${i}', 48)`);
    await results.wait(`grown${i}`);
    await tab.waitForTimeout(200);
  }
  check(`${label}: malloc growth releases memory`, released() > before);
  const level = (await tab.evaluate(() => window.blHost.memoryPressure)).at(-1)?.level ?? null;
  const shown = [];
  for (const name of names.slice(0, -1).reverse()) {
    await tab.evaluate(() => window.blTest.view().back());
    shown.push(await results.wait(`${name}2`));
  }
  await tab.close();
  return { shown, level };
}

// The release starts at 64 MB, memory is short only from 4 GB (never here)
const {
  shown: [left, older],
} = await backAfterRelease('release', 'BL_MEMORY_RELEASE_MB=64,BL_MEMORY_PRESSURE_MB=4096', [
  'first',
  'second',
  'third',
]);
check(
  'back to the page left last comes from the cache, scrolled where it was',
  left === 'true/3000',
  `pageshow persisted/scrollY ${left}`,
);
check(
  'a page left before it was dropped by the release and loads again',
  older?.startsWith('false/'),
  `pageshow persisted/scrollY ${older}`,
);

// Above the budget from 64 MB on, but the release frees the 256 MB of the page left before: the
// area is not full, memory is not short, the page left last stays
const budget = await backAfterRelease(
  'budget',
  'BL_MEMORY_RELEASE_MB=64,BL_MEMORY_PRESSURE_MB=64',
  ['big', 'second', 'third'],
  256,
);
check(
  'above the budget with the malloc area free after the release: memory-pressure moderate',
  budget.level === 'moderate',
  `level ${budget.level}`,
);
check(
  'above the budget the page left last still comes from the cache',
  budget.shown[0] === 'true/3000',
  `pageshow persisted/scrollY ${budget.shown[0]}`,
);
check(
  'above the budget the page left before goes',
  budget.shown[1]?.startsWith('false/'),
  `pageshow persisted/scrollY ${budget.shown[1]}`,
);

// Above the budget from 64 MB on with the area full (the page holds what malloc grew by): memory
// is short, the release empties the cache
const short = await backAfterRelease('short', 'BL_MEMORY_RELEASE_MB=64,BL_MEMORY_PRESSURE_MB=64', [
  'one',
  'two',
]);
check(
  'with the malloc area full above the budget: memory-pressure critical',
  short.level === 'critical',
  `level ${short.level}`,
);
check(
  'with memory short the release drops the page left last too',
  short.shown[0]?.startsWith('false/'),
  `pageshow persisted/scrollY ${short.shown[0]}`,
);

await browser.close();
finish();
