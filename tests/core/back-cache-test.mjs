// The back/forward cache through the automatic memory releases (engine/src/MemoryWatch.cpp): a
// release keeps the page left last, so going back to it shows it at once where it was scrolled to
// (pageshow persisted), instead of loading it again and restoring the scroll position only once
// the load is complete. Older pages and, when memory is short, every cached page go.
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

// Opens the pages one after the other, each scrolled to 3000, then grows malloc in the last one
// until an automatic release ran. Returns pageshow of going back to each of the others in turn.
async function backAfterRelease(label, env, names) {
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
  const shown = [];
  for (const name of names.slice(0, -1).reverse()) {
    await tab.evaluate(() => window.blTest.view().back());
    shown.push(await results.wait(`${name}2`));
  }
  await tab.close();
  return shown;
}

// The release starts at 64 MB, memory is short only from 4 GB (never here)
const [left, older] = await backAfterRelease(
  'release',
  'BL_MEMORY_RELEASE_MB=64,BL_MEMORY_PRESSURE_MB=4096',
  ['first', 'second', 'third'],
);
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

// Memory short from 64 MB on: the release empties the cache
const [short] = await backAfterRelease(
  'short',
  'BL_MEMORY_RELEASE_MB=64,BL_MEMORY_PRESSURE_MB=64',
  ['one', 'two'],
);
check(
  'with memory short the release drops the page left last too',
  short?.startsWith('false/'),
  `pageshow persisted/scrollY ${short}`,
);

await browser.close();
finish();
