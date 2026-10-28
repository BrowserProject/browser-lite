// Emoji in the page: with the variation selector VS16 (U+FE0F, "warning sign" as in many pages)
// they take the color emoji font (patch 0057); without one, like in Chrome, a character that is
// text by default (warning sign, heart suit) takes a text font and one that is emoji by default
// (star) the color font (patch 0059). The fonts load on first use.
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
<span style="left: 20px">⚠️</span><span style="left: 220px">❤️</span><span style="left: 420px">⚠</span>
<span style="left: 620px">⭐</span><span style="left: 20px; top: 140px">♥</span>`;
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
watchErrors(page);
check('page loaded', await openHost(page, stack.app({ url: siteURL })));
const pixels = async (left, top) => {
  const found = [];
  for (let x = left + 10; x < left + 80; x += 10)
    for (let y = top + 10; y < top + 80; y += 10)
      found.push((await pagePixel(page, x, y)) ?? [255, 255, 255]);
  return found;
};
// A pixel with color: the channels differ clearly (a box or text is black, white or gray)
const isColored = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > 80;
const isDark = ([r, g, b]) => Math.max(r, g, b) < 90;
const anyColored = async (left, top = 20) => (await pixels(left, top)).some(isColored);
// Drawn as text: dark pixels, none in color
const asText = async (left, top = 20) => {
  const found = await pixels(left, top);
  return found.some(isDark) && !found.some(isColored);
};
check('star (emoji by default) in color', await waitFor(() => anyColored(620), 20000));
check('warning sign with VS16 in color', await waitFor(() => anyColored(20), 10000));
check('heart with VS16 in color', await waitFor(() => anyColored(220), 10000));
check('warning sign without a selector as text', await waitFor(() => asText(420), 10000));
check('heart suit as text', await waitFor(() => asText(20, 140), 10000));
await browser.close();
finish();
