// Slower cores: keeps one core (taskset and SCHED_FIFO from outside) busy for (F-1)/F of every
// period of PERIOD_US microseconds, the device gets the rest. The periods follow the clock, so the
// stealers of all cores are busy at the same time: else a single thread of the device moves to
// whichever core is free and runs faster than 1/F.
//   node stealer.mjs <factor>
const factor = Number(process.argv[2]);
const period = BigInt(Number(process.env.PERIOD_US || 2000) * 1000);
const busy = (period * BigInt(Math.round(((factor - 1) / factor) * 1e6))) / 1000000n;
const wait = new Int32Array(new SharedArrayBuffer(4));
for (;;) {
  const now = process.hrtime.bigint();
  const phase = now % period;
  if (phase < busy) {
    const end = now - phase + busy;
    while (process.hrtime.bigint() < end);
  } else {
    Atomics.wait(wait, 0, 0, Number(period - phase) / 1e6);
  }
}
