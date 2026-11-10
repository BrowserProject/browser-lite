// A table with thousands of rows and collapsed borders paints as fast as one with separate borders
// (patch 0106): the background of each cell at its left or right edge looked through all cells
// above and below it for the widest border half at that edge, a pass over the whole column per
// cell painted, seconds per frame on iana.org's IDN table (12,000 rows). The widest halves are now
// kept per table until its collapsed borders change. The cells of a narrower edge border still
// start their background where the widest border's half ends.
//
//   node tests/core/big-table-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  check,
  collect,
  finish,
  launch,
  openHost,
  serve,
  shownPixel,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

const ROWS = 8000;
// Two tables of ROWS rows, one with collapsed and one with separate borders, each shown alone.
// measure(collapse) changes the width of the shown table in 9 animation frames, so each frame
// lays it out and paints the rows in view again, and reports the median frame. The small table is
// the case of WPT css-tables/collapsed-border-background-inset.html: its header cells have no
// border and the cells below 20 px, so the backgrounds of the header start 10 px into the
// table at both edges. edges() reports the left and right edge of the table and its middle row.
const PAGE = `<!doctype html><title>Big table</title>
<style>
  body { margin: 0; font: 13px sans-serif }
  table { width: 600px }
  td { background: rgb(230, 240, 255); border: 1px solid rgb(200, 200, 200); padding: 2px 6px }
  .collapse { border-collapse: collapse }
  .hidden { display: none }
  #small { border-collapse: collapse; width: 200px; position: absolute; left: 30px; top: 30px }
  #small th { background: rgb(0, 160, 0); border: 0 solid; height: 20px }
  #small td { background: none; border: 20px solid rgb(0, 0, 0); height: 20px }
</style>
<table id="small"><tr><th id="first">a</th><th id="last">b</th></tr><tr><td>c</td><td>d</td></tr></table>
<table id="collapse" class="collapse hidden"></table>
<table id="separate" class="hidden"></table>
<script>
const rows = [];
for (let i = 0; i < ${ROWS}; i++)
  rows.push('<tr><td>Row ' + i + '</td><td>Registry ' + (i % 37) + '<br>v3.' + (i % 9) + ' 2020-10-06</td></tr>');
for (const id of ['collapse', 'separate']) document.getElementById(id).innerHTML = rows.join('');
window.measure = (id) => {
  document.getElementById('small').classList.add('hidden');
  for (const other of ['collapse', 'separate']) document.getElementById(other).classList.toggle('hidden', other !== id);
  const table = document.getElementById(id);
  const times = [];
  let last = 0;
  const frame = (now) => {
    if (last) times.push(now - last);
    last = now;
    if (times.length === 9) {
      times.sort((a, b) => a - b);
      console.log('RESULT ' + id + '=' + times[4].toFixed(1));
      return;
    }
    table.style.width = (600 + (times.length % 2)) + 'px';
    requestAnimationFrame(frame);
  };
  // Settle the switch first
  requestAnimationFrame(() => requestAnimationFrame(frame));
};
window.edges = () => {
  const first = document.getElementById('first').getBoundingClientRect();
  const last = document.getElementById('last').getBoundingClientRect();
  console.log('RESULT edges=' + [first.left, last.right, first.top + first.height / 2].map(Math.round).join(','));
};
console.log('RESULT ready=1');
</script>`;
const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

const stack = await startStack();
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const results = collect(page);
check('page loaded', await openHost(page, stack.app({ url: siteURL })));
await results.wait('ready');
await page.waitForTimeout(1500);

// The small table: the header's background leaves out the inner half of the widest border at
// each edge of the table (10 px), and fills the rest
await page.evaluate(() => window.blTest.eval('edges()'));
const [left, right, y] = ((await results.wait('edges')) || '0,0,0').split(',').map(Number);
const xs = [left + 5, left + 15, right - 5, right - 15];
const colors = [];
for (const x of xs) colors.push(await shownPixel(page, x, y));
const green = (pixel) => !!pixel && pixel[0] < 60 && pixel[1] > 120 && pixel[2] < 60;
const white = (pixel) => !!pixel && pixel.every((value) => value > 200);
check(
  'the backgrounds of cells at the edges of a collapsed table leave out the widest border half there',
  white(colors[0]) && green(colors[1]) && white(colors[2]) && green(colors[3]),
  xs.map((x, i) => `${x} px: ${colors[i]}`).join(', '),
);

// Alternating, so both see the same load of the machine
const frames = { collapse: [], separate: [] };
for (let round = 0; round < 3; round++) {
  for (const id of ['separate', 'collapse']) {
    results.delete(id);
    await page.evaluate((id) => window.blTest.eval(`measure('${id}')`), id);
    frames[id].push(Number(await results.wait(id, 120000)));
  }
}
const median = (values) => values.sort((a, b) => a - b)[1];
const collapse = median(frames.collapse);
const separate = median(frames.separate);
// Before the change 3.3 times as long (652 against 200 ms), after it 1.6 times: what is left is
// working out all collapsed borders again after each layout
check(
  `a frame of a table of ${ROWS} rows with collapsed borders costs at most 2.5 times one with separate borders`,
  collapse <= 2.5 * separate,
  `collapsed ${frames.collapse.join(', ')} ms, separate ${frames.separate.join(', ')} ms`,
);
await browser.close();
finish();
