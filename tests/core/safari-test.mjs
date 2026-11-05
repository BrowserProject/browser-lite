// The paths of the core for iPhone Safari 18, forced in Chromium: before the start the test gives
// the host an iPhone user agent and removes what Safari lacks on the main thread (MediaSource,
// which iPhone Safari has only as ManagedMediaSource, MediaStreamTrackProcessor,
// requestIdleCallback, navigator.virtualKeyboard). Checks MSE through the ManagedMediaSource path,
// the microphone through the AudioWorklet of the capture (no AudioData), and the on-screen keyboard
// modes and enter key hints of the IME field ("text-input"). Video capture
// without a main thread processor transfers the track to the engine worker, which Chromium
// cannot; that path is checked on devices (docs/status.md).
//
//   node tests/core/safari-test.mjs [engine-dir]
import {
  chromiumOnly,
  SWIFTSHADER,
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  openHost,
  recordClip,
  serve,
  serveBytes,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit();
// The Safari paths are forced in Chromium (Firefox has its own suite run)
if (!chromiumOnly('the Safari 18 paths (forced in Chromium)')) {
  finish();
  process.exit(0);
}

const PAGE = `<!doctype html><title>Safari paths</title>
<style>body { margin: 0 } input, button { position: absolute; left: 20px; width: 200px; height: 30px }</style>
<input id="text" style="top: 20px" enterkeyhint="send">
<input id="number" type="number" style="top: 70px">
<input id="numeric" inputmode="numeric" style="top: 120px">
<div id="editable" contenteditable style="position: absolute; left: 20px; top: 170px; width: 200px; height: 30px; border: 1px solid"></div>
<button id="plain" style="top: 220px">plain</button>
<button id="mic" style="top: 270px">microphone</button>
<input id="jump" style="top: 320px">
<input id="overlay" style="top: 370px">
<video id="video" muted playsinline style="position:absolute;left:300px;top:20px;width:320px;height:240px"></video>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + String(value).replace(/\\s/g, '_'));
// Like Google's search box: focusing it opens an overlay with another field that takes the focus
document.getElementById('jump').addEventListener('focus', (e) => setTimeout(() => { e.target.blur(); setTimeout(() => document.getElementById('overlay').focus(), 20); }, 10));
document.getElementById('text').addEventListener('keydown', (e) => { if (e.key === 'Enter') location.href = '/next'; });
const type = 'video/webm; codecs="vp8"';
result('msesupported', MediaSource.isTypeSupported(type));
const video = document.getElementById('video');
const source = new MediaSource();
video.src = URL.createObjectURL(source);
source.addEventListener('sourceopen', async () => {
  const data = new Uint8Array(await (await fetch('/clip.webm')).arrayBuffer());
  const buffer = source.addSourceBuffer(type);
  await new Promise((resolve) => { buffer.addEventListener('updateend', resolve, { once: true }); buffer.appendBuffer(data); });
  source.endOfStream();
  video.addEventListener('timeupdate', () => {
    if (video.currentTime > 1.2) result('msetime', video.currentTime.toFixed(1));
  });
  video.play().then(() => result('mseplay', 'ok'), (e) => result('mseplay', e.name));
});
document.getElementById('mic').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    audioContext.createMediaStreamSource(stream).connect(analyser);
    await audioContext.resume();
    let peak = 0;
    for (let i = 0; i < 50 && peak < 0.01; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      for (const value of samples) peak = Math.max(peak, Math.abs(value));
    }
    result('micpeak', peak > 0.01 ? 'sound' : 'silent' + peak);
    stream.getTracks().forEach((track) => track.stop());
  } catch (e) {
    result('micpeak', e.name + ':' + e.message);
  }
});
</script>`;

const browser = await launch({
  args: [
    ...SWIFTSHADER,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const CLIP = await recordClip(browser, 3);
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/clip.webm') serveBytes(req, res, CLIP, 'video/webm');
  else if (req.url === '/next')
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Next</title>');
  else res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack({ token: 'safari-token-0123456789abcdef' });
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  permissions: ['microphone'],
});
await context.addInitScript(() => {
  const scope = /** @type {Record<string, unknown>} */ (window);
  scope.ManagedMediaSource = scope.MediaSource;
  delete scope.MediaSource;
  delete scope.MediaStreamTrackProcessor;
  delete scope.requestIdleCallback;
  delete Object.getPrototypeOf(navigator).virtualKeyboard;
  Object.defineProperty(navigator, 'userAgent', {
    value:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  });
});
const page = await context.newPage();
const results = collect(page);
const result = (key, ms = TIMEOUT) => results.wait(key, ms);

check('starts without the Safari gaps', await openHost(page, stack.app({ url: siteURL })));
await page.evaluate(() => {
  window.blHost.permissionAnswer = 'grant';
});

// MSE through ManagedMediaSource (the engine asks it for the types, the host element plays)
check(
  'MSE: type supported',
  (await result('msesupported')) === 'true',
  results.get('msesupported'),
);
check('MSE: play()', (await result('mseplay')) === 'ok', results.get('mseplay'));
const mseTime = Number(await result('msetime'));
check('MSE: time runs', mseTime > 1, String(mseTime));
check(
  'MSE: host element without remote playback (needed by ManagedMediaSource)',
  await page.evaluate(() =>
    // In the media container or behind the view canvas (video overlay, #232)
    [...document.querySelectorAll('video')].some(
      (video) => video.disableRemotePlayback && video.src.startsWith('blob:'),
    ),
  ),
);

// On-screen keyboard: the IME field follows the focused field of the page
const box = await canvasOrigin(page);
const imeMode = () =>
  page.evaluate(() => {
    const ime = document.querySelector('[data-bl-ime]');
    return `${ime.inputMode}/${ime.enterKeyHint}`;
  });
const tapAndMode = async (y, expected) => {
  await page.mouse.click(box.x + 120, box.y + y);
  let mode = '';
  await waitFor(async () => (mode = await imeMode()) === expected, 10000);
  return mode;
};
// iOS gives the keyboard the enter key hint only at a focus: the IME field, focused since the
// tap, is focused again once the page field's hint differs from the one of its last focus
const imeFocus = () =>
  page.evaluate(() => {
    const ime = document.querySelector('[data-bl-ime]');
    const focus = window.imeFocus;
    window.imeFocus = [];
    return {
      focus,
      active: document.activeElement === ime,
      fields: document.querySelectorAll('textarea').length,
    };
  });
await page.evaluate(() => {
  const ime = document.querySelector('[data-bl-ime]');
  window.imeFocus = [];
  ime.addEventListener('focus', () => window.imeFocus.push(`${ime.inputMode}/${ime.enterKeyHint}`));
});
check('keyboard: none before a field', (await imeMode()) === 'none/', await imeMode());
let mode = await tapAndMode(35, 'text/send');
check('keyboard: text field with enterkeyhint', mode === 'text/send', mode);
let focus = await imeFocus();
check(
  'keyboard (iOS): the IME field is focused again with the enter key hint',
  focus.focus.at(-1) === 'text/send' && focus.active && focus.fields === 1,
  JSON.stringify(focus),
);
mode = await tapAndMode(85, 'decimal/');
check('keyboard: number field', mode === 'decimal/', mode);
focus = await imeFocus();
check(
  'keyboard (iOS): focused again for a field without a hint after one with a hint',
  focus.focus.at(-1) === 'decimal/' && focus.active,
  JSON.stringify(focus),
);
mode = await tapAndMode(135, 'numeric/');
check('keyboard: inputmode numeric', mode === 'numeric/', mode);
focus = await imeFocus();
check(
  'keyboard (iOS): not focused again while the hint stays',
  focus.focus.length === 0 && focus.active,
  JSON.stringify(focus),
);
mode = await tapAndMode(185, 'text/');
check('keyboard: contenteditable', mode === 'text/', mode);
mode = await tapAndMode(235, 'none/');
check('keyboard: none after a button', mode === 'none/', mode);

// Focus that moves from one field to another passes through none: the keyboard stays (Android
// would close it and not open it again without a new tap)
await page.evaluate(() => {
  const ime = document.querySelector('[data-bl-ime]');
  window.imeModes = [];
  new MutationObserver(() => window.imeModes.push(ime.inputMode)).observe(ime, {
    attributeFilter: ['inputmode'],
  });
});
mode = await tapAndMode(335, 'text/');
await page.waitForTimeout(1000);
const modes = await page.evaluate(() => window.imeModes);
check(
  'keyboard: stays open while the focus moves to another field',
  mode === 'text/' && modes.length > 0 && !modes.includes('none') && (await imeMode()) === 'text/',
  JSON.stringify(modes),
);
mode = await tapAndMode(235, 'none/');

// Microphone without MediaStreamTrackProcessor and AudioData: AudioWorklet to the engine
await page.mouse.click(box.x + 120, box.y + 285);
const micPeak = await result('micpeak');
check('microphone through the AudioWorklet', micPeak === 'sound', micPeak);

// Enter in a search field loads the results: the keyboard closes with the old page
mode = await tapAndMode(35, 'text/send');
await page.keyboard.press('Enter');
await waitFor(async () => (mode = await imeMode()) === 'none/', 10000);
check('keyboard: none after the page with the field is gone', mode === 'none/', mode);

await browser.close();
finish();
