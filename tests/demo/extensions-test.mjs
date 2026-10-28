// UI slots of extensions in the demo (apps/demo/src/extensions.ts, @browser-lite/ui slots): an
// extension installed at runtime gets its toolbar button (with the active view), context menu
// entry, side panel and settings section; turning it off in the settings removes them.
//
//   node tests/demo/extensions-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

const PAGE =
  '<!doctype html><title>Slots</title><body style="margin:0;height:600px"><p>Text</p><script>console.log("RESULT ready=1")</script>';
const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

const stack = await startStack({ app: 'demo', token: 'slots-token-0123456789abcdef' });
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(page);

await page.goto(stack.app({ url: siteURL }));
const ready = await results.wait('ready', TIMEOUT);
check('page ready', ready === '1', ready);

await page.evaluate(() =>
  window.blTest.installExtension({
    id: 'slots-test',
    version: '0.0.1',
    setup({ app: { ui } }) {
      window.slotLog = [];
      return [
        ui.add('toolbar', {
          id: 'slots-test.button',
          label: 'Slots test',
          icon: 'S',
          action: (view) => window.slotLog.push(`button:${view?.url}`),
        }),
        ui.add('context-menu', {
          id: 'slots-test.menu',
          label: 'Slots entry',
          action: (view) => window.slotLog.push(`menu:${view.url}`),
        }),
        ui.add('panel', {
          id: 'slots-test.panel',
          title: 'Slots panel',
          render(container) {
            container.textContent = 'Panel of the extension';
            return () => window.slotLog.push('panel-closed');
          },
        }),
        ui.add('settings', {
          id: 'slots-test.settings',
          title: 'Slots settings',
          render(container) {
            container.textContent = 'Settings of the extension';
            return undefined;
          },
        }),
      ];
    },
  }),
);

const button = page.locator('#extension-buttons button[data-bl-item="slots-test.button"]');
check('toolbar button shown', (await button.count()) === 1 && (await button.textContent()) === 'S');
await button.click();
const log = () => page.evaluate(() => window.slotLog);
check(
  'toolbar button gets the active view',
  (await log()).includes(`button:${siteURL}`),
  JSON.stringify(await log()),
);

const box = await canvasOrigin(page);
await page.mouse.click(box.x + 300, box.y + 300, { button: 'right' });
const entry = page.locator('.bl-context-menu button[data-bl-item="slots-test.menu"]');
const menuShown = await entry.waitFor({ timeout: 10000 }).then(
  () => true,
  () => false,
);
check('context menu entry shown', menuShown);
if (menuShown) {
  await entry.click();
  check('context menu entry runs with the view', (await log()).includes(`menu:${siteURL}`));
}

await page.evaluate(() => window.blTest.ui.openPanel('slots-test.panel'));
const panel = page.locator('#side-panel [data-bl-item="slots-test.panel"]');
check(
  'side panel of the extension',
  (await panel.textContent()) === 'Panel of the extension' &&
    (await page.locator('#side-panel h2').textContent()) === 'Slots panel',
);
await page.click('#side-panel .panel-close');
check('closing the panel runs its cleanup', (await log()).includes('panel-closed'));

await page.click('#menu-button');
await page.click('#side-panel .panel-menu-item:has-text("Settings")');
await page.click('#settings nav button[data-section=extensions]');
const own = page.locator('#settings [data-bl-item="slots-test.settings"]');
check(
  'settings section of the extension',
  (await own.textContent()) === 'Settings of the extension',
);
await page.click('#settings input[data-extension="slots-test"]');
await page.waitForFunction(() => !window.blTest.extensions.extensions[0].enabled, null, {
  timeout: 5000,
});
check(
  'turned off: its button and section are gone',
  (await button.count()) === 0 && (await own.count()) === 0,
);
check(
  'turned off: remembered in the profile',
  await page.evaluate(() =>
    window.blTest.profile.prefs('extensions')?.disabled?.includes('slots-test'),
  ),
);

await browser.close();
finish();
