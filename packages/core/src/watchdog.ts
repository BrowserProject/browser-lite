import type { EngineModule } from './engine.js';

const HANG_TIMEOUT = 10000;

/**
 * Detects a stuck engine thread (for example an endless loop in a page): after a call the
 * engine always answers (load, find) or after input nothing comes back for 10 s. The engine sees
 * in its memory whether the host waits (bl_host_wait_address) and stops a script that keeps it
 * waiting for `scriptTimeoutSeconds`; then it answers again and `responsive` follows.
 */
export class Watchdog {
  private waitingSince = 0;
  private inputSince = 0;
  private inputMark = 0;
  private markAddress = 0;
  private waitAddress = 0;
  // What the engine sees: 0 = no wait, else the number of the wait (bl_host_wait_address)
  private wait = 0;
  private waits = 0;
  private hung = false;
  // While hung: when to report unresponsive again (keepWaiting), 0 = not
  private repeatAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly module: EngineModule,
    private readonly onChange: (hung: boolean) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.check(), 1000);
    this.publishWait(false);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Before every call the engine surely answers (progress, navigation, find). */
  expectAnswer(): void {
    if (!this.waitingSince) this.waitingSince = Date.now();
    this.publishWait(false);
  }

  /** After input to a page (mouse down, key down). */
  inputSent(): void {
    if (!this.timer) return;
    if (!this.inputSince) this.inputSince = Date.now();
    this.inputMark = (this.inputMark + 1) >>> 0;
    this.module._bl_input_mark(this.inputMark);
    this.publishWait(false);
  }

  /** Any message of the engine thread. */
  answered(): void {
    this.waitingSince = 0;
    this.publishWait(false);
    if (this.hung && !this.inputSince) {
      this.hung = false;
      this.repeatAt = 0;
      this.onChange(false);
    }
  }

  /**
   * The host waits on after `unresponsive`: reported again after another 10 s of no answer, and
   * the engine gives the script that blocks it the whole limit again.
   */
  keepWaiting(): void {
    if (!this.hung) return;
    this.repeatAt = Date.now() + HANG_TIMEOUT;
    this.publishWait(true);
  }

  /**
   * A page dialog was answered. Only its page waited (the engine thread went on), but a native
   * dialog of the host page stops the main thread: the time it was open does not count.
   */
  dialogClosed(): void {
    if (this.waitingSince) this.waitingSince = Date.now();
    if (this.inputSince) this.inputSince = Date.now();
    this.publishWait(true);
  }

  // Tells the engine whether the host waits; restart: a wait that goes on counts from now
  private publishWait(restart: boolean): void {
    if (!this.timer) return;
    const waiting = this.waitingSince !== 0 || this.inputSince !== 0;
    let wait = 0;
    if (waiting) {
      if (this.wait && !restart) return;
      this.waits = (this.waits + 1) >>> 0 || 1;
      wait = this.waits;
    } else if (!this.wait) return;
    this.wait = wait;
    if (!this.waitAddress) this.waitAddress = this.module._bl_host_wait_address();
    const heap = this.module.blHeap();
    Atomics.store(new Int32Array(heap.buffer, heap.byteOffset), this.waitAddress >> 2, wait | 0);
  }

  // Mark the engine thread stores after the last handled input (bl_input_mark)
  private handledMark(): number {
    if (!this.markAddress) this.markAddress = this.module._bl_input_mark_address();
    const heap = this.module.blHeap();
    const at = this.markAddress;
    return (
      ((heap[at] ?? 0) |
        ((heap[at + 1] ?? 0) << 8) |
        ((heap[at + 2] ?? 0) << 16) |
        ((heap[at + 3] ?? 0) << 24)) >>>
      0
    );
  }

  private check(): void {
    if (this.inputSince && this.handledMark() === this.inputMark) {
      this.inputSince = 0;
      if (!this.waitingSince) this.answered();
      else this.publishWait(false);
    }
    if (this.hung && this.repeatAt && Date.now() >= this.repeatAt) {
      this.repeatAt = 0;
      this.onChange(true);
    }
    const since = Math.min(this.waitingSince || Infinity, this.inputSince || Infinity);
    if (this.hung || since === Infinity || Date.now() - since < HANG_TIMEOUT) return;
    this.hung = true;
    this.onChange(true);
  }
}
