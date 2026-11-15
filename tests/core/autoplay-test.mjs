// Autoplay with sound like Chrome's policy: media that is not muted and Web Audio start only once
// the user activated the page, and that activation is sticky for the document. Muted video
// autoplays without one. Before, BBC's player started its IMA pre-roll with sound by itself, and
// the user's tap on the play button clicked the playing ad, which opened the advertiser's site.
//
// Checked: without activation an unmuted autoplay video with sound stays paused, play() of an
// unmuted video without an audio track and of an <audio> is refused (NotAllowedError), an
// AudioContext stays suspended, unmuting a muted video that plays pauses it, the muted autoplay
// video plays, and the host plays none of the others. After a click and longer than a transient
// activation lasts, all of it may play with sound, an AudioContext made then runs. A document
// loaded afterwards starts without activation again.
//
//   node tests/core/autoplay-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  canvasOrigin,
  check,
  collect,
  evalPage,
  finish,
  launch,
  load,
  openHost,
  recordClip,
  serve,
  serveBytes,
  startStack,
  timeLimit,
  wav,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>Autoplay</title><body style="margin:0;height:100vh;background:#eef">
<video id="sound" src="/sound-clip.webm" autoplay loop playsinline width="160" height="120"></video>
<video id="muted" src="/sound-clip.webm" muted autoplay loop playsinline width="160" height="120"></video>
<video id="unmute" src="/sound-clip.webm" muted autoplay loop playsinline width="160" height="120"></video>
<video id="silent" src="/clip.webm" loop playsinline width="160" height="120"></video>
<audio id="tone" src="/tone.wav" loop></audio>
<script>
const result = (key, value) => console.log('RESULT ' + location.search.slice(1) + key + '=' + value);
const $ = (id) => document.getElementById(id);
const play = (id, key) => $(id).play().then(() => result(key, 'ok'), (e) => result(key, e.name));
$('muted').addEventListener('playing', () => result('muted', 'playing'), { once: true });
// Unmuted by a script while it plays: Chrome pauses it
$('unmute').addEventListener('playing', () => {
  $('unmute').muted = false;
  setTimeout(() => result('unmuted', $('unmute').paused), 500);
}, { once: true });
play('silent', 'silent');
play('tone', 'tone');
const context = new AudioContext();
context.resume();
setTimeout(() => result('context', context.state + ',' + $('sound').paused), 3000);
// Run by the test through blTest.eval (which is no activation) once the page was clicked
window.later = () => {
  play('silent', 'silentlater');
  play('tone', 'tonelater');
  play('sound', 'soundlater');
  const later = new AudioContext();
  later.resume().then(() => result('contextlater', later.state));
};
document.addEventListener('click', () => result('clicked', '1'));
</script>`;

const browser = await launch({
  args: [...SWIFTSHADER, '--autoplay-policy=no-user-gesture-required'],
});
const MEDIA = {
  '/tone.wav': [wav(10), 'audio/wav'],
  '/clip.webm': [await recordClip(browser, 3), 'video/webm'],
  '/sound-clip.webm': [await recordClip(browser, 3, { audio: true }), 'video/webm'],
};
const { url: siteURL } = await serve((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (MEDIA[path]) return serveBytes(req, res, ...MEDIA[path]);
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(PAGE);
});

const stack = await startStack({ token: 'autoplay-token-0123456789abcd' });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(page);
const result = (key) => results.wait(key, 30000);
const hostPlaying = async () =>
  (await page.evaluate(() => window.blTest.mediaState())).filter((p) => !p.paused).length;
await openHost(page, stack.app({ url: siteURL }));

// Without activation
check('muted autoplay video plays', (await result('muted')) === 'playing');
check(
  'unmuted video without an audio track: play() refused',
  (await result('silent')) === 'NotAllowedError',
  results.get('silent'),
);
check('<audio>: play() refused', (await result('tone')) === 'NotAllowedError', results.get('tone'));
check(
  'AudioContext suspended, autoplay video with sound paused',
  (await result('context')) === 'suspended,true',
  results.get('context'),
);
check(
  'muted video unmuted by a script pauses',
  (await result('unmuted')) === 'true',
  results.get('unmuted'),
);
const before = await hostPlaying();
check('host plays only the muted video', before === 1, String(before));

// A click activates the page; past a transient activation (5 s) the activation still counts
const box = await canvasOrigin(page);
await page.mouse.click(box.x + 500, box.y + 400);
check('click reaches the page', (await result('clicked')) === '1');
await page.waitForTimeout(6000);
await evalPage(page, 'later()');
check(
  'after a click: play() of <audio>',
  (await result('tonelater')) === 'ok',
  results.get('tonelater'),
);
check(
  'after a click: play() of the video without an audio track',
  (await result('silentlater')) === 'ok',
  results.get('silentlater'),
);
check(
  'after a click: play() of the video with sound',
  (await result('soundlater')) === 'ok',
  results.get('soundlater'),
);
check(
  'after a click: new AudioContext runs',
  (await result('contextlater')) === 'running',
  results.get('contextlater'),
);

// A new document (like a reload) has no activation
await load(page, `${siteURL}?next`);
check(
  'next document: <audio> play() refused again',
  (await result('nexttone')) === 'NotAllowedError',
  results.get('nexttone'),
);
check('next document: AudioContext suspended', (await result('nextcontext')) === 'suspended,true');

await browser.close();
finish();
