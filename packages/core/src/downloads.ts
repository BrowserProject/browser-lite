import type { HostDownloads, HostStream } from './download-stream.js';
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

/**
 * A download of the pages; the engine loads the file and sends it in chunks. Until `save()` the
 * chunks collect in memory (the Blob at the end); `save()` streams them into the host browser's
 * downloads instead ({@link HostDownloads}), or, where that is not possible, saves the Blob
 * once done.
 */
export class DownloadImpl implements Download {
  received = 0;
  state: Download['state'] = 'progress';
  error?: string;
  blob: Blob | null = null;
  size: number;
  /** Bytes not handed to a stream. */
  private chunks: Uint8Array<ArrayBuffer>[] = [];
  /**
   * none: kept in memory; wanted: saved once the first bytes or the end come (an error response
   * is no file); opening: asking the host; stream: streaming; memory: Blob saved when done.
   */
  private saving: 'none' | 'wanted' | 'opening' | 'stream' | 'memory' = 'none';
  private stream: HostStream | null = null;
  /** The engine finished while the host stream was opening. */
  private complete = false;
  private readonly events = new Emitter<DownloadEvents>();

  constructor(
    readonly id: number,
    private readonly source: ViewImpl | undefined,
    readonly filename: string,
    readonly mime: string,
    readonly url: string,
    size: number,
    private readonly host: DownloadHost,
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
    this.received += bytes.length;
    if (this.stream) this.stream.write(bytes);
    else this.chunks.push(bytes);
    if (this.saving === 'wanted') this.open();
    this.events.emit('progress', { download: this });
  }

  /** @internal Ends the download; an error text means it failed. */
  finish(error: string): void {
    if (this.state !== 'progress') return;
    if (error) {
      this.state = 'error';
      this.error = error;
      this.chunks = [];
      this.stream?.end(error);
      this.events.emit('error', { download: this });
      this.events.clear();
    } else if (this.saving === 'wanted' || this.saving === 'opening') {
      this.complete = true;
      if (this.saving === 'wanted') this.open();
    } else {
      this.done();
    }
  }

  private done(): void {
    if (this.stream) {
      this.stream.end('');
      this.size = this.received;
    } else {
      this.blob = new Blob(this.chunks, { type: this.mime || 'application/octet-stream' });
      this.chunks = [];
      this.size = this.blob.size;
      if (this.saving === 'memory') saveBlob(this.blob, this.filename);
    }
    this.state = 'done';
    this.events.emit('done', { download: this });
    this.events.clear();
  }

  cancel(): void {
    if (this.state !== 'progress') return;
    this.host.cancel(this);
    this.finish('Cancelled');
  }

  save(): void {
    if (this.state === 'done') {
      if (this.blob) saveBlob(this.blob, this.filename);
      return;
    }
    if (this.state !== 'progress' || this.saving !== 'none') return;
    this.saving = 'wanted';
    if (this.received > 0) this.open();
  }

  private open(): void {
    this.saving = 'opening';
    void this.host
      .open(this, () => this.cancel())
      .catch(() => null)
      .then((stream) => this.attach(stream));
  }

  /** The host stream opened (or null: it cannot), the chunks so far go there. */
  private attach(stream: HostStream | null): void {
    if (this.state !== 'progress') {
      stream?.end(this.error ?? 'Cancelled');
      return;
    }
    if (stream) {
      this.saving = 'stream';
      this.stream = stream;
      for (const bytes of this.chunks) stream.write(bytes);
      this.chunks = [];
    } else {
      this.saving = 'memory';
    }
    if (this.complete) this.done();
  }
}

/** Saves a file with the download of the host browser (a link with `download`). */
function saveBlob(blob: Blob, filename: string): void {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** What a download needs of its browser. */
interface DownloadHost {
  /** Ends it in the engine. */
  cancel(download: DownloadImpl): void;
  /** The host browser's download that streams it; null when not possible. */
  open(download: DownloadImpl, onCancel: () => void): Promise<HostStream | null>;
}

interface DownloadsHost {
  readonly module: EngineModule;
  readonly ready: boolean;
  /** Emits the browser event `download`; false when nobody listens. */
  announceDownload(download: Download): boolean;
}

/**
 * The running downloads (engine events download-start and download-done, data through
 * onEngineDownloadData). Without a `download` listener a file is saved right away.
 */
export class Downloads {
  private readonly running = new Map<number, DownloadImpl>();
  private readonly downloadHost: DownloadHost;

  /** `streams` opens the host browser's download of a file ({@link HostDownloads}). */
  constructor(
    private readonly host: DownloadsHost,
    streams: Pick<HostDownloads, 'open'>,
  ) {
    this.downloadHost = {
      cancel: (download) => {
        this.running.delete(download.id);
        if (this.host.ready) this.host.module._bl_download_cancel(download.id);
      },
      open: (download, onCancel) =>
        streams.open(download.id, download.filename, download.mime, onCancel),
    };
  }

  start(data: Record<string, unknown>, view: ViewImpl | undefined): void {
    const download = new DownloadImpl(
      Number(data.id),
      view,
      String(data.filename ?? 'download'),
      String(data.mime ?? ''),
      String(data.url ?? ''),
      Number(data.size) || 0,
      this.downloadHost,
    );
    this.running.set(download.id, download);
    if (!this.host.announceDownload(download)) download.save();
  }

  data(id: number, bytes: Uint8Array<ArrayBuffer>): void {
    this.running.get(id)?.add(bytes);
  }

  done(data: Record<string, unknown>): void {
    const download = this.running.get(Number(data.id));
    if (!download) return;
    this.running.delete(download.id);
    download.finish(String(data.error ?? ''));
  }

  /** The browser ended: every running download fails. */
  abortAll(): void {
    const downloads = [...this.running.values()];
    this.running.clear();
    for (const download of downloads) download.finish('Aborted');
  }
}
