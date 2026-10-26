// <video>/<audio> through the media service of @browser-lite/core: the hidden <video> of the host
// page plays, the data comes from the engine through the service worker (range requests over
// the relay), the engine paints the frames into the page (BL_VIDEO_OVERLAY=0; the overlay of #232
// has video-overlay-test.mjs). Also MSE, blob:, data:, preload,
// picture-in-picture and the range special cases of media-sw.js.
//
// The test files are made here: a WAV (30 s, several 2 MB pieces) and a WebM clip, recorded
// with MediaRecorder in the test Chromium.
//
//   node tests/core/media-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  load,
  openHost,
  pagePixel,
  recordClip,
  screenshot,
  serve,
  serveBytes,
  startStack,
  timeLimit,
  waitFor,
  wav,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 180000);

// --------------------------------------------------------- test files

const TONE = wav(30, { rate: 44100 });

const browser = await launch();

// WebM: 3 s, the canvas always red (the color is checked by "video: frame painted in the page")
const CLIP = await recordClip(browser, 3);
console.log(
  `Test files: WAV ${(TONE.length / 1e6).toFixed(1)} MB, WebM ${(CLIP.length / 1e3).toFixed(0)} kB`,
);

const PAGE = `<!doctype html><title>Media test</title><body style="margin:0;background:#fff">
<video id="video" src="/clip.webm" muted playsinline style="position:absolute;left:20px;top:20px;width:320px;height:240px"></video>
<audio id="audio" src="/tone.wav" muted preload="auto"></audio>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const video = document.getElementById('video');
const audio = document.getElementById('audio');
video.addEventListener('loadedmetadata', () => result('videometa', video.videoWidth + 'x' + video.videoHeight));
video.addEventListener('playing', () => result('videoplaying', '1'));
video.addEventListener('error', () => result('videoerror', video.error && video.error.code));
video.play().then(() => result('videoplay', 'ok'), (e) => result('videoplay', e.name));
// requestVideoFrameCallback: three frames with a growing number and the size
if (video.requestVideoFrameCallback) {
  const seen = [];
  const onFrame = (now, metadata) => {
    seen.push(metadata.presentedFrames);
    if (seen.length < 3)
      return video.requestVideoFrameCallback(onFrame);
    const increasing = seen[0] < seen[1] && seen[1] < seen[2];
    result('rvfc', (increasing ? 'ok' : seen.join('/')) + ',' + metadata.width + 'x' + metadata.height + ',' + (metadata.mediaTime > 0));
  };
  video.requestVideoFrameCallback(onFrame);
} else
  result('rvfc', 'missing');

// Picture-in-picture on a click (through the <video> of the host)
const pipEvents = [];
video.addEventListener('enterpictureinpicture', (e) => pipEvents.push('enter:' + (e.pictureInPictureWindow.width > 0)));
video.addEventListener('leavepictureinpicture', () => pipEvents.push('leave'));
video.addEventListener('click', async () => {
  try {
    const pipWindow = await video.requestPictureInPicture();
    result('pip', [document.pictureInPictureEnabled, document.pictureInPictureElement === video, pipWindow.width > 0 && pipWindow.height > 0].join(','));
    await document.exitPictureInPicture();
    setTimeout(() => result('pipevents', pipEvents.join('|') + ',' + (document.pictureInPictureElement === null)), 500);
  } catch (e) {
    result('pip', e.name + ':' + e.message.replace(/\s/g, '_'));
  }
});
// Picture-in-picture also in a frame without <video>: the members only reach the prototypes
// when the window creates them
addEventListener('message', (e) => {
  if (Array.isArray(e.data))
    result('pipframe', e.data.join(','));
});
const pipFrame = document.createElement('iframe');
pipFrame.srcdoc = '<script>parent.postMessage([typeof document.exitPictureInPicture, document.pictureInPictureElement, "requestPictureInPicture" in HTMLVideoElement.prototype, document.createElement("video").onenterpictureinpicture, document.createElement("div").attachShadow({ mode: "open" }).pictureInPictureElement, typeof PictureInPictureEvent].map(String), "*")<\\/script>';
document.body.append(pipFrame);
audio.addEventListener('loadedmetadata', () => result('audioduration', audio.duration.toFixed(1)));
audio.addEventListener('error', () => result('audioerror', audio.error && audio.error.code));
let seekedOnce = false;
audio.addEventListener('seeked', () => {
  if (!seekedOnce) {
    seekedOnce = true;
    result('audioseeked', audio.currentTime.toFixed(1));
    setTimeout(() => result('audioafter', audio.currentTime.toFixed(1)), 1500);
  }
});
audio.addEventListener('playing', () => {
  setTimeout(() => {
    result('audiotime', audio.currentTime.toFixed(1));
    audio.currentTime = 25;
  }, 1500);
}, { once: true });
audio.play().then(() => result('audioplay', 'ok'), (e) => result('audioplay', e.name));
</script>`;

// MSE: append the clip in two odd parts (also checks the parser with half elements)
const MSE_PAGE = `<!doctype html><title>MSE test</title><body style="margin:0;background:#fff">
<video id="video" muted playsinline style="position:absolute;left:20px;top:20px;width:320px;height:240px"></video>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const type = 'video/webm; codecs="vp8"';
result('msesupported', MediaSource.isTypeSupported(type));
const video = document.getElementById('video');
const source = new MediaSource();
video.src = URL.createObjectURL(source);
source.addEventListener('sourceopen', async () => {
  const data = new Uint8Array(await (await fetch('/clip.webm')).arrayBuffer());
  const buffer = source.addSourceBuffer(type);
  const append = (part) => new Promise((resolve) => { buffer.addEventListener('updateend', resolve, { once: true }); buffer.appendBuffer(part); });
  const middle = Math.floor(data.length / 2) + 7;
  await append(data.subarray(0, middle));
  await append(data.subarray(middle));
  result('msebuffered', buffer.buffered.length ? buffer.buffered.end(0).toFixed(1) : 'empty');
  source.endOfStream();
  result('mseduration', video.duration.toFixed(1));
  video.addEventListener('playing', () => result('mseplaying', '1'));
  let removed = false;
  video.addEventListener('timeupdate', () => {
    if (video.currentTime <= 1.2)
      return;
    result('msetime', video.currentTime.toFixed(1));
    // Then drop the end, the host must do so too
    if (removed)
      return;
    removed = true;
    buffer.addEventListener('updateend', () => result('mseremoved', buffer.buffered.length ? buffer.buffered.end(0).toFixed(1) : 'empty'), { once: true });
    buffer.remove(2.5, Infinity);
  });
  video.play().then(() => result('mseplay', 'ok'), (e) => result('mseplay', e.name));
});
</script>`;

// blob: (recorded video, like messengers and editors) and data: (short sound), plus
// preload="metadata" and a later change to "auto". clip.mov without type: the host does not
// know the type of the extension (video/quicktime), but detects the format (WebM here) while
// loading.
const BEEP = wav(0.5, { rate: 8000 }).toString('base64');
const BLOB_PAGE = `<!doctype html><title>Blob test</title><body style="margin:0;background:#fff">
<video id="video" muted loop playsinline style="position:absolute;left:20px;top:20px;width:320px;height:240px"></video>
<audio id="lazy" src="/tone.wav" preload="metadata"></audio>
<video id="mov" src="/clip.mov" muted preload="auto" style="position:absolute;left:600px;top:20px;width:80px;height:60px"></video>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const video = document.getElementById('video');
video.addEventListener('loadedmetadata', () => {
  result('blobmeta', video.videoWidth + 'x' + video.videoHeight);
  // The engine keeps the bytes itself, later range requests still work
  URL.revokeObjectURL(video.src);
});
video.addEventListener('error', () => result('bloberror', video.error && video.error.code));
// Then canvas.drawImage(video) (a copy of the frame owned by the engine), then smaller: from
// there on the frames of the host come in another size
video.addEventListener('playing', () => {
  result('blobplaying', '1');
  setTimeout(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, 32, 24);
    const [r, g, b] = context.getImageData(16, 12, 1, 1).data;
    result('blobdraw', r + ',' + g + ',' + b);
    video.style.width = '160px';
    video.style.height = '120px';
    result('blobresized', '1');
  }, 1000);
}, { once: true });
// loop: at the end it seeks back to the start and plays on
video.addEventListener('seeked', () => {
  setTimeout(() => result('blobloop', video.paused ? 'paused' : video.currentTime > 0.3 ? 'plays' : 'stands at ' + video.currentTime), 1000);
}, { once: true });
fetch('/clip.webm').then((r) => r.blob()).then((blob) => {
  video.src = URL.createObjectURL(blob);
  video.play().catch((e) => result('blobplay', e.name));
});
const beep = new Audio('data:audio/wav;base64,${BEEP}');
beep.addEventListener('loadedmetadata', () => result('dataduration', beep.duration.toFixed(1)));
beep.addEventListener('error', () => result('dataerror', beep.error && beep.error.code));
const lazy = document.getElementById('lazy');
lazy.addEventListener('loadedmetadata', () => result('lazymeta', lazy.duration.toFixed(1)));
const mov = document.getElementById('mov');
mov.addEventListener('loadedmetadata', () => result('movmeta', mov.videoWidth + 'x' + mov.videoHeight));
mov.addEventListener('error', () => result('movmeta', 'error' + (mov.error && mov.error.code)));
document.addEventListener('click', () => {
  lazy.preload = 'auto';
  result('lazyauto', '1');
});
</script>`;

// Servers with range quirks: /star.wav without a known length (bytes a-b/*), /short.wav with an
// empty 206 from 2 MB on (file shorter than announced)
const RANGE_PAGE = (file) =>
  `<!doctype html><title>Range test</title><audio src="/${file}" muted preload="auto"></audio>`;
const SHORT_AT = 2 * 1024 * 1024;

function oddRange(req, res) {
  const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (!match) {
    res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(TONE);
    return;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), TONE.length - 1) : TONE.length - 1;
  if (req.url === '/short.wav' && start >= SHORT_AT) {
    res
      .writeHead(206, {
        'Content-Type': 'audio/wav',
        'Content-Length': 0,
        'Content-Range': `bytes ${start}-${end}/${TONE.length}`,
      })
      .end();
    return;
  }
  if (start >= TONE.length) {
    res.writeHead(416, { 'Content-Range': 'bytes */*' }).end();
    return;
  }
  const total = req.url === '/star.wav' ? '*' : TONE.length;
  res.writeHead(206, {
    'Content-Type': 'audio/wav',
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${total}`,
  });
  res.end(TONE.subarray(start, end + 1));
}

const ranges = [];
const { url: siteURL } = await serve((req, res) => {
  const files = {
    '/clip.webm': [CLIP, 'video/webm'],
    '/clip.mov': [CLIP, 'video/quicktime'],
    '/tone.wav': [TONE, 'audio/wav'],
  };
  const html = { '/': PAGE, '/mse.html': MSE_PAGE, '/blob.html': BLOB_PAGE }[req.url];
  if (html) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    return;
  }
  const rangePage = /^\/range-(\w+)\.html$/.exec(req.url);
  if (rangePage) {
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(RANGE_PAGE(rangePage[1] + '.wav'));
    return;
  }
  if (req.url === '/star.wav' || req.url === '/short.wav') {
    oddRange(req, res);
    return;
  }
  const file = files[req.url];
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  const range = serveBytes(req, res, ...file);
  if (range) ranges.push(`${req.url}:${range[0]}-${range[1]}`);
});

const stack = await startStack({ token: 'media-token-0123456789abcdef' });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(page);
const result = (key, timeout = TIMEOUT) => results.wait(key, timeout);

const isRed = (p) => !!p && p.r > 180 && p.g < 60 && p.b < 60;
const isWhite = (p) => !!p && p.r > 200 && p.g > 200 && p.b > 200;
// Pixel of the page until test(pixel) is true (at most 20 s)
async function waitForPixel(x, y, test) {
  let pixel = null;
  await waitFor(
    async () => {
      const [r, g, b] = await pagePixel(page, x, y);
      return test((pixel = { r, g, b }));
    },
    20000,
    250,
  );
  return pixel;
}

// Frames copied and painted into the page (#217); the overlay has video-overlay-test.mjs
await openHost(page, stack.app({ url: siteURL, env: 'BL_VIDEO_OVERLAY=0' }));

check(
  'video: metadata',
  (await result('videometa')) === '320x240',
  results.get('videoerror') ? `error ${results.get('videoerror')}` : results.get('videometa'),
);
check(
  'video: play() (muted, without a click)',
  (await result('videoplay')) === 'ok',
  results.get('videoplay'),
);
check('video: plays', (await result('videoplaying')) === '1');

// A red frame must be at the place of the video in the page
const pixel = await waitForPixel(180, 140, isRed);
check('video: frame painted in the page', isRed(pixel), JSON.stringify(pixel));

check(
  'video: requestVideoFrameCallback',
  (await result('rvfc')) === 'ok,320x240,true',
  results.get('rvfc'),
);

// Picture-in-picture: click on the video
const box = await canvasOrigin(page);
await page.mouse.click(box.x + 180, box.y + 140);
check(
  'picture-in-picture: requestPictureInPicture',
  (await result('pip', 20000)) === 'true,true,true',
  results.get('pip'),
);
check(
  'picture-in-picture: events and exit',
  (await result('pipevents', 20000)) === 'enter:true|leave,true',
  results.get('pipevents'),
);
check(
  'picture-in-picture: in a frame without video',
  (await result('pipframe')) === 'function,null,true,null,null,function',
  results.get('pipframe'),
);

check(
  'audio: duration known',
  (await result('audioduration')) === '30.0',
  results.get('audioerror') ? `error ${results.get('audioerror')}` : results.get('audioduration'),
);
check('audio: play()', (await result('audioplay')) === 'ok', results.get('audioplay'));
const audioTime = Number(await result('audiotime'));
check('audio: time runs', audioTime > 0.8 && audioTime < 3, String(audioTime));
const seeked = Number(await result('audioseeked'));
check('audio: seek to 25 s', Math.abs(seeked - 25) < 0.5, String(seeked));
const after = Number(await result('audioafter'));
check('audio: plays on after seeking', after > seeked + 0.5, String(after));
const toneRanges = ranges.filter((r) => r.startsWith('/tone.wav'));
check('data in pieces (range over the relay)', toneRanges.length >= 2, toneRanges.join(' '));

await screenshot(page, 'media');

// ------------------------------------------------------------------ MSE
await load(page, `${siteURL}mse.html`);
check(
  'MSE: isTypeSupported(WebM/VP8)',
  (await result('msesupported')) === 'true',
  results.get('msesupported'),
);
const mseBuffered = Number(await result('msebuffered'));
check('MSE: buffered after two parts', mseBuffered > 2.5 && mseBuffered < 3.6, String(mseBuffered));
check('MSE: play()', (await result('mseplay')) === 'ok', results.get('mseplay'));
check('MSE: plays', (await result('mseplaying')) === '1');
const mseTime = Number(await result('msetime'));
check('MSE: time runs', mseTime > 1, String(mseTime));
const msePixel = await waitForPixel(180, 140, isRed);
check('MSE: frame painted in the page', isRed(msePixel), JSON.stringify(msePixel));
await screenshot(page, 'mse');
const mseRemoved = await result('mseremoved');
check(
  'MSE: remove() in the engine',
  Number(mseRemoved) > 2 && Number(mseRemoved) <= 2.5,
  mseRemoved,
);
let hostBuffered = null;
const removeEnd = Date.now() + 10000;
while (Date.now() < removeEnd) {
  const players = await page.evaluate(() => window.blTest.mediaState());
  hostBuffered = players.length ? players[players.length - 1].buffered : null;
  if (hostBuffered && hostBuffered.length && hostBuffered[hostBuffered.length - 1][1] < 2.6) break;
  await page.waitForTimeout(250);
}
check(
  'MSE: remove() in the host too',
  hostBuffered && hostBuffered.length && hostBuffered[hostBuffered.length - 1][1] < 2.6,
  JSON.stringify(hostBuffered),
);

// ------------------------------------------------------ blob:, data:, preload
const players = () => page.evaluate(() => window.blTest.mediaState());
const before = new Set((await players()).map((p) => p.id));
await load(page, `${siteURL}blob.html`);
check(
  'blob: metadata',
  (await result('blobmeta')) === '320x240',
  results.get('bloberror') ? `error ${results.get('bloberror')}` : results.get('blobmeta'),
);
check('blob: plays', (await result('blobplaying')) === '1', results.get('blobplay'));
const blobPixel = await waitForPixel(180, 140, isRed);
check('blob: frame painted in the page', isRed(blobPixel), JSON.stringify(blobPixel));
const draw = (await result('blobdraw')) || '';
const [r, g, b] = draw.split(',').map(Number);
check('blob: canvas.drawImage(video)', isRed({ r, g, b }), draw);
await result('blobresized');
const framesBefore = Math.max(
  0,
  ...(await players()).filter((p) => !before.has(p.id)).map((p) => p.frames),
);
const outside = await waitForPixel(300, 220, isWhite);
const smallPixel = await waitForPixel(100, 80, isRed);
check(
  'blob: painted smaller after a size change',
  isWhite(outside) && isRed(smallPixel),
  JSON.stringify([outside, smallPixel]),
);
await page.waitForTimeout(1500);
const framesAfter = Math.max(
  0,
  ...(await players()).filter((p) => !before.has(p.id)).map((p) => p.frames),
);
check(
  'blob: frames keep coming (loop after revokeObjectURL)',
  framesAfter > framesBefore,
  `${framesBefore} -> ${framesAfter}`,
);
check(
  'blob: loop plays on after the end',
  (await result('blobloop')) === 'plays',
  results.get('blobloop'),
);
check(
  'data: sound with a duration',
  (await result('dataduration')) === '0.5',
  results.get('dataerror') ? `error ${results.get('dataerror')}` : results.get('dataduration'),
);
check('preload=metadata: metadata', (await result('lazymeta')) === '30.0', results.get('lazymeta'));
check(
  'video with an unknown extension (.mov without type): metadata',
  (await result('movmeta')) === '320x240',
  results.get('movmeta'),
);
const lazy = (await players()).find((p) => !before.has(p.id) && p.preload === 'metadata');
check(
  'preload=metadata: host <video> with metadata',
  !!lazy,
  JSON.stringify((await players()).map((p) => p.preload)),
);
await page.mouse.click(box.x + 600, box.y + 400);
await result('lazyauto');
let lazyNow = null;
const lazyEnd = Date.now() + 10000;
while (lazy && Date.now() < lazyEnd) {
  lazyNow = (await players()).find((p) => p.id === lazy.id);
  if (lazyNow?.preload === 'auto') break;
  await page.waitForTimeout(250);
}
check(
  'preload: the change to auto reaches the host',
  lazyNow?.preload === 'auto',
  JSON.stringify(lazyNow),
);
await screenshot(page, 'media-blob');

// ------------------------------------------- range special cases (media-sw.js of the core)
// The answer of the service worker must end instead of loading forever. We read
// bl-media/<instance>/<player>/... directly, like the <video> of the host does.
async function openPlayer(url) {
  const before = new Set((await page.evaluate(() => window.blTest.mediaState())).map((p) => p.id));
  await load(page, url);
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const fresh = (await page.evaluate(() => window.blTest.mediaState())).find(
      (p) => !before.has(p.id),
    );
    if (fresh) return fresh.id;
    await page.waitForTimeout(250);
  }
  return null;
}
const mediaFetch = (id, range) =>
  page.evaluate(
    async ({ id, range }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        // The hidden host video of the player has bl-media/<instance>/<player>/<nonce> as src
        const src = [...document.querySelectorAll('[data-bl-media] video')]
          .map((video) => video.src)
          .find((url) => url.includes(`/bl-media/`) && url.split('/').at(-2) === String(id));
        const response = await fetch(src.replace(/[^/]+$/, 'range-test'), {
          headers: range ? { Range: range } : {},
          signal: controller.signal,
        });
        const length = (await response.arrayBuffer()).byteLength;
        return `${response.status} ${response.headers.get('Content-Range') || '-'} ${length}`;
      } catch (e) {
        return e.name;
      } finally {
        clearTimeout(timer);
      }
    },
    { id, range },
  );

const starPlayer = await openPlayer(siteURL + 'range-star.html');
check('range without length (/*): player there', starPlayer !== null);
if (starPlayer !== null) {
  const open = await mediaFetch(starPlayer, 'bytes=0-');
  check(
    'range without length (/*): an open range delivers the first piece',
    open === `206 bytes 0-${2 * 1024 * 1024 - 1}/* ${2 * 1024 * 1024}`,
    open,
  );
  const whole = await mediaFetch(starPlayer, null);
  check(
    'range without length (/*): the whole file ends at the end of the file',
    whole === `200 - ${TONE.length}`,
    whole,
  );
}
const shortPlayer = await openPlayer(siteURL + 'range-short.html');
check('empty 206: player there', shortPlayer !== null);
if (shortPlayer !== null) {
  const short = await mediaFetch(shortPlayer, 'bytes=0-');
  check('empty 206: the answer ends without progress', /^206 .* 2097152$/.test(short), short);
}
await browser.close();
finish();
