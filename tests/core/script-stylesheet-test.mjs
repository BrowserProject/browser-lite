// A style sheet that a script inserts is not render-blocking (HTML, Chrome): while it loads,
// elements still get their style and scripts of the parser still run, and it applies once it
// arrived (patch 0160). WebKit held back the style of every element without one until every
// loading sheet had arrived, and every layout a script asked for meanwhile restyled the whole
// document: duolingo.com inserts Google's sign-in sheet (gsi/style, 8 to 11 s to load) and reads
// a height every 100 ms, 20 full restyles of 4500 elements, 160 ms each. Here a page of 2000
// elements inserts a sheet the server holds: an element added afterwards shows, a layout read
// after a rendering update with a new element costs about what it costs without the sheet, a
// script of the parser after a script that inserted a sheet runs at once, and the sheet applies
// once it arrives.
//
//   node tests/core/script-stylesheet-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  collect,
  evalPage,
  finish,
  launch,
  near,
  openHost,
  serve,
  shownPixel,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 120000);

const YELLOW = [255, 204, 0];
const GREEN = [0, 200, 0];
const BLUE = [0, 102, 255];

// 2000 styled elements, so that a restyle of the whole document costs clearly more than one of a
// new element
const many = Array.from(
  { length: 400 },
  (_, i) => `<div class="card c${i % 7}"><h3>Card ${i}</h3><p>Text <b>bold</b> <i>it</i></p></div>`,
).join('');
const style = `<style>
  body { margin: 0; background: #fc0; font: 14px sans-serif; }
  #many { margin-top: 320px; }
  .card { display: flex; gap: 4px; padding: 2px; border: 1px solid #ccc; }
  .card h3 { margin: 0; font-size: 12px; } .card p { margin: 0; }
  .c1 b, .c3 i { color: #333; } .c2 > p { letter-spacing: 1px; } .c4 h3 + p { opacity: 0.9; }
  #box { position: fixed; left: 0; top: 0; width: 400px; height: 300px; background: #00c800; }
</style>`;
const pages = {
  '/page': `<!doctype html>${style}<body><div id="many">${many}</div>`,
  // The parser runs the second script once the first one inserted its sheet
  '/order': `<!doctype html>${style}<script>
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/order.css';
    document.head.append(link);
    window.inserted = performance.now();
  </script><script>console.log('RESULT second=' + Math.round(performance.now() - window.inserted));</script>
  <body>`,
};
const held = new Map();
const requested = new Set();
const { url: siteURL } = await serve((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const html = pages[path];
  if (html) {
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(html);
    return;
  }
  if (path.endsWith('.css')) {
    requested.add(path);
    held.set(path, () =>
      res
        .writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' })
        .end('#box { background: #0066ff; }'),
    );
    return;
  }
  res.writeHead(404).end();
});
const at = (path) => `${siteURL}${path.slice(1)}`;
function release(path) {
  held.get(path)?.();
  held.delete(path);
}

const stack = await startStack({ token: 'script-stylesheet-token-0123456789', allowLocal: true });
const browser = await launch();
const tab = await browser.newPage({ viewport: { width: 800, height: 600 } });
const results = collect(tab);
check('host page starts', await openHost(tab, stack.app({ url: at('/page') })));
const pixel = () => shownPixel(tab, 200, 150);
check('the page shows', await waitFor(async () => near(await pixel(), YELLOW), 20000));

// Layout reads, each after a new element that a rendering update saw first: the median time of
// one in ms
const reads = (key) =>
  evalPage(
    tab,
    `(async () => {
      const times = [];
      for (let i = 0; i < 30; i++) {
        const div = document.createElement('div');
        div.textContent = 'new ' + i;
        document.getElementById('many').append(div);
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
        const start = performance.now();
        void div.offsetHeight;
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      console.log('RESULT ${key}=' + times[15].toFixed(2));
    })()`,
  );
await reads('warm');
await results.wait('warm', 30000);
await reads('without');
const without = Number(await results.wait('without', 30000));

await evalPage(
  tab,
  `{
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/held.css';
    document.head.append(link);
  }`,
);
check('the page asks for the sheet', await waitFor(() => requested.has('/held.css'), 20000));
await evalPage(
  tab,
  `{
    const box = document.createElement('div');
    box.id = 'box';
    document.body.append(box);
  }`,
);
check(
  'an element added while the sheet loads shows',
  await waitFor(async () => near(await pixel(), GREEN), 3000),
  JSON.stringify(await pixel()),
);
await reads('pending');
const pending = Number(await results.wait('pending', 60000));
check(
  'a layout read while the sheet loads restyles only what changed',
  pending < Math.max(3 * without, without + 3),
  `median ${pending} ms, ${without} ms without the sheet`,
);
release('/held.css');
check(
  'the sheet applies once it arrived',
  await waitFor(async () => near(await pixel(), BLUE), 10000),
);

await evalPage(tab, `location.href = ${JSON.stringify(at('/order'))}`);
const second = await results.wait('second', 20000);
check(
  'a script of the parser runs without waiting for the inserted sheet',
  second !== null && requested.has('/order.css') && held.has('/order.css'),
  `${second} ms`,
);

await browser.close();
for (const path of [...held.keys()]) release(path);
finish();
