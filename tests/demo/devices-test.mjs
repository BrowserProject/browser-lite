// Permission requests in the demo UI (the permission prompt of the ui package, decisions stored
// in the profile; the engine side is tests/core/devices-test.mjs): location, notifications and the
// microphone for speech recognition with the prompt like in Chrome, a prompt of a closed tab goes
// away and is not stored, permissions.query with the stored decisions, Block denies.
//
//   node tests/demo/devices-test.mjs [engine-dir]
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

const PAGE = `<!doctype html><html><head><title>Devices test</title>
<style>
  body { margin: 0; font: 20px sans-serif; }
  #geo { position: absolute; left: 20px; top: 200px; width: 200px; height: 40px; }
  #notify { position: absolute; left: 260px; top: 200px; width: 200px; height: 40px; }
  #speech { position: absolute; left: 500px; top: 200px; width: 200px; height: 40px; }
</style></head><body>
<button id="geo">Location</button>
<button id="notify">Notification</button>
<button id="speech">Speak</button>
<script>
  const result = (key, value) => console.log('RESULT ' + key + '=' + value);
  document.getElementById('geo').addEventListener('click', () => {
    navigator.geolocation.getCurrentPosition(
      (p) => result('geo', p.coords.latitude.toFixed(2) + ',' + p.coords.longitude.toFixed(2)),
      (e) => result('geo', 'error' + e.code));
  });
  document.getElementById('notify').addEventListener('click', async () => {
    const permission = await Notification.requestPermission();
    result('notifypermission', permission);
    result('notifystate', Notification.permission);
  });
  document.getElementById('speech').addEventListener('click', () => {
    const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    recognition.onresult = (e) => result('speechresult', e.results[e.resultIndex][0].transcript.replace(/ /g, '_'));
    recognition.onerror = (e) => result('speecherror', e.error);
    recognition.start();
  });
  result('ready', 1);
</script></body></html>`;
const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

const stack = await startStack({ app: 'demo', token: 'devices-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  geolocation: { latitude: 46.948, longitude: 7.447 },
  permissions: ['geolocation', 'notifications'],
});
// Speech recognition of the host as a stand-in (headless has no microphone)
await context.addInitScript(() => {
  class FakeRecognition extends EventTarget {
    start() {
      setTimeout(() => {
        this.dispatchEvent(new Event('start'));
        const event = new Event('result');
        event.resultIndex = 0;
        event.results = [
          Object.assign([{ transcript: 'hello world', confidence: 0.9 }], { isFinal: true }),
        ];
        this.dispatchEvent(event);
        this.dispatchEvent(new Event('end'));
      }, 50);
    }
    stop() {}
    abort() {}
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeRecognition;
});
const page = await context.newPage();
const results = collect(page, /RESULT (\w+)=(.*?)(\s+\(|$)/);
const result = (key, timeout = 30000) => results.wait(key, timeout);
async function at(x, y) {
  const box = await canvasOrigin(page);
  return [box.x + x, box.y + y];
}
const prompt = page.locator('.bl-permission-prompt:not([hidden])');
const promptShown = () =>
  prompt.waitFor({ timeout: 10000 }).then(
    () => true,
    () => false,
  );

await page.goto(stack.app({ url: siteURL }));
check('page ready', (await result('ready', TIMEOUT)) === '1');

// 1) Location: a prompt like Chrome, after "Allow" the position arrives
await page.mouse.click(...(await at(120, 220)));
const locationPrompt = await promptShown();
check('location: prompt appears', locationPrompt && /location/.test(await prompt.textContent()));
if (locationPrompt) await prompt.locator('button', { hasText: 'Allow' }).click();
check('location arrives', (await result('geo', 15000)) === '46.95,7.45', results.get('geo'));

// 2) Notifications: prompt, then "granted"
await page.mouse.click(...(await at(360, 220)));
const notifyPrompt = await promptShown();
if (notifyPrompt) await prompt.locator('button', { hasText: 'Allow' }).click();
check(
  'notifications allowed through the prompt',
  notifyPrompt &&
    (await result('notifypermission', 15000)) === 'granted' &&
    (await result('notifystate')) === 'granted',
  `${results.get('notifypermission')} / ${results.get('notifystate')}`,
);

// 3) Speech recognition: prompt for the microphone
await page.mouse.click(...(await at(600, 220)));
const speechPrompt = await promptShown();
check(
  'speech recognition: prompt for the microphone',
  speechPrompt && /microphone/.test(await prompt.textContent()),
);
if (speechPrompt) await prompt.locator('button', { hasText: 'Allow' }).click();
check(
  'speech recognition: result after Allow',
  (await result('speechresult', 15000)) === 'hello_world',
  results.get('speechresult') || results.get('speecherror'),
);

// 4) Close a tab with an open prompt: the prompt goes away and is not stored
await page.click('#new-tab');
await page.fill('#address', `${siteURL}?second-tab`);
await page.press('#address', 'Enter');
await page
  .waitForFunction(
    () => document.querySelector('#tab-list .tab.active .title')?.textContent === 'Devices test',
    null,
    { timeout: 30000 },
  )
  .catch(() => {});
await page.evaluate(() =>
  window.blTest.eval('navigator.mediaDevices.getUserMedia({ video: true }).catch(() => {})'),
);
const cameraPrompt = await promptShown();
check(
  'closed tab: prompt for the camera appears',
  cameraPrompt && /camera/.test(await prompt.textContent()),
);
await page.click('#tab-list .tab.active .close');
const promptGone = await page
  .locator('.bl-permission-prompt')
  .waitFor({ state: 'hidden', timeout: 5000 })
  .then(
    () => true,
    () => false,
  );
const stored = await page.evaluate(() =>
  JSON.stringify(window.blTest.profile.prefs('permissions') || {}),
);
check('closed tab: prompt gone and not stored', promptGone && !stored.includes('camera'), stored);

// 5) permissions.query answers with the stored decisions; the camera is still open after the
// closed tab
const queryPermissions = () =>
  page.evaluate(() =>
    window.blTest.eval(`Promise.all(['geolocation', 'notifications', 'microphone', 'camera']
  .map((name) => navigator.permissions.query({ name }).then((s) => s.state, (e) => e.name))).then((states) => console.log('RESULT permissions=' + states.join(',')))`),
  );
await queryPermissions();
check(
  'permissions.query: allowed and open',
  (await result('permissions', 10000)) === 'granted,granted,granted,prompt',
  results.get('permissions'),
);
await page.evaluate(() =>
  window.blTest.eval(
    'navigator.mediaDevices.getUserMedia({ video: true }).then(() => console.log("RESULT camera=ok"), (e) => console.log("RESULT camera=" + e.name))',
  ),
);
const cameraAgain = await promptShown();
check(
  'camera: the prompt comes again (closing was no denial)',
  cameraAgain && /camera/.test(await prompt.textContent()),
);
if (cameraAgain) await prompt.locator('button', { hasText: 'Block' }).click();
check(
  'camera blocked: getUserMedia rejected',
  (await result('camera', 10000)) === 'NotAllowedError',
  results.get('camera'),
);
results.delete('permissions');
await queryPermissions();
check(
  'permissions.query: camera blocked',
  (await result('permissions', 10000)) === 'granted,granted,granted,denied',
  results.get('permissions'),
);
const blocked = await page.evaluate(() =>
  JSON.stringify(window.blTest.profile.prefs('permissions') || {}),
);
check(
  'decisions stored in the profile',
  blocked.includes('camera') && blocked.includes('geolocation'),
  blocked,
);

await browser.close();
finish();
