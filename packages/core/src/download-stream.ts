/** How long the service worker may take to answer the frame of a download before it is kept in memory. */
const ANSWER_TIMEOUT = 10000;
/** A message this often keeps the worker alive while a download waits for bytes. */
const KEEP_ALIVE = 10000;
/** The frame of a download stays this long after the end, while the host browser takes over. */
const FRAME_LINGER = 10000;

/** A download the host browser saves while its bytes arrive. */
export interface HostStream {
  /** Hands the bytes over; their buffer is transferred to the service worker. */
  write(bytes: Uint8Array<ArrayBuffer>): void;
  /** Ends the host's download; an error text makes it fail there. */
  end(error: string): void;
}

/**
 * The page side of download-sw.js: streams downloads into the downloads of the host browser.
 * A hidden frame navigates to the download's URL below `bl-download/`, the worker answers it with
 * an attachment whose body is the stream of the bytes posted here, so the host browser writes the
 * file while it arrives (and shows its own progress), and the page keeps nothing.
 */
export class HostDownloads {
  private readonly instance = crypto.randomUUID();
  /** Downloads waiting for an answer of the worker: 'opened', then 'started' (or false). */
  private readonly answers = new Map<number, (answer: 'opened' | 'started' | false) => void>();
  /** Cancel of the running streams, for a download cancelled in the host browser. */
  private readonly cancels = new Map<number, () => void>();

  constructor(
    private readonly registration: () => Promise<ServiceWorkerRegistration | null>,
    private readonly signal: AbortSignal,
  ) {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener(
      'message',
      (event) => {
        const message = event.data as { bl?: unknown; instance?: unknown; id?: unknown } | null;
        if (message?.instance !== this.instance) return;
        const id = Number(message.id);
        if (message.bl === 'download-opened') this.answers.get(id)?.('opened');
        else if (message.bl === 'download-started') this.answers.get(id)?.('started');
        else if (message.bl === 'download-cancel') this.cancels.get(id)?.();
      },
      { signal },
    );
    signal.addEventListener('abort', () => {
      for (const answer of [...this.answers.values()]) answer(false);
    });
  }

  /**
   * Starts the host browser's download of a file; null when that is not possible (no service
   * worker with download-sw.js, a Content Security Policy without `frame-src 'self'`, no answer
   * within 10 s). `onCancel` runs when the download is cancelled in the host browser.
   */
  async open(
    id: number,
    filename: string,
    mime: string,
    onCancel: () => void,
  ): Promise<HostStream | null> {
    const registration = await this.registration();
    const worker = registration?.active;
    if (!registration || !worker || this.signal.aborted || typeof document === 'undefined')
      return null;
    const post = (message: Record<string, unknown>, transfer: Transferable[] = []) =>
      worker.postMessage({ ...message, instance: this.instance, id }, { transfer });
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    // The frame navigates once the worker has the download, the host's download starts with
    // the worker's answer to that navigation
    const answered = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ANSWER_TIMEOUT);
      this.answers.set(id, (answer) => {
        if (answer === 'opened') {
          frame.src = new URL(
            `bl-download/${this.instance}/${id}/${encodeURIComponent(filename)}`,
            registration.scope,
          ).href;
          document.body.append(frame);
          return;
        }
        clearTimeout(timer);
        resolve(answer === 'started');
      });
      post({ bl: 'download-open', filename, mime });
    });
    this.answers.delete(id);
    if (!answered) {
      post({ bl: 'download-end', error: 'No answer' });
      frame.remove();
      return null;
    }
    this.cancels.set(id, onCancel);
    // The bytes keep the worker alive; a server that pauses must not let it stop
    const alive = setInterval(() => post({ bl: 'download-alive' }), KEEP_ALIVE);
    return {
      write: (bytes) => {
        const owned =
          bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes
            : bytes.slice();
        post({ bl: 'download-data', bytes: owned.buffer }, [owned.buffer]);
      },
      end: (error) => {
        clearInterval(alive);
        this.cancels.delete(id);
        post({ bl: 'download-end', error });
        if (error) frame.remove();
        else setTimeout(() => frame.remove(), FRAME_LINGER);
      },
    };
  }
}
