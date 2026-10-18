// Long run through the demo UI (fixtures/soak.mjs): many navigations through the address bar in
// one tab, then tabs opened with the new tab button and closed with the close button of the tab;
// documents and memory stay bounded. The same through the core API: core/soak-test.mjs.
//
//   node tests/demo/soak-test.mjs [engine-dir]
//   SOAK_ROUNDS (default 40) rounds through all pages, SOAK_TABS (default 30) tabs
import { serveSoakPages, soak } from '../fixtures/soak.mjs';
import { TIMEOUT, finish, launch, startStack, timeLimit, watchErrors } from '../lib/index.mjs';

timeLimit(TIMEOUT + 420000);

const siteURL = await serveSoakPages();
const stack = await startStack({ app: 'demo', token: 'soak-token-0123456789abcdef' });
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
watchErrors(page);

async function go(address) {
  await page.click('#address');
  await page.fill('#address', address);
  await page.press('#address', 'Enter');
}

await soak({
  page,
  siteURL,
  start: (url) => page.goto(stack.app({ url })),
  go,
  openTab: async (url) => {
    await page.click('#new-tab');
    await go(url);
  },
  closeTab: () => page.click('#tab-list .tab.active .close'),
  tabCount: () => page.locator('#tab-list .tab').count(),
  unit: 'tabs',
});

await browser.close();
finish();
