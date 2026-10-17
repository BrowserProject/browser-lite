// End-to-End Test fuer Geraete und Berechtigungen (web/devices.js,
// engine/src/DeviceClients.cpp): Markieren mit der Maus, Touch (Antippen,
// Wischen scrollt), Farbschema des Systems, Standort und Benachrichtigungen mit
// der Abfrage wie in Chrome, offene Abfragen beim Schliessen des Tabs,
// Antworten der Host-Bruecke auf einer ruhigen und auf einer verlassenen Seite.
//
//   cd tests/e2e && node devices-test.mjs [engine-ordner]
import { TIMEOUT, canvasOrigin, check, collect, finish, launch, serve, startStack, timeLimit } from './harness.mjs';

timeLimit();

const PAGE = `<!doctype html><html><head><title>Geraete-Test</title>
<style>
  body { margin: 0; font: 20px sans-serif; height: 4000px; }
  #text { position: absolute; left: 20px; top: 20px; width: 600px; }
  #tap { position: absolute; left: 20px; top: 100px; width: 200px; height: 60px; background: #9cf; }
  #geo { position: absolute; left: 20px; top: 200px; width: 200px; height: 40px; }
  #notify { position: absolute; left: 260px; top: 200px; width: 200px; height: 40px; }
  #speech { position: absolute; left: 500px; top: 200px; width: 200px; height: 40px; }
  #files { position: absolute; left: 740px; top: 200px; width: 200px; height: 40px; }
</style></head><body>
<p id="text">Dieser Satz soll mit der Maus markiert werden koennen.</p>
<div id="tap">Antippen</div>
<button id="geo">Standort</button>
<button id="notify">Benachrichtigung</button>
<button id="speech">Sprechen</button>
<button id="files">Dateien</button>
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
  // Lage- und Bewegungssensoren des Hosts (ENABLE_DEVICE_ORIENTATION)
  // Chrome schickt beim Anmelden ein Event ohne Werte, wenn es keine Sensoren hat
  addEventListener('deviceorientation', (e) => { if (e.alpha != null) result('orient', [e.alpha, e.beta, e.gamma].map(Math.round).join(',')); });
  addEventListener('devicemotion', (e) => { if (e.accelerationIncludingGravity?.z != null) result('motion', Math.round(e.accelerationIncludingGravity.z)); });
  document.getElementById('geo').addEventListener('click', () => {
    navigator.geolocation.getCurrentPosition(
      (p) => result('geo', p.coords.latitude.toFixed(2) + ',' + p.coords.longitude.toFixed(2)),
      (e) => result('geo', 'fehler' + e.code));
  });
  // Spracherkennung ueber den Host (im Test eine Attrappe im Host)
  document.getElementById('speech').addEventListener('click', () => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new Recognition();
    recognition.lang = 'de-CH';
    recognition.interimResults = true;
    const events = [];
    recognition.onstart = () => events.push('start');
    recognition.onaudiostart = () => events.push('audio');
    recognition.onresult = (e) => result('speechresult', e.results[e.resultIndex][0].transcript.replace(/ /g, '_') + ':' + e.results[e.resultIndex].isFinal + ':' + e.results[e.resultIndex][0].confidence.toFixed(1));
    recognition.onerror = (e) => result('speecherror', e.error);
    recognition.onend = () => result('speechend', events.join('+'));
    recognition.start();
  });
  // File System Access ueber den Host (im Test Attrappen im Host)
  document.getElementById('files').addEventListener('click', async () => {
    try {
      const [handle] = await showOpenFilePicker({ types: [{ description: 'Text', accept: { 'text/plain': ['.txt'] } }] });
      const file = await handle.getFile();
      result('fsopen', handle.kind + ':' + handle.name + ':' + (await file.text()).replace(/ /g, '_') + ':' + (handle instanceof FileSystemFileHandle));
      const save = await showSaveFilePicker({ suggestedName: 'ergebnis.txt' });
      const writable = await save.createWritable();
      await writable.write('Gespeichert ');
      await writable.write(new TextEncoder().encode('aus der Seite'));
      await writable.close();
      const directory = await showDirectoryPicker();
      const names = [];
      for await (const [name, entry] of directory.entries())
        names.push(name + '/' + entry.kind);
      const created = await directory.getFileHandle('neu.txt', { create: true });
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
  // Plattform-Funktionen, die per Einstellung/Polyfill dazukamen (engine/src/WebPlatformExtras.cpp)
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
    // APIs des Host ueber die Bruecke der Polyfills (die Bruecke selber ist unsichtbar)
    result('hostbridge', typeof __blHost + ',' + typeof EyeDropper + ',' + typeof navigator.keyboard?.lock);
    const battery = await navigator.getBattery();
    result('battery', typeof battery.level + ',' + typeof battery.charging + ',' + (battery instanceof EventTarget));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const connection = navigator.connection;
    result('netinfo', [typeof connection.effectiveType, typeof connection.downlink, connection instanceof EventTarget, typeof navigator.deviceMemory].join(','));
    const layout = await navigator.keyboard.getLayoutMap().then((map) => 'map:' + (map instanceof Map), (e) => 'fehler:' + e.name);
    result('keyboardlayout', layout);
    const cache = await caches.open('test');
    await cache.put('/a?x=1', new Response('hallo'));
    await cache.put('/a?x=1', new Response('neu'));
    result('cacheapi', (await (await cache.match('/a', { ignoreSearch: true })).text()) + ':' + (await cache.keys()).length + ':' + (await caches.has('test')));
  })();
  result('ready', 1);
</script></body></html>`;

// Host-Bruecke (engine/src/WebPlatformExtras.cpp): auf einer Seite ohne Timer
// muss das Promise trotzdem aufgeloest werden; die Antwort fuer eine verlassene
// Seite verfaellt still
const HOST_PAGES = {
  '/hostcall': `<!doctype html><title>Host-Aufruf</title><script>ImageDecoder.isTypeSupported('image/png')
  .then((value) => console.log('RESULT hostsupported=' + value), (e) => console.log('RESULT hostsupported=' + e.name))</script>`,
  '/weg': `<!doctype html><title>Weg</title><script>ImageDecoder.isTypeSupported('image/x-langsam')
  .then(() => console.log('RESULT stale=called'), () => console.log('RESULT stale=rejected')); location.href = '/danach'</script>`,
  '/danach': `<!doctype html><title>Danach</title><script>console.log('RESULT danach=1')</script>`,
};
const { url: siteURL } = await serve((req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(HOST_PAGES[req.url] || PAGE));

const stack = await startStack({ token: 'devices-token-0123456789abcdef' });
const browser = await launch();
// Touchscreen wie ein Chromebook, Standort Bern
const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, hasTouch: true, geolocation: { latitude: 46.948, longitude: 7.447 }, permissions: ['geolocation', 'notifications'] });
// Spracherkennung des Host als Attrappe (headless hat kein Mikrofon)
await context.addInitScript(() => {
  class FakeRecognition extends EventTarget {
    start() {
      window.__speechLang = this.lang;
      setTimeout(() => {
        this.dispatchEvent(new Event('start'));
        this.dispatchEvent(new Event('audiostart'));
        const event = new Event('result');
        event.resultIndex = 0;
        event.results = [Object.assign([{ transcript: 'hallo welt', confidence: 0.9 }], { isFinal: true })];
        this.dispatchEvent(event);
        this.dispatchEvent(new Event('audioend'));
        this.dispatchEvent(new Event('end'));
      }, 50);
    }
    stop() {}
    abort() {}
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeRecognition;

  // File System Access des Host als Attrappe (Dateien im Speicher)
  const files = new Map([['notiz.txt', 'Hallo Datei'], ['bild.png', 'png']]);
  window.__fakeFiles = files;
  class FakeFile {
    constructor(name) { this.kind = 'file'; this.name = name; }
    async getFile() { return new File([files.get(this.name) ?? ''], this.name, { type: 'text/plain', lastModified: 1000 }); }
    async createWritable() {
      const name = this.name;
      const parts = [];
      return {
        async write(data) { parts.push(typeof data === 'string' ? data : new TextDecoder().decode(data.data ?? data)); },
        async seek() {},
        async truncate() {},
        async close() { files.set(name, parts.join('')); },
        async abort() {},
      };
    }
    async isSameEntry(other) { return other.name === this.name; }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
  }
  class FakeDirectory {
    constructor() { this.kind = 'directory'; this.name = 'ordner'; }
    async getFileHandle(name, options = {}) {
      if (!files.has(name) && !options.create)
        throw new DOMException('Not found', 'NotFoundError');
      if (!files.has(name))
        files.set(name, '');
      return new FakeFile(name);
    }
    async *values() { for (const name of [...files.keys()]) yield new FakeFile(name); }
    async removeEntry(name) { files.delete(name); }
    async queryPermission() { return 'granted'; }
  }
  window.showOpenFilePicker = async () => [new FakeFile('notiz.txt')];
  window.showSaveFilePicker = async (options) => new FakeFile(options?.suggestedName || 'neu.txt');
  window.showDirectoryPicker = async () => new FakeDirectory();

  // Langsame Antwort des Host fuer den Test der verlassenen Seite
  if (typeof ImageDecoder === 'function') {
    const isTypeSupported = ImageDecoder.isTypeSupported.bind(ImageDecoder);
    ImageDecoder.isTypeSupported = (type) => type === 'image/x-langsam'
      ? new Promise((resolve) => setTimeout(() => { window.__slowAnswered = true; resolve(false); }, 2000))
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

await page.goto(stack.app({ url: siteURL }));
check('Seite bereit', (await result('ready', TIMEOUT)) === '1');
check('Touchscreen erkannt (ontouchstart)', (await result('ontouchstart')) === 'true');
check('scheduler.postTask/yield mit Abbruch', (await result('scheduler')) === 'ab+abort', results.get('scheduler'));
check('Canvas-Filter (blur)', (await result('canvasfilter')) === 'blur', results.get('canvasfilter'));
check('moveBefore', (await result('movebefore')) === 'true');
check('navigator.storage.estimate', (await result('estimate')) === 'number');
check('Host-Bruecke unsichtbar, EyeDropper und keyboard.lock da', (await result('hostbridge')) === 'undefined,function,function', results.get('hostbridge'));
check('navigator.connection und deviceMemory', (await result('netinfo')) === 'string,number,true,number', results.get('netinfo'));
check('navigator.getBattery() vom Host', (await result('battery')) === 'number,boolean,true', results.get('battery'));
check('navigator.keyboard.getLayoutMap() vom Host', (await result('keyboardlayout')) === 'map:true', results.get('keyboardlayout'));
check('screen.orientation', (await result('orientation')) === 'landscape-primary', results.get('orientation'));
check('Cache API (put, match, keys)', (await result('cacheapi')) === 'neu:1:true', results.get('cacheapi'));

// 1) Markieren mit der Maus (braucht ENABLE_DRAG_SUPPORT)
await page.mouse.move(...await at(25, 45));
await page.mouse.down();
await page.mouse.move(...await at(200, 45), { steps: 8 });
await page.mouse.move(...await at(380, 45), { steps: 8 });
await page.mouse.up();
const selection = await result('selection', 10000);
check('Markieren mit der Maus', selection && selection.length > 10, JSON.stringify(selection));

// 2) Antippen: Touch-Events gehen an die Seite, daraus wird ein Klick
await page.touchscreen.tap(...await at(100, 130));
check('Touch-Event (touchstart)', (await result('touchstart', 10000)) === '1');
check('Antippen wird Klick', (await result('tapclick', 10000)) === '1');

// 3) Wischen scrollt die Seite (CDP: Finger nach oben ziehen)
const cdp = await context.newCDPSession(page);
const [sx, sy] = await at(600, 500);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] });
for (let i = 1; i <= 10; i++) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx, y: sy - i * 30 }] });
  await page.waitForTimeout(16);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const touchScroll = await result('touchscroll', 10000);
check('Wischen scrollt', Number(touchScroll) > 50, String(touchScroll));
// Schwung auslaufen lassen, dann wieder nach oben
await page.waitForTimeout(2000);
await page.mouse.move(...await at(600, 400));
await page.mouse.wheel(0, -5000);
await page.waitForTimeout(1000);

// 4) Farbschema: der Host wechselt auf dunkel, die Seite merkt es
check('Farbschema hell am Anfang', (await result('dark')) === 'false');
await page.emulateMedia({ colorScheme: 'dark' });
check('Farbschema dunkel kommt an', (await result('darkchange', 10000)) === 'true');

// 5) Standort: Abfrage wie Chrome, nach "Zulassen" kommt die Position
await page.mouse.click(...await at(120, 220));
const prompt = page.locator('#permission-prompt:not([hidden])');
const promptShown = await prompt.waitFor({ timeout: 10000 }).then(() => true, () => false);
check('Standort: Abfrage erscheint', promptShown && /Standort/.test(await prompt.textContent()));
if (promptShown)
  await prompt.locator('button', { hasText: 'Zulassen' }).click();
check('Standort kommt an', (await result('geo', 15000)) === '46.95,7.45', results.get('geo'));

// 6) Benachrichtigungen: Abfrage, danach "granted"
await page.mouse.click(...await at(360, 220));
const notifyPrompt = await prompt.waitFor({ timeout: 10000 }).then(() => true, () => false);
if (notifyPrompt)
  await prompt.locator('button', { hasText: 'Zulassen' }).click();
check('Benachrichtigungen erlaubt', notifyPrompt && (await result('notifypermission', 15000)) === 'granted' && (await result('notifystate')) === 'granted',
  `${results.get('notifypermission')} / ${results.get('notifystate')}`);

// 7) Spracherkennung: Abfrage fuer das Mikrofon, dann Ergebnis vom Host
await page.mouse.click(...await at(600, 220));
const speechPrompt = await prompt.waitFor({ timeout: 10000 }).then(() => true, () => false);
check('Spracherkennung: Abfrage fuer das Mikrofon', speechPrompt && /Mikrofon/.test(await prompt.textContent()));
if (speechPrompt)
  await prompt.locator('button', { hasText: 'Zulassen' }).click();
check('Spracherkennung: Ergebnis kommt an', (await result('speechresult', 15000)) === 'hallo_welt:true:0.9', results.get('speechresult') || results.get('speecherror'));
check('Spracherkennung: start/audio/end', (await result('speechend', 15000)) === 'start+audio', results.get('speechend'));
check('Spracherkennung: Sprache an den Host', (await page.evaluate(() => window.__speechLang)) === 'de-CH');

// 8) File System Access: Datei oeffnen, speichern, Ordner lesen (ueber den Host)
await page.mouse.click(...await at(840, 220));
check('showOpenFilePicker + getFile', (await result('fsopen', 15000)) === 'file:notiz.txt:Hallo_Datei:true', results.get('fsopen') || results.get('fserror'));
check('showDirectoryPicker + entries + getFileHandle(create)', (await result('fsdir', 15000)) === 'bild.png/file,ergebnis.txt/file,notiz.txt/file:neu.txt:true', results.get('fsdir') || results.get('fserror'));
check('showSaveFilePicker + createWritable schreibt beim Host', (await page.evaluate(() => window.__fakeFiles.get('ergebnis.txt'))) === 'Gespeichert aus der Seite');

// 9) Lage und Bewegung: die Oberflaeche reicht die Events des Hosts weiter,
// solange die Seite zuhoert (der Zuhoerer im Host kommt mit etwas Verzoegerung)
for (let i = 0; i < 30 && !(results.has('orient') && results.has('motion')); i++) {
  await page.evaluate(() => {
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 10, beta: 20, gamma: 30 }));
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 }, interval: 16 }));
  });
  await page.waitForTimeout(300);
}
check('deviceorientation kommt an', (await result('orient', 5000)) === '10,20,30', results.get('orient'));
check('devicemotion kommt an', (await result('motion', 5000)) === '10', results.get('motion'));

// 10) Tab mit offener Abfrage schliessen: die Abfrage verschwindet und wird
// nicht gemerkt (web/devices.js forgetTab)
await page.click('#new-tab');
await page.fill('#address', siteURL + '?zweiter-tab');
await page.press('#address', 'Enter');
await page.waitForFunction(() => document.querySelector('#tab-list .tab.active .title')?.textContent === 'Geraete-Test', null, { timeout: 30000 }).catch(() => {});
await page.evaluate(() => window.__blEval('navigator.mediaDevices.getUserMedia({ video: true }).catch(() => {})'));
const cameraPrompt = await prompt.waitFor({ timeout: 10000 }).then(() => true, () => false);
check('Geschlossener Tab: Abfrage fuer die Kamera erscheint', cameraPrompt && /Kamera/.test(await prompt.textContent()));
await page.click('#tab-list .tab.active .close');
const promptGone = await page.locator('#permission-prompt').waitFor({ state: 'hidden', timeout: 5000 }).then(() => true, () => false);
const stored = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('bl-profile-prefs') || '{}').permissions || {}));
check('Geschlossener Tab: Abfrage weg und nicht gemerkt', promptGone && !stored.includes('camera'), stored);

// 11) permissions.query antwortet mit den gemerkten Entscheidungen
// (engine/src/Permissions.cpp); die Kamera ist nach dem geschlossenen Tab
// weiter offen, auch in der Engine
const queryPermissions = () => page.evaluate(() => window.__blEval(`Promise.all(['geolocation', 'notifications', 'microphone', 'camera']
  .map((name) => navigator.permissions.query({ name }).then((s) => s.state, (e) => e.name))).then((states) => console.log('RESULT permissions=' + states.join(',')))`));
await queryPermissions();
check('permissions.query: erlaubt und offen', (await result('permissions', 10000)) === 'granted,granted,granted,prompt', results.get('permissions'));
await page.evaluate(() => window.__blEval('navigator.mediaDevices.getUserMedia({ video: true }).then(() => console.log("RESULT camera=ok"), (e) => console.log("RESULT camera=" + e.name))'));
const cameraAgain = await prompt.waitFor({ timeout: 10000 }).then(() => true, () => false);
check('Kamera: Abfrage kommt wieder (Schliessen war keine Ablehnung)', cameraAgain && /Kamera/.test(await prompt.textContent()));
if (cameraAgain)
  await prompt.locator('button', { hasText: 'Blockieren' }).click();
check('Kamera blockiert: getUserMedia abgelehnt', (await result('camera', 10000)) === 'NotAllowedError', results.get('camera'));
results.delete('permissions');
await queryPermissions();
check('permissions.query: Kamera blockiert', (await result('permissions', 10000)) === 'granted,granted,granted,denied', results.get('permissions'));

// 12) Host-Bruecke: Antwort auf einer ruhigen Seite, Antwort nach dem Verlassen
async function go(address) {
  await page.fill('#address', address);
  await page.press('#address', 'Enter');
}
await go(siteURL + 'hostcall');
check('Host-Aufruf: Promise auf einer ruhigen Seite aufgeloest', (await result('hostsupported', 15000)) === 'true', results.get('hostsupported'));
await go(siteURL + 'weg');
check('Host-Aufruf: Seite verlassen, bevor die Antwort kommt', (await result('danach', 15000))?.trim() === '1');
const linesBefore = results.logs.length;
await page.waitForFunction(() => window.__slowAnswered, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1000);
const lateLines = results.logs.slice(linesBefore).filter((line) => /stale|Uncaught|Exception|Error/.test(line));
check('Host-Aufruf: Antwort fuer die verlassene Seite verfaellt still', await page.evaluate(() => !!window.__slowAnswered)
  && !results.has('stale') && !lateLines.length, lateLines.join(' | '));

await browser.close();
finish();
