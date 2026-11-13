// The host page and the engine's memory (packages/core/src/browser.ts leave, stopEngine;
// engine/js/engine-memory.js):
// - a host page that goes into the back-forward cache (pagehide with persisted) ends its engine
//   like one that is left for good, and the engine's memory becomes garbage although the page
//   still holds the browser: Safari kept the whole engine of a cached page, and a new start in
//   the same tab then failed to get its memory
// - destroy() of the ended browser still takes its views off the page: back from the cache the
//   old canvases stayed above the views of the next browser, which looked dead
// - without 4 GB of free address space for the memory (the engine of another page of the same
//   process holds it) the engine starts with a smaller maximum and works
// The garbage check needs Chromium's gc().
//
//   node tests/core/host-left-test.mjs [engine-dir]
import {
  check,
  chromiumOnly,
  collect,
  finish,
  launch,
  load,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit();
if (!chromiumOnly('host page left (gc())')) finish();

const { url: siteURL } = await serve((req, res) =>
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(
      '<!doctype html><title>Page</title><script>console.log("RESULT page=" + (6 * 7));</script>',
    ),
);
const stack = await startStack({ token: 'host-left-token-0123456789abcdef' });
const browser = await launch({ args: ['--js-flags=--expose-gc'] });

// Watches the engine memory for its collection; the page must not keep it itself
const watchMemory = (page) =>
  page.evaluate(() => {
    window.memoryCollected = false;
    window.memoryRegistry = new FinalizationRegistry(() => {
      window.memoryCollected = true;
    });
    window.memoryRegistry.register(window.blTest.browser.debug.module.blHeap().buffer, 'memory');
  });
const collected = (page) =>
  waitFor(
    () =>
      page.evaluate(async () => {
        window.gc();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return window.memoryCollected;
      }),
    40000,
    300,
  );

for (const persisted of [true, false]) {
  const page = await browser.newPage();
  check(
    `host page starts (${persisted ? 'cached' : 'left'})`,
    await openHost(page, stack.app({ url: 'about:blank' })),
  );
  await watchMemory(page);
  const left = Date.now();
  await page.evaluate((persisted) => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted }));
  }, persisted);
  const state = await page.evaluate(() => window.blTest.browser.state);
  check(
    `pagehide ${persisted ? 'into the back-forward cache' : 'for good'} ends the engine`,
    state === 'destroyed',
    state,
  );
  check(
    `its memory is garbage while the page still holds the browser (${persisted ? 'cached' : 'left'})`,
    await collected(page),
    `after ${Date.now() - left} ms`,
  );
  if (persisted) {
    const elements = () =>
      page.evaluate(() => document.querySelectorAll('canvas, textarea').length);
    const before = await elements();
    await page.evaluate(() => window.blTest.browser.destroy());
    const after = await elements();
    check(
      'back from the cache, destroy() of the ended browser takes its views off the page',
      before > 0 && after === 0,
      `canvases and IME fields ${before} -> ${after}`,
    );
  }
  await page.close();
}

// Only 2 GB of address space: the 4 GB maximum fails like in iOS Safari with three engines
const context = await browser.newContext();
await context.addInitScript(() => {
  const Original = WebAssembly.Memory;
  window.memoryMaxima = [];
  WebAssembly.Memory = function Memory(descriptor) {
    if (descriptor?.shared && descriptor.initial >= 4096) {
      window.memoryMaxima.push(descriptor.maximum);
      if (descriptor.maximum > 32768) throw new RangeError('Out of memory');
    }
    return new Original(descriptor);
  };
  WebAssembly.Memory.prototype = Original.prototype;
});
const page = await context.newPage();
const results = collect(page);
const started = await openHost(page, stack.app({ url: 'about:blank' }));
check('engine starts without 4 GB of address space', started);
const maxima = await page.evaluate(() => window.memoryMaxima);
check('it takes the next smaller maximum', maxima.join() === '65536,32768', maxima.join());
if (started) {
  await load(page, siteURL);
  check('its pages run', (await results.wait('page')) === '42');
}

await browser.close();
finish();
