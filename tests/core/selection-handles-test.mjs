// Selection handles like Chrome on phones and Safari: a long press selects a word and two handles
// appear at its start and end (engine event touch-selection); dragging one moves that end of the
// selection, the menu of the selection opens when it is released, the handles follow a scroll
// and end with a tap elsewhere. In a text field the selection stays inside the field. A selection
// made by script gets no handles. The finger is the mouse of an emulated touch device, so the
// test runs in Chromium and Firefox alike.
//
//   node tests/core/selection-handles-test.mjs [engine-dir]
import {
  canvasOrigin,
  check,
  collect,
  evalPage,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit();

// 12 px a character of 20px monospace, lines of 30 px
const PAGE = `<!doctype html><title>selection handles</title>
<meta name="viewport" content="width=device-width">
<style>
  body { margin: 0; font: 20px/30px monospace; height: 2000px; }
  p { position: absolute; left: 20px; margin: 0; white-space: pre; }
  input { position: absolute; left: 20px; top: 200px; width: 200px; font: 20px monospace; padding: 0 5px; border: 1px solid; }
</style>
<p id="one" style="top: 100px">alpha beta gamma delta</p>
<p id="two" style="top: 130px">second line here</p>
<input id="field" value="one two three">
<script>
  window.state = (key) => {
    const s = getSelection();
    console.log('RESULT ' + key + '=' + encodeURIComponent(JSON.stringify({
      text: document.activeElement === field ? field.value.slice(field.selectionStart, field.selectionEnd) : s.toString(),
      active: document.activeElement.id,
    })));
  };
  console.log('RESULT ready=1');
</script>`;

const { url } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);
const stack = await startStack({ token: 'selection-handles-token-0123456' });
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 400, height: 500 } });
const results = collect(page);
check(
  'page opens on an emulated touch device',
  await openHost(page, stack.app({ url, device: '400x500x1x1' })),
);
check('page loaded', (await results.wait('ready')) === '1');
const origin = await canvasOrigin(page);
const at = (x, y) => [origin.x + x, origin.y + y];

let stateCount = 0;
const selectionState = async () => {
  const key = `state${++stateCount}`;
  await evalPage(page, `state('${key}')`);
  return JSON.parse(decodeURIComponent(await results.wait(key, 10000)));
};
const menuCount = () => page.evaluate(() => window.blHost.contextMenus.length);
const menuAfter = async (count) => {
  await waitFor(async () => (await menuCount()) > count, 5000);
  return page.evaluate((n) => window.blHost.contextMenus[n] ?? null, count);
};

// The tips of the shown handles (the corner of the drawn drop at the bottom of the caret line)
// in view coordinates, null for a hidden one
const handles = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-bl-view]').getBoundingClientRect();
    return ['start', 'end'].map((name) => {
      const handle = document.querySelector(`[data-bl-selection-handle="${name}"]`);
      if (!handle?.isConnected || getComputedStyle(handle).display === 'none') return null;
      const drop = handle.firstElementChild.getBoundingClientRect();
      if (!drop.width) return null;
      return {
        x: Math.round((name === 'start' ? drop.right : drop.left) - canvas.left),
        y: Math.round(drop.top - canvas.top),
      };
    });
  });
const waitHandles = async (test, timeout = 5000) => {
  let last = null;
  await waitFor(async () => test((last = await handles())), timeout);
  return last;
};
const near = (a, b, tolerance = 3) => Math.abs(a - b) <= tolerance;

const longPress = async (x, y) => {
  const count = await menuCount();
  await page.mouse.move(...at(x, y));
  await page.mouse.down();
  await page.waitForTimeout(1000);
  await page.mouse.up();
  return menuAfter(count);
};

// Drags a handle by the middle of its drop to a point dx, dy away, in steps like a finger
const drag = async (name, dx, dy) => {
  const box = await page.evaluate((handle) => {
    const drop = document.querySelector(
      `[data-bl-selection-handle="${handle}"]`,
    )?.firstElementChild;
    const r = drop?.getBoundingClientRect();
    return r?.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, name);
  if (!box) return null;
  const count = await menuCount();
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + dx, box.y + dy, { steps: 10 });
  await page.waitForTimeout(300);
  await page.mouse.up();
  return menuAfter(count);
};

// A long press on "beta": the word selected, handles at its start and end below the line
const menu = await longPress(20 + 12 * 7.5, 115);
check(
  'long press selects the word',
  menu?.selection === 'beta' && menu.touch,
  JSON.stringify(menu),
);
// The menu keeps clear of the selection and its handles (the selection's line, 100 to 130)
check(
  'the menu of the long press knows the selection with its handles',
  menu?.selectionBounds?.y <= 106 && menu.selectionBounds.y + menu.selectionBounds.height >= 150,
  JSON.stringify(menu?.selectionBounds),
);
const word = await waitHandles(([start, end]) => start && end);
check(
  'long press: handles at the start and end of the word, below its line',
  word[0] &&
    near(word[0].x, 20 + 12 * 6) &&
    near(word[0].y, 130) &&
    word[1] &&
    near(word[1].x, 20 + 12 * 10) &&
    near(word[1].y, 130),
  JSON.stringify(word),
);

// The end handle to the end of "gamma": the selection grows, the menu of the selection opens
const grown = await drag('end', 12 * 6, 0);
const grownState = await selectionState();
check(
  'dragging the end handle extends the selection',
  grownState.text === 'beta gamma',
  JSON.stringify(grownState),
);
check(
  'releasing the handle opens the menu of the selection, from a finger',
  grown?.selection === 'beta gamma' &&
    grown.touch &&
    !grown.link &&
    grown.selectionBounds?.x + grown.selectionBounds?.width >= 20 + 12 * 16,
  JSON.stringify(
    grown && { selection: grown.selection, touch: grown.touch, bounds: grown.selectionBounds },
  ),
);
const afterEnd = await waitHandles(([, end]) => end && near(end.x, 20 + 12 * 16));
check(
  'the end handle sits at the new end',
  !!afterEnd[1] && near(afterEnd[1].x, 20 + 12 * 16),
  JSON.stringify(afterEnd),
);

// The start handle left past the start of the line: the selection starts before "alpha"
await drag('start', -70, 0);
const startState = await selectionState();
check(
  'dragging the start handle moves the start',
  startState.text === 'alpha beta gamma',
  JSON.stringify(startState),
);

// The end handle past the start (the finger stays on the screen): one character stays selected
await drag('end', -12 * 17, 0);
const minimum = await selectionState();
check(
  'the end handle cannot pass the start: one character stays',
  minimum.text === 'a',
  JSON.stringify(minimum),
);

// The end handle down to the second line
await drag('end', 12 * 2, 30);
const twoLines = await selectionState();
check(
  'dragging the end handle onto the next line',
  twoLines.text.startsWith('alpha beta gamma delta') && twoLines.text.includes('sec'),
  JSON.stringify(twoLines),
);
const before = await handles();

// A scroll moves the handles with the text
await evalPage(page, 'scrollBy(0, 40)');
const scrolled = await waitHandles(([start]) => start && near(start.y, (before[0]?.y ?? 0) - 40));
check(
  'the handles follow a scroll',
  !!scrolled[0] &&
    near(scrolled[0].y, before[0].y - 40) &&
    !!scrolled[1] &&
    near(scrolled[1].y, before[1].y - 40),
  JSON.stringify({ before, scrolled }),
);
await evalPage(page, 'scrollTo(0, 0)');

// Select all of the menu keeps the handles, around everything
await page.evaluate(() => window.blTest.view().command('SelectAll'));
// The end of everything lies after the field (at y 200 to 229)
const all = await waitHandles(([start, end]) => start && end && end.y > 220);
const allState = await selectionState();
check(
  'Select all keeps the handles, at the start and end of everything',
  allState.text.includes('second line here') && !!all[0] && near(all[0].x, 20) && all[1]?.y > 220,
  JSON.stringify({ allState, all }),
);

// A tap elsewhere ends the selection and the handles
await page.mouse.click(...at(300, 400));
const tapped = await waitHandles(([start, end]) => !start && !end);
check('a tap elsewhere hides the handles', !tapped[0] && !tapped[1], JSON.stringify(tapped));

// A selection of the page's script gets no handles
await evalPage(page, 'getSelection().selectAllChildren(two)');
await page.waitForTimeout(1000);
const scripted = await handles();
check(
  'a selection made by script has no handles',
  !scripted[0] && !scripted[1],
  JSON.stringify(scripted),
);
await evalPage(page, 'getSelection().removeAllRanges()');

// In a text field: the word of a long press, the end handle far right stops at the field's end
const fieldMenu = await longPress(26 + 12 * 5, 215);
check(
  'long press in a field selects its word',
  fieldMenu?.selection === 'two' && fieldMenu.editable,
  JSON.stringify(fieldMenu),
);
await waitHandles(([start, end]) => start && end);
await drag('end', 250, 0);
const fieldState = await selectionState();
check(
  'the end handle stays in the field',
  fieldState.active === 'field' && fieldState.text === 'two three',
  JSON.stringify(fieldState),
);
// Typing replaces the selection and ends the handles
await page.keyboard.type('x');
const typed = await waitHandles(([start, end]) => !start && !end);
check('typing ends the handles', !typed[0] && !typed[1], JSON.stringify(typed));

await browser.close();
finish();
