// <video>/<audio> through the media service of @browser-lite/core: the hidden <video> of the host
// page plays, the data comes from the engine through the service worker (range requests over
// the relay), the engine paints the frames into the page (BL_VIDEO_OVERLAY=0; the overlay of #232
// has video-overlay-test.mjs), with requestVideoFrameCallback and getVideoPlaybackQuality().
// Also MSE, HLS and DASH manifests refused (players then take MSE), navigator.mediaCapabilities,
// blob:, data:, preload, picture-in-picture, muted autoplay only in the view, a fullscreen video
// letterboxed over a page object-fit: cover, the icons of the media controls and their exit
// fullscreen button and the range special cases of media-sw.js.
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
// WebM with alpha: the left half red, the right half transparent
const ALPHA_CLIP = await recordClip(browser, 2, { transparent: true });
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

// getVideoPlaybackQuality(): the frames counted while it plays, "total/dropped/corrupted" twice
const quality = () => {
  const q = video.getVideoPlaybackQuality();
  return [q.totalVideoFrames, q.droppedVideoFrames, q.corruptedVideoFrames].join('/');
};
video.addEventListener('playing', () => {
  setTimeout(() => {
    const first = quality();
    setTimeout(() => result('quality', first + '_' + quality()), 1000);
  }, 700);
}, { once: true });

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

// A transparent video over a blue page, filtered like the hero of zoo.ch (a filter refuses the
// overlay, so its frames are copied); drawImage(video) keeps the alpha too
const ALPHA_PAGE = `<!doctype html><title>Alpha</title><body style="margin:0;background:rgb(0,0,255)">
<video id="video" src="/alpha.webm" muted loop playsinline autoplay style="position:absolute;left:20px;top:20px;width:320px;height:240px;filter:saturate(1)"></video>
<script>
const video = document.getElementById('video');
const canvas = document.createElement('canvas');
canvas.width = 320;
canvas.height = 240;
const context = canvas.getContext('2d');
const draw = setInterval(() => {
  if (video.readyState < 2)
    return;
  context.clearRect(0, 0, 320, 240);
  context.drawImage(video, 0, 0, 320, 240);
  const left = context.getImageData(80, 120, 1, 1).data, right = context.getImageData(240, 120, 1, 1).data;
  if (left[3] < 200)
    return;
  clearInterval(draw);
  console.log('RESULT alphadraw=' + left[3] + ',' + right[3]);
}, 100);
</script>`;

// navigator.mediaCapabilities.decodingInfo: the MSE clip's codec, a file codec, an unknown codec
// (the host's answer each) and a container the host's MSE may take but the engine's parsers do not
// (always unsupported) and an HLS playlist as a file (always unsupported, the host <video> gets one
// resource only). Twitch's player drops every variant decodingInfo calls unsupported.
const DECODING_CONFIGS = [
  {
    type: 'media-source',
    video: {
      contentType: 'video/webm;codecs="vp8"',
      width: 640,
      height: 360,
      bitrate: 630000,
      framerate: 30,
    },
  },
  { type: 'file', audio: { contentType: 'audio/webm;codecs="opus"' } },
  {
    type: 'media-source',
    video: {
      contentType: 'video/mp4;codecs="xyz1.0"',
      width: 640,
      height: 360,
      bitrate: 630000,
      framerate: 30,
    },
  },
  { type: 'media-source', audio: { contentType: 'audio/mpeg' } },
  {
    type: 'file',
    video: {
      contentType: 'application/vnd.apple.mpegurl',
      width: 640,
      height: 360,
      bitrate: 630000,
      framerate: 30,
    },
  },
];
// Streaming manifests: the engine plays neither, whatever the host answers (Chrome and Safari say
// "maybe" for HLS), so players like video.js (SRF) take MSE instead of setting the playlist as src
const MANIFEST_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegURL',
  'audio/mpegurl',
  'video/vnd.apple.mpegurl',
  'application/dash+xml',
];
// "supported smooth powerEfficient" as digits per configuration, then encodingInfo of MediaRecorder
const ASK_CAPABILITIES = `(async () => {
  const answers = [];
  for (const configuration of ${JSON.stringify(DECODING_CONFIGS)}) {
    try {
      const info = await navigator.mediaCapabilities.decodingInfo(configuration);
      answers.push([info.supported, info.smooth, info.powerEfficient].map(Number).join(''));
    } catch (e) {
      answers.push(e.name);
    }
  }
  try {
    const info = await navigator.mediaCapabilities.encodingInfo({ type: 'record', video: { contentType: 'video/webm;codecs="vp8"', width: 640, height: 360, bitrate: 630000, framerate: 30 } });
    answers.push('record:' + Number(info.supported));
  } catch (e) {
    answers.push('record:' + e.name);
  }
  return answers.join(',');
})()`;

// MSE: append the clip in two odd parts (also checks the parser with half elements)
const MSE_PAGE = `<!doctype html><title>MSE test</title><body style="margin:0;background:#fff">
<video id="video" muted playsinline style="position:absolute;left:20px;top:20px;width:320px;height:240px"></video>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const askCapabilities = ${JSON.stringify(ASK_CAPABILITIES)};
(0, eval)(askCapabilities).then((answers) => result('capabilities', answers));
const capabilitiesWorker = new Worker(URL.createObjectURL(new Blob([askCapabilities + '.then((answers) => postMessage(answers))'], { type: 'text/javascript' })));
capabilitiesWorker.onmessage = (e) => result('workercapabilities', e.data);
const type = 'video/webm; codecs="vp8"';
result('msesupported', MediaSource.isTypeSupported(type));
result('manifests', JSON.stringify(${JSON.stringify(MANIFEST_TYPES)}.map((type) => document.createElement('video').canPlayType(type))));
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
    // The end afterwards: that of the last frame before 2.5, which may go past it (Firefox's
    // MediaRecorder writes long frames now and then)
    const before = buffer.buffered.end(0).toFixed(2);
    buffer.addEventListener('updateend', () => result('mseremoved', before + '/' + (buffer.buffered.length ? buffer.buffered.end(0).toFixed(2) : 'empty')), { once: true });
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

// Muted autoplay plays only while the video is in the view, like Chrome (#399): "far" waits
// below the fold until the page scrolls to it and pauses when it leaves the view again. step()
// reports the state and scrolls on (to "far", then back to the top); the test calls it through
// blTest.eval, as a click would give the page user activation, after which WebKit lifts the rule
// for a video that starts.
const AUTOPLAY_PAGE = `<!doctype html><title>Autoplay</title><body style="margin:0;background:#fff;height:5000px">
<video id="near" src="/clip.webm" muted loop autoplay playsinline style="position:absolute;left:20px;top:20px;width:160px;height:120px"></video>
<video id="far" src="/clip.webm" muted loop autoplay playsinline style="position:absolute;left:20px;top:3000px;width:160px;height:120px"></video>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const near = document.getElementById('near');
const far = document.getElementById('far');
const state = (video) => video.paused + ',' + (video.currentTime > 0);
near.addEventListener('playing', () => result('nearplaying', scrollY), { once: true });
far.addEventListener('playing', () => result('farplaying', scrollY));
far.addEventListener('pause', () => steps === 2 && result('farpause', scrollY));
let steps = 0;
function step() {
  steps++;
  if (steps === 1) {
    result('farbefore', state(far));
    scrollTo(0, 2800);
  } else if (steps === 2) {
    near.addEventListener('playing', () => result('nearagain', scrollY), { once: true });
    scrollTo(0, 0);
  }
}
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

// A video in fullscreen shows its whole picture even with object-fit: cover from the page, like
// the native players of phones (m.youtube.com fullscreens its <video> for the iPhone it sees)
const FULLSCREEN_PAGE = `<!doctype html><title>Fullscreen video</title><body style="margin:0;background:#fff">
<video id="video" src="/clip.webm" muted loop playsinline autoplay style="display:block;width:100%;height:120px;object-fit:cover"></video>
<button id="fs" style="position:absolute;left:20px;top:200px;width:200px;height:60px">Fullscreen</button>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const video = document.getElementById('video');
video.addEventListener('playing', () => result('fsplaying', '1'), { once: true });
document.getElementById('fs').addEventListener('click', () =>
  video.requestFullscreen().catch((e) => result('fsfit', e.name)));
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement === video)
    requestAnimationFrame(() => result('fsfit', getComputedStyle(video).objectFit + ',' + innerWidth + ',' + innerHeight));
});
</script>`;

// <video controls> into fullscreen through webkitEnterFullscreen(): the media controls show their
// icons (the WASM port compiles them in, patch 0103) and the exit button, which needs the
// player's fullscreen support
const CONTROLS_FULLSCREEN_PAGE = `<!doctype html><title>Fullscreen controls</title><body style="margin:0;background:#fff">
<video id="video" src="/clip.webm" controls muted playsinline style="display:block;width:320px;height:240px"></video>
<button id="fs" style="position:absolute;left:20px;top:300px;width:200px;height:60px">Fullscreen</button>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const video = document.getElementById('video');
video.addEventListener('loadedmetadata', () => result('cfsupported', video.webkitSupportsFullscreen), { once: true });
document.getElementById('fs').addEventListener('click', () => video.webkitEnterFullscreen());
document.addEventListener('fullscreenchange', () =>
  result(document.fullscreenElement === video ? 'cfsin' : 'cfsout', innerWidth + ',' + innerHeight));
// Firefox can resize the fullscreen window once more after the change
addEventListener('resize', () => result('cfssize', innerWidth + ',' + innerHeight));
</script>`;

// <audio controls> on a blue page: the bar is only drawn once the controls exist
const CONTROLS_PAGE = `<!doctype html><title>Controls</title><body style="margin:0;background:#00f">
<audio controls src="/tone.wav" preload="none" style="position:absolute;left:20px;top:20px;width:300px;height:25px"></audio>`;

const ranges = [];
const { url: siteURL } = await serve((req, res) => {
  const files = {
    '/clip.webm': [CLIP, 'video/webm'],
    '/clip.mov': [CLIP, 'video/quicktime'],
    '/alpha.webm': [ALPHA_CLIP, 'video/webm'],
    '/tone.wav': [TONE, 'audio/wav'],
  };
  const html = {
    '/': PAGE,
    '/mse.html': MSE_PAGE,
    '/alpha.html': ALPHA_PAGE,
    '/blob.html': BLOB_PAGE,
    '/controls.html': CONTROLS_PAGE,
    '/autoplay.html': AUTOPLAY_PAGE,
    '/fullscreen.html': FULLSCREEN_PAGE,
    '/controls-fullscreen.html': CONTROLS_FULLSCREEN_PAGE,
  }[req.url];
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
// First pixel of the page in the box [x0, x1) x [y0, y1) (every 2 px) that is a light icon of the
// media controls, null when there is none
async function iconPixel(x0, x1, y0, y1) {
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const [r, g, b] = await pagePixel(page, x, y);
      if (r > 120 && g > 120 && b > 120) return { x, y, r, g, b };
    }
  }
  return null;
}
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

const counts = ((await result('quality')) || '')
  .split('_')
  .map((value) => value.split('/').map(Number));
check(
  'video: getVideoPlaybackQuality() counts the frames',
  counts.length === 2 &&
    counts[1][0] > counts[0][0] &&
    counts[1][1] <= counts[1][0] &&
    counts[1][2] === 0,
  results.get('quality'),
);

// Picture-in-picture: click on the video
const box = await canvasOrigin(page);
await page.mouse.click(box.x + 180, box.y + 140);
// The pages see picture-in-picture only where the host has it (not in Firefox)
const hostPip = await page.evaluate(() => 'requestPictureInPicture' in HTMLVideoElement.prototype);
if (hostPip) {
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
} else {
  check(
    'picture-in-picture: missing like in the host',
    /^TypeError:/.test(await result('pip', 20000)) &&
      (await result('pipframe')) === 'undefined,undefined,false,undefined,undefined,undefined',
    `${results.get('pip')} ${results.get('pipframe')}`,
  );
}

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
check(
  'HLS and DASH: canPlayType says no, so players take MSE',
  (await result('manifests')) === JSON.stringify(MANIFEST_TYPES.map(() => '')),
  results.get('manifests'),
);
const mseBuffered = Number(await result('msebuffered'));
check('MSE: buffered after two parts', mseBuffered > 2.5 && mseBuffered < 3.6, String(mseBuffered));
check('MSE: play()', (await result('mseplay')) === 'ok', results.get('mseplay'));
check('MSE: plays', (await result('mseplaying')) === '1');
const mseTime = Number(await result('msetime'));
check('MSE: time runs', mseTime > 1, String(mseTime));
const msePixel = await waitForPixel(180, 140, isRed);
check('MSE: frame painted in the page', isRed(msePixel), JSON.stringify(msePixel));
// The host's own answers for the first three, the engine never takes the fourth and the fifth
const hostCapabilities = (await page.evaluate(ASK_CAPABILITIES)).split(',');
const expectedCapabilities = [...hostCapabilities.slice(0, 3), '000', '000', 'record:1'].join(',');
check(
  "mediaCapabilities.decodingInfo like the host's (page)",
  hostCapabilities[0].startsWith('1') && (await result('capabilities')) === expectedCapabilities,
  `${results.get('capabilities')} expected ${expectedCapabilities}`,
);
check(
  "mediaCapabilities.decodingInfo like the host's (worker)",
  (await result('workercapabilities')) === expectedCapabilities,
  `${results.get('workercapabilities')} expected ${expectedCapabilities}`,
);
await screenshot(page, 'mse');
const mseRemoved = await result('mseremoved');
const [removeFrom, removedTo] = String(mseRemoved).split('/').map(Number);
check(
  'MSE: remove() in the engine (buffered end before/after)',
  removedTo > 2 && removedTo < 2.7 && removedTo < removeFrom,
  mseRemoved,
);
let hostBuffered = null;
const removeEnd = Date.now() + 10000;
while (Date.now() < removeEnd) {
  const players = await page.evaluate(() => window.blTest.mediaState());
  hostBuffered = players.length ? players[players.length - 1].buffered : null;
  if (hostBuffered && hostBuffered.length && hostBuffered[hostBuffered.length - 1][1] < 2.7) break;
  await page.waitForTimeout(250);
}
check(
  'MSE: remove() in the host too',
  hostBuffered && hostBuffered.length && hostBuffered[hostBuffered.length - 1][1] < 2.7,
  JSON.stringify(hostBuffered),
);

// ------------------------------------------------------ transparent video
// Only where the host's own <video> shows the alpha (Chromium records and decodes VP8 alpha)
const hostAlpha = await page.evaluate(async (bytes) => {
  const video = document.createElement('video');
  video.muted = true;
  video.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/webm' }));
  await video.play().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  const context = new OffscreenCanvas(320, 240).getContext('2d');
  context.drawImage(video, 0, 0);
  const alpha = context.getImageData(240, 120, 1, 1).data[3];
  URL.revokeObjectURL(video.src);
  return video.readyState >= 2 && alpha === 0;
}, Array.from(ALPHA_CLIP));
if (hostAlpha) {
  await load(page, `${siteURL}alpha.html`);
  const isBlue = (p) => !!p && p.r < 60 && p.g < 60 && p.b > 180;
  const opaquePart = await waitForPixel(100, 140, isRed);
  const clearPart = await waitForPixel(260, 140, isBlue);
  check(
    'transparent video: the page shows through (filter, copied frames)',
    isRed(opaquePart) && isBlue(clearPart),
    JSON.stringify({ opaquePart, clearPart }),
  );
  const alphaDraw = String(await result('alphadraw'));
  const [leftAlpha, rightAlpha] = alphaDraw.split(',').map(Number);
  check(
    'transparent video: drawImage(video) keeps the alpha',
    leftAlpha > 200 && rightAlpha < 30,
    alphaDraw,
  );
} else console.log('skip transparent video (the host shows no VP8 alpha)');

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

// ------------------------------------------------------------------- controls
// Made after a rendering update once the document painted (patch 0049), not while parsing
await load(page, `${siteURL}controls.html`);
let barPixels = [];
const barShown = await waitFor(
  async () => {
    barPixels = [];
    for (let x = 30; x < 320; x += 20) {
      const [r, g, b] = await pagePixel(page, x, 32);
      barPixels.push([r, g, b]);
    }
    return barPixels.some(([r, g, b]) => r > 40 || g > 40 || b < 200);
  },
  20000,
  250,
);
check('controls: <audio controls> shows its bar', barShown, JSON.stringify(barPixels.slice(0, 4)));
// The play button at the left end of the bar: empty without the icons (patch 0103)
let playIcon = null;
await waitFor(async () => !!(playIcon = await iconPixel(34, 52, 28, 42)), 10000, 250);
check('controls: the play button shows its icon', !!playIcon, JSON.stringify(playIcon));

// ------------------------------------------------------------- autoplay
const earlier = new Set((await players()).map((p) => p.id));
await load(page, `${siteURL}autoplay.html`);
check('autoplay: the video in the view plays', (await result('nearplaying')) === '0');
// Long enough for "far" to load and, without the visibility rule, to play
await page.waitForTimeout(3000);
const playingHosts = async () =>
  (await players()).filter((p) => !earlier.has(p.id) && !p.paused).length;
const hostsBefore = await playingHosts();
await page.evaluate(() => window.blTest.eval('step()'));
check(
  'autoplay: a muted video below the fold waits (paused, at the start)',
  (await result('farbefore')) === 'true,false' && hostsBefore === 1,
  `${results.get('farbefore')}, ${hostsBefore} host videos playing`,
);
check(
  'autoplay: it plays once scrolled into the view',
  (await result('farplaying', 20000)) === '2800',
  results.get('farplaying'),
);
await page.evaluate(() => window.blTest.eval('step()'));
check(
  'autoplay: it pauses when scrolled out of the view',
  (await result('farpause', 20000)) === '0',
  results.get('farpause'),
);
check(
  'autoplay: the video back in the view plays again',
  (await result('nearagain', 20000)) === '0',
  results.get('nearagain'),
);
let hostsAfter = 0;
await waitFor(async () => (hostsAfter = await playingHosts()) === 1, 10000, 250);
check('autoplay: the host plays only the visible video', hostsAfter === 1, `${hostsAfter} playing`);

// ----------------------------------------------------------- fullscreen
await load(page, `${siteURL}fullscreen.html`);
check('fullscreen video: plays inline', (await result('fsplaying')) === '1');
const fsBox = await canvasOrigin(page);
await page.mouse.click(fsBox.x + 120, fsBox.y + 230);
const [fit, fsWidth, fsHeight] = String(await result('fsfit', 20000)).split(',');
// The 4:3 clip in a wider screen: black bars left and right, red in the middle
const fsMiddle = await waitForPixel(Number(fsWidth) / 2, Number(fsHeight) / 2, isRed);
const isBlack = (p) => !!p && p.r < 40 && p.g < 40 && p.b < 40;
const fsEdge = await waitForPixel(4, Number(fsHeight) / 2, isBlack);
check(
  'fullscreen video: letterboxed (object-fit contain over the page cover)',
  fit === 'contain' &&
    Number(fsWidth) * 3 > Number(fsHeight) * 4 &&
    isRed(fsMiddle) &&
    isBlack(fsEdge),
  `${results.get('fsfit')}, middle ${JSON.stringify(fsMiddle)}, edge ${JSON.stringify(fsEdge)}`,
);
await screenshot(page, 'media-fullscreen');
await page.evaluate(() => document.exitFullscreen().catch(() => {}));

// ------------------------------------------------------ fullscreen controls
await load(page, `${siteURL}controls-fullscreen.html`);
check(
  'fullscreen controls: webkitSupportsFullscreen',
  (await result('cfsupported')) === 'true',
  results.get('cfsupported'),
);
const cfsBox = await canvasOrigin(page);
await page.mouse.click(cfsBox.x + 120, cfsBox.y + 330);
const cfsIn = await result('cfsin', 20000);
check('fullscreen controls: webkitEnterFullscreen() enters fullscreen', !!cfsIn);
if (cfsIn) {
  // The bar of the Adwaita fullscreen controls is 468 px wide, centered, 25 px above the bottom;
  // the exit button is at its right end, nothing is right of the bar (the disabled overflow
  // button showed there). The icons load one after the other, so the position must hold for two
  // looks. The mouse over the video shows the controls.
  let cfsWidth = 0;
  let cfsHeight = 0;
  let exitIcon = null;
  let besideBar = null;
  let last = '';
  await waitFor(
    async () => {
      [cfsWidth, cfsHeight] = (results.get('cfssize') ?? cfsIn).split(',').map(Number);
      const barRight = cfsWidth / 2 + 234;
      await page.mouse.move(cfsBox.x + cfsWidth / 2, cfsBox.y + cfsHeight / 2);
      await page.mouse.move(cfsBox.x + cfsWidth / 2 + 10, cfsBox.y + cfsHeight / 2 + 10);
      exitIcon = await iconPixel(barRight - 54, barRight - 2, cfsHeight - 90, cfsHeight - 62);
      besideBar = await iconPixel(barRight + 2, barRight + 40, cfsHeight - 90, cfsHeight - 62);
      const seen = JSON.stringify([cfsWidth, cfsHeight, exitIcon?.x, exitIcon?.y, besideBar]);
      const stable = !!exitIcon && seen === last;
      last = seen;
      return stable;
    },
    20000,
    500,
  );
  check(
    'fullscreen controls: the exit button shows its icon',
    !!exitIcon,
    JSON.stringify(exitIcon),
  );
  check('fullscreen controls: no button outside the bar', !besideBar, JSON.stringify(besideBar));
  await screenshot(page, 'media-fullscreen-controls');
  if (exitIcon) await page.mouse.click(cfsBox.x + exitIcon.x, cfsBox.y + exitIcon.y);
  check(
    'fullscreen controls: the exit button leaves fullscreen',
    !!exitIcon && !!(await result('cfsout', 10000)),
  );
}

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
