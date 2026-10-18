// Camera and microphone (engine/src/media/MediaStreamWasm.cpp, capture service of the core):
// getUserMedia with the fake camera and microphone of Chromium, the permission request,
// <video>.srcObject, canvas.drawImage(video), the microphone in Web Audio, enumerateDevices, the
// capture-state event. MediaRecorder (engine/src/media/MediaRecorderWasm.cpp) records a canvas
// and Web Audio as WebM, the real Chromium plays the file. Also getDisplayMedia, the sound of a
// stream in <audio>, picture-in-picture of streams and broken camera frames.
//
//   node tests/core/mediastream-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  hostEvents,
  waitEvent,
  waitFor,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>MediaStream test</title>
<style>body { margin: 0 } #start { position: absolute; left: 20px; top: 20px; width: 200px; height: 60px; } #screen { position: absolute; left: 260px; top: 20px; width: 200px; height: 60px; } #rec { position: absolute; left: 500px; top: 20px; width: 200px; height: 60px; } #listen { position: absolute; left: 740px; top: 20px; width: 200px; height: 60px; } #pipcam { position: absolute; left: 20px; top: 400px; width: 200px; height: 60px; } #pipcanvas { position: absolute; left: 260px; top: 400px; width: 200px; height: 60px; } #broken { position: absolute; left: 740px; top: 400px; width: 200px; height: 60px; }</style>
<button id="start">Camera on</button>
<button id="screen">Share screen</button>
<button id="rec">Record</button>
<button id="listen">Listen</button>
<button id="pipcam">PiP camera</button>
<button id="pipcanvas">PiP Canvas</button>
<button id="broken">Camera broken</button>
<script>
// Picture-in-picture for srcObject streams: camera (copy of the host track) and canvas (sink of
// the engine)
async function streamPip(key, stream, hold) {
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  video.style.cssText = 'position:absolute;left:500px;top:400px;width:80px;height:60px';
  document.body.append(video);
  await video.play();
  if (video.readyState < 1)
    await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
  const events = [];
  video.onenterpictureinpicture = () => events.push('enter');
  video.onleavepictureinpicture = () => events.push('leave');
  const pipWindow = await video.requestPictureInPicture();
  log(key, [document.pictureInPictureElement === video, pipWindow.width > 0].join(','));
  await new Promise((resolve) => setTimeout(resolve, hold));
  await document.exitPictureInPicture();
  await new Promise((resolve) => setTimeout(resolve, 500));
  log(key + 'events', events.join('|') + ',' + (document.pictureInPictureElement === null));
  video.remove();
}
document.getElementById('pipcam').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
    await streamPip('pipcam', stream, 2500);
    stream.getTracks().forEach((track) => track.stop());
  } catch (e) {
    log('piperror', e.name + ':' + e.message);
  }
});
document.getElementById('pipcanvas').addEventListener('click', async () => {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    const context = canvas.getContext('2d');
    const timer = setInterval(() => {
      context.fillStyle = 'rgb(0,200,0)';
      context.fillRect(0, 0, 160, 120);
    }, 50);
    await streamPip('pipcanvas', canvas.captureStream(20), 2500);
    clearInterval(timer);
  } catch (e) {
    log('piperror', e.name + ':' + e.message);
  }
});
// A camera whose frames no longer reach the engine worker (the test sends a broken stream): the
// track must end instead of running on with a frozen frame
document.getElementById('broken').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => log('brokenended', track.readyState));
    log('brokenlive', track.readyState);
  } catch (e) {
    log('brokenerror', e.name + ':' + e.message);
  }
});
// Sound of a stream in <audio>: 440 Hz from Web Audio through srcObject
let listenAudio = null;
document.getElementById('listen').addEventListener('click', async () => {
  try {
    if (listenAudio) {
      listenAudio.muted = true;
      log('listenmuted', 1);
      return;
    }
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    gain.gain.value = 0.5;
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    await audioContext.resume();
    listenAudio = new Audio();
    listenAudio.srcObject = destination.stream;
    await listenAudio.play();
    log('listen', listenAudio.paused ? 'paused' : 'playing');
  } catch (e) {
    log('listen', e.name + ':' + e.message);
  }
});
const log = (key, value) => console.log('RESULT ' + key + '=' + String(value).replace(/\\s/g, '_'));
log('api', typeof navigator.mediaDevices?.getUserMedia + ',' + typeof navigator.mediaDevices?.getDisplayMedia);
document.getElementById('screen').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    log('screen', video.videoWidth > 0 && video.videoHeight > 0 ? 'picture:' + stream.getVideoTracks()[0].getSettings().displaySurface : 'empty');
    stream.getTracks().forEach((track) => track.stop());
  } catch (e) {
    log('screen', e.name + ':' + e.message);
  }
});
document.getElementById('rec').addEventListener('click', async () => {
  try {
    const types = ['video/webm', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'audio/webm;codecs=opus', 'video/mp4', 'audio/webm;codecs=vp8'];
    log('rectypes', types.map((type) => MediaRecorder.isTypeSupported(type) ? 1 : 0).join(','));
    // Picture: a canvas with changing colors, sound: 440 Hz from Web Audio
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    const context = canvas.getContext('2d');
    let frame = 0;
    const draw = () => {
      context.fillStyle = frame++ % 2 ? 'rgb(255,0,0)' : 'rgb(0,0,255)';
      context.fillRect(0, 0, 160, 120);
    };
    draw();
    const timer = setInterval(draw, 50);
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    oscillator.frequency.value = 440;
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    await audioContext.resume();
    const stream = new MediaStream([...canvas.captureStream(20).getVideoTracks(), ...destination.stream.getAudioTracks()]);
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    const events = [];
    recorder.ondataavailable = (event) => {
      events.push('data');
      if (event.data.size)
        chunks.push(event.data);
    };
    recorder.onstart = () => events.push('start');
    const stopped = new Promise((resolve) => recorder.onstop = resolve);
    recorder.start(500);
    log('recstate', recorder.state);
    // 2.5 s by the clock of the AudioContext: on a busy machine the sound of the engine falls
    // behind the wall clock, the file then has less sound
    const audioStart = audioContext.currentTime;
    const wallStart = performance.now();
    while (audioContext.currentTime - audioStart < 2.5 && performance.now() - wallStart < 15000)
      await new Promise((resolve) => setTimeout(resolve, 100));
    log('rectime', ((performance.now() - wallStart) / 1000).toFixed(2) + ':' + (audioContext.currentTime - audioStart).toFixed(2));
    recorder.stop();
    await stopped;
    clearInterval(timer);
    oscillator.stop();
    log('recmime', recorder.mimeType);
    log('recevents', events[0] + ':' + events.filter((e) => e === 'data').length);
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    log('recsize', bytes.length);
    let binary = '';
    for (const byte of bytes)
      binary += String.fromCharCode(byte);
    log('recdata', btoa(binary));
  } catch (e) {
    log('recerror', e.name + ':' + e.message);
  }
});
document.getElementById('start').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: true });
    log('tracks', stream.getVideoTracks().length + ':' + stream.getAudioTracks().length);
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    video.style.cssText = 'position:absolute;left:20px;top:100px;width:320px;height:240px';
    document.body.append(video);
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    log('videosize', video.videoWidth + 'x' + video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, 64, 48);
    const pixels = context.getImageData(0, 0, 64, 48).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4)
      sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
    log('pixels', sum > 64 * 48 * 30 ? 'picture' : 'black' + sum);
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    audioContext.createMediaStreamSource(stream).connect(analyser);
    await audioContext.resume();
    let peak = 0;
    for (let i = 0; i < 30 && peak < 0.01; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      for (const value of samples)
        peak = Math.max(peak, Math.abs(value));
    }
    log('micpeak', peak > 0.01 ? 'sound' : 'silent' + peak);
    const devices = await navigator.mediaDevices.enumerateDevices();
    log('devices', devices.filter((d) => d.kind !== 'audiooutput').map((d) => d.kind + ':' + d.label).sort().join(','));
    stream.getTracks().forEach((track) => track.stop());
    log('stopped', stream.getVideoTracks()[0].readyState);
  } catch (e) {
    log('error', e.name + ':' + e.message);
  }
});
</script>`;

const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

const stack = await startStack({ token: 'mediastream-token-0123456789abcdef' });
// Fake camera (test picture) and fake microphone (beep) of Chromium
const browser = await launch({
  args: [
    ...SWIFTSHADER,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  permissions: ['camera', 'microphone'],
});
const page = await context.newPage();
const results = collect(page);
const result = (key, ms = TIMEOUT) => results.wait(key, ms, () => results.has('error'));

await openHost(page, stack.app({ url: siteURL, log: '1' }));
await page.evaluate(() => {
  window.blHost.permissionAnswer = 'grant';
});
check(
  'mediaDevices.getUserMedia/getDisplayMedia there',
  (await result('api')) === 'function,function',
  results.get('api'),
);
const box = await canvasOrigin(page);
await page.mouse.click(box.x + 120, box.y + 50);
const asked = await waitEvent(page, /^permission:/, 15000);
const kinds = await page.evaluate(() =>
  window.blHost.permissionRequests.map((r) => r.kind).join(','),
);
check(
  'permission request for camera and microphone',
  !!asked && /camera/.test(kinds) && /microphone/.test(kinds),
  kinds,
);
const err = () => results.get('error') || '';
check(
  'stream with a video and an audio track',
  (await result('tracks', 30000)) === '1:1',
  results.get('tracks') || err(),
);
check('capture-state event: capturing', !!(await waitEvent(page, 'capture-state:true', 10000)));
check(
  '<video>.srcObject shows the camera',
  (await result('videosize', 30000)) === '320x240',
  results.get('videosize') || err(),
);
check(
  'canvas.drawImage(video) has the picture',
  (await result('pixels', 30000)) === 'picture',
  results.get('pixels') || err(),
);
check(
  'microphone in Web Audio (MediaStreamSource)',
  (await result('micpeak', 30000)) === 'sound',
  results.get('micpeak') || err(),
);
check(
  'enumerateDevices with names after the permission',
  (await result('devices', 30000)) === 'audioinput:Microphone,videoinput:Camera',
  results.get('devices') || err(),
);
check(
  'track.stop() ends the track',
  (await result('stopped', 30000)) === 'ended',
  results.get('stopped') || err(),
);
await page.mouse.click(box.x + 360, box.y + 50);
check(
  'getDisplayMedia shows the screen',
  (await result('screen', 30000)) === 'picture:monitor',
  results.get('screen'),
);

// MediaRecorder: canvas + Web Audio as WebM
await page.mouse.click(box.x + 600, box.y + 50);
const recErr = () => results.get('recerror') || '';
check(
  'MediaRecorder.isTypeSupported like Chrome',
  (await result('rectypes', 30000)) === '1,1,1,1,0,0',
  results.get('rectypes') || recErr(),
);
check(
  'MediaRecorder records',
  (await result('recstate', 30000)) === 'recording',
  results.get('recstate') || recErr(),
);
check(
  'MediaRecorder.mimeType like Chrome',
  (await result('recmime', 30000)) === 'video/webm;codecs=vp8,opus',
  results.get('recmime') || recErr(),
);
// Recording time: wall clock and the clock of the AudioContext of the page (in seconds)
const [recWall, recAudio] = (results.get('rectime') || '0:0').split(':').map(Number);
check(
  'AudioContext clock runs while recording',
  recAudio >= 2.5,
  `wall clock ${recWall} s, AudioContext ${recAudio} s`,
);
const recEvents = await result('recevents', 30000);
check(
  'start and several dataavailable (timeslice)',
  /^start:([3-9]|\d\d)$/.test(recEvents || ''),
  recEvents || recErr(),
);
const recData = await result('recdata', 30000);
const webm = recData ? Buffer.from(recData, 'base64') : Buffer.alloc(0);
check(
  'WebM file (EBML header)',
  webm.length > 2000 && webm.readUInt32BE(0) === 0x1a45dfa3,
  `${webm.length} bytes`,
);
// The real Chromium plays the recording: picture size, color, sound
const playback = await page
  .evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
    const video = document.createElement('video');
    video.muted = true;
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () =>
        reject(new Error('video error ' + (video.error && video.error.message)));
    });
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 12;
    const context = canvas.getContext('2d');
    const colors = [];
    for (const time of [0, 0.5, 1, 1.5]) {
      video.currentTime = time;
      await new Promise((resolve) => (video.onseeked = resolve));
      context.drawImage(video, 0, 0, 16, 12);
      colors.push([...context.getImageData(8, 6, 1, 1).data.slice(0, 3)]);
    }
    const [r, g, b] = colors[2];
    const audio = await new AudioContext().decodeAudioData(bytes.buffer.slice(0));
    const samples = audio.getChannelData(0);
    let peak = 0;
    for (const value of samples) peak = Math.max(peak, Math.abs(value));
    return {
      size: video.videoWidth + 'x' + video.videoHeight,
      color: [r, g, b],
      colors,
      audioSeconds: Math.round(audio.duration * 10) / 10,
      peak: Math.round(peak * 100) / 100,
    };
  }, recData || '')
  .catch((e) => ({ error: String(e) }));
check(
  'Chromium plays the recording (picture)',
  playback.size === '160x120' && (playback.color[0] > 200 || playback.color[2] > 200),
  JSON.stringify(playback),
);
// Measured by the clock of the AudioContext, not the wall clock: so a failure shows lost sound in
// the recorder, not a busy machine
check(
  'Chromium plays the recording (sound)',
  playback.audioSeconds >= 0.8 * recAudio && playback.peak > 0.3,
  `${JSON.stringify(playback)}, AudioContext ${recAudio} s`,
);

// Sound of a stream in <audio> (srcObject) reaches the host, muted = silent
const hostPeak = async (done) => {
  let peak = null;
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    peak = (await page.evaluate(() => window.blTest.audioState())).peak;
    if (done(peak)) break;
    await page.waitForTimeout(250);
  }
  return peak;
};
await page.mouse.click(box.x + 840, box.y + 50);
check(
  '<audio>.srcObject plays',
  (await result('listen', 30000)) === 'playing',
  results.get('listen'),
);
const streamPeak = await hostPeak((peak) => peak > 0.3);
check(
  'sound of the stream reaches the host',
  streamPeak > 0.3 && streamPeak < 0.6,
  String(streamPeak),
);
await page.mouse.click(box.x + 840, box.y + 50);
await result('listenmuted', 10000);
const mutedStreamPeak = await hostPeak((peak) => peak <= 0.01);
check('<audio>.muted makes the stream silent', mutedStreamPeak <= 0.01, String(mutedStreamPeak));

// Picture-in-picture for streams: the PiP video of the host shows the track
const hostPip = () =>
  page.evaluate(async () => {
    for (let i = 0; i < 20; i++) {
      const video = document.pictureInPictureElement;
      if (video && video.srcObject && video.videoWidth > 0)
        return video.videoWidth + 'x' + video.videoHeight;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return document.pictureInPictureElement ? 'no-picture' : 'no-pip';
  });
const pipErr = () => results.get('piperror') || '';
await page.mouse.click(box.x + 120, box.y + 430);
check(
  'PiP for a camera stream (srcObject)',
  (await result('pipcam', 30000)) === 'true,true',
  results.get('pipcam') || pipErr(),
);
check(
  'PiP window of the host shows the camera',
  (await hostPip()) === '320x240',
  results.has('pipcam') ? '' : pipErr(),
);
check(
  'PiP camera: events and exit',
  (await result('pipcamevents', 30000)) === 'enter|leave,true',
  results.get('pipcamevents') || pipErr(),
);
await page.mouse.click(box.x + 360, box.y + 430);
check(
  'PiP for a canvas stream (sink of the engine)',
  (await result('pipcanvas', 30000)) === 'true,true',
  results.get('pipcanvas') || pipErr(),
);
check('PiP window of the host shows the canvas', (await hostPip()) === '160x120', pipErr());
check(
  'PiP canvas: events and exit',
  (await result('pipcanvasevents', 30000)) === 'enter|leave,true',
  results.get('pipcanvasevents') || pipErr(),
);
check(
  'PiP video in the host cleaned up',
  await page.evaluate(
    () =>
      [...document.querySelectorAll('video')].every(
        (v) =>
          !(v.srcObject instanceof MediaStream) ||
          v.srcObject.getVideoTracks().every((t) => t.readyState === 'live'),
      ) && !document.pictureInPictureElement,
  ),
);

// Broken frames of the host camera: the page gets "ended", the camera goes off. An ImageBitmap
// has close() but no visibleRect: every frame fails only when copied, the track may only end
// after 30 failures in a row.
await page.evaluate(() => {
  const post = Worker.prototype.postMessage;
  window.__blTestCaptures = [];
  Worker.prototype.postMessage = function (message, transfer) {
    if (message?.blCapture?.readable)
      window.__blTestCaptures.push({
        worker: this,
        id: message.blCapture.id,
        kind: message.blCapture.kind,
      });
    return post.call(this, message, transfer);
  };
});
const eventsBeforeBroken = (await hostEvents(page)).length;
await page.mouse.click(box.x + 840, box.y + 430);
check(
  'camera for the failure case runs',
  (await result('brokenlive', 30000)) === 'live',
  results.get('brokenerror') || '',
);
const captureFound = await page.evaluate(async () => {
  for (let i = 0; i < 50 && !window.__blTestCaptures.some((c) => c.kind === 'video'); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const capture = window.__blTestCaptures.filter((c) => c.kind === 'video').pop();
  if (!capture) return false;
  window.__blTestPulled = 0;
  const readable = new ReadableStream({
    pull: async (controller) => {
      window.__blTestPulled++;
      controller.enqueue(await createImageBitmap(new ImageData(2, 2)));
    },
  });
  capture.worker.postMessage({ blCapture: { id: capture.id, kind: 'video', readable } }, [
    readable,
  ]);
  return true;
});
check(
  'broken frames: the track ends',
  captureFound && (await result('brokenended', 20000)) === 'ended',
  String(captureFound),
);
const brokenPulled = await page.evaluate(() => window.__blTestPulled);
check('broken frames: only after 30 failures in a row', brokenPulled >= 30, String(brokenPulled));
const brokenStates = async () =>
  (await hostEvents(page)).slice(eventsBeforeBroken).filter((e) => e.startsWith('capture-state:'));
check(
  'broken frames: capture-state event on, then off',
  await waitFor(
    async () => (await brokenStates()).join() === 'capture-state:true,capture-state:false',
    10000,
  ),
  (await brokenStates()).join(),
);

await browser.close();
finish();
