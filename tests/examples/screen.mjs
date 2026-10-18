// Pixels of element screenshots for the examples suite (the example pages have no test hooks).
import { inflateSync } from 'node:zlib';
import { TIMEOUT } from '../lib/index.mjs';

/** Pixels of a PNG screenshot (8 bit RGB or RGBA, not interlaced): (x, y) => [r, g, b]. */
function decodePNG(png) {
  let width = 0;
  let height = 0;
  let channels = 4;
  const data = [];
  for (let pos = 8; pos < png.length; ) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const chunk = png.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      channels = chunk[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') data.push(chunk);
    pos += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? out[(y - 1) * stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = (value + predicted) & 255;
    }
  }
  return (x, y) => [...out.subarray(y * stride + x * channels, y * stride + x * channels + 3)];
}

/** True once the element shows the red square of the test page at (50, 50). */
export async function rendersRed(locator, ms = TIMEOUT) {
  for (
    const end = Date.now() + ms;
    Date.now() < end;
    await new Promise((r) => setTimeout(r, 250))
  ) {
    const [r, g, b] = decodePNG(await locator.screenshot())(50, 50);
    if (r > 200 && g < 60 && b < 60) return true;
  }
  return false;
}

/** The page with the red square at (0, 0) that both examples load through the relay. */
export const RED_PAGE = `<!doctype html><title>Example page</title>
<style>body { margin: 0 } #red { position: absolute; left: 0; top: 0; width: 100px; height: 100px; background: #ff0000 }</style>
<div id="red"></div>`;
