import { Service, type ServiceContext } from './service.js';

interface Output {
  node: AudioWorkletNode | null;
  stopped: boolean;
}

/** The engine renders all sound at this rate (AudioDestinationWasm). */
const ENGINE_SAMPLE_RATE = 48000;

/**
 * Web Audio of the pages through an AudioWorklet of the host: the engine renders into a ring
 * buffer in shared memory, the worklet plays it. Host browsers allow sound only after a user
 * gesture; until then the engine keeps rendering silently. Safari starts an AudioContext only
 * inside a gesture, so the first gesture creates it already (suspended again while no page
 * plays sound); after that it may start at any time.
 */
export class AudioService extends Service {
  readonly features = ['audio'] as const;

  constructor() {
    super('audio');
  }

  setup(ctx: ServiceContext): void {
    const workletUrl = new URL('../audio-worklet.js', import.meta.url).href;
    let context: AudioContext | null = null;
    let workletReady: Promise<void> | null = null;
    const outputs = new Map<number, Output>();
    let lastPeak = 0;

    const audioContext = (sampleRate: number) => {
      if (!context) {
        context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
        workletReady = context.audioWorklet.addModule(workletUrl);
      }
      return context;
    };

    // The context ran once: from now on it may start without a gesture
    let started = false;
    const gesture = () => {
      const audio = audioContext(ENGINE_SAMPLE_RATE);
      if (audio.state !== 'suspended' || (started && !outputs.size)) return;
      audio.resume().then(
        () => {
          started = true;
          if (!outputs.size && audio.state === 'running') audio.suspend().catch(() => {});
        },
        () => {},
      );
    };

    const stopOutput = (id: number) => {
      const output = outputs.get(id);
      if (!output) return;
      output.stopped = true;
      if (output.node) {
        output.node.port.postMessage('stop');
        output.node.disconnect();
      }
      outputs.delete(id);
    };

    const startOutput = async (
      id: number,
      ptr: number,
      capacity: number,
      channels: number,
      sampleRate: number,
    ) => {
      stopOutput(id);
      const output: Output = { node: null, stopped: false };
      outputs.set(id, output);
      try {
        const audio = audioContext(sampleRate);
        await workletReady;
        if (output.stopped || ctx.signal.aborted) return;
        output.node = new AudioWorkletNode(audio, 'engine-audio-player', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: { buffer: ctx.module.HEAPU8.buffer, ptr, capacity, channels },
        });
        output.node.port.onmessage = (event) => {
          lastPeak = event.data.peak;
        };
        output.node.connect(audio.destination);
        if (audio.state === 'suspended') audio.resume().catch(() => {});
      } catch (error) {
        console.warn('[browser-lite] audio not available:', error);
      }
    };

    ctx.module.onEngineAudio = (type, id, ptr, capacity, channels, sampleRate) => {
      if (type === 'start') startOutput(id, ptr, capacity, channels, sampleRate);
      else if (type === 'stop') stopOutput(id);
      else if (type === 'close') {
        stopOutput(id);
        // The worklet may still be reading
        setTimeout(() => {
          if (!ctx.signal.aborted) ctx.module._free(ptr);
        }, 500);
      }
    };
    ctx.onUserGesture(gesture);
    ctx.debugState('audio', () => ({
      state: (context as AudioContext | null)?.state ?? 'none',
      outputs: outputs.size,
      peak: lastPeak,
    }));
    ctx.signal.addEventListener('abort', () => {
      for (const id of [...outputs.keys()]) stopOutput(id);
      (context as AudioContext | null)?.close().catch(() => {});
    });
  }
}
