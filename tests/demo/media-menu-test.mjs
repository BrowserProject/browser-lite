// The media items of the context menu like Chrome: a right click on a <video> (also on its
// controls) offers Loop and Show controls to check, Open video in new tab, Save video as, Copy
// video address and, where the host browser has it, Picture in picture. They change the element
// as the page's own script would: the attributes change, the video goes into the host's window and
// out again with the page's events, past a requestPictureInPicture the page replaced. Save video as
// downloads the file, Copy video address puts the address on the clipboard. An <audio> gets the
// audio texts, Show controls disabled and no Picture in picture.
//
//   node tests/demo/media-menu-test.mjs [engine-dir]
import { readFileSync } from 'node:fs';
import {
  BROWSER,
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  recordClip,
  screenshot,
  serve,
  serveBytes,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
  wav,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 180000);

const browser = await launch();
const CLIP = await recordClip(browser, 2);
const TONE = wav(5, { rate: 44100 });

const PAGE = `<!doctype html><title>Media menu</title>
<style>
body { margin: 0 }
#video { position: absolute; left: 20px; top: 40px; width: 480px; height: 270px; background: #333 }
#audio { position: absolute; left: 20px; top: 360px; width: 300px }
</style>
<video id="video" src="/clip.webm" controls muted playsinline></video>
<audio id="audio" src="/tone.wav" controls preload="auto"></audio>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const video = document.getElementById('video');
let changes = 0;
new MutationObserver(() => result('attributes' + ++changes, [video.loop, video.controls].join(',')))
  .observe(video, { attributes: true, attributeFilter: ['loop', 'controls'] });
video.addEventListener('enterpictureinpicture', () => result('pip', 'enter,' + (document.pictureInPictureElement === video)));
video.addEventListener('leavepictureinpicture', () => result('pipleave', String(document.pictureInPictureElement === null)));
// The menu goes past what the page put in place, like Chrome's
HTMLVideoElement.prototype.requestPictureInPicture = () => Promise.reject(new Error('the page'));
video.addEventListener('loadedmetadata', () => result('ready', '1'), { once: true });
</script>`;

const { url: siteURL } = await serve((req, res) => {
  const file = { '/clip.webm': [CLIP, 'video/webm'], '/tone.wav': [TONE, 'audio/wav'] }[req.url];
  if (file) serveBytes(req, res, ...file);
  else if (req.url === '/')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  else res.writeHead(404).end();
});
const VIDEO_URL = new URL('/clip.webm', siteURL).href;
const AUDIO_URL = new URL('/tone.wav', siteURL).href;

const stack = await startStack({ app: 'demo', token: 'media-menu-token-0123456789abcdef' });
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  acceptDownloads: true,
});
// The texts the menu writes to the host clipboard
await context.addInitScript(() => {
  window.blCopied = [];
  const writeText = Clipboard.prototype.writeText;
  Clipboard.prototype.writeText = function (text) {
    window.blCopied.push(text);
    return writeText.call(this, text).catch(() => {});
  };
});
const page = await context.newPage();
watchErrors(page);
const results = collect(page);
await page.goto(stack.app({ url: siteURL }));
check('video loaded', (await results.wait('ready', TIMEOUT)) === '1');
// The controls are made after the first paint
await page.waitForTimeout(1500);
const hostDownloads = [];
page.on('download', (download) => hostDownloads.push(download));
const hostPip = await page.evaluate(
  () => 'requestPictureInPicture' in HTMLVideoElement.prototype && document.pictureInPictureEnabled,
);

const box = await canvasOrigin(page);
const VIDEO_POINT = [box.x + 260, box.y + 110];
const AUDIO_POINT = [box.x + 60, box.y + 375];
const openMenu = async ([x, y]) => {
  await page.mouse.click(x, y, { button: 'right' });
  return page
    .waitForSelector('.bl-context-menu', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
};
const rows = () =>
  page
    .locator('.bl-context-menu .bl-menu-item')
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        [
          node.dataset.blItem,
          node.textContent,
          node.getAttribute('aria-checked') ?? '',
          node.disabled ? 'disabled' : '',
        ].join(':'),
      ),
    );
const item = (id) => page.locator(`.bl-context-menu button[data-bl-item=${id}]`);
const choose = async (point, id) => {
  if (!(await openMenu(point))) return false;
  await item(id).click();
  return true;
};

check('right click on the video: menu', await openMenu(VIDEO_POINT));
const videoRows = await rows();
check(
  'video: the media items of Chrome in its order',
  videoRows.slice(0, hostPip ? 6 : 5).join('|') ===
    [
      'loop:Loop:false:',
      'show-controls:Show controls:true:',
      'open-media:Open video in new tab::',
      'save-media:Save video as…::',
      'copy-media-address:Copy video address::',
      ...(hostPip ? ['picture-in-picture:Picture in picture:false:'] : []),
    ].join('|'),
  videoRows.join(' | '),
);
check(
  hostPip ? 'video: Picture in picture once' : 'video: no Picture in picture without the host API',
  videoRows.filter((row) => row.startsWith('picture-in-picture:')).length === (hostPip ? 1 : 0),
  videoRows.join(' | '),
);
await screenshot(page, 'media-menu');

// Loop and Show controls change the attributes like the page's script would
await item('loop').click();
check('Loop: the video loops', (await results.wait('attributes1', 10000)) === 'true,true');
check('right click again', await openMenu(VIDEO_POINT));
check(
  'Loop is checked now',
  (await item('loop').getAttribute('aria-checked')) === 'true',
  (await rows()).join(' | '),
);
await item('show-controls').click();
check(
  'Show controls: the controls go',
  (await results.wait('attributes2', 10000)) === 'true,false',
  results.get('attributes2'),
);
check('Show controls again', await choose(VIDEO_POINT, 'show-controls'));
check(
  'Show controls: the controls are back',
  (await results.wait('attributes3', 10000)) === 'true,true',
  results.get('attributes3'),
);
await page.waitForTimeout(500);

// Copy video address: the address on the host clipboard
check('Copy video address', await choose(VIDEO_POINT, 'copy-media-address'));
await waitFor(async () => (await page.evaluate(() => window.blCopied.length)) > 0, 10000);
const copied = await page.evaluate(() => window.blCopied.at(-1));
check('Copy video address: the address of the video', copied === VIDEO_URL, copied);

// Save video as: the file reaches the host
check('Save video as', await choose(VIDEO_POINT, 'save-media'));
await waitFor(() => hostDownloads.length > 0, 20000);
const file = hostDownloads[0];
const bytes = file ? readFileSync(await file.path()) : null;
check(
  'Save video as: the file with the bytes of the video',
  file?.suggestedFilename() === 'clip.webm' && !!bytes && Buffer.compare(bytes, CLIP) === 0,
  `${file?.suggestedFilename()} ${bytes?.length} bytes`,
);

// Open video in new tab: a tab with the address of the video
const tabsBefore = await page.evaluate(() => window.blTest.views().length);
check('Open video in new tab', await choose(VIDEO_POINT, 'open-media'));
let tabURLs = [];
await waitFor(async () => {
  tabURLs = await page.evaluate(() => window.blTest.views().map((view) => view.url));
  return tabURLs.length > tabsBefore && tabURLs.includes(VIDEO_URL);
}, 20000);
check(
  'Open video in new tab: a tab with the video',
  tabURLs.includes(VIDEO_URL),
  tabURLs.join(' '),
);

// Picture in picture: into the host's window and out again, with the page's events
if (hostPip) {
  check('Picture in picture', await choose(VIDEO_POINT, 'picture-in-picture'));
  check(
    "Picture in picture: the video is in the window with the page's event",
    (await results.wait('pip', 20000)) === 'enter,true',
    results.get('pip'),
  );
  const hostWindow = await page.evaluate(() => document.pictureInPictureElement?.tagName ?? null);
  check(
    "Picture in picture: the host's video is in the window",
    hostWindow === 'VIDEO',
    hostWindow,
  );
  check('right click in picture in picture', await openMenu(VIDEO_POINT));
  check(
    'Picture in picture is checked now',
    (await item('picture-in-picture').getAttribute('aria-checked')) === 'true',
    (await rows()).join(' | '),
  );
  await item('picture-in-picture').click();
  check(
    'Picture in picture again: the video leaves the window',
    (await results.wait('pipleave', 20000)) === 'true',
    results.get('pipleave'),
  );
}

// An <audio>: the audio texts, no controls to hide, no Picture in picture
check('right click on the audio: menu', await openMenu(AUDIO_POINT));
const audioRows = await rows();
check(
  'audio: the audio items',
  audioRows.slice(0, 5).join('|') ===
    [
      'loop:Loop:false:',
      'show-controls:Show controls:true:disabled',
      'open-media:Open audio in new tab::',
      'save-media:Save audio as…::',
      'copy-media-address:Copy audio address::',
    ].join('|') && !audioRows.some((row) => row.startsWith('picture-in-picture:')),
  audioRows.join(' | '),
);
await page.keyboard.press('Escape');
check('Copy audio address', await choose(AUDIO_POINT, 'copy-media-address'));
await waitFor(async () => (await page.evaluate(() => window.blCopied.at(-1))) === AUDIO_URL, 10000);
const audioCopied = await page.evaluate(() => window.blCopied.at(-1));
check('Copy audio address: the address of the audio', audioCopied === AUDIO_URL, audioCopied);

console.log(`(${BROWSER})`);
await browser.close();
await stack.stop?.();
finish();
