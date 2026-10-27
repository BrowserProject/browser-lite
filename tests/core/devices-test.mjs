// Devices and permissions (devices service of the core, engine/src/DeviceClients.cpp): selecting
// with the mouse, touch (tap, swiping scrolls), the color scheme of the system, location,
// notifications and speech recognition through the permission handler, File System Access,
// orientation and motion, platform features of the polyfills, an open permission request when
// the view closes (aborted, not stored), permissions.query with the stored decisions, answers of
// the host bridge on a quiet and on an abandoned page.
//
//   node tests/core/devices-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  chromiumOnly,
  collect,
  emulateTouchPoints,
  evalPage,
  finish,
  hostEvents,
  launch,
  load,
  openHost,
  openView,
  serve,
  startStack,
  timeLimit,
  waitEvent,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><html><head><title>Devices test</title>
<style>
  body { margin: 0; font: 20px sans-serif; height: 4000px; }
  #text { position: absolute; left: 20px; top: 20px; width: 600px; }
  #tap { position: absolute; left: 20px; top: 100px; width: 200px; height: 60px; background: #9cf; }
  #geo { position: absolute; left: 20px; top: 200px; width: 200px; height: 40px; }
  #notify { position: absolute; left: 260px; top: 200px; width: 200px; height: 40px; }
  #speech { position: absolute; left: 500px; top: 200px; width: 200px; height: 40px; }
  #files { position: absolute; left: 740px; top: 200px; width: 200px; height: 40px; }
</style></head><body>
<p id="text">This sentence should be selectable with the mouse.</p>
<div id="tap">Tap</div>
<button id="geo">Location</button>
<button id="notify">Notification</button>
<button id="speech">Speak</button>
<button id="files">Files</button>
<script>
  const result = (key, value) => console.log('RESULT ' + key + '=' + value);
  document.addEventListener('mouseup', () => {
    const text = String(getSelection());
    if (text)
      result('selection', text.trim());
  });
  const tap = document.getElementById('tap');
  tap.addEventListener('touchstart', (e) => result('touchstart', e.touches.length));
  tap.addEventListener('click', () => result('tapclick', 1));
  let reported = false;
  window.addEventListener('scroll', () => {
    if (!reported && scrollY > 50) {
      reported = true;
      result('touchscroll', Math.round(scrollY));
    }
  });
  const dark = matchMedia('(prefers-color-scheme: dark)');
  result('dark', dark.matches);
  dark.addEventListener('change', () => result('darkchange', dark.matches));
  result('ontouchstart', 'ontouchstart' in window);
  // Orientation and motion sensors of the host (ENABLE_DEVICE_ORIENTATION). Chrome sends an event
  // without values on registration when it has no sensors
  addEventListener('deviceorientation', (e) => { if (e.alpha != null) result('orient', [e.alpha, e.beta, e.gamma].map(Math.round).join(',')); });
  addEventListener('devicemotion', (e) => { if (e.accelerationIncludingGravity?.z != null) result('motion', Math.round(e.accelerationIncludingGravity.z)); });
  document.getElementById('geo').addEventListener('click', () => {
    navigator.geolocation.getCurrentPosition(
      (p) => result('geo', p.coords.latitude.toFixed(2) + ',' + p.coords.longitude.toFixed(2)),
      (e) => result('geo', 'error' + e.code));
  });
  // Speech recognition through the host (a stand-in in the host for the test)
  document.getElementById('speech').addEventListener('click', () => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new Recognition();
    recognition.lang = 'en-GB';
    recognition.interimResults = true;
    const events = [];
    recognition.onstart = () => events.push('start');
    recognition.onaudiostart = () => events.push('audio');
    recognition.onresult = (e) => result('speechresult', e.results[e.resultIndex][0].transcript.replace(/ /g, '_') + ':' + e.results[e.resultIndex].isFinal + ':' + e.results[e.resultIndex][0].confidence.toFixed(1));
    recognition.onerror = (e) => result('speecherror', e.error);
    recognition.onend = () => result('speechend', events.join('+'));
    recognition.start();
  });
  // File System Access through the host (stand-ins in the host for the test)
  document.getElementById('files').addEventListener('click', async () => {
    try {
      const [handle] = await showOpenFilePicker({ types: [{ description: 'Text', accept: { 'text/plain': ['.txt'] } }] });
      const file = await handle.getFile();
      result('fsopen', handle.kind + ':' + handle.name + ':' + (await file.text()).replace(/ /g, '_') + ':' + (handle instanceof FileSystemFileHandle));
      const save = await showSaveFilePicker({ suggestedName: 'result.txt' });
      const writable = await save.createWritable();
      await writable.write('Saved ');
      await writable.write(new TextEncoder().encode('from the page'));
      await writable.close();
      const directory = await showDirectoryPicker();
      const names = [];
      for await (const [name, entry] of directory.entries())
        names.push(name + '/' + entry.kind);
      const created = await directory.getFileHandle('new.txt', { create: true });
      result('fsdir', names.sort().join(',') + ':' + created.name + ':' + (directory instanceof FileSystemDirectoryHandle));
    } catch (e) {
      result('fserror', e.name + ':' + e.message);
    }
  });
  document.getElementById('notify').addEventListener('click', async () => {
    const permission = await Notification.requestPermission();
    result('notifypermission', permission);
    result('notifystate', Notification.permission);
  });
  // Platform features added by settings or polyfills (engine/src/WebPlatformExtras.cpp)
  (async () => {
    const order = [];
    await Promise.all([scheduler.postTask(() => order.push('a')), scheduler.postTask(() => order.push('b'), { delay: 5 })]);
    const controller = new TaskController();
    const task = scheduler.postTask(() => 1, { signal: controller.signal, delay: 50 });
    controller.abort();
    const aborted = await task.then(() => false, (e) => e.name === 'AbortError');
    result('scheduler', order.join('') + (aborted ? '+abort' : ''));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 20;
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');
    ctx.filter = 'blur(3px)';
    ctx.fillRect(5, 5, 10, 10);
    result('canvasfilter', ctx.getImageData(3, 10, 1, 1).data[3] > 0 ? 'blur' : 'none');
    const from = document.createElement('div'), to = document.createElement('div'), child = document.createElement('span');
    from.append(child);
    document.body.append(from, to);
    to.moveBefore(child, null);
    result('movebefore', child.parentNode === to);
    result('estimate', typeof (await navigator.storage.estimate()).quota);
    result('orientation', screen.orientation.type);
    // APIs of the host through the bridge of the polyfills (the bridge itself is invisible)
    result('hostbridge', typeof __blHost + ',' + typeof EyeDropper + ',' + typeof navigator.keyboard?.lock);
    const battery = await navigator.getBattery();
    result('battery', typeof battery.level + ',' + typeof battery.charging + ',' + (battery instanceof EventTarget));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const connection = navigator.connection;
    result('netinfo', [typeof connection.effectiveType, typeof connection.downlink, connection instanceof EventTarget, typeof navigator.deviceMemory].join(','));
    const layout = await navigator.keyboard.getLayoutMap().then((map) => 'map:' + (map instanceof Map), (e) => 'error:' + e.name);
    result('keyboardlayout', layout);
    const cache = await caches.open('test');
    await cache.put('/a?x=1', new Response('hello'));
    await cache.put('/a?x=1', new Response('new'));
    result('cacheapi', (await (await cache.match('/a', { ignoreSearch: true })).text()) + ':' + (await cache.keys()).length + ':' + (await caches.has('test')));
  })();
  result('ready', 1);
</script></body></html>`;

// Host bridge (engine/src/WebPlatformExtras.cpp): on a page without timers the promise must still
// be resolved; the answer for an abandoned page is dropped silently
const HOST_PAGES = {
  '/hostcall': `<!doctype html><title>Host call</title><script>ImageDecoder.isTypeSupported('image/png')
  .then((value) => console.log('RESULT hostsupported=' + value), (e) => console.log('RESULT hostsupported=' + e.name))</script>`,
  '/away': `<!doctype html><title>Away</title><script>ImageDecoder.isTypeSupported('image/x-slow')
  .then(() => console.log('RESULT stale=called'), () => console.log('RESULT stale=rejected')); location.href = '/after'</script>`,
  '/after': `<!doctype html><title>After</title><script>console.log('RESULT after=1')</script>`,
};
const { url: siteURL } = await serve((req, res) =>
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(HOST_PAGES[req.url] || PAGE),
);

const stack = await startStack({ token: 'devices-token-0123456789abcdef' });
const browser = await launch();
// Touch screen like a Chromebook, location Bern
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  hasTouch: true,
  geolocation: { latitude: 46.948, longitude: 7.447 },
  permissions: ['geolocation', 'notifications'],
});
await emulateTouchPoints(context);
// Speech recognition of the host as a stand-in (headless has no microphone)
await context.addInitScript(() => {
  class FakeRecognition extends EventTarget {
    start() {
      window.__speechLang = this.lang;
      setTimeout(() => {
        this.dispatchEvent(new Event('start'));
        this.dispatchEvent(new Event('audiostart'));
        const event = new Event('result');
        event.resultIndex = 0;
        event.results = [
          Object.assign([{ transcript: 'hello world', confidence: 0.9 }], { isFinal: true }),
        ];
        this.dispatchEvent(event);
        this.dispatchEvent(new Event('audioend'));
        this.dispatchEvent(new Event('end'));
      }, 50);
    }
    stop() {}
    abort() {}
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeRecognition;

  // File System Access of the host as a stand-in (files in memory)
  const files = new Map([
    ['note.txt', 'Hello file'],
    ['image.png', 'png'],
  ]);
  window.__fakeFiles = files;
  class FakeFile {
    constructor(name) {
      this.kind = 'file';
      this.name = name;
    }
    async getFile() {
      return new File([files.get(this.name) ?? ''], this.name, {
        type: 'text/plain',
        lastModified: 1000,
      });
    }
    async createWritable() {
      const name = this.name;
      const parts = [];
      return {
        async write(data) {
          parts.push(typeof data === 'string' ? data : new TextDecoder().decode(data.data ?? data));
        },
        async seek() {},
        async truncate() {},
        async close() {
          files.set(name, parts.join(''));
        },
        async abort() {},
      };
    }
    async isSameEntry(other) {
      return other.name === this.name;
    }
    async queryPermission() {
      return 'granted';
    }
    async requestPermission() {
      return 'granted';
    }
  }
  class FakeDirectory {
    constructor() {
      this.kind = 'directory';
      this.name = 'folder';
    }
    async getFileHandle(name, options = {}) {
      if (!files.has(name) && !options.create) throw new DOMException('Not found', 'NotFoundError');
      if (!files.has(name)) files.set(name, '');
      return new FakeFile(name);
    }
    async *values() {
      for (const name of [...files.keys()]) yield new FakeFile(name);
    }
    async removeEntry(name) {
      files.delete(name);
    }
    async queryPermission() {
      return 'granted';
    }
  }
  window.showOpenFilePicker = async () => [new FakeFile('note.txt')];
  window.showSaveFilePicker = async (options) => new FakeFile(options?.suggestedName || 'new.txt');
  window.showDirectoryPicker = async () => new FakeDirectory();

  // Slow answer of the host for the test of the abandoned page
  if (typeof ImageDecoder === 'function') {
    const isTypeSupported = ImageDecoder.isTypeSupported.bind(ImageDecoder);
    ImageDecoder.isTypeSupported = (type) =>
      type === 'image/x-slow'
        ? new Promise((resolve) =>
            setTimeout(() => {
              window.__slowAnswered = true;
              resolve(false);
            }, 2000),
          )
        : isTypeSupported(type);
  }
});
const page = await context.newPage();
const results = collect(page, /RESULT (\w+)=(.*?)(\s+\(|$)/);
const result = (key, timeout = 30000) => results.wait(key, timeout);
async function at(x, y) {
  const box = await canvasOrigin(page);
  return [box.x + x, box.y + y];
}

await openHost(page, stack.app({ url: siteURL }));
const host = (expression, arg) => page.evaluate(expression, arg);
const answer = (kind, value) =>
  host(
    ([kind, value]) => {
      window.blHost.permissionAnswers[kind] = value;
    },
    [kind, value],
  );
check('page ready', (await result('ready', TIMEOUT)) === '1');
check('touch screen detected (ontouchstart)', (await result('ontouchstart')) === 'true');
check(
  'scheduler.postTask/yield with abort',
  (await result('scheduler')) === 'ab+abort',
  results.get('scheduler'),
);
check(
  'canvas filter (blur)',
  (await result('canvasfilter')) === 'blur',
  results.get('canvasfilter'),
);
check('moveBefore', (await result('movebefore')) === 'true');
check('navigator.storage.estimate', (await result('estimate')) === 'number');
check(
  'host bridge invisible, EyeDropper and keyboard.lock there',
  (await result('hostbridge')) === 'undefined,function,function',
  results.get('hostbridge'),
);
check(
  'navigator.connection and deviceMemory',
  (await result('netinfo')) === 'string,number,true,number',
  results.get('netinfo'),
);
check(
  'navigator.getBattery() from the host',
  (await result('battery')) === 'number,boolean,true',
  results.get('battery'),
);
check(
  'navigator.keyboard.getLayoutMap() from the host',
  (await result('keyboardlayout')) === 'map:true',
  results.get('keyboardlayout'),
);
check(
  'screen.orientation',
  (await result('orientation')) === 'landscape-primary',
  results.get('orientation'),
);
check(
  'Cache API (put, match, keys)',
  (await result('cacheapi')) === 'new:1:true',
  results.get('cacheapi'),
);

// 1) Select with the mouse (needs ENABLE_DRAG_SUPPORT)
await page.mouse.move(...(await at(25, 45)));
await page.mouse.down();
await page.mouse.move(...(await at(200, 45)), { steps: 8 });
await page.mouse.move(...(await at(380, 45)), { steps: 8 });
await page.mouse.up();
const selection = await result('selection', 10000);
check('select with the mouse', selection && selection.length > 10, JSON.stringify(selection));

// 2) Tap: touch events go to the page, a click follows
await page.touchscreen.tap(...(await at(100, 130)));
check('touch event (touchstart)', (await result('touchstart', 10000)) === '1');
check('tap becomes a click', (await result('tapclick', 10000)) === '1');

// 3) Swiping scrolls the page (CDP: drag the finger up)
if (chromiumOnly('swiping scrolls (CDP Input.dispatchTouchEvent)')) {
  const cdp = await context.newCDPSession(page);
  const [sx, sy] = await at(600, 500);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: sx, y: sy }],
  });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: sx, y: sy - i * 30 }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const touchScroll = await result('touchscroll', 10000);
  check('swiping scrolls', Number(touchScroll) > 50, String(touchScroll));
  // Let the fling end, then back to the top
  await page.waitForTimeout(2000);
  await page.mouse.move(...(await at(600, 400)));
  await page.mouse.wheel(0, -5000);
  await page.waitForTimeout(1000);
}

// 4) Color scheme: the host switches to dark, the page notices
check('color scheme light at the start', (await result('dark')) === 'false');
await page.emulateMedia({ colorScheme: 'dark' });
const darkArrived = (await result('darkchange', 10000)) === 'true';
check('color scheme dark arrives', darkArrived);
// Rare in CI, never locally: everything after it failed too. What the page and the host say then
if (!darkArrived) {
  await evalPage(
    page,
    "console.log('RESULT diag=' + [scrollY, matchMedia('(prefers-color-scheme: dark)').matches, document.hasFocus(), document.visibilityState].join(','))",
  );
  console.log(`     page: ${(await result('diag', 5000)) ?? 'no answer'}`);
  console.log(`     host events: ${(await hostEvents(page)).slice(-8).join(' | ')}`);
}

// 5) Location: the permission handler grants it, then the position arrives
await answer('geolocation', 'grant');
await page.mouse.click(...(await at(120, 220)));
check('location: permission request', !!(await waitEvent(page, 'permission:geolocation', 10000)));
check('location arrives', (await result('geo', 15000)) === '46.95,7.45', results.get('geo'));

// 6) Notifications: permission request, then "granted"
await answer('notifications', 'grant');
await page.mouse.click(...(await at(360, 220)));
check(
  'notifications allowed',
  !!(await waitEvent(page, 'permission:notifications', 10000)) &&
    (await result('notifypermission', 15000)) === 'granted' &&
    (await result('notifystate')) === 'granted',
  `${results.get('notifypermission')} / ${results.get('notifystate')}`,
);

// 7) Speech recognition: permission request for the microphone, then the result from the host
await answer('microphone', 'grant');
await page.mouse.click(...(await at(600, 220)));
check(
  'speech recognition: permission request for the microphone',
  !!(await waitEvent(page, 'permission:microphone', 10000)),
);
check(
  'speech recognition: result arrives',
  (await result('speechresult', 15000)) === 'hello_world:true:0.9',
  results.get('speechresult') || results.get('speecherror'),
);
check(
  'speech recognition: start/audio/end',
  (await result('speechend', 15000)) === 'start+audio',
  results.get('speechend'),
);
check(
  'speech recognition: language to the host',
  (await page.evaluate(() => window.__speechLang)) === 'en-GB',
);

// 8) File System Access: open a file, save, read a folder (through the host)
await page.mouse.click(...(await at(840, 220)));
check(
  'showOpenFilePicker + getFile',
  (await result('fsopen', 15000)) === 'file:note.txt:Hello_file:true',
  results.get('fsopen') || results.get('fserror'),
);
check(
  'showDirectoryPicker + entries + getFileHandle(create)',
  (await result('fsdir', 15000)) === 'image.png/file,note.txt/file,result.txt/file:new.txt:true',
  results.get('fsdir') || results.get('fserror'),
);
check(
  'showSaveFilePicker + createWritable writes at the host',
  (await page.evaluate(() => window.__fakeFiles.get('result.txt'))) === 'Saved from the page',
);

// 9) Orientation and motion: the core forwards the events of the host while the page listens
// (the listener in the host comes with a little delay)
for (let i = 0; i < 30 && !(results.has('orient') && results.has('motion')); i++) {
  await page.evaluate(() => {
    window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientation', { alpha: 10, beta: 20, gamma: 30 }),
    );
    window.dispatchEvent(
      new DeviceMotionEvent('devicemotion', {
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
        interval: 16,
      }),
    );
  });
  await page.waitForTimeout(300);
}
check(
  'deviceorientation arrives',
  (await result('orient', 5000)) === '10,20,30',
  results.get('orient'),
);
check('devicemotion arrives', (await result('motion', 5000)) === '10', results.get('motion'));

// 10) Close a view with an open permission request: the request is aborted and not stored
await answer('camera', 'wait');
await openView(page, `${siteURL}?second-view`);
await page
  .waitForFunction(() => window.blTest.view()?.title === 'Devices test', null, { timeout: 30000 })
  .catch(() => {});
await page.evaluate(() =>
  window.blTest.eval('navigator.mediaDevices.getUserMedia({ video: true }).catch(() => {})'),
);
check(
  'closed view: permission request for the camera',
  !!(await waitEvent(page, 'permission:camera', 10000)),
);
await page.evaluate(() => window.blTest.view().close({ force: true }));
check('closed view: request aborted', !!(await waitEvent(page, 'permission-aborted:camera', 5000)));

// 11) permissions.query answers with the stored decisions (engine/src/Permissions.cpp); the
// camera is still open after the closed view, also in the engine
const queryPermissions = () =>
  page.evaluate(() =>
    window.blTest.eval(`Promise.all(['geolocation', 'notifications', 'microphone', 'camera']
  .map((name) => navigator.permissions.query({ name }).then((s) => s.state, (e) => e.name))).then((states) => console.log('RESULT permissions=' + states.join(',')))`),
  );
await queryPermissions();
check(
  'permissions.query: granted and open',
  (await result('permissions', 10000)) === 'granted,granted,granted,prompt',
  results.get('permissions'),
);
await answer('camera', 'deny');
const cameraRequests = await page.evaluate(
  () => window.blHost.permissionRequests.filter((r) => r.kind === 'camera').length,
);
await page.evaluate(() =>
  window.blTest.eval(
    'navigator.mediaDevices.getUserMedia({ video: true }).then(() => console.log("RESULT camera=ok"), (e) => console.log("RESULT camera=" + e.name))',
  ),
);
check(
  'camera denied: getUserMedia rejected',
  (await result('camera', 10000)) === 'NotAllowedError',
  results.get('camera'),
);
check(
  'camera: asked again (closing was no denial)',
  (await page.evaluate(
    () => window.blHost.permissionRequests.filter((r) => r.kind === 'camera').length,
  )) ===
    cameraRequests + 1,
);
results.delete('permissions');
await queryPermissions();
check(
  'permissions.query: camera denied',
  (await result('permissions', 10000)) === 'granted,granted,granted,denied',
  results.get('permissions'),
);

// 12) Host bridge: answer on a quiet page, answer after leaving the page
await load(page, `${siteURL}hostcall`);
check(
  'host call: promise resolved on a quiet page',
  (await result('hostsupported', 15000)) === 'true',
  results.get('hostsupported'),
);
await load(page, `${siteURL}away`);
check(
  'host call: page left before the answer comes',
  (await result('after', 15000))?.trim() === '1',
);
const linesBefore = results.logs.length;
await page.waitForFunction(() => window.__slowAnswered, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1000);
const lateLines = results.logs
  .slice(linesBefore)
  .filter((line) => /stale|Uncaught|Exception|Error/.test(line));
check(
  'host call: the answer for the abandoned page is dropped silently',
  (await page.evaluate(() => !!window.__slowAnswered)) &&
    !results.has('stale') &&
    !lateLines.length,
  lateLines.join(' | '),
);

await browser.close();
finish();
