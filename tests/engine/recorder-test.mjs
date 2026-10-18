// WebM muxer of MediaRecorder (engine/js/mediarecorder-host.js) without the
// engine: loaded in node, VideoEncoder/AudioEncoder and the engine memory are
// fakes. A small EBML reader reads the output back and checks sizes, tracks,
// cluster boundaries and block times.
//   node tests/engine/recorder-test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok)
    failed++;
};

// ------------------------------------------------- Fakes of the engine

const heap = new ArrayBuffer(64 * 1024 * 1024);
globalThis.HEAPU8 = new Uint8Array(heap);
globalThis.HEAP32 = new Int32Array(heap);
let nextFree = 1024;
const flushed = [];
globalThis.Module = {
  _malloc(size) {
    const ptr = nextFree;
    nextFree += (size + 7) & ~7;
    return ptr;
  },
  blAlloc(size) {
    return this._malloc(size);
  },
  _bl__recorder_flushed: (id) => flushed.push(id),
};
globalThis.stringToNewUTF8 = (text) => {
  console.log('    error to the engine:', text);
  return 1;
};

globalThis.VideoFrame = class {
  constructor(data, init) {
    this.timestamp = init.timestamp;
  }
  close() {}
};
globalThis.AudioData = class {
  constructor(init) {
    this.timestamp = init.timestamp;
  }
  close() {}
};

// Encoders deliver one chunk per input, asynchronously like the real ones. The
// data size comes from chunkSizes (per timestamp), otherwise 10 bytes.
const encoders = [];
class FakeEncoder {
  constructor({ output, error }) {
    this.output = output;
    this.error = error;
    this.state = 'unconfigured';
    this.encodeQueueSize = 0;
    this.configs = [];
    this.pending = Promise.resolve();
    encoders.push(this);
  }
  configure(config) {
    this.state = 'configured';
    this.configs.push(config);
    this.sendConfig = true;
  }
  encode(input, options = {}) {
    const metadata = this.sendConfig ? { decoderConfig: { codec: this.configs.at(-1).codec, description: this.description } } : undefined;
    this.sendConfig = false;
    const size = chunkSizes.get(input.timestamp) ?? 10;
    const chunk = {
      type: this.kind === 'audio' || options.keyFrame ? 'key' : 'delta',
      timestamp: input.timestamp,
      byteLength: size,
      copyTo: (dest) => dest.fill(this.kind === 'audio' ? 0xAA : 0x55),
    };
    this.pending = this.pending.then(() => this.output(chunk, metadata));
  }
  flush() {
    return this.pending;
  }
  close() {
    this.state = 'closed';
  }
}
globalThis.VideoEncoder = class extends FakeEncoder {
  kind = 'video';
};
const OPUS_HEAD = Uint8Array.from([...Buffer.from('OpusHead'), 1, 1, 0x38, 1, 0x80, 0xBB, 0, 0, 0, 0, 0]);
globalThis.AudioEncoder = class extends FakeEncoder {
  kind = 'audio';
  description = OPUS_HEAD;
};

vm.runInThisContext(readFileSync(new URL('../../engine/js/mediarecorder-host.js', import.meta.url), 'utf8'));
const recorder = globalThis.blRecorder;

// Data size per timestamp (us); around the boundaries of the EBML lengths
const chunkSizes = new Map();

// Inputs in time order: ['v', us, width, height] or ['a', us]
async function record(id, config, inputs) {
  if (recorder.create(id, JSON.stringify(config)) !== 0)
    return null;
  for (const [kind, timestamp, width = 64, height = 48] of inputs) {
    if (kind === 'v')
      recorder.video(id, 0, width * height * 4, 5, width, height, timestamp);
    else
      recorder.audio(id, 0, 960, 1, 48000, timestamp);
  }
  recorder.flush(id);
  for (let i = 0; i < 100 && !flushed.includes(id); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const lengthPtr = 16;
  const ptr = recorder.take(id, lengthPtr);
  const bytes = ptr ? HEAPU8.slice(ptr, ptr + HEAP32[lengthPtr >> 2]) : new Uint8Array(0);
  recorder.close(id);
  return bytes;
}

// ------------------------------------------------------------ EBML reader

const ID = { EBML: 0x1A45DFA3, DocType: 0x4282, Segment: 0x18538067, Info: 0x1549A966, TimecodeScale: 0x2AD7B1, Tracks: 0x1654AE6B,
  TrackEntry: 0xAE, TrackNumber: 0xD7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63A2, Video: 0xE0, PixelWidth: 0xB0,
  PixelHeight: 0xBA, Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F, Cluster: 0x1F43B675, Timecode: 0xE7, SimpleBlock: 0xA3 };
const MASTERS = new Set([ID.EBML, ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Audio, ID.Cluster]);

function vint(bytes, pos, keepMarker) {
  const first = bytes[pos];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1))))
    length++;
  if (length > 8 || pos + length > bytes.length)
    throw new Error(`invalid length at ${pos}`);
  const mask = 0xFF >> length;
  let value = keepMarker ? first : first & mask;
  let allOnes = (first & mask) === mask;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[pos + i];
    allOnes &&= bytes[pos + i] === 0xFF;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

// Unknown length (segment, cluster): up to the end of the parent element, a
// cluster ends at the next cluster
function readElement(bytes, pos, end) {
  const id = vint(bytes, pos, true);
  const size = vint(bytes, pos + id.length, false);
  const dataStart = pos + id.length + size.length;
  if (!size.unknown && dataStart + size.value > end)
    throw new Error(`element ${id.value.toString(16)} at ${pos} goes beyond its parent element`);
  const dataEnd = size.unknown ? end : dataStart + size.value;
  const element = { id: id.value, unknown: size.unknown };
  if (!MASTERS.has(id.value)) {
    element.data = bytes.subarray(dataStart, dataEnd);
    return { element, next: dataEnd };
  }
  const children = readChildren(bytes, dataStart, dataEnd, id.value);
  element.children = children.list;
  return { element, next: size.unknown ? children.next : dataEnd };
}
function readChildren(bytes, pos, end, parent) {
  const list = [];
  while (pos < end) {
    if (parent === ID.Cluster && vint(bytes, pos, true).value === ID.Cluster)
      break;
    const { element, next } = readElement(bytes, pos, end);
    list.push(element);
    pos = next;
  }
  return { list, next: pos };
}

const all = (list, id) => list.filter((element) => element.id === id);
const one = (list, id) => list.find((element) => element.id === id);
const uint = (element) => element.data.reduce((value, byte) => value * 256 + byte, 0);
const text = (element) => Buffer.from(element.data).toString();
const float = (element) => new DataView(element.data.buffer, element.data.byteOffset, element.data.byteLength).getFloat64(0);

// Whole file: header, tracks and per cluster the time and the blocks
function readWebM(bytes) {
  const top = readChildren(bytes, 0, bytes.length, null);
  if (top.next !== bytes.length)
    throw new Error('file not read completely');
  const segment = one(top.list, ID.Segment);
  const tracks = all(one(segment.children, ID.Tracks).children, ID.TrackEntry).map((entry) => {
    const video = one(entry.children, ID.Video);
    const audio = one(entry.children, ID.Audio);
    const privateData = one(entry.children, ID.CodecPrivate);
    return {
      number: uint(one(entry.children, ID.TrackNumber)),
      type: uint(one(entry.children, ID.TrackType)),
      codec: text(one(entry.children, ID.CodecID)),
      codecPrivate: privateData ? [...privateData.data] : null,
      width: video ? uint(one(video.children, ID.PixelWidth)) : null,
      height: video ? uint(one(video.children, ID.PixelHeight)) : null,
      rate: audio ? float(one(audio.children, ID.SamplingFrequency)) : null,
      channels: audio ? uint(one(audio.children, ID.Channels)) : null,
    };
  });
  const clusters = all(segment.children, ID.Cluster).map((cluster) => ({
    unknown: cluster.unknown,
    time: uint(one(cluster.children, ID.Timecode)),
    blocks: all(cluster.children, ID.SimpleBlock).map(({ data }) => ({
      track: data[0] & 0x7F,
      relative: new DataView(data.buffer, data.byteOffset).getInt16(1),
      key: !!(data[3] & 0x80),
      size: data.length - 4,
      fill: data[4],
    })),
  }));
  return {
    docType: text(one(one(top.list, ID.EBML).children, ID.DocType)),
    segmentUnknown: segment.unknown,
    timecodeScale: uint(one(one(segment.children, ID.Info).children, ID.TimecodeScale)),
    tracks,
    clusters,
  };
}
const blockTimes = (webm, track) => webm.clusters.flatMap((c) => c.blocks.filter((b) => b.track === track).map((b) => c.time + b.relative));

// ------------------------------------------------------------------ Cases

// A frame every 100 ms and sound every 20 ms, 3 s long: key frame every 2 s
// (KEYFRAME_INTERVAL), a new cluster starts there
{
  const inputs = [];
  for (let ms = 0; ms < 3000; ms += 20) {
    if (ms % 100 === 0)
      inputs.push(['v', ms * 1000]);
    inputs.push(['a', ms * 1000 + 5000]);
  }
  // Blocks around the boundaries of the EBML lengths (126/127 and 16382/16383 bytes of content)
  [122, 123, 16378, 16379].forEach((size, i) => chunkSizes.set((i + 1) * 100000, size));
  const webm = readWebM(await record(1, { video: { codec: 'vp8', bitrate: 1e6 }, audio: { bitrate: 64000 } }, inputs));
  check('header: DocType webm, segment with unknown length, time in ms', webm.docType === 'webm' && webm.segmentUnknown && webm.timecodeScale === 1e6);
  const [video, audio] = webm.tracks;
  check('tracks: VP8 and Opus', webm.tracks.length === 2 && video.codec === 'V_VP8' && video.number === 1 && video.type === 1
    && audio.codec === 'A_OPUS' && audio.number === 2 && audio.type === 2, JSON.stringify(webm.tracks));
  check('video: size in the track', video.width === 64 && video.height === 48);
  check('audio: OpusHead from the encoder, 48 kHz, 1 channel', JSON.stringify(audio.codecPrivate) === JSON.stringify([...OPUS_HEAD]) && audio.rate === 48000 && audio.channels === 1);
  check('cluster at every key frame (0 s, 2 s)', JSON.stringify(webm.clusters.map((c) => c.time)) === '[0,2000]' && webm.clusters.every((c) => c.unknown),
    JSON.stringify(webm.clusters.map((c) => c.time)));
  check('cluster starts with the key frame', webm.clusters.every((c) => c.blocks[0].track === 1 && c.blocks[0].key && c.blocks[0].relative === 0));
  const videoTimes = blockTimes(webm, 1);
  const audioTimes = blockTimes(webm, 2);
  check('all frames, times relative to the cluster', videoTimes.length === 30 && videoTimes.every((t, i) => t === i * 100), videoTimes.slice(0, 5).join(','));
  check('all sound, times relative to the cluster', audioTimes.length === 150 && audioTimes.every((t, i) => t === i * 20 + 5), audioTimes.slice(0, 5).join(','));
  const keys = webm.clusters.flatMap((c) => c.blocks.filter((b) => b.track === 1 && b.key).map((b) => c.time + b.relative));
  check('key frames only every 2 s', JSON.stringify(keys) === '[0,2000]', JSON.stringify(keys));
  const sizes = webm.clusters.flatMap((c) => c.blocks.filter((b) => b.track === 1).map((b) => b.size));
  check('block sizes around the length boundaries', JSON.stringify(sizes.slice(1, 5)) === '[122,123,16378,16379]' && webm.clusters.every((c) => c.blocks.every((b) => b.fill === (b.track === 1 ? 0x55 : 0xAA))),
    JSON.stringify(sizes.slice(0, 6)));
  chunkSizes.clear();
}

// Sound only, 12 s: a new cluster every 5 s
{
  const inputs = [];
  for (let ms = 0; ms < 12000; ms += 20)
    inputs.push(['a', ms * 1000]);
  const webm = readWebM(await record(2, { audio: { bitrate: 64000 } }, inputs));
  check('sound only: one track', webm.tracks.length === 1 && webm.tracks[0].codec === 'A_OPUS' && webm.tracks[0].number === 1);
  check('sound only: cluster every 5 s', JSON.stringify(webm.clusters.map((c) => c.time)) === '[0,5000,10000]', JSON.stringify(webm.clusters.map((c) => c.time)));
  check('sound only: all blocks, relative time below 5 s', blockTimes(webm, 1).length === 600 && webm.clusters.every((c) => c.blocks.every((b) => b.relative >= 0 && b.relative < 5000)));
}

// Video announced but never a frame: after 1 s of sound the track is dropped,
// the sound becomes track 1
{
  const inputs = [];
  for (let ms = 0; ms < 2000; ms += 20)
    inputs.push(['a', ms * 1000]);
  const webm = readWebM(await record(3, { video: { codec: 'vp9' }, audio: {} }, inputs));
  check('track without data is dropped, sound becomes track 1', webm.tracks.length === 1 && webm.tracks[0].codec === 'A_OPUS' && webm.tracks[0].number === 1, JSON.stringify(webm.tracks));
  check('without the empty track: all blocks on track 1', blockTimes(webm, 1).length === 100 && webm.clusters.every((c) => c.blocks.every((b) => b.track === 1)));
}

// Video announced but only one frame, then 35 s of sound only: no 5 s cut
// (there is video), a new cluster only after more than 30 s, so the relative
// time fits into the int16 of the block
{
  const inputs = [['v', 0]];
  for (let ms = 0; ms < 35000; ms += 20)
    inputs.push(['a', ms * 1000]);
  const webm = readWebM(await record(7, { video: { codec: 'vp8' }, audio: {} }, inputs));
  check('long sound after one frame: cluster at 0 s and after 30 s', JSON.stringify(webm.clusters.map((c) => c.time)) === '[0,30020]', JSON.stringify(webm.clusters.map((c) => c.time)));
  check('long sound: all blocks, relative time at most 30 s', blockTimes(webm, 2).length === 1750
    && webm.clusters.every((c) => c.blocks.every((b) => b.relative >= 0 && b.relative <= 30000)));
}

// New frame size: encoder reconfigured, a key frame and a new cluster right
// away, the track keeps the first size
{
  const before = encoders.length;
  const inputs = [];
  for (let ms = 0; ms < 1500; ms += 100)
    inputs.push(ms < 1000 ? ['v', ms * 1000, 64, 48] : ['v', ms * 1000, 32, 24]);
  const webm = readWebM(await record(4, { video: { codec: 'vp8' } }, inputs));
  const encoder = encoders[before];
  check('new size: encoder reconfigured', encoder.configs.map((c) => c.width + 'x' + c.height).join(',') === '64x48,32x24');
  check('new size: key frame and cluster', JSON.stringify(webm.clusters.map((c) => c.time)) === '[0,1000]', JSON.stringify(webm.clusters.map((c) => c.time)));
  check('new size: track with the first size', webm.tracks[0].width === 64 && webm.tracks[0].height === 48);
}

// Errors and idle
check('unknown codec: error to the engine', recorder.create(5, JSON.stringify({ video: { codec: 'h264' } })) !== 0);
HEAP32[4] = 99;
check('take without data: 0 and length 0', recorder.take(6, 16) === 0 && HEAP32[4] === 0);

console.log(failed ? `${failed} test(s) failed` : 'All tests ok');
process.exit(failed ? 1 : 0);
