// @ts-check
// engine-audio-player plays the audio of the engine. The engine renders Web Audio on its own
// thread into a ring buffer in the shared WASM memory (AudioDestinationWasm.cpp, patch 0013).
// Header (32 bytes, uint32): [written, read, capacity, channels, heartbeat, ...], then float32
// samples with interleaved channels. Counters are in frames. The heartbeat tells the engine we
// are playing.

/**
 * @typedef {{ buffer: SharedArrayBuffer, ptr: number, capacity: number, channels: number }} PlayerOptions
 */

class EngineAudioPlayer extends AudioWorkletProcessor {
  /** @param {{ processorOptions: unknown }} options */
  constructor(options) {
    super();
    const { buffer, ptr, capacity, channels } = /** @type {PlayerOptions} */ (
      options.processorOptions
    );
    this.header = new Uint32Array(buffer, ptr, 8);
    this.samples = new Float32Array(buffer, ptr + 32, capacity * channels);
    this.mask = capacity - 1;
    this.channels = channels;
    this.running = true;
    this.peak = 0;
    this.blocks = 0;
    /** @param {{ data: unknown }} event */
    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.running = false;
    };
  }

  /**
   * @param {Float32Array[][]} _inputs
   * @param {Float32Array[][]} outputs
   */
  process(_inputs, outputs) {
    if (!this.running) return false;
    Atomics.add(this.header, 4, 1);
    const output = outputs[0];
    const first = output?.[0];
    if (!output || !first) return true;
    const frames = first.length;
    const written = Atomics.load(this.header, 0);
    const read = Atomics.load(this.header, 1);
    const count = Math.min(frames, (written - read) >>> 0);
    for (let c = 0; c < output.length; c++) {
      const out = /** @type {Float32Array} */ (output[c]);
      const source = Math.min(c, this.channels - 1);
      for (let i = 0; i < count; i++)
        out[i] = /** @type {number} */ (
          this.samples[((read + i) & this.mask) * this.channels + source]
        );
    }
    Atomics.store(this.header, 1, (read + count) >>> 0);
    for (let i = 0; i < count; i++)
      this.peak = Math.max(this.peak, Math.abs(/** @type {number} */ (first[i])));
    if (++this.blocks >= 64) {
      this.port.postMessage({ peak: this.peak, underrun: count < frames });
      this.peak = 0;
      this.blocks = 0;
    }
    return true;
  }
}

registerProcessor('engine-audio-player', EngineAudioPlayer);

/**
 * Hands the samples of its input to the page in planes of 1024 frames (stand-in for
 * MediaStreamTrackProcessor, services/track-reader.ts). Outputs silence.
 */
class EngineAudioCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Float32Array[][]} */
    this.blocks = [];
    this.frames = 0;
  }

  flush() {
    const first = this.blocks[0];
    if (!first) return;
    const planes = first.map((_, channel) => {
      const plane = new Float32Array(this.frames);
      let offset = 0;
      for (const block of this.blocks) {
        const samples = /** @type {Float32Array} */ (block[channel]);
        plane.set(samples, offset);
        offset += samples.length;
      }
      return plane;
    });
    this.port.postMessage(
      planes,
      planes.map((plane) => plane.buffer),
    );
    this.blocks = [];
    this.frames = 0;
  }

  /** @param {Float32Array[][]} inputs */
  process(inputs) {
    const input = inputs[0];
    const first = input?.[0];
    if (!input || !first) return true;
    if (this.blocks.length && this.blocks[0]?.length !== input.length) this.flush();
    this.blocks.push(input.map((channel) => channel.slice()));
    this.frames += first.length;
    if (this.frames >= 1024) this.flush();
    return true;
  }
}

registerProcessor('engine-audio-capture', EngineAudioCapture);

/**
 * Plays the samples the page sends ({ planes, sampleRate }, planar), into a
 * MediaStreamAudioDestinationNode (stand-in for MediaStreamTrackGenerator,
 * services/track-streams.ts). At most half a second waits, older samples are dropped.
 */
class EngineAudioFeed extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {{ planes: Float32Array[], sampleRate: number }[]} */
    this.queue = [];
    this.position = 0;
    /** @param {{ data: unknown }} event */
    this.port.onmessage = (event) => {
      this.queue.push(/** @type {{ planes: Float32Array[], sampleRate: number }} */ (event.data));
      let frames = 0;
      for (const chunk of this.queue) frames += chunk.planes[0]?.length ?? 0;
      while (frames > sampleRate / 2 && this.queue.length > 1) {
        frames -= this.queue.shift()?.planes[0]?.length ?? 0;
        this.position = 0;
      }
    };
  }

  /**
   * @param {Float32Array[][]} _inputs
   * @param {Float32Array[][]} outputs
   */
  process(_inputs, outputs) {
    const output = outputs[0];
    const frames = output?.[0]?.length ?? 0;
    let i = 0;
    while (output && i < frames && this.queue.length) {
      const chunk = /** @type {{ planes: Float32Array[], sampleRate: number }} */ (this.queue[0]);
      const length = chunk.planes[0]?.length ?? 0;
      if (this.position >= length) {
        this.position -= length;
        this.queue.shift();
        continue;
      }
      // Nearest sample for another sample rate
      const index = Math.floor(this.position);
      for (let c = 0; c < output.length; c++) {
        const plane = chunk.planes[Math.min(c, chunk.planes.length - 1)];
        /** @type {Float32Array} */ (output[c])[i] = plane?.[index] ?? 0;
      }
      this.position += chunk.sampleRate / sampleRate;
      i++;
    }
    return true;
  }
}

registerProcessor('engine-audio-feed', EngineAudioFeed);
