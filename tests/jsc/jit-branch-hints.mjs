// Checks the branch hints of the JIT's largest module among the given files (BL_JIT=3 writes every
// module as jit-<index>.wasm): a custom section "metadata.code.branch_hint" before the code
// section, functions and offsets in increasing order, every offset on an `if` or `br_if` of its
// function, and at least one hint per 100 bytes of the compiled function's code. V8 ignores the
// whole section when one entry is wrong, and with it the layout that keeps the code of large
// functions dense in the instruction cache (docs/jit.md).
//   node tests/jsc/jit-branch-hints.mjs jit-*.wasm
import fs from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) {
  console.log('FAIL no modules');
  process.exit(1);
}
const largest = files.map((file) => [file, fs.statSync(file).size]).sort((a, b) => b[1] - a[1])[0][0];
const bytes = fs.readFileSync(largest);

let at = 8;
const u32 = () => {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[at++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) return result;
  }
};
const fail = (message) => {
  console.log(`FAIL ${largest}: ${message}`);
  process.exit(1);
};

let hints = null;
let bodies = null;
while (at < bytes.length) {
  const id = bytes[at++];
  const size = u32();
  const end = at + size;
  if (id === 0) {
    const nameLength = u32();
    const name = bytes.subarray(at, at + nameLength).toString();
    at += nameLength;
    if (name === 'metadata.code.branch_hint') {
      if (bodies) fail('branch hints after the code section');
      hints = [];
      let lastFunction = -1;
      for (let count = u32(); count--; ) {
        const index = u32();
        if (index <= lastFunction) fail(`function ${index} out of order`);
        lastFunction = index;
        let lastOffset = -1;
        for (let n = u32(); n--; ) {
          const offset = u32();
          if (offset <= lastOffset) fail(`offset ${offset} of function ${index} out of order`);
          lastOffset = offset;
          if (u32() !== 1) fail('hint size not 1');
          const value = bytes[at++];
          if (value > 1) fail(`hint value ${value}`);
          hints.push([index, offset]);
        }
      }
    }
  } else if (id === 10) {
    bodies = [];
    for (let count = u32(); count--; ) {
      const size = u32();
      bodies.push(bytes.subarray(at, at + size));
      at += size;
    }
  }
  at = end;
}

if (!hints) fail('no branch hint section');
if (!bodies) fail('no code section');
for (const [index, offset] of hints) {
  const opcode = bodies[index]?.[offset];
  if (opcode !== 0x04 && opcode !== 0x0d) fail(`hint of function ${index} at ${offset} on opcode ${opcode}`);
}
const mainHints = hints.filter(([index]) => index === 0).length;
if (mainHints * 100 < bodies[0].length)
  fail(`${mainHints} hints for ${bodies[0].length} bytes of the compiled function`);
console.log(`OK ${hints.length} branch hints, ${mainHints} in ${bodies[0].length} bytes of the compiled function`);
