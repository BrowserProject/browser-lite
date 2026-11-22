// The JIT's warm-up (engine/jit/WasmJIT.cpp warmUpFires, docs/jit.md): runs
// tests/engine/pages/jit-warmup.html in the engine (node) with BL_JIT=2 and reads the compiles in
// the JIT's log. A large function whose loop ran a few thousand times and a mid-sized one called a
// few thousand times stay interpreted, the same large function with millions of iterations and a
// small hot function compile. Before, a large function compiled after 2000 iterations (4 fires),
// whatever its size: React and Next.js code ran 1.5 times slower than without the JIT.
//   node tests/engine/jit-warmup-test.mjs [engine-dir]
import { readFileSync } from 'node:fs';
import { enginePath, runEngine } from './engine-node.mjs';

process.env.BL_JIT = '2';
const compiled = new Set();
const COLD = ['bigOnce', 'warmMid'];
const HOT = ['bigHot', 'hot', 'driveHot'];

function expected() {
  let s = 0;
  for (let i = 0; i < 5000; i++) s = (s + i) | 0;
  let mid = 0;
  for (let i = 0; i < 3000; i++) mid = (mid + ((i + 1) | 0)) | 0;
  let big = 0;
  for (let i = 0; i < 3000000; i++) big = (big + i) | 0;
  let drive = 0;
  for (let i = 0; i < 500000; i++) drive = ((drive + i) * 3 + 1) | 0;
  return [s, s, s, mid, big, drive].join(',');
}

const timer = setTimeout(() => {
  console.log('ERROR: no result within 120 s');
  process.exit(1);
}, 120000);

await runEngine({
  enginePath: enginePath(process.argv[2]),
  html: readFileSync(new URL('pages/jit-warmup.html', import.meta.url), 'utf8'),
  url: 'file:///jit-warmup/',
  width: 200,
  height: 200,
  onPrintErr(text) {
    const match = /\[jit\] (\w+)#\w+:.*: \d+ bytes, \d+ branch hints, function [1-9]/.exec(text);
    if (match) compiled.add(match[1]);
  },
  onConsole(message) {
    if (!message.startsWith('JIT-WARMUP done ')) return;
    clearTimeout(timer);
    // The log of the last compiles may come after the console message
    setTimeout(() => {
      let failed = false;
      const results = message.slice('JIT-WARMUP done '.length);
      if (results !== expected()) {
        console.log(`ERROR: results ${results}, expected ${expected()}`);
        failed = true;
      }
      for (const name of COLD)
        if (compiled.has(name)) {
          console.log(`ERROR: ${name} compiled although it ran only briefly`);
          failed = true;
        }
      for (const name of HOT)
        if (!compiled.has(name)) {
          console.log(`ERROR: ${name} stayed interpreted although it ran long`);
          failed = true;
        }
      console.log(
        `Compiled: ${[...compiled].filter((name) => [...COLD, ...HOT].includes(name)).join(', ')}`,
      );
      process.exit(failed ? 1 : 0);
    }, 500);
  },
});
