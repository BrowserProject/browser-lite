// Emoji in the page: with the variation selector VS16 (U+FE0F, "warning sign" as in many pages)
// they take the color emoji font like without it (patch 0057); the emoji fonts load on first use.
//
//   node tests/core/emoji-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  check,
  finish,
  launch,
  openHost,
  pagePixel,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

// Big emoji at known places: the middle of a color emoji is not gray
const PAGE = `<!doctype html><meta charset="utf-8"><title>Emoji</title>
<style>body { margin: 0 } span { position: absolute; top: 20px; font: 80px sans-serif; line-height: 1 }</style>
<span style="left: 20px">⚠️</span><span style="left: 220px">❤️</span><span style="left: 420px">⚠</span>`;
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
watchErrors(page);
check('page loaded', await openHost(page, stack.app({ url: siteURL })));
// A pixel with color: the channels differ clearly (a box or text is black, white or gray)
const colored = async (x, y) => {
  const [r, g, b] = (await pagePixel(page, x, y)) ?? [0, 0, 0];
  return Math.max(r, g, b) - Math.min(r, g, b) > 80;
};
const anyColored = async (left) => {
  for (let x = left + 20; x < left + 80; x += 10)
    for (let y = 40; y < 100; y += 10) if (await colored(x, y)) return true;
  return false;
};
check('warning sign without a selector in color', await waitFor(() => anyColored(420), 20000));
check('warning sign with VS16 in color', await waitFor(() => anyColored(20), 10000));
check('heart with VS16 in color', await waitFor(() => anyColored(220), 10000));
await browser.close();
finish();
