// Calibration of a device profile: loop steps per second with one thread and with all device
// cores (JS in workers), in millions. The factor against S is the measured slowdown.
//   node calib.mjs [--out <jsonl>]
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';

const MS = Number(process.env.CALIB_MS || 4000);
const code = `const { parentPort } = require('node:worker_threads');
let n = 0, h = 0; const end = Date.now() + ${MS};
while (Date.now() < end) { for (let i = 0; i < 1e4; i++) h = (h * 31 + i) | 0; n++; }
parentPort.postMessage(n + (h & 0));`;
async function run(threads) {
  const counts = await Promise.all(
    Array.from(
      { length: threads },
      () =>
        new Promise((resolve) => {
          const worker = new Worker(code, { eval: true });
          worker.on('message', (n) => {
            resolve(n);
            worker.terminate();
          });
        }),
    ),
  );
  return (counts.reduce((a, b) => a + b, 0) * 1e4) / MS / 1000;
}
const cpus = Number(process.env.PERF_CPUS || 1);
const row = {
  kind: 'calib',
  profile: process.env.PERF_PROFILE,
  cpus,
  factor: Number(process.env.PERF_FACTOR),
  one: +(await run(1)).toFixed(1),
  all: +(await run(cpus)).toFixed(1),
};
console.log(JSON.stringify(row));
const i = process.argv.indexOf('--out');
if (i > 0) fs.appendFileSync(process.argv[i + 1], JSON.stringify(row) + '\n');
