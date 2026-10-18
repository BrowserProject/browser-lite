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

/** WebM (VP8, no sound) of a red canvas, recorded in the Chromium of the test. */
export async function recordClip(browser, seconds = 3) {
  const recorder = await browser.newPage();
  await recorder.goto('about:blank');
  const bytes = await recorder.evaluate(async (ms) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    const media = new MediaRecorder(canvas.captureStream(25), {
      mimeType: 'video/webm;codecs=vp8',
    });
    const chunks = [];
    media.ondataavailable = (e) => chunks.push(e.data);
    const timer = setInterval(() => {
      ctx.fillStyle = '#e00000';
      ctx.fillRect(0, 0, 320, 240);
    }, 40);
    media.start(500);
    await new Promise((r) => setTimeout(r, ms));
    await new Promise((r) => {
      media.onstop = r;
      media.stop();
    });
    clearInterval(timer);
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  }, seconds * 1000);
  await recorder.close();
  return Buffer.from(bytes);
}
