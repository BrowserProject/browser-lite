// Slower cores: keeps one core (taskset and SCHED_FIFO from outside) busy for (F-1)/F of every
// period of PERIOD_US microseconds, the device gets the rest.
//   node stealer.mjs <factor>
const factor = Number(process.argv[2]);
const period = Number(process.env.PERIOD_US || 2000) * 1000;
const busy = BigInt(Math.round((period * (factor - 1)) / factor));
const idleMs = (period - Number(busy)) / 1e6;
const wait = new Int32Array(new SharedArrayBuffer(4));
for (;;) {
  const end = process.hrtime.bigint() + busy;
  while (process.hrtime.bigint() < end);
  Atomics.wait(wait, 0, 0, idleMs);
}
