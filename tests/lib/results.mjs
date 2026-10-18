// Reading the page under test: RESULT lines from the console, pixels of the view, waiting.
import path from 'node:path';
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
