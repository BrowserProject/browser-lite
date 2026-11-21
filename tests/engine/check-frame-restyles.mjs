// Checks the frame of frame-restyles.html: the clones of the first <use>, updated in place by every
// attribute and inline style change (patch 0175), paint like the clones of a <use> made at the end,
// 300 px to the right (up to 16 levels a channel: partial repaints of rotated content leave seams
// of a few levels in antialiased edges, also without <use>).
//   node tests/engine/check-frame-restyles.mjs <frame.ppm>   (run by pages-test.mjs)
import { near, readFrame, reporter } from './frame.mjs';

const { pixel } = readFrame(process.argv[2]);
const { expect, exitCode } = reporter();

let differ = 0;
let painted = 0;
let first = '';
for (let y = 1; y < 120; y++) {
  for (let x = 1; x < 290; x++) {
    const left = pixel(x, y);
    const right = pixel(x + 300, y);
    if (!near(left, [255, 255, 255], 4)) painted++;
    if (!near(left, right, 16)) {
      if (!differ) first = `${x},${y}: ${left} / ${right}`;
      differ++;
    }
  }
}
expect('the clones paint', painted > 1000, `${painted} pixels`);
expect(
  'updated clones paint like new ones',
  differ === 0,
  differ ? `${differ} pixels differ, first ${first}` : '',
);
process.exit(exitCode());
