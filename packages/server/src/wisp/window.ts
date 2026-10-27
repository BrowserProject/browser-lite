/**
 * How many bytes the relay may have on the way to a client that acknowledges what it received
 * (CONTINUE on stream 0 from the client, an extra of browser-lite). Everything the relay hands to
 * the WebSocket waits in the operating system's buffers, a few MB on a slow link, and a small
 * response of one stream queued behind them for seconds. With the acknowledgements the relay
 * keeps only twice what the link delivers in the shortest round trip on the way, like BBR's
 * congestion window, at least {@link MIN_WINDOW}.
 */
export class DeliveryWindow {
  /** Whether the client acknowledges; until then there is no limit. */
  active = false;
  private sent = 0;
  private acked = 0;
  private limit = MIN_WINDOW;
  private minRtt = Number.POSITIVE_INFINITY;
  private minRttAt = 0;
  /** Sent byte counts with their time and what was on the way then, for round trip samples. */
  private readonly marks: { bytes: number; at: number; inFlight: number }[] = [];
  /** Acknowledged byte counts with their time, for the delivery rate. */
  private readonly acks: { bytes: number; at: number }[] = [];
  /** Delivery rates (bytes per millisecond) of the last {@link RATE_LIFETIME_MS}, for their maximum. */
  private readonly rates: { rate: number; at: number }[] = [];

  /** Bytes sent but not acknowledged yet. */
  get inFlight(): number {
    return this.sent - this.acked;
  }

  /** Whether the bytes on the way exceed the window. */
  get full(): boolean {
    return this.active && this.inFlight > this.limit;
  }

  /** Whether enough was acknowledged to read from the targets again. */
  get open(): boolean {
    return !this.active || this.inFlight <= this.limit * RESUME_SHARE;
  }

  /** `bytes` were handed to the WebSocket at `now` (milliseconds). */
  onSent(bytes: number, now: number): void {
    this.sent += bytes;
    const last = this.marks.at(-1);
    if (!last || now - last.at >= MARK_INTERVAL_MS)
      this.marks.push({ bytes: this.sent, at: now, inFlight: this.inFlight });
    if (this.marks.length > MAX_SAMPLES) this.marks.shift();
  }

  /**
   * The client received `total` bytes in all (modulo 2^32). Ignored when it acknowledges more
   * than was sent.
   */
  onAck(total: number, now: number): void {
    const delta = (total - this.acked) >>> 0;
    if (delta > this.inFlight) return;
    this.active = true;
    this.acked += delta;
    for (let mark = this.marks[0]; mark && mark.bytes <= this.acked; mark = this.marks[0]) {
      this.marks.shift();
      const rtt = now - mark.at;
      // Only bytes sent with little on the way measure the round trip, the others mostly the
      // queue in front of them. A round trip may grow for good (other route): forget the minimum
      // after a while
      const fresh = mark.inFlight <= SAMPLE_IN_FLIGHT;
      const known = Number.isFinite(this.minRtt);
      if (
        fresh
          ? !known || rtt < this.minRtt || now - this.minRttAt > MIN_RTT_LIFETIME_MS
          : known && rtt < this.minRtt
      ) {
        this.minRtt = Math.max(1, rtt);
        this.minRttAt = now;
      }
    }
    this.acks.push({ bytes: this.acked, at: now });
    const span = Math.max(RATE_SPAN_MS, this.minRtt);
    while (this.acks.length > 2 && now - (this.acks[1]?.at ?? now) >= span) this.acks.shift();
    if (this.acks.length > MAX_SAMPLES) this.acks.shift();
    const first = this.acks[0];
    const elapsed = first ? now - first.at : 0;
    if (!first || elapsed <= 0 || !Number.isFinite(this.minRtt)) return;
    // The largest rate of the last seconds: measured while the window holds the data back, the
    // rate is lower than what the link carries
    this.rates.push({ rate: (this.acked - first.bytes) / elapsed, at: now });
    while ((this.rates[0]?.at ?? now) < now - RATE_LIFETIME_MS) this.rates.shift();
    const rate = Math.max(...this.rates.map((sample) => sample.rate));
    this.limit = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, GAIN * rate * this.minRtt));
  }
}

/** Smallest window: below this a single stream gets too little on a fast link. */
export const MIN_WINDOW = 128 * 1024;
const MAX_WINDOW = 16 * 1024 * 1024;
const GAIN = 2.5;
const RESUME_SHARE = 0.75;
const RATE_LIFETIME_MS = 2000;
const MARK_INTERVAL_MS = 5;
const SAMPLE_IN_FLIGHT = 64 * 1024;
const RATE_SPAN_MS = 100;
const MIN_RTT_LIFETIME_MS = 10000;
const MAX_SAMPLES = 2048;
