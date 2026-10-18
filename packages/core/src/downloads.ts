import { Emitter } from './emitter.js';
import type { Download, Unsubscribe } from './types.js';

interface DownloadEvents {
  progress: undefined;
  done: undefined;
  error: undefined;
}

/** A download of the pages; the engine loads the file and sends it in chunks. */
export class DownloadImpl implements Download {
  received = 0;
  state: Download['state'] = 'progress';
  error?: string;
  blob: Blob | null = null;
  size: number;
  private chunks: Uint8Array<ArrayBuffer>[] = [];
  private readonly events = new Emitter<DownloadEvents>();

  constructor(
    readonly id: number,
    readonly filename: string,
    readonly mime: string,
    readonly url: string,
    size: number,
  ) {
    this.size = size > 0 ? size : 0;
  }

  on(type: 'progress' | 'done' | 'error', listener: () => void): Unsubscribe {
    return this.events.on(type, listener);
  }

  /** @internal */
  add(bytes: Uint8Array<ArrayBuffer>): void {
    this.chunks.push(bytes);
    this.received += bytes.length;
    this.events.emit('progress', undefined);
  }

  /** @internal */
  finish(error: string): void {
    if (error) {
      this.state = 'failed';
      this.error = error;
      this.chunks = [];
      this.events.emit('error', undefined);
    } else {
      this.blob = new Blob(this.chunks, { type: this.mime || 'application/octet-stream' });
      this.chunks = [];
      this.size = this.blob.size;
      this.state = 'done';
      this.events.emit('done', undefined);
    }
    this.events.clear();
  }

  save(): void {
    if (!this.blob) return;
    const link = document.createElement('a');
    const url = URL.createObjectURL(this.blob);
    link.href = url;
    link.download = this.filename;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

/** Text of a page source (view-source download) in its charset. */
export function decodeSource(bytes: ArrayBuffer, mime: string): string {
  const charset = /charset=([\w-]+)/i.exec(mime || '')?.[1] || 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}
