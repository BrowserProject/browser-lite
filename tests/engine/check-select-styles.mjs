// Checks the frame of select-styles.html: a select whose background or border the page sets shows
// that background and border with the arrow in its text color inside the border, like in Chrome;
// a select without them keeps the native look (patch 0157).
//   node tests/engine/check-select-styles.mjs <frame.ppm>   (run by pages-test.mjs)
import { near, readFrame, reporter } from './frame.mjs';

const { pixel } = readFrame(process.argv[2]);
const { expect, exitCode } = reporter();

/** Pixels of the box [x0, x1) x [y0, y1) for which `match` holds. */
const count = (x0, x1, y0, y1, match) => {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (match(pixel(x, y))) n++;
  return n;
};
const show = (x, y) => JSON.stringify(pixel(x, y));
const DARK = [37, 37, 37];
const isLight = (p) => near(p, [213, 213, 213], 12);
const isGreen = ([r, g, b]) => g > 150 && r < 100 && b < 100;
const isDark = (p) => Math.max(...p) < 100;
const isNativeArrow = (p) => near(p, [46, 52, 54], 6);

// left, top, width, height and border of the selects of the page
for (const [id, left, top, border] of [
  ['background-color and border', 20, 20, 1],
  ['background-color', 20, 70, 1],
  ['background shorthand', 20, 120, 0],
]) {
  expect(
    `${id}: the page's background`,
    near(pixel(left + 70, top + 4), DARK),
    show(left + 70, top + 4),
  );
  const right = left + 140 - border;
  const light = count(right - 30, right, top + 5, top + 25, isLight);
  const native = count(right - 30, right, top + 5, top + 25, isNativeArrow);
  expect(
    `${id}: the arrow in the text color`,
    light >= 15 && !native,
    `${light} light, ${native} of the native arrow`,
  );
}

expect(
  'border only: the default background',
  near(pixel(90, 176), [255, 255, 255], 4),
  show(90, 176),
);
expect('border only: the page border', near(pixel(90, 171), [255, 0, 0]), show(90, 171));
expect('border only: the arrow in the text color', count(126, 156, 178, 198, isDark) >= 8);

// thick border: 220, 20, 140 x 50, 8 px blue
expect('thick border: the background', near(pixel(290, 30), DARK), show(290, 30));
const inside = count(228, 352, 28, 62, isGreen);
const arrow = count(322, 352, 28, 62, isGreen);
const all = count(220, 360, 20, 70, isGreen);
expect(
  'thick border: the arrow inside the border',
  arrow >= 8 && all === inside,
  `${arrow} arrow, ${all - inside} on the border`,
);

// right to left: the arrow on the left
expect('right to left: the arrow on the left', count(222, 250, 145, 165, isGreen) >= 8);

// no background or border: the native button with its dark arrow
expect('native: the button', near(pixel(290, 94), [244, 244, 244]), show(290, 94));
expect('native: the arrow', count(325, 358, 95, 115, isNativeArrow) >= 8);

process.exit(exitCode());
