/** Globals of the AudioWorkletGlobalScope (not part of the TypeScript libs). */
interface WorkletMessagePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
}

declare const currentTime: number;
declare const sampleRate: number;

declare class AudioWorkletProcessor {
  readonly port: WorkletMessagePort;
  constructor(options?: unknown);
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options: { processorOptions: unknown }) => AudioWorkletProcessor,
): void;

/** Sample rate of the AudioContext. */
declare const sampleRate: number;
