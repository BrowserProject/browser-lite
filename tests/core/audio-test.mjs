// Web Audio through @browser-lite/core: the page in the engine makes sound, the audio service of
// the core plays it through an AudioWorklet in the real Chromium.
//
// Checked: oscillator (inverse FFT for the wave tables), AnalyserNode (FFT), ConvolverNode (FFT
// convolution), decodeAudioData (decoder of the host browser, with rate conversion), HRTF panner
// (data in engine.data), that sound really reaches the host after a click, the media-state
// event and muting the view.
//
//   node tests/core/audio-test.mjs [engine-dir]
import {
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitEvent,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>Audio test</title><body style="margin:0;height:100vh;background:#eef">Audio test<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);

// WAV (16 bit, mono) with a sine
function wav(rate, seconds, frequency) {
  const frames = rate * seconds;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++)
    view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * frequency * i / rate) * 16000), true);
  return buffer;
}

async function offlineTests() {
  // The oscillator must be a clean sine
  const plain = new OfflineAudioContext(1, 4800, 48000);
  const osc = plain.createOscillator();
  osc.frequency.value = 1000;
  osc.connect(plain.destination);
  osc.start();
  const reference = (await plain.startRendering()).getChannelData(0);
  let sineError = 0;
  for (let i = 0; i < reference.length; i++)
    sineError = Math.max(sineError, Math.abs(reference[i] - Math.sin(2 * Math.PI * 1000 * i / 48000)));
  result('sine', sineError.toFixed(4));

  // Convolution with an impulse shifted by 200 samples = shifted signal
  const offline = new OfflineAudioContext(1, 4800, 48000);
  const osc2 = offline.createOscillator();
  osc2.frequency.value = 1000;
  const convolver = offline.createConvolver();
  convolver.normalize = false;
  const impulse = offline.createBuffer(1, 1024, 48000);
  impulse.getChannelData(0)[200] = 1;
  convolver.buffer = impulse;
  osc2.connect(convolver);
  convolver.connect(offline.destination);
  osc2.start();
  const convolved = (await offline.startRendering()).getChannelData(0);
  let convolveError = 0;
  for (let i = 200; i < convolved.length; i++)
    convolveError = Math.max(convolveError, Math.abs(convolved[i] - reference[i - 200]));
  result('convolver', convolveError.toFixed(4));
}

async function hrtfTest() {
  const offline = new OfflineAudioContext(2, 9600, 48000);
  const osc = offline.createOscillator();
  const panner = new PannerNode(offline, { panningModel: 'HRTF', positionX: 1, positionZ: -1 });
  osc.connect(panner);
  panner.connect(offline.destination);
  osc.start();
  const buffer = await offline.startRendering();
  let left = 0, right = 0;
  for (let i = 4800; i < 9600; i++) {
    left = Math.max(left, Math.abs(buffer.getChannelData(0)[i]));
    right = Math.max(right, Math.abs(buffer.getChannelData(1)[i]));
  }
  // Source on the right: right louder than left
  result('hrtf', left.toFixed(3) + ',' + right.toFixed(3));
}

(async () => {
  try {
    await offlineTests();
  } catch (e) {
    result('sine', 'error:' + e);
  }

  const context = new AudioContext();
  result('rate', context.sampleRate);
  // Let the HRTF data load (happens in the background)
  new PannerNode(context, { panningModel: 'HRTF' });

  try {
    const decoded = await context.decodeAudioData(wav(22050, 1, 440));
    let peak = 0;
    for (const value of decoded.getChannelData(0))
      peak = Math.max(peak, Math.abs(value));
    result('decode', decoded.sampleRate + ',' + decoded.length + ',' + peak.toFixed(2));
  } catch (e) {
    result('decode', 'error:' + e);
  }

  // 440 Hz through an analyser to the output (keeps running, so the host has sound)
  const osc = context.createOscillator();
  osc.frequency.value = 440;
  const gain = context.createGain();
  gain.gain.value = 0.5;
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  osc.connect(gain);
  gain.connect(analyser);
  analyser.connect(context.destination);
  osc.start();
  const start = context.currentTime;
  setTimeout(async () => {
    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    let best = 0;
    for (let i = 1; i < bins.length; i++)
      if (bins[i] > bins[best]) best = i;
    result('analyser', Math.round(best * context.sampleRate / analyser.fftSize));
    result('time', (context.currentTime - start).toFixed(2));
    try {
      await hrtfTest();
    } catch (e) {
      result('hrtf', 'error:' + e);
    }
  }, 1500);
})();
</script>`;

const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

const stack = await startStack({ token: 'audio-token-0123456789abcdef' });
const browser = await launch();
const page = await browser.newPage();
const results = collect(page);
const result = (key) => results.wait(key);
await openHost(page, stack.app({ url: siteURL }));

const sine = await result('sine');
check('oscillator is a clean sine', Number(sine) < 0.01, `(deviation ${sine})`);
const convolver = await result('convolver');
check(
  'ConvolverNode (FFT convolution) shifts exactly',
  Number(convolver) < 0.001,
  `(deviation ${convolver})`,
);
check('AudioContext with 48 kHz', (await result('rate')) === '48000');
const decode = (await result('decode')) || '';
const [decodedRate, decodedLength, decodedPeak] = decode.split(',').map(Number);
check(
  'decodeAudioData (WAV 22.05 kHz -> 48 kHz)',
  decodedRate === 48000 &&
    Math.abs(decodedLength - 48000) < 100 &&
    Math.abs(decodedPeak - 0.49) < 0.03,
  decode,
);

// A click as user activation, so the host AudioContext may start
const box = await canvasOrigin(page);
await page.mouse.click(box.x + 50, box.y + 50);

const analyser = Number(await result('analyser'));
check('AnalyserNode finds 440 Hz', Math.abs(analyser - 440) < 30, `(${analyser} Hz)`);
const time = Number(await result('time'));
check('currentTime runs', time > 1 && time < 3, `(${time} s)`);

let state = null;
const end = Date.now() + 20000;
while (Date.now() < end) {
  state = await page.evaluate(() => window.blTest.audioState());
  if (state.state === 'running' && state.peak > 0.3) break;
  await page.waitForTimeout(250);
}
check(
  'sound reaches the host (AudioWorklet)',
  state?.state === 'running' && state.peak > 0.3 && state.peak < 0.6,
  JSON.stringify(state),
);

// The view reports sound (media-state), setMuted() mutes it
check(
  'media-state event: audible',
  !!(await waitEvent(page, 'media-state:true', 10000)) &&
    (await page.evaluate(() => window.blTest.view().audible)),
);
const peakUntil = async (done) => {
  let peak = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    peak = (await page.evaluate(() => window.blTest.audioState())).peak;
    if (done(peak)) break;
  }
  return peak;
};
await page.evaluate(() => window.blTest.view().setMuted(true));
const mutedPeak = await peakUntil((peak) => peak <= 0.01);
check(
  'view muted: no more sound',
  mutedPeak <= 0.01 && (await page.evaluate(() => window.blTest.view().muted)),
  String(mutedPeak),
);
await page.evaluate(() => window.blTest.view().setMuted(false));
const unmutedPeak = await peakUntil((peak) => peak > 0.3);
check('sound on again', unmutedPeak > 0.3, String(unmutedPeak));

const hrtf = (await result('hrtf')) || '';
const [left, right] = hrtf.split(',').map(Number);
check('HRTF panner (source on the right)', right > 0.05 && right > left, hrtf);

await browser.close();
finish();
