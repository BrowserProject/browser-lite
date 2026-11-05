// The mouse over a page that comes back from the back/forward cache: the element it was over before
// the page was left still counts as hovered, so a move inside it fires nothing and the first move
// out of it fires mouseout and mouseleave, like in Chrome. Also inside an iframe. Before patch 0079
// the engine forgot that element when the page was left: no mouseleave ever came, and popups that
// close on it (Wikipedia's reference tooltips) stayed open after back and forward.
//
//   node tests/core/hover-history-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  load,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 120000);

const FRAME = `<body style="margin:0"><div id="inner" style="width:200px;height:100px;background:#cfc"></div>
<script>
for (const type of ['mouseover', 'mouseenter', 'mouseout', 'mouseleave'])
  document.getElementById('inner').addEventListener(type, () => parent.note('inner-' + type));
</script>`;
const PAGE = `<!doctype html><title>hover</title>
<style>
  body { margin: 0; }
  #ref { position: absolute; left: 20px; top: 100px; width: 100px; height: 30px; background: #ccf; }
  #frame { position: absolute; left: 300px; top: 100px; width: 200px; height: 100px; border: 0; }
</style>
<a id="ref" href="#">ref</a>
<iframe id="frame" srcdoc="${FRAME.replaceAll('"', '&quot;')}"></iframe>
<script>
  const events = [];
  window.note = (name) => {
    events.push(name);
    console.log('RESULT events=' + events.join(','));
  };
  for (const type of ['mouseover', 'mouseenter', 'mouseout', 'mouseleave'])
    document.getElementById('ref').addEventListener(type, () => note('ref-' + type));
  addEventListener('pageshow', (e) => note('pageshow-' + e.persisted));
</script>`;

const { url: siteURL } = await serve((req, res) => {
  const html = {
    '/a': PAGE,
    '/b': '<!doctype html><title>b</title><p>b<script>console.log("RESULT b=1")</script>',
  }[req.url];
  if (!html) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
});

const stack = await startStack({ token: 'hover-history-token-0123456789ab' });
const browser = await launch();
const tab = await browser.newPage({ viewport: { width: 800, height: 600 } });
const results = collect(tab);
check('host page starts', await openHost(tab, stack.app({ url: `${siteURL}a` })));
check('page loaded', !!(await results.wait('events')));

const events = () => (results.get('events') ?? '').split(',');
const eventsSince = (count) => events().slice(count);
const move = async (x, y) => {
  const origin = await canvasOrigin(tab);
  await tab.mouse.move(origin.x + x, origin.y + y, { steps: 5 });
};
const has = async (count, names) =>
  waitFor(() => names.every((name) => eventsSince(count).includes(name)), 10000);

for (const [name, inside, nearby, prefix] of [
  ['element of the page', [60, 115], [62, 117], 'ref'],
  ['element in an iframe', [400, 150], [402, 152], 'inner'],
]) {
  await move(...inside);
  check(`${name}: hovered`, await has(0, [`${prefix}-mouseenter`]), events().join());
  results.delete('b');
  await load(tab, `${siteURL}b`);
  check(`${name}: next page loaded`, (await results.wait('b')) === '1');

  const before = events().length;
  await tab.evaluate(() => window.blTest.view().back());
  check(
    `${name}: back from the back/forward cache`,
    await has(before, ['pageshow-true']),
    eventsSince(before).join(),
  );
  const restored = events().length;
  await move(...nearby);
  await tab.waitForTimeout(1000);
  check(
    `${name}: a move inside it after the restore fires nothing`,
    eventsSince(restored).every((event) => !event.startsWith(prefix)),
    eventsSince(restored).join(),
  );
  await move(200, 400);
  await has(restored, [`${prefix}-mouseout`, `${prefix}-mouseleave`]);
  const own = eventsSince(restored).filter((event) => event.startsWith(prefix));
  check(
    `${name}: moving out after the restore fires mouseout and mouseleave`,
    own.join() === `${prefix}-mouseout,${prefix}-mouseleave`,
    own.join(),
  );
}

await browser.close();
finish();
