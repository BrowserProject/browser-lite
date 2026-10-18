import { Emitter } from './emitter.js';
import type { EngineModule } from './engine.js';
import type { Download, Unsubscribe, View } from './types.js';
import type { ViewImpl } from './view.js';

type DownloadEvent = { download: Download };

interface DownloadEvents {
  progress: DownloadEvent;
  done: DownloadEvent;
  error: DownloadEvent;
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
    private readonly source: ViewImpl | undefined,
    readonly filename: string,
    readonly mime: string,
    readonly url: string,
    size: number,
    private readonly onCancel: (download: DownloadImpl) => void,
  ) {
    this.size = size > 0 ? size : 0;
  }

  get view(): View | null {
    return this.source && !this.source.closed ? this.source : null;
  }

  on(type: keyof DownloadEvents, listener: (event: DownloadEvent) => void): Unsubscribe {
    return this.events.on(type, listener);
  }

  /** @internal */
  add(bytes: Uint8Array<ArrayBuffer>): void {
    if (this.state !== 'progress') return;
    this.chunks.push(bytes);
    this.received += bytes.length;
    this.events.emit('progress', { download: this });
  }

  /** @internal Ends the download; an error text means it failed. */
  finish(error: string): void {
    if (this.state !== 'progress') return;
    if (error) {
      this.state = 'error';
      this.error = error;
      this.chunks = [];
      this.events.emit('error', { download: this });
    } else {
      this.blob = new Blob(this.chunks, { type: this.mime || 'application/octet-stream' });
      this.chunks = [];
      this.size = this.blob.size;
      this.state = 'done';
      this.events.emit('done', { download: this });
    }
    this.events.clear();
  }

  cancel(): void {
    if (this.state !== 'progress') return;
    this.onCancel(this);
    this.finish('Cancelled');
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

interface DownloadsHost {
  readonly module: EngineModule;
  readonly ready: boolean;
  /** Emits the browser event `download`; false when nobody listens. */
  announceDownload(download: Download): boolean;
}

/**
 * The running downloads (engine events download-start and download-done, data through
 * onEngineDownloadData). A page source of viewSource arrives the same way and goes to its view
 * as the event `source`. Without a `download` listener a finished file is saved.
 */
export class Downloads {
  private readonly running = new Map<
    number,
    { download: DownloadImpl; view: ViewImpl | undefined; source: boolean; announced: boolean }
  >();

  constructor(private readonly host: DownloadsHost) {}

  start(data: Record<string, unknown>, view: ViewImpl | undefined): void {
    const download = new DownloadImpl(
      Number(data.id),
      view,
      String(data.filename ?? 'download'),
      String(data.mime ?? ''),
      String(data.url ?? ''),
      Number(data.size) || 0,
      (cancelled) => {
        this.running.delete(cancelled.id);
        if (this.host.ready) this.host.module._bl_download_cancel(cancelled.id);
      },
    );
    const source = !!data.viewSource;
    const entry = { download, view, source, announced: false };
    this.running.set(download.id, entry);
    if (!source) entry.announced = this.host.announceDownload(download);
  }

  data(id: number, bytes: Uint8Array<ArrayBuffer>): void {
    this.running.get(id)?.download.add(bytes);
  }

  done(data: Record<string, unknown>): void {
    const entry = this.running.get(Number(data.id));
    if (!entry) return;
    this.running.delete(entry.download.id);
    const { download, view } = entry;
    download.finish(String(data.error ?? ''));
    if (entry.source) {
      if (!download.blob || !view || view.closed) return;
      download.blob.arrayBuffer().then((bytes) => {
        if (!view.closed)
          view.emit('source', { url: download.url, text: decodeSource(bytes, download.mime) });
      });
      return;
    }
    if (download.state === 'done' && !entry.announced) download.save();
  }

  /** The browser ended: every running download fails. */
  abortAll(): void {
    const entries = [...this.running.values()];
    this.running.clear();
    for (const { download } of entries) download.finish('Aborted');
  }
}
