import type { EngineModule } from './engine.js';

const HANG_TIMEOUT = 10000;

/**
 * Detects a stuck engine thread (for example an endless loop in a page): after a call the
 * engine always answers (load, find) or after input nothing comes back for 10 s. The engine
 * itself stops scripts that run too long; then it answers again and `responsive` follows.
 */
export class Watchdog {
  private waitingSince = 0;
  private inputSince = 0;
  private inputMark = 0;
  private markAddress = 0;
  private hung = false;
  private paused = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly module: EngineModule,
    private readonly onChange: (hung: boolean) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.check(), 1000);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Before every call the engine surely answers (progress, navigation, find). */
  expectAnswer(): void {
    if (!this.waitingSince) this.waitingSince = Date.now();
  }

  /** After input to a page (mouse down, key down). */
  inputSent(): void {
    if (!this.timer) return;
    if (!this.inputSince) this.inputSince = Date.now();
    this.inputMark = (this.inputMark + 1) >>> 0;
    this.module._bl_input_mark(this.inputMark);
  }

  /** Any message of the engine thread. */
  answered(): void {
    this.waitingSince = 0;
    if (this.hung && !this.inputSince) {
      this.hung = false;
      this.onChange(false);
    }
  }

  /** A page dialog opened: the engine thread waits for its answer, that is no hang. */
  pause(): void {
    this.paused++;
  }

  /** The dialog was answered: the time it was open does not count. */
  resume(): void {
    this.paused = Math.max(0, this.paused - 1);
    if (this.waitingSince) this.waitingSince = Date.now();
    if (this.inputSince) this.inputSince = Date.now();
  }

  // Mark the engine thread stores after the last handled input (bl_input_mark)
  private handledMark(): number {
    if (!this.markAddress) this.markAddress = this.module._bl_input_mark_address();
    const heap = this.module.HEAPU8;
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
    if (this.paused) return;
    if (this.inputSince && this.handledMark() === this.inputMark) {
      this.inputSince = 0;
      if (!this.waitingSince) this.answered();
    }
    const since = Math.min(this.waitingSince || Infinity, this.inputSince || Infinity);
    if (this.hung || since === Infinity || Date.now() - since < HANG_TIMEOUT) return;
    this.hung = true;
    this.onChange(true);
  }
}
