// Suggestions of <input list> (a datalist) through the dataListPopup handler, like Chrome's
// dropdown: typing asks with the matching options (labels too), Up and Down in the field move
// the highlight (a new request each), Enter takes the highlighted one, a click (the handler's
// answer) takes its entry, Escape and leaving the field close the list without a choice, the
// dropdown arrow of the field opens it.
//
//   node tests/core/datalist-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 180000);

const PAGE = `<!doctype html>
<html><head><title>Datalist test</title>
<style>
  body { margin: 0; font: 16px sans-serif; }
  #city { position: absolute; left: 20px; top: 20px; width: 240px; height: 30px; font-size: 16px; }
  #other { position: absolute; left: 20px; top: 300px; width: 240px; height: 30px; }
</style></head>
<body>
<input id="city" list="cities" autocomplete="off">
<datalist id="cities"><option value="Zurich"><option value="Zug" label="Canton Zug"><option value="Bern"></datalist>
<input id="other" autocomplete="off">
<script>
  const city = document.getElementById('city');
  city.addEventListener('change', () => console.log('RESULT change=' + city.value));
  console.log('RESULT ready=1');
</script>
</body></html>`;

const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  else res.writeHead(404).end();
});

const browser = await launch();
const stack = await startStack();
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const results = collect(page, /RESULT (\w+)=(.*?)(\s+\(|$)/);
check('host page started a browser', await openHost(page, stack.app({ url: siteURL })));
check('page ready', (await results.wait('ready', TIMEOUT)) === '1');

const at = async (x, y) => {
  const origin = await canvasOrigin(page);
  return [origin.x + x, origin.y + y];
};
const requests = () => page.evaluate(() => window.blHost.dataListRequests);
const openList = async () => (await requests()).findLast((request) => request.open) ?? null;
// Until the open list matches (suggestions joined with ',' and the highlighted index)
const listIs = (suggestions, highlighted) =>
  waitFor(async () => {
    const list = await openList();
    return list?.suggestions.join() === suggestions && list.highlightedIndex === highlighted;
  }, 10000);
const closed = () => waitFor(async () => !(await openList()), 10000);
const describe = async () => JSON.stringify(await openList());
const change = async () => {
  const value = await results.wait('change', 10000);
  results.delete('change');
  return value;
};

// Typing asks with the options that start with the text; the label comes along
await page.mouse.click(...(await at(100, 35)));
await page.keyboard.type('Z');
check(
  'typing shows the matching suggestions',
  await listIs('Zurich,Zug|Canton Zug', -1),
  await describe(),
);
const rect = (await openList())?.rect;
check(
  'the request has the rect of the field',
  rect && Math.abs(rect.x - 20) <= 2 && Math.abs(rect.y - 20) <= 2 && rect.width >= 240,
  JSON.stringify(rect),
);

// Up and Down in the field move the highlight (wrapping), Enter takes it
await page.keyboard.press('ArrowDown');
check(
  'Down highlights the first suggestion',
  await listIs('Zurich,Zug|Canton Zug', 0),
  await describe(),
);
await page.keyboard.press('ArrowDown');
check('Down again the second', await listIs('Zurich,Zug|Canton Zug', 1), await describe());
await page.keyboard.press('ArrowDown');
check(
  'Down at the end wraps to the first',
  await listIs('Zurich,Zug|Canton Zug', 0),
  await describe(),
);
await page.keyboard.press('ArrowUp');
check(
  'Up at the start wraps to the last',
  await listIs('Zurich,Zug|Canton Zug', 1),
  await describe(),
);
await page.keyboard.press('Enter');
check('Enter takes the highlighted suggestion', (await change()) === 'Zug', results.get('change'));
check('the list closes after the choice', await closed(), await describe());

// The answer of the handler (a click on an entry) takes that suggestion
await page.keyboard.press('ControlOrMeta+A');
await page.keyboard.type('er');
check('text inside an option matches too', await listIs('Bern', -1), await describe());
await page.evaluate(() => window.blHost.answerDataList(0));
check('a chosen entry reaches the page', (await change()) === 'Bern', results.get('change'));
check('the list closes after the click', await closed(), await describe());

// Escape closes without a choice, the next key opens it again
await page.keyboard.press('ControlOrMeta+A');
await page.keyboard.type('Zu');
check(
  'typing again shows suggestions',
  await listIs('Zurich,Zug|Canton Zug', -1),
  await describe(),
);
await page.keyboard.press('Escape');
check('Escape closes the list', await closed(), await describe());
await page.keyboard.type('r');
check('the next key opens it again', await listIs('Zurich', -1), await describe());

// No match closes, leaving the field closes
await page.keyboard.type('x');
check('no matching option closes the list', await closed(), await describe());
await page.keyboard.press('Backspace');
check('a match opens it again', await listIs('Zurich', -1), await describe());
await page.mouse.click(...(await at(100, 315)));
check('leaving the field closes the list', await closed(), await describe());
check(
  'leaving keeps the typed text (its change event, no suggestion)',
  (await change()) === 'Zur',
  results.get('change'),
);

// The dropdown arrow WebKit draws at the right end of the field opens the list
await page.mouse.click(...(await at(252, 35)));
check('the arrow of the field opens the list', await listIs('Zurich', -1), await describe());
await page.keyboard.press('Escape');
check('Escape closes it again', await closed(), await describe());

await browser.close();
finish();
