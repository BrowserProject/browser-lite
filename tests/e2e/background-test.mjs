// End-to-End Test fuer Tabs im Hintergrund (WebView::setVisible, web/app.js
// updateVisibility): versteckte Seiten sehen visibilityState 'hidden', rAF und
// CSS-Animationen stehen, setInterval laeuft hoechstens einmal pro Sekunde, die
// Engine malt nicht; mit Ton laufen Ton und Timer weiter. Mit und ohne Compositor.
// Dazu Speicherdruck (die Engine meldet "memory-pressure", die Oberflaeche
// verwirft Hintergrund-Tabs), Haengen nach einer Eingabe und nach einem langen
// Dialog (web/watchdog.js), ein stummes Video im PiP-Fenster laeuft versteckt weiter (und
// sein Tab wird nicht verworfen), ein srcObject-Stream und Ton mit muted auch.
//
//   cd tests/e2e && node background-test.mjs [engine-ordner]
import { SWIFTSHADER, TIMEOUT, VERBOSE, canvasOrigin, check, finish, launch, recordClip, serve, serveBytes, startStack, timeLimit, watchErrors, wav } from './harness.mjs';

timeLimit(TIMEOUT + 300000);

const TONE = wav(60, { amplitude: 4000 });

// Zaehlt rAF und einen Timer (10 ms); beim Verstecken und Zeigen kommt, was
// dazwischen lief. Die CSS-Animation laeuft mit Ebenen im Compositor.
const VISIBILITY_SCRIPT = `
let raf = 0, ticks = 0, mark = null;
const loop = () => { raf++; requestAnimationFrame(loop); };
requestAnimationFrame(loop);
setInterval(() => ticks++, 10);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    mark = { raf, ticks, time: performance.now() };
    console.log('RESULT hidden=' + document.visibilityState);
    return;
  }
  const seconds = (performance.now() - mark.time) / 1000;
  console.log('RESULT shown=' + JSON.stringify({ state: document.visibilityState, raf: raf - mark.raf,
    ticksPerSecond: Math.round((ticks - mark.ticks) / seconds), seconds: Math.round(seconds * 10) / 10 }));
});
`;
const PAGES = {
  bewegt: `<!doctype html><title>bewegt</title><style>body{margin:0;background:#fff}
#box{position:absolute;left:0;top:0;width:100px;height:100px;background:#e00;animation:move 0.6s linear infinite alternate;will-change:transform}
@keyframes move{to{transform:translateX(400px)}}</style><div id="box"></div>
<script>${VISIBILITY_SCRIPT}console.log('RESULT loaded=' + document.visibilityState)</script>`,
  ton: `<!doctype html><title>ton</title><audio src="/ton.wav" loop></audio>
<script>${VISIBILITY_SCRIPT}console.log('RESULT loaded=' + document.visibilityState)</script>`,
  leer: '<!doctype html><title>leer</title><p>leer<script>console.log("RESULT loaded=leer")</script>',
  // Schleife im mousedown: blockiert den Engine-Thread, bis der Watchdog sie abbricht
  klemmt: `<!doctype html><title>klemmt</title><body style="margin:0"><div style="width:400px;height:300px;background:#cde"></div>
<script>document.body.onmousedown = () => { if (location.hash === '#los') for (;;); };
addEventListener('pagehide', () => console.log('RESULT gone=klemmt'));
console.log('RESULT loaded=klemmt')</script>`,
  // alert aus keydown, danach noch etwas Arbeit
  dialog: `<!doctype html><title>dialog</title><body style="margin:0"><div style="width:400px;height:300px;background:#cde"></div>
<script>document.onkeydown = (e) => { if (e.key !== 'a') return; alert('hallo'); const end = Date.now() + 300; while (Date.now() < end); console.log('RESULT alerted=1'); };
console.log('RESULT loaded=dialog')</script>`,
  // Stummes Video (ohne Tonspur), ein Klick schickt es ins PiP-Fenster
  pip: `<!doctype html><title>pip</title><body style="margin:0"><video src="/clip.webm" muted loop autoplay playsinline style="display:block;width:400px;height:300px"></video>
<script>const video = document.querySelector('video');
video.onplaying = () => console.log('RESULT playing=' + document.visibilityState);
video.onpause = () => console.log('RESULT pause=' + document.visibilityState);
document.onclick = () => video.requestPictureInPicture().then(() => console.log('RESULT pip=ok'), (e) => console.log('RESULT pip=' + e.name));
document.addEventListener('visibilitychange', () => console.log('RESULT state=' + document.visibilityState));
console.log('RESULT loaded=pip')</script>`,
  // Stumm, aber kein reines Video: srcObject-Stream (wie eine Videokonferenz) und Ton mit muted
  strom: `<!doctype html><title>strom</title><canvas width="64" height="64"></canvas><video muted playsinline></video><audio src="/ton.wav" muted loop></audio>
<script>const canvas = document.querySelector('canvas');
const context = canvas.getContext('2d');
let frame = 0;
setInterval(() => { context.fillStyle = frame++ % 2 ? '#f00' : '#00f'; context.fillRect(0, 0, 64, 64); }, 100);
const video = document.querySelector('video');
const audio = document.querySelector('audio');
video.srcObject = canvas.captureStream(10);
video.onpause = () => console.log('RESULT pause=video');
audio.onpause = () => console.log('RESULT pause=audio');
Promise.all([video.play(), audio.play()]).then(() => console.log('RESULT playing=strom'), (e) => console.log('RESULT playing=' + e.name));
document.addEventListener('visibilitychange', () => console.log('RESULT state=' + document.visibilityState + ':' + video.paused + ':' + audio.paused));
</script>`,
  // Fuer den Speicherdruck: meldet, wenn der Tab verworfen wird
  speicher: `<!doctype html><title>speicher</title><p>speicher<script>const name = location.search.slice(1);
addEventListener('pagehide', () => console.log('RESULT gone=' + name));
console.log('RESULT loaded=' + name)</script>`,
};
const browser = await launch({ args: [...SWIFTSHADER, '--autoplay-policy=no-user-gesture-required'] });
const MEDIA = { '/ton.wav': [TONE, 'audio/wav'], '/clip.webm': [await recordClip(browser, 4), 'video/webm'] };
const { url: siteURL } = await serve((req, res) => {
  if (MEDIA[req.url])
    return serveBytes(req, res, ...MEDIA[req.url]);
  const page = PAGES[new URL(req.url, siteURL).pathname.slice(1)];
  if (!page)
    return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page);
});

const stack = await startStack({ token: 'background-token-0123456789ab' });

// Oberflaeche in einem neuen Kontext; results: [viewId, key, value] in der Reihenfolge
async function openApp(params) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  const results = [];
  watchErrors(page);
  page.on('console', (msg) => {
    const text = msg.text();
    if (VERBOSE)
      console.log('   ', text);
    const match = /\[page (\d+)\] RESULT (\w+)=(\S*)/.exec(text);
    if (match)
      results.push([Number(match[1]), match[2], match[3]]);
  });
  const wait = async (key, value = null, ms = 30000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      const found = results.find((r) => r[1] === key && (value === null || r[2] === value));
      if (found) {
        results.splice(results.indexOf(found), 1);
        return found;
      }
    }
    return null;
  };
  await page.goto(stack.app(params));
  await page.waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: TIMEOUT });
  const go = async (address) => {
    await page.click('#address');
    await page.fill('#address', address);
    await page.press('#address', 'Enter');
  };
  // Neuer Tab im Vordergrund mit Adresse; der vorige kommt in den Hintergrund
  const newTab = async (address) => {
    await page.click('#new-tab');
    await go(address);
  };
  const selectTab = (index) => page.click(`#tab-list .tab:nth-child(${index}) .title`);
  return { context, page, results, wait, go, newTab, selectTab };
}

// Bild-Wuensche der Engine je View (Module.onEngineNeedsFrame, engine/src/Host.cpp)
const countFrames = (page) => page.evaluate(() => {
  const engine = window.blTest.browser.debug.module;
  if (!engine.blFrameCount) {
    const original = engine.onEngineNeedsFrame;
    engine.blFrameCount = {};
    engine.onEngineNeedsFrame = (id) => {
      engine.blFrameCount[id] = (engine.blFrameCount[id] || 0) + 1;
      original(id);
    };
  }
  return { ...engine.blFrameCount };
});

// Lage der roten Box in einer Zeile der sichtbaren Seite
const boxRow = (page) => page.evaluate(() => window.blTest.pageRow(50).findIndex(([r, g, b]) => r > 200 && g < 80 && b < 80));

async function visibility(label, params) {
  const app = await openApp({ url: siteURL + 'bewegt', ...params });
  const loaded = await app.wait('loaded');
  check(`${label}: Seite im Vordergrund sichtbar`, loaded?.[2] === 'visible', JSON.stringify(loaded));
  const viewId = loaded?.[0];
  await countFrames(app.page);
  await app.page.waitForTimeout(1000);
  const visibleFrames = (await countFrames(app.page))[viewId] || 0;
  check(`${label}: sichtbar malt die Engine`, visibleFrames > 5, `${visibleFrames} Bilder in 1 s`);

  await app.newTab(siteURL + 'leer');
  const hidden = await app.wait('hidden');
  check(`${label}: Hintergrund-Tab bekommt visibilitychange, hidden`, hidden?.[0] === viewId && hidden?.[2] === 'hidden', JSON.stringify(hidden));
  await app.wait('loaded', 'leer');
  await app.page.waitForTimeout(300);
  const before = (await countFrames(app.page))[viewId] || 0;
  await app.page.waitForTimeout(2500);
  const hiddenFrames = ((await countFrames(app.page))[viewId] || 0) - before;
  check(`${label}: versteckt malt die Engine nicht`, hiddenFrames === 0, `${hiddenFrames} Bilder in 2.5 s`);
  // Das Canvas des versteckten Tabs nur in der Oberflaeche zeigen: auch der
  // Compositor bewegt die Box (Animation auf der GPU) nicht mehr
  const hiddenRows = await app.page.evaluate(async () => {
    const canvas = document.querySelectorAll('canvas[data-bl-view]')[0];
    canvas.style.display = 'block';
    const rows = [];
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const probe = new OffscreenCanvas(canvas.width, canvas.height);
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0);
      const data = ctx.getImageData(0, Math.round(50 * canvas.height / canvas.clientHeight), canvas.width, 1).data;
      let x = -1;
      for (let p = 0; p < data.length && x < 0; p += 4) {
        if (data[p] > 200 && data[p + 1] < 80 && data[p + 2] < 80)
          x = p / 4;
      }
      rows.push(x);
    }
    canvas.style.display = 'none';
    return rows;
  });
  check(`${label}: versteckt steht auch das Bild des Compositors`, new Set(hiddenRows).size === 1 && hiddenRows[0] >= 0, JSON.stringify(hiddenRows));

  // Tab des Host verdeckt: auch der aktive Tab ist versteckt
  await app.page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await app.selectTab(1);
  await app.page.waitForTimeout(800);
  const stillHidden = !app.results.some((r) => r[0] === viewId && r[1] === 'shown');
  await app.page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const shown = await app.wait('shown');
  const state = shown ? JSON.parse(shown[2]) : {};
  check(`${label}: Host verdeckt: Tab bleibt versteckt, dann sichtbar`, stillHidden && shown?.[0] === viewId && state.state === 'visible', JSON.stringify(state));
  check(`${label}: versteckt kein rAF`, state.raf <= 1, `${state.raf} rAF in ${state.seconds} s`);
  check(`${label}: versteckt setInterval hoechstens etwa 1/s`, state.seconds >= 2.5 && state.ticksPerSecond <= 3, `${state.ticksPerSecond}/s`);
  // Wieder zu sehen: die Engine (bzw. der Compositor) malt die Animation weiter
  await app.page.waitForTimeout(500);
  const positions = new Set();
  for (let i = 0; i < 6; i++) {
    positions.add(await boxRow(app.page));
    await app.page.waitForTimeout(150);
  }
  check(`${label}: wieder sichtbar: Animation laeuft`, positions.size >= 3 && !positions.has(-1), JSON.stringify([...positions]));

  // Mit Ton: Ton und Timer laufen im Hintergrund weiter
  await app.go(siteURL + 'ton');
  const tonLoaded = await app.wait('loaded');
  await app.page.evaluate(() => window.blTest.eval('document.querySelector("audio").play().then(() => console.log("RESULT play=ok"), (e) => console.log("RESULT play=" + e.name))'));
  const play = await app.wait('play');
  const audible = await app.page.waitForFunction(() => !document.querySelector('#tab-list .tab.active .audio').hidden, null, { timeout: 15000 }).then(() => true, () => false);
  check(`${label}: Ton spielt`, play?.[2] === 'ok' && audible, JSON.stringify(play));
  await app.selectTab(2);
  check(`${label}: Tab mit Ton im Hintergrund versteckt`, (await app.wait('hidden'))?.[0] === tonLoaded?.[0]);
  const playerTime = () => app.page.evaluate(() => window.blTest.mediaState().map((p) => [p.time, p.paused]));
  const timeBefore = await playerTime();
  await app.page.waitForTimeout(3000);
  const timeAfter = await playerTime();
  check(`${label}: Ton laeuft im Hintergrund weiter`, timeAfter.length === 1 && !timeAfter[0][1] && timeAfter[0][0] - timeBefore[0][0] > 2,
    `${JSON.stringify(timeBefore)} -> ${JSON.stringify(timeAfter)}`);
  await app.selectTab(1);
  const tonShown = await app.wait('shown');
  const tonState = tonShown ? JSON.parse(tonShown[2]) : {};
  check(`${label}: mit Ton Timer nicht gedrosselt`, tonState.ticksPerSecond > 20, `${tonState.ticksPerSecond}/s`);
  await app.context.close();
}

await visibility('Compositor', {});
await visibility('Ohne Compositor', { compositing: '0' });

// Speicherdruck: ueber der Grenze meldet die Engine bei jedem Wachstum um 32 MB,
// die Oberflaeche verwirft je den am laengsten nicht benutzten Hintergrund-Tab.
// Die Grenze liegt knapp ueber dem Speicher einer gleichen Sitzung ohne Druck.
async function memorySession(params) {
  const app = await openApp({ url: siteURL + 'speicher?eins', ...params });
  await app.wait('loaded', 'eins');
  await app.newTab(siteURL + 'speicher?zwei');
  await app.wait('loaded', 'zwei');
  await app.newTab(siteURL + 'speicher?drei');
  await app.wait('loaded', 'drei');
  await app.page.waitForTimeout(1000);
  return app;
}
const probe = await memorySession({});
const baseMB = Math.ceil(await probe.page.evaluate(() => window.blTest.memory()) / 2 ** 20);
await probe.context.close();
const app = await memorySession({ env: `BL_MEMORY_PRESSURE_MB=${baseMB + 96}` });
check('Speicherdruck: vorher kein Tab verworfen', !app.results.some((r) => r[1] === 'gone'), `Grenze ${baseMB + 96} MB`);
const allocate = (mb) => app.page.evaluate((size) => window.blTest.eval(`(window.big ||= []).push(new Uint8Array(${size} << 20).fill(1)); console.log("RESULT allocated=" + big.length)`), mb);
const gone = [];
for (let i = 0; i < 12 && gone.length < 2; i++) {
  await allocate(64);
  await app.wait('allocated');
  await app.page.waitForTimeout(500);
  for (let found; (found = await app.wait('gone', null, 10));)
    gone.push(found[2]);
}
check('Speicherdruck: beide Hintergrund-Tabs verworfen, der aelteste zuerst', gone.join() === 'eins,zwei', gone.join());
await allocate(64);
await app.page.waitForTimeout(1000);
const titles = await app.page.locator('#tab-list .tab .title').allTextContents();
check('Speicherdruck: aktiver Tab bleibt, Titel der verworfenen bleiben', !(await app.wait('gone', null, 500)) && titles.join() === 'speicher,speicher,speicher', titles.join());
await app.selectTab(1);
check('Speicherdruck: verworfener Tab laedt beim Anklicken', !!(await app.wait('loaded', 'eins')));
await app.context.close();

// Haengen nach einer Eingabe: der Engine-Thread schliesst keine Aufgabe mehr ab
const hang = await openApp({ url: siteURL + 'klemmt', env: 'BL_SCRIPT_TIMEOUT=20' });
await hang.wait('loaded', 'klemmt');
const origin = await canvasOrigin(hang.page);
const boot = () => hang.page.evaluate(() => (document.getElementById('boot').hidden ? '' : document.getElementById('boot').textContent));
await hang.page.mouse.click(origin.x + 100, origin.y + 100);
await hang.page.waitForTimeout(11500);
check('Klick ohne Haengen: keine Meldung', (await boot()) === '', await boot());
await hang.page.evaluate(() => window.blTest.eval('location.hash = "los"'));
await hang.page.waitForTimeout(500);
const clicked = Date.now();
await hang.page.mouse.click(origin.x + 100, origin.y + 100);
const shownHang = await hang.page.waitForFunction(() => document.getElementById('boot').textContent.includes('not responding') && !document.getElementById('boot').hidden,
  null, { timeout: 14000 }).then(() => true, () => false);
check('Klick in eine haengende Seite: Meldung nach 10 s', shownHang && Date.now() - clicked >= 9500, `${Date.now() - clicked} ms, ${await boot()}`);
const recovered = await hang.page.waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: 15000 }).then(() => true, () => false);
check('Haengen nach Klick: Meldung geht, sobald der Watchdog abbricht', recovered);

await hang.context.close();

// Ein Dialog haelt den Haupt-Thread der Oberflaeche an: die Zeit bis zur Antwort
// zaehlt nicht als Haengen, auch wenn die Eingabe noch offen ist
const dialog = await openApp({ url: siteURL + 'dialog' });
await dialog.wait('loaded', 'dialog');
let alerts = 0;
dialog.page.on('dialog', async (d) => {
  if (d.type() !== 'alert')
    return d.dismiss();
  alerts++;
  await new Promise((r) => setTimeout(r, 12000));
  await d.accept();
});
await dialog.page.evaluate(() => {
  window.blHangSeen = 0;
  const box = document.getElementById('boot');
  new MutationObserver(() => {
    if (!box.hidden && box.textContent.includes('not responding'))
      window.blHangSeen++;
  }).observe(box, { attributes: true, childList: true, subtree: true, characterData: true });
});
const dialogOrigin = await canvasOrigin(dialog.page);
await dialog.page.mouse.click(dialogOrigin.x + 100, dialogOrigin.y + 100);
await dialog.page.waitForTimeout(500);
dialog.page.keyboard.press('a').catch(() => {});
const alerted = await dialog.wait('alerted', null, 30000);
await dialog.page.waitForTimeout(2500);
const hangSeen = await dialog.page.evaluate(() => window.blHangSeen);
check('Langer alert nach Taste: keine Meldung "not responding"', alerts === 1 && !!alerted && hangSeen === 0, `${alerts} Dialoge, Meldung ${hangSeen}x`);
await dialog.context.close();

// Stumm im Hintergrund wie Chrome: ein srcObject-Stream und Ton mit muted laufen weiter
// (angehalten wird nur Video ohne Tonspur)
const muted = await openApp({ url: siteURL + 'strom' });
check('Stumm: Stream und Ton spielen', (await muted.wait('playing'))?.[2] === 'strom');
// Nur, was ab hier kommt (am Anfang meldet stumme Wiedergabe kurz pause, siehe docs/status.md)
await muted.page.waitForTimeout(1000);
muted.results.length = 0;
await muted.newTab(siteURL + 'leer');
const mutedHidden = await muted.wait('state');
await muted.page.waitForTimeout(2000);
const mutedPaused = muted.results.filter((r) => r[1] === 'pause').map((r) => r[2]);
check('Stumm: Stream und Ton laufen im Hintergrund weiter', mutedHidden?.[2] === 'hidden:false:false' && !mutedPaused.length,
  `${JSON.stringify(mutedHidden)} angehalten: ${mutedPaused}`);
await muted.context.close();

// Stummes Video im PiP-Fenster: WebKit haelt stumme Wiedergabe versteckter
// Seiten an, das Video im PiP-Fenster ist aber zu sehen (wie in Chrome)
const pip = await openApp({ url: siteURL + 'pip' });
await pip.wait('loaded', 'pip');
check('PiP: stummes Video spielt', !!(await pip.wait('playing', 'visible')));
const pipOrigin = await canvasOrigin(pip.page);
await pip.page.mouse.click(pipOrigin.x + 100, pipOrigin.y + 100);
const entered = await pip.wait('pip');
const hostPip = await pip.page.evaluate(() => !!document.pictureInPictureElement);
check('PiP: Video im PiP-Fenster', entered?.[2] === 'ok' && hostPip, JSON.stringify(entered));
// Nur, was ab hier kommt (Autoplay meldet am Anfang auch pause)
pip.results.length = 0;
await pip.newTab(siteURL + 'leer');
check('PiP: Tab im Hintergrund versteckt', !!(await pip.wait('state', 'hidden')));
const pipBefore = await pip.page.evaluate(() => window.blTest.mediaState().map((p) => p.time));
await pip.page.waitForTimeout(3000);
const pipAfter = await pip.page.evaluate(() => window.blTest.mediaState().map((p) => [p.time, p.paused]));
const paused = pip.results.find((r) => r[1] === 'pause');
check('PiP: Video laeuft im Hintergrund weiter', !paused && pipAfter.length === 1 && !pipAfter[0][1] && pipAfter[0][0] !== pipBefore[0],
  `${JSON.stringify(paused)} ${JSON.stringify(pipBefore)} -> ${JSON.stringify(pipAfter)}`);
// Speicherdruck: der Tab mit dem PiP-Fenster ist der aelteste, verworfen wird trotzdem ein anderer
await pip.newTab(siteURL + 'speicher?neu');
await pip.wait('loaded', 'neu');
const discarded = await pip.page.evaluate(() => window.blTest.checkMemory());
const pipTitles = await pip.page.locator('#tab-list .tab .title').allTextContents();
check('Speicherdruck: Tab mit PiP-Fenster bleibt', discarded > 0 && await pip.page.evaluate(() => !!document.pictureInPictureElement) && !pip.results.some((r) => r[1] === 'pause'),
  `verworfen ${discarded}, Tabs ${pipTitles}`);
await pip.page.evaluate(() => document.exitPictureInPicture().catch(() => {}));
await pip.context.close();

await browser.close();
finish();
