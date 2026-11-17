// Checks the frame of basic.html: colors at known places and that text is there.
//   node tests/engine/check-basic.mjs <frame.ppm>   (pages/basic.html, run by pages-test.mjs)
import { near, readFrame, reporter } from './frame.mjs';

const { pixel } = readFrame(process.argv[2]);
const { expect, exitCode } = reporter();

expect('red box', near(pixel(140, 90), [255, 0, 0]), JSON.stringify(pixel(140, 90)));
expect('blue circle center', near(pixel(350, 90), [0, 0, 255]), JSON.stringify(pixel(350, 90)));
expect(
  'circle corner is background',
  near(pixel(303, 43), [244, 244, 244]),
  JSON.stringify(pixel(303, 43)),
);
expect('background', near(pixel(700, 500), [244, 244, 244]), JSON.stringify(pixel(700, 500)));

// Text: the row of the heading must have dark pixels
let dark = 0;
for (let x = 40; x < 600; x++) {
  for (let y = 185; y < 215; y++) {
    const [r, g, b] = pixel(x, y);
    if (r < 100 && g < 100 && b < 100) dark++;
  }
}
expect('text painted', dark > 200, `${dark} dark pixels`);
// "(JS ok)" makes the row longer: there must be text further right too
let darkRight = 0;
for (let x = 380; x < 600; x++) {
  for (let y = 185; y < 215; y++) {
    const [r, g, b] = pixel(x, y);
    if (r < 100 && g < 100 && b < 100) darkRight++;
  }
}
expect('JavaScript changed the text', darkRight > 50, `${darkRight} dark pixels on the right`);

process.exit(exitCode());
