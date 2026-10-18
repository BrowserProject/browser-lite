// Long run through the core API (fixtures/soak.mjs): many navigations in one view, then views
// opened with createView and closed with close({ force: true }); documents and memory stay
// bounded. The same through the demo UI: demo/soak-test.mjs.
//
//   node tests/core/soak-test.mjs [engine-dir]
//   SOAK_ROUNDS (default 40) rounds through all pages, SOAK_TABS (default 30) views
import { serveSoakPages, soak } from '../fixtures/soak.mjs';
import {
  TIMEOUT,
  finish,
  launch,
  load,
  openHost,
  openView,
  startStack,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 420000);

const siteURL = await serveSoakPages();
const stack = await startStack({ token: 'soak-token-0123456789abcdef' });
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
watchErrors(page);

await soak({
  page,
  siteURL,
  start: (url) => openHost(page, stack.app({ url })),
  go: (url) => load(page, url),
  openTab: (url) => openView(page, url),
  closeTab: () => page.evaluate(() => window.blTest.view().close({ force: true })),
  tabCount: () => page.evaluate(() => window.blTest.views().length),
  unit: 'views',
});

await browser.close();
finish();
