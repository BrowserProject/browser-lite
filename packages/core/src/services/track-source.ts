import { trackProcessor } from './host-apis.js';
import type { ServiceContext } from './service.js';
import { videoFrames } from './track-streams.js';

let captureContext: { context: AudioContext; ready: Promise<void>; users: number } | null = null;

/** The AudioContext of the audio captures, closed when the last one stops. */
function useCaptureContext(): { context: AudioContext; ready: Promise<void>; release(): void } {
  if (!captureContext) {
    const context = new AudioContext({ latencyHint: 'interactive' });
    const workletUrl = new URL('../audio-worklet.js', import.meta.url).href;
    captureContext = { context, ready: context.audioWorklet.addModule(workletUrl), users: 0 };
  }
  const current = captureContext;
  current.users++;
  return {
    context: current.context,
    ready: current.ready,
    release() {
      if (--current.users > 0) return;
      if (captureContext === current) captureContext = null;
      current.context.close().catch(() => {});
    },
  };
}

/**
 * Sound through an AudioWorklet: the processor posts planar blocks straight to the engine
 * worker over a MessagePort (Safari has neither an audio MediaStreamTrackProcessor nor
 * AudioData).
 */
async function streamAudio(worker: Worker, id: number, track: MediaStreamTrack) {
  const shared = useCaptureContext();
  const { context } = shared;
  try {
    await shared.ready;
    const source = new MediaStreamAudioSourceNode(context, {
      mediaStream: new MediaStream([track]),
    });
    const node = new AudioWorkletNode(context, 'engine-audio-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCountMode: 'explicit',
      channelCount: Math.min(2, track.getSettings().channelCount || 1),
    });
    const channel = new MessageChannel();
    node.port.postMessage({ port: channel.port1 }, [channel.port1]);
    worker.postMessage({ blCapture: { id, kind: 'audio', port: channel.port2 } }, [channel.port2]);
    // The processor runs only while the graph pulls it; its output is silence
    source.connect(node).connect(context.destination);
    if (context.state === 'suspended') await context.resume().catch(() => {});
    return () => {
      node.port.postMessage('stop');
      source.disconnect();
      node.disconnect();
      shared.release();
    };
  } catch (error) {
    shared.release();
    throw error;
  }
}

/**
 * Hands the frames or the sound of a host track to the engine worker as capture source `id`
 * (engine/js/webcodecs-host.js): the ReadableStream of a MediaStreamTrackProcessor where the
 * main thread has one (Chromium); otherwise sound through an AudioWorklet, video as a clone of
 * the track whose processor runs in the engine worker (Safari), or where tracks cannot be
 * transferred (Firefox) frames of a <video> (track-streams.ts). Returns the function that stops
 * it on the host side (the engine detaches with `{ blCapture: { id } }`).
 */
export async function streamTrackToEngine(
  ctx: ServiceContext,
  id: number,
  track: MediaStreamTrack,
): Promise<() => void> {
  const worker = ctx.engineWorker();
  if (!worker) throw new Error('No engine worker');
  const kind = track.kind === 'audio' ? 'audio' : 'video';
  const Processor = trackProcessor();
  if (Processor) {
    const processor = new Processor({ track });
    worker.postMessage({ blCapture: { id, kind, readable: processor.readable } }, [
      processor.readable,
    ]);
    return () => {};
  }
  if (kind === 'audio') return streamAudio(worker, id, track);
  const clone = track.clone();
  try {
    worker.postMessage({ blCapture: { id, kind, track: clone } }, [clone]);
    return () => {};
  } catch {
    clone.stop();
  }
  if (typeof VideoFrame !== 'function') throw new Error('No way to read video frames');
  const readable = videoFrames(track);
  worker.postMessage({ blCapture: { id, kind, readable } }, [readable]);
  return () => {};
}
