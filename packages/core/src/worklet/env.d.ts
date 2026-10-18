/** Globals of the AudioWorkletGlobalScope (not part of the TypeScript libs). */
interface WorkletMessagePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

declare class AudioWorkletProcessor {
  readonly port: WorkletMessagePort;
  constructor(options?: unknown);
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options: { processorOptions: unknown }) => AudioWorkletProcessor,
): void;
