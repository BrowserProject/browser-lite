// AudioWorklet: spielt den Ton der Engine ab.
//
// Die Engine rendert Web Audio auf einem eigenen Thread in einen Ringpuffer im
// gemeinsamen WASM-Speicher (platform/audio/wasm/AudioDestinationWasm.cpp).
// Kopf (32 Bytes): [geschrieben, gelesen, Kapazitaet, Kanaele, Herzschlag, ...]
// als uint32, danach die Samples als float32, Kanaele verschachtelt. Die
// Zaehler laufen in Frames. Am Herzschlag sieht die Engine, dass wir abspielen.

class EngineAudioPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { buffer, ptr, capacity, channels } = options.processorOptions;
    this.header = new Uint32Array(buffer, ptr, 8);
    this.samples = new Float32Array(buffer, ptr + 32, capacity * channels);
    this.mask = capacity - 1;
    this.channels = channels;
    this.running = true;
    // Lautester Wert der letzten Zeit, fuer die Tests und eine Anzeige
    this.peak = 0;
    this.blocks = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'stop')
        this.running = false;
    };
  }

  process(inputs, outputs) {
    if (!this.running)
      return false;
    Atomics.add(this.header, 4, 1);
    const output = outputs[0];
    const frames = output[0].length;
    const written = Atomics.load(this.header, 0);
    const read = Atomics.load(this.header, 1);
    const count = Math.min(frames, (written - read) >>> 0);
    for (let c = 0; c < output.length; c++) {
      const out = output[c];
      const source = Math.min(c, this.channels - 1);
      for (let i = 0; i < count; i++)
        out[i] = this.samples[((read + i) & this.mask) * this.channels + source];
      // Rest bleibt still (Unterlauf)
    }
    Atomics.store(this.header, 1, (read + count) >>> 0);
    for (let i = 0; i < count; i++)
      this.peak = Math.max(this.peak, Math.abs(output[0][i]));
    if (++this.blocks >= 64) {
      this.port.postMessage({ peak: this.peak, underrun: count < frames });
      this.peak = 0;
      this.blocks = 0;
    }
    return true;
  }
}

registerProcessor('engine-audio-player', EngineAudioPlayer);
