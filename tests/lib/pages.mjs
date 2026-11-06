// Local test servers for the pages the engine loads (through the relay) and generated media.
import http from 'node:http';

/** HTTP server on 127.0.0.1 with a free port; url ends with /. */
export async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

/** Sends data like a media server with Range (206). Returns [start, end], null without Range. */
export function serveBytes(req, res, data, type) {
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (!range) {
    res
      .writeHead(200, {
        'Content-Type': type,
        'Content-Length': data.length,
        'Accept-Ranges': 'bytes',
      })
      .end(data);
    return null;
  }
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : data.length - 1, data.length - 1);
  res
    .writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      'Accept-Ranges': 'bytes',
    })
    .end(data.subarray(start, end + 1));
  return [start, end];
}

/** WAV (16 bit, mono) with a sine; frequency 0 is silence. */
export function wav(seconds, { rate = 22050, frequency = 440, amplitude = 8000 } = {}) {
  const frames = Math.round(seconds * rate);
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; frequency && i < frames; i++)
    buffer.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * amplitude),
      44 + i * 2,
    );
  return buffer;
}

/**
 * WebM (VP8) of a red canvas, recorded in the browser of the test; with `audio` also a quiet sine
 * (Opus), otherwise without an audio track; with `transparent` the right half is transparent (VP8
 * with alpha where the browser records it).
 */
export async function recordClip(
  browser,
  seconds = 3,
  { audio = false, transparent = false } = {},
) {
  const recorder = await browser.newPage();
  await recorder.goto('about:blank');
  const bytes = await recorder.evaluate(
    async ([ms, withAudio, withAlpha]) => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(25);
      const sound = withAudio ? new AudioContext() : null;
      if (sound) {
        // Without an audio device (Firefox under Xvfb) it never resumes; the track exists anyway
        sound.resume();
        const oscillator = sound.createOscillator();
        const gain = sound.createGain();
        const target = sound.createMediaStreamDestination();
        gain.gain.value = 0.05;
        oscillator.connect(gain).connect(target);
        oscillator.start();
        stream.addTrack(target.stream.getAudioTracks()[0]);
      }
      const media = new MediaRecorder(stream, {
        mimeType: withAudio ? 'video/webm;codecs=vp8,opus' : 'video/webm;codecs=vp8',
      });
      const chunks = [];
      media.ondataavailable = (e) => chunks.push(e.data);
      const timer = setInterval(() => {
        ctx.clearRect(0, 0, 320, 240);
        ctx.fillStyle = '#e00000';
        ctx.fillRect(0, 0, withAlpha ? 160 : 320, 240);
      }, 40);
      media.start(500);
      await new Promise((r) => setTimeout(r, ms));
      await new Promise((r) => {
        media.onstop = r;
        media.stop();
      });
      clearInterval(timer);
      sound?.close();
      return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    },
    [seconds * 1000, audio, transparent],
  );
  await recorder.close();
  return Buffer.from(bytes);
}

/**
 * Answers the in-page dialogs of @browser-lite/ui (`.bl-page-dialog`) in page, also after a
 * reload: `respond(type, text)` gets the type (`alert`, `confirm`, `prompt`, `beforeunload`,
 * `many-dialogs`) and the title and message separated by an empty line (like the text of a native
 * dialog) and returns, or resolves, 'accept', 'dismiss' or the text a prompt accepts.
 */
export async function answerPageDialogs(page, respond) {
  await page.exposeBinding('blAnswerDialog', (_source, type, text) => respond(type, text));
  const install = () => {
    if (window.blDialogWatch) return;
    window.blDialogWatch = true;
    const seen = new WeakSet();
    const check = () => {
      for (const form of document.querySelectorAll('.bl-page-dialog')) {
        if (seen.has(form)) continue;
        seen.add(form);
        const text = [form.querySelector('h2'), form.querySelector('.bl-message')]
          .filter(Boolean)
          .map((node) => node.textContent)
          .join('\n\n');
        window.blAnswerDialog(form.dataset.blType, text).then((answer) => {
          if (!form.isConnected) return;
          const input = form.querySelector('input');
          if (input && typeof answer === 'string' && answer !== 'accept' && answer !== 'dismiss')
            input.value = answer;
          // An alert has only OK
          const cancel = answer === 'dismiss' ? form.querySelector('.bl-cancel') : null;
          (cancel ?? form.querySelector('.bl-ok'))?.click();
        });
      }
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
    check();
  };
  await page.addInitScript(install);
  await page.evaluate(install).catch(() => {});
}
