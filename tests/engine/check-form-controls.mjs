// Checks the frame of form-controls.html: the border of every empty control without author styles
// is dark enough for WCAG's 3:1 non-text contrast on the white page, like Chrome's #767676
// (patch 0161).
//   node tests/engine/check-form-controls.mjs <frame.ppm>   (run by pages-test.mjs)
import { readFrame, reporter } from './frame.mjs';

const { pixel } = readFrame(process.argv[2]);
const { expect, exitCode } = reporter();

/** WCAG contrast ratio of an sRGB color against white. */
const contrast = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
};

/** The darkest pixel of the box [x0, x1) x [y0, y1). */
const darkest = (x0, x1, y0, y1) => {
  let best = [255, 255, 255];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) if (contrast(pixel(x, y)) > contrast(best)) best = pixel(x, y);
  return best;
};

// name, box around the control (positions of the page, sizes with a few px to spare)
for (const [name, x0, y0, x1, y1] of [
  ['text field', 20, 20, 40, 50],
  ['checkbox', 20, 70, 36, 86],
  ['radio', 60, 70, 76, 86],
  ['select', 20, 110, 24, 135],
  ['button', 160, 110, 164, 135],
]) {
  const color = darkest(x0, x1, y0, y1);
  const ratio = contrast(color);
  expect(
    `${name}: border contrast at least 3:1`,
    ratio >= 3,
    `${JSON.stringify(color)} ${ratio.toFixed(2)}:1`,
  );
}

process.exit(exitCode());
