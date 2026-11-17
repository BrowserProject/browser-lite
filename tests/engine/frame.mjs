// Frames of render.mjs (binary PPM) for the frame checks of pages-test.mjs.
import { readFileSync } from 'node:fs';

/**
 * Reads a PPM frame.
 * @param {string} file path of the frame
 * @returns {{ width: number, height: number, pixel: (x: number, y: number) => number[] }}
 */
export function readFrame(file) {
  const data = readFileSync(file);
  let headerEnd = 0;
  for (let i = 0, newlines = 0; i < data.length && !headerEnd; i++)
    if (data[i] === 10 && ++newlines === 3) headerEnd = i + 1;
  if (!headerEnd) throw new Error('not a valid PPM');
  const [, size] = data.subarray(0, headerEnd).toString().split('\n');
  const [width, height] = size.split(' ').map(Number);
  const pixel = (x, y) => {
    const i = headerEnd + (y * width + x) * 3;
    return [data[i], data[i + 1], data[i + 2]];
  };
  return { width, height, pixel };
}

/** Whether two RGB colors differ by at most `tolerance` in every channel. */
export const near = (a, b, tolerance = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

/** Prints checks like the suites and returns the exit code of the check script. */
export function reporter() {
  let failed = 0;
  return {
    expect(name, ok, info) {
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info || ''}`);
      if (!ok) failed++;
    },
    exitCode: () => (failed ? 1 : 0),
  };
}
