// @ts-check
// Plays the audio of the engine. The engine renders Web Audio on its own thread into a ring
// buffer in the shared WASM memory (AudioDestinationWasm.cpp, patch 0013). Header (32 bytes,
// uint32): [written, read, capacity, channels, heartbeat, ...], then float32 samples with
// interleaved channels. Counters are in frames. The heartbeat tells the engine we are playing.

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
