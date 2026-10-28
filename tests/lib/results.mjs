// Reading the page under test: RESULT lines from the console, pixels of the view, waiting.
import path from 'node:path';
import zlib from 'node:zlib';
import { BROWSER } from './browser.mjs';
import { TIMEOUT, VERBOSE, buildDir } from './env.mjs';
import { watchErrors } from './report.mjs';

/**
 * Collects "RESULT name=value" from the console of one or more pages (the host page and the demo
 * forward the console of the views as "[page N] ..."). logs holds every line.
 */
export class Results extends Map {
  constructor(pattern = /RESULT (\w+)=(\S*)/) {
    super();
    this.pattern = pattern;
    this.logs = [];
  }

  watch(page) {
    page.on('console', (msg) => {
      const text = msg.text();
      this.logs.push(text);
      if (VERBOSE) console.log('   ', text);
      const match = this.pattern.exec(text);
      if (match) this.set(match[1], match[2]);
    });
    watchErrors(page);
    return this;
  }

  /** Value of key; null after ms or as soon as stop() is true. */
  async wait(key, ms = TIMEOUT, stop = () => false) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.has(key)) return this.get(key);
      if (stop()) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }
}

export const collect = (page, pattern) => new Results(pattern).watch(page);

/** Top left corner of the visible view canvas in the window. */
export function canvasOrigin(page) {
  return page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas[data-bl-view]')].find(
      (c) => c.style.display !== 'none',
    );
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });
}

/** Color [r, g, b] of the active view at x, y (window.blTest), null without a view. */
export const pagePixel = (page, x, y) =>
  page.evaluate(([x, y]) => (window.blTest.view() ? window.blTest.pagePixel(x, y) : null), [x, y]);

/**
 * Color { r, g, b } of the host page at x, y as Chromium shows it (a screenshot of one pixel):
 * the canvas of the view together with what lies behind it, like the video overlay (#232).
 */
export async function screenPixel(page, x, y) {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  // One pixel: the row after the filter byte is the raw color, every PNG filter predicts 0
  let data = Buffer.alloc(0);
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString('latin1', offset + 4, offset + 8) === 'IDAT')
      data = Buffer.concat([data, png.subarray(offset + 8, offset + 8 + length)]);
    offset += 12 + length;
  }
  const [, r, g, b] = zlib.inflateSync(data);
  return { r, g, b };
}

/**
 * Color [r, g, b] of the active view at x, y like pagePixel, in Firefox from a screenshot: there
 * the main thread reads the view canvas from the worker that draws it, without the compositor the
 * engine thread, and while that thread waits for the main thread the read stalls for 10 s and
 * comes back empty.
 */
export async function shownPixel(page, x, y) {
  if (BROWSER !== 'firefox') return pagePixel(page, x, y);
  const origin = await canvasOrigin(page);
  const { r, g, b } = await screenPixel(page, Math.round(origin.x + x), Math.round(origin.y + y));
  return [r, g, b];
}

/** Colors roughly equal: every channel at most tolerance apart. */
export const near = (pixel, rgb, tolerance = 40) =>
  !!pixel && rgb.every((value, i) => Math.abs(pixel[i] - value) <= tolerance);

/** Until condition() is true, at most ms (for states without an event, for example an image). */
export async function waitFor(condition, ms = 20000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return false;
}

/** Screenshot of the window to build/e2e-<name>.png (CI artifact). */
export const screenshot = (page, name) =>
  page.screenshot({ path: path.join(buildDir, `e2e-${name}.png`) }).catch(() => {});
