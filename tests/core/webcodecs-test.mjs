// WebCodecs (engine/src/media/WebCodecsWasm.cpp, VideoFrameWasm.cpp, engine/js/webcodecs-host.js):
// VideoFrame from a canvas and from I420 data, encode and decode VP8 (also in a worker), encode
// and decode Opus, convert AudioData, ImageDecoder.
//
//   node tests/core/webcodecs-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  TIMEOUT,
  check,
  collect,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

// VP8 there and back, runs in the window and in the worker
const ROUNDTRIP = `
async function vp8RoundTrip(makeFrame) {
  const chunks = [];
  let decoderConfig = null;
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig)
        decoderConfig = meta.decoderConfig;
      chunks.push(chunk);
    },
    error: (e) => { failure = 'encoder:' + e.message; },
  });
  encoder.configure({ codec: 'vp8', width: 64, height: 48, bitrate: 500000, framerate: 30 });
  for (let i = 0; i < 5; i++) {
    const frame = makeFrame(i * 33333);
    encoder.encode(frame, { keyFrame: i === 0 });
    frame.close();
  }
  await encoder.flush();
  encoder.close();
  const frames = [];
  const decoder = new VideoDecoder({ output: (f) => frames.push(f), error: (e) => { failure = 'decoder:' + e.message; } });
  decoder.configure(decoderConfig || { codec: 'vp8' });
  for (const chunk of chunks)
    decoder.decode(chunk);
  await decoder.flush();
  decoder.close();
  return { chunks, decoderConfig, frames, failure };
}
`;

const WORKER = `${ROUNDTRIP}
onmessage = async () => {
  try {
    const data = new Uint8Array(64 * 48 * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = 0; data[i + 1] = 200; data[i + 2] = 0; data[i + 3] = 255; }
    const result = await vp8RoundTrip((timestamp) => new VideoFrame(data, { format: 'RGBA', codedWidth: 64, codedHeight: 48, timestamp }));
    const frame = result.frames[0];
    postMessage(result.failure || (result.chunks.length + ':' + result.frames.length + ':' + (frame ? frame.codedWidth + 'x' + frame.codedHeight : '-')));
    result.frames.forEach((f) => f.close());
  } catch (e) {
    postMessage('error:' + e);
  }
};
`;

const PAGE = `<!doctype html><title>WebCodecs-Test</title><body>WebCodecs
<script>${ROUNDTRIP}
const log = (key, value) => console.log('RESULT ' + key + '=' + String(value).replace(/\\s/g, '_'));
// Every part on its own, an error must not hide the others
const part = async (name, run) => {
  try {
    await run();
  } catch (e) {
    log(name + 'error', e);
  }
};
(async () => {
  log('api', [typeof VideoDecoder, typeof VideoEncoder, typeof AudioDecoder, typeof AudioEncoder, typeof VideoFrame, typeof AudioData, typeof EncodedVideoChunk].join(','));

  // VideoFrame from a canvas: left red, right blue
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 48;
  const context = canvas.getContext('2d');
  context.fillStyle = 'rgb(255,0,0)';
  context.fillRect(0, 0, 32, 48);
  context.fillStyle = 'rgb(0,0,255)';
  context.fillRect(32, 0, 32, 48);
  await part('canvas', async () => {
  const frame = new VideoFrame(canvas, { timestamp: 0 });
  log('canvasframe', frame.format + ':' + frame.codedWidth + 'x' + frame.codedHeight);
  const pixels = new Uint8Array(frame.allocationSize());
  await frame.copyTo(pixels);
  log('copyto', Array.from(pixels.slice(0, 4)).join('.'));
  frame.close();
  });

  // Draw I420 data (red in BT.709, limited range) onto a canvas
  await part('i420', async () => {
  const i420 = new Uint8Array(24);
  i420.fill(63, 0, 16);
  i420.fill(102, 16, 20);
  i420.fill(240, 20, 24);
  const yuv = new VideoFrame(i420, { format: 'I420', codedWidth: 4, codedHeight: 4, timestamp: 5 });
  const small = document.createElement('canvas');
  small.width = 4;
  small.height = 4;
  const smallContext = small.getContext('2d');
  smallContext.drawImage(yuv, 0, 0);
  const red = smallContext.getImageData(1, 1, 1, 1).data;
  log('i420draw', red[0] > 220 && red[1] < 40 && red[2] < 40 ? 'red' : red.join('.'));
  yuv.close();
  });

  // Encode and decode VP8
  await part('vp8', async () => {
  const result = await vp8RoundTrip((timestamp) => new VideoFrame(canvas, { timestamp }));
  if (result.failure)
    log('vp8error', result.failure);
  log('encoded', result.chunks.length + ':' + result.chunks[0].type + ':' + (result.decoderConfig ? result.decoderConfig.codec : 'none'));
  const first = result.frames[0];
  log('decoded', result.frames.length + ':' + first.codedWidth + 'x' + first.codedHeight + ':' + first.timestamp);
  const target = document.createElement('canvas');
  target.width = 64;
  target.height = 48;
  const targetContext = target.getContext('2d');
  targetContext.drawImage(first, 0, 0);
  const left = targetContext.getImageData(8, 24, 1, 1).data;
  const right = targetContext.getImageData(56, 24, 1, 1).data;
  log('decodedcolor', left[0] > 180 && left[2] < 80 && right[2] > 180 && right[0] < 80 ? 'ok' : left.join('.') + '/' + right.join('.'));
  result.frames.forEach((f) => f.close());
  });

  await part('support', async () => {
  log('vp9', (await VideoDecoder.isConfigSupported({ codec: 'vp09.00.10.08' })).supported);
  log('bogus', (await VideoDecoder.isConfigSupported({ codec: 'vp8x' })).supported);
  });

  // ImageDecoder: a blue PNG from a canvas
  await part('imagedecoder', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 10;
    const context = canvas.getContext('2d');
    context.fillStyle = 'rgb(0, 0, 255)';
    context.fillRect(0, 0, 20, 10);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: 'image/png' });
    await decoder.tracks.ready;
    const { image } = await decoder.decode();
    const pixels = new Uint8Array(image.allocationSize());
    await image.copyTo(pixels);
    log('imagedecoder', [await ImageDecoder.isTypeSupported('image/png'), decoder.tracks.length, decoder.tracks.selectedTrack.frameCount,
      image.codedWidth + 'x' + image.codedHeight, pixels[0] < 30 && pixels[2] > 220].join(','));
    image.close();
    decoder.close();
  });

  // Encode and decode Opus (440 Hz)
  await part('opus', async () => {
  const audioChunks = [];
  let audioConfig = null;
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig)
        audioConfig = meta.decoderConfig;
      audioChunks.push(chunk);
    },
    error: (e) => log('aencerror', e.message),
  });
  audioEncoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 64000 });
  for (let i = 0; i < 10; i++) {
    const samples = new Float32Array(960);
    for (let s = 0; s < 960; s++)
      samples[s] = Math.sin((i * 960 + s) / 48000 * 2 * Math.PI * 440) * 0.5;
    const data = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: i * 20000, data: samples });
    audioEncoder.encode(data);
    data.close();
  }
  await audioEncoder.flush();
  log('aencoded', audioChunks.length + ':' + (audioConfig ? audioConfig.codec + '/' + audioConfig.sampleRate : 'none'));
  const audio = [];
  const audioDecoder = new AudioDecoder({ output: (d) => audio.push(d), error: (e) => log('adecerror', e.message) });
  audioDecoder.configure(audioConfig || { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
  for (const chunk of audioChunks)
    audioDecoder.decode(chunk);
  await audioDecoder.flush();
  let peak = 0;
  for (const data of audio) {
    const out = new Float32Array(data.numberOfFrames);
    data.copyTo(out, { planeIndex: 0, format: 'f32-planar' });
    for (const value of out)
      peak = Math.max(peak, Math.abs(value));
  }
  log('adecoded', audio.length + ':' + audio[0].sampleRate + ':' + audio[0].numberOfChannels + ':' + (peak > 0.2 ? 'sound' : 'silent' + peak));

  });

  // AudioData: s16 stereo -> right channel as f32
  await part('audiodata', async () => {
  const stereo = new AudioData({ format: 's16', sampleRate: 8000, numberOfFrames: 2, numberOfChannels: 2, timestamp: 0, data: new Int16Array([16384, -16384, 8192, -8192]) });
  const rightChannel = new Float32Array(2);
  stereo.copyTo(rightChannel, { planeIndex: 1, format: 'f32-planar' });
  log('audiodata', stereo.duration + ':' + rightChannel[0].toFixed(2) + ',' + rightChannel[1].toFixed(2));
  });

  // The same in the worker
  const worker = new Worker('/worker.js');
  worker.onmessage = (e) => log('worker', e.data);
  worker.postMessage('go');
})().catch((e) => log('error', e));
</script>`;

const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/worker.js')
    return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(WORKER);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack({ token: 'webcodecs-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(page);
const result = (key, ms = TIMEOUT) => results.wait(key, ms, () => results.has('error'));

// E2E_DIRECT=1: the same page directly in Chromium (for comparison)
await page.goto(process.env.E2E_DIRECT ? siteURL : stack.app({ url: siteURL, log: '1' }));
if (!process.env.E2E_DIRECT)
  check('host page starts the browser', await page.evaluate(() => window.blHost.ready));
const err = (part) => results.get(part + 'error') || results.get('error') || '';
check(
  'WebCodecs API there',
  (await result('api')) === Array(7).fill('function').join(','),
  results.get('api'),
);
check(
  'VideoFrame from a canvas',
  (await result('canvasframe', 30000)) === 'RGBA:64x48',
  results.get('canvasframe') || err('canvas'),
);
check(
  'VideoFrame.copyTo (RGBA, red)',
  (await result('copyto', 30000)) === '255.0.0.255',
  results.get('copyto') || err('canvas'),
);
check(
  'draw an I420 frame (YUV -> RGB)',
  (await result('i420draw', 30000)) === 'red',
  results.get('i420draw') || err('i420'),
);
check(
  'VP8 encoded (key frame, decoderConfig)',
  /^5:key:vp8$/.test((await result('encoded', 60000)) || ''),
  results.get('encoded') || err('vp8'),
);
check(
  'VP8 decoded',
  /^5:64x48:0$/.test((await result('decoded', 60000)) || ''),
  results.get('decoded') || err('vp8'),
);
check(
  'decoded frame has the colors',
  (await result('decodedcolor', 30000)) === 'ok',
  results.get('decodedcolor') || err('vp8'),
);
check(
  'VP9 is supported',
  (await result('vp9', 30000)) === 'true',
  results.get('vp9') || err('support'),
);
check(
  'unknown codec refused',
  (await result('bogus', 30000)) === 'false',
  results.get('bogus') || err('support'),
);
check(
  'ImageDecoder (PNG -> VideoFrame)',
  (await result('imagedecoder', 60000)) === 'true,1,1,20x10,true',
  results.get('imagedecoder') || err('imagedecoder'),
);
check(
  'Opus encoded',
  /^\d+:opus\/48000$/.test((await result('aencoded', 60000)) || ''),
  results.get('aencoded') || results.get('aencerror') || err('opus'),
);
check(
  'Opus decoded with sound',
  /^\d+:48000:1:sound$/.test((await result('adecoded', 60000)) || ''),
  results.get('adecoded') || results.get('adecerror') || err('opus'),
);
check(
  'AudioData s16 -> f32-planar',
  (await result('audiodata', 30000)) === '250:-0.50,-0.25',
  results.get('audiodata') || err('audiodata'),
);
check(
  'VP8 in the worker',
  /^5:5:64x48$/.test((await result('worker', 60000)) || ''),
  results.get('worker') || err('worker'),
);

await browser.close();
finish();
