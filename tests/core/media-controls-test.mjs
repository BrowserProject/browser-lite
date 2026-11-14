// Keys and the double click of the media controls (patch 0135), like Chrome: a click on a
// <video controls> plays it and focuses it, Space and Enter on the focused element play or pause
// without scrolling the page, a double click on the video enters and leaves fullscreen and leaves
// playback as it was, the arrows, Home and End seek and change the volume of a focused
// <audio controls>, and a key the page prevented stays with the page.
//
//   node tests/core/media-controls-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  load,
  openHost,
  recordClip,
  serve,
  serveBytes,
  startStack,
  timeLimit,
  waitFor,
  wav,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 180000);

const browser = await launch();
const CLIP = await recordClip(browser, 3);
const TONE = wav(30, { rate: 44100 });

// A page taller than the view, so a Space that is not taken scrolls it
const PAGE = `<!doctype html><title>Media controls</title><body style="margin:0;height:3000px;background:#fff">
<video id="video" src="/clip.webm" controls loop muted playsinline style="display:block;width:480px;height:360px"></video>
<audio id="audio" src="/tone.wav" controls preload="auto" style="display:block;width:300px"></audio>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const video = document.getElementById('video');
const audio = document.getElementById('audio');
const counts = {};
const count = (name) => (counts[name] = (counts[name] || 0) + 1);
// paused, the focused element, fullscreen, scrollY
const state = (key) => result(key, [video.paused, document.activeElement && document.activeElement.tagName, document.fullscreenElement === video, scrollY].join(','));
video.addEventListener('loadedmetadata', () => result('videometa', '1'), { once: true });
audio.addEventListener('loadedmetadata', () => result('audiometa', audio.duration.toFixed(1)), { once: true });
audio.addEventListener('seeked', () => result('seeked' + count('seeked'), audio.currentTime.toFixed(2)));
audio.addEventListener('volumechange', () => result('volume' + count('volume'), audio.volume.toFixed(2) + ',' + audio.muted));
// A key the page handles itself: registered before the controls exist
let block = false;
audio.addEventListener('keydown', (e) => {
  if (block)
    e.preventDefault();
});
</script>`;

const { url: siteURL } = await serve((req, res) => {
  const file = { '/clip.webm': [CLIP, 'video/webm'], '/tone.wav': [TONE, 'audio/wav'] }[req.url];
  if (file) serveBytes(req, res, ...file);
  else if (req.url === '/')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  else res.writeHead(404).end();
});

const stack = await startStack();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(page);
const result = (key, timeout = 10000) => results.wait(key, timeout);
const pageEval = (source) => page.evaluate((s) => window.blTest.eval(s), source);

check('host page started a browser', await openHost(page, stack.app({ url: siteURL })));
await load(page, siteURL);
check('video loaded', (await result('videometa', TIMEOUT)) === '1');
check('audio loaded', (await result('audiometa', TIMEOUT)) === '30.0', results.get('audiometa'));
// The controls are made after the first paint (patch 0049)
await page.waitForTimeout(1500);
const origin = await canvasOrigin(page);
const videoMiddle = [origin.x + 240, origin.y + 120];

// ------------------------------------------------------------ video
// The state "paused,focused element,fullscreen,scrollY" once test(state) holds (at most 10 s),
// else the last one: play and pause events alone can come from the host's player as well
let polls = 0;
async function stateWhen(test) {
  let state = null;
  await waitFor(
    async () => {
      const key = `state${++polls}`;
      await pageEval(`state('${key}')`);
      state = await result(key);
      return test(state.split(','));
    },
    10000,
    250,
  );
  return state;
}
const playing = ([paused]) => paused === 'false';
const paused = ([paused]) => paused === 'true';
// The core counts a press within 500 ms at the same place as the next click of a series
const pause = () => page.waitForTimeout(700);

await page.mouse.click(...videoMiddle);
const clicked = await stateWhen(playing);
check('a click plays the video and focuses it', clicked?.startsWith('false,VIDEO,false,'), clicked);
// Long enough to see a pause that a key did not make
await page.waitForTimeout(1500);

await page.keyboard.press(' ');
const spaced = await stateWhen(paused);
check('Space pauses the focused video', spaced?.startsWith('true,VIDEO,'), spaced);
check('Space does not scroll the page', spaced?.endsWith(',0'), spaced);

await page.keyboard.press('Enter');
const entered = await stateWhen(playing);
check('Enter plays it again', entered?.startsWith('false,VIDEO,'), entered);

// The two clicks toggle playback twice (Chrome pauses and plays again), so it plays on
await pause();
await page.mouse.dblclick(...videoMiddle);
const inFullscreen = await stateWhen(([, , fullscreen]) => fullscreen === 'true');
check('a double click enters fullscreen', inFullscreen?.split(',')[2] === 'true', inFullscreen);
await page.waitForTimeout(1000);
const fsPlaying = await stateWhen(playing);
check('the video plays on in fullscreen', fsPlaying?.startsWith('false,VIDEO,true,'), fsPlaying);

const fsBox = await canvasOrigin(page);
const fsSize = page.viewportSize();
await pause();
await page.mouse.dblclick(fsBox.x + fsSize.width / 2, fsBox.y + fsSize.height / 3);
const left = await stateWhen(([, , fullscreen]) => fullscreen === 'false');
check('a double click in fullscreen leaves it', left?.split(',')[2] === 'false', left);
await page.waitForTimeout(1000);
const afterFullscreen = await stateWhen(playing);
check(
  'the video plays on after fullscreen',
  afterFullscreen?.startsWith('false,'),
  afterFullscreen,
);

// ------------------------------------------------------------ audio
await pageEval('audio.focus()');
await page.keyboard.press('End');
check('End seeks to the end', (await result('seeked1')) === '30.00', results.get('seeked1'));
await page.keyboard.press('Home');
check('Home seeks to the start', (await result('seeked2')) === '0.00', results.get('seeked2'));
await page.keyboard.press('ArrowRight');
check(
  'ArrowRight steps by a hundredth of the duration',
  (await result('seeked3')) === '0.30',
  results.get('seeked3'),
);
await page.keyboard.press('ArrowLeft');
check('ArrowLeft steps back', (await result('seeked4')) === '0.00', results.get('seeked4'));
await page.keyboard.press('ArrowDown');
check(
  'ArrowDown lowers the volume',
  (await result('volume1')) === '0.95,false',
  results.get('volume1'),
);
await page.keyboard.press('ArrowUp');
check('ArrowUp raises it', (await result('volume2')) === '1.00,false', results.get('volume2'));

await pageEval('block = true');
await page.keyboard.press('End');
await page.waitForTimeout(1500);
check('a key the page prevented does not seek', !results.get('seeked5'), results.get('seeked5'));

await browser.close();
finish();
