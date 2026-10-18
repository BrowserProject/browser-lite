// Hand written WebAssembly modules for the tests: tests/engine-js and tests/core/wasm-test.mjs
// (inserted there as source text into the test page, so no dependencies except each other)
export const leb = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
export const str = (t) => {
  const b = [...new TextEncoder().encode(t)];
  return [...leb(b.length), ...b];
};
export const sec = (id, ...items) => {
  const body = [...leb(items.length), ...items.flat()];
  return [id, ...leb(body.length), ...body];
};
export const code = (...instr) => {
  const body = [0, ...instr, 11];
  return [...leb(body.length), ...body];
};
export const wasm = (...sections) =>
  new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...sections.flat()]);

// Three memories: m0 (i32, 1 page), m1 (i32, 1 to 3 pages, "Zwei" at 16, passive segment
// "Init"), m2 (i64, 1 page, "Dre" at 0). Accesses, grow, copy, fill, init and atomics with a
// memory index
export const multiMemoryModule = () =>
  wasm(
    sec(
      1,
      [0x60, 2, 0x7f, 0x7f, 0],
      [0x60, 1, 0x7f, 1, 0x7f],
      [0x60, 0, 1, 0x7f],
      [0x60, 3, 0x7f, 0x7f, 0x7f, 0],
      [0x60, 3, 0x7e, 0x7f, 0x7f, 0],
      [0x60, 1, 0x7e, 1, 0x7f],
      [0x60, 2, 0x7f, 0x7f, 1, 0x7f],
    ),
    sec(3, [0], [1], [1], [2], [1], [3], [3], [4], [5], [3], [6]),
    sec(5, [0x00, 1], [0x01, 1, 3], [0x04, 1]),
    sec(
      7,
      [...str('m0'), 2, 0],
      [...str('m1'), 2, 1],
      [...str('m2'), 2, 2],
      ...[
        'store1',
        'load1',
        'load0',
        'size1',
        'grow1',
        'copy10',
        'fill1',
        'copy21',
        'load2',
        'init1',
        'add1',
      ].map((name, i) => [...str(name), 0, i]),
    ),
    [12, 1, 3],
    sec(
      10,
      code(0x20, 0, 0x20, 1, 0x36, 0x42, 1, 0),
      code(0x20, 0, 0x28, 0x42, 1, 0),
      code(0x20, 0, 0x28, 2, 0),
      code(0x3f, 1),
      code(0x20, 0, 0x40, 1),
      code(0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 10, 0, 1),
      code(0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 11, 1),
      code(0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 10, 2, 1),
      code(0x20, 0, 0x2d, 0x40, 2, 0),
      code(0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 8, 1, 1),
      code(0x20, 0, 0x20, 1, 0xfe, 0x1e, 0x42, 1, 0),
    ),
    sec(
      11,
      [0x02, 1, 0x41, 16, 0x0b, ...str('Zwei')],
      [0x01, ...str('Init')],
      [0x02, 2, 0x42, 0, 0x0b, ...str('Dre')],
    ),
  );

// memory64: one i64 memory "memory" (1 to 4 pages, "Hallo" at 8, passive segment "Init").
// far reads with offset 2^32, which always traps
export const memory64Module = () =>
  wasm(
    sec(
      1,
      [0x60, 2, 0x7e, 0x7e, 0],
      [0x60, 1, 0x7e, 1, 0x7e],
      [0x60, 0, 1, 0x7e],
      [0x60, 3, 0x7e, 0x7f, 0x7e, 0],
      [0x60, 3, 0x7e, 0x7e, 0x7e, 0],
      [0x60, 1, 0x7e, 1, 0x7f],
      [0x60, 2, 0x7e, 0x7e, 1, 0x7e],
      [0x60, 3, 0x7e, 0x7f, 0x7f, 0],
    ),
    sec(3, [0], [1], [2], [1], [3], [4], [5], [1], [6], [7]),
    sec(5, [0x05, 1, 4]),
    sec(
      7,
      [...str('memory'), 2, 0],
      ...['store', 'load', 'size', 'grow', 'fill', 'copy', 'load8', 'far', 'add', 'init'].map(
        (name, i) => [...str(name), 0, i],
      ),
    ),
    [12, 1, 2],
    sec(
      10,
      code(0x20, 0, 0x20, 1, 0x37, 3, 0),
      code(0x20, 0, 0x29, 3, 0),
      code(0x3f, 0),
      code(0x20, 0, 0x40, 0),
      code(0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 11, 0),
      code(0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 10, 0, 0),
      code(0x20, 0, 0x2d, 0, 0),
      code(0x20, 0, 0x29, 3, 0x80, 0x80, 0x80, 0x80, 0x10),
      code(0x20, 0, 0x20, 1, 0xfe, 0x1f, 3, 0),
      code(0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 8, 1, 0),
    ),
    sec(11, [0x00, 0x42, 8, 0x0b, ...str('Hallo')], [0x01, ...str('Init')]),
  );

// Sequence of calls, results or the error name as text. Expected is the result of the original
// (measured in node and Chromium)
export const MULTI_MEMORY_RESULT =
  '1768257370,0,99:0,1768257370,1,1,2,1768257370,-1,328965,90,68,1953066569,99,100,' +
  'RuntimeError,RuntimeError,RuntimeError,RuntimeError,RuntimeError,RuntimeError,RuntimeError';
export const MEMORY64_RESULT =
  '72,1234605616436508552,1,1,3,1234605616436508552,-1,-1,-1,5,RuntimeError,RuntimeError,RuntimeError,' +
  'RuntimeError,7,RuntimeError,RuntimeError,97,RuntimeError,1234605616436508552,1234605616436508553,RuntimeError,73,RuntimeError';
const outcome = (fn) => {
  try {
    return String(fn());
  } catch (e) {
    return e.name;
  }
};
export const multiMemoryRun = (e) =>
  [
    () => e.load1(16),
    () => e.load0(16),
    () => (e.store1(32, 99), e.load1(32) + ':' + e.load0(32)),
    () => (e.copy10(0, 16, 4), e.load0(0)),
    () => e.size1(),
    () => e.grow1(1),
    () => e.size1(),
    () => e.load1(16),
    () => e.grow1(2),
    () => (e.fill1(100, 5, 3), e.load1(100)),
    () => (e.copy21(10n, 16, 4), e.load2(10n)),
    () => e.load2(0n),
    () => (e.init1(200, 0, 4), e.load1(200)),
    () => e.add1(32, 1),
    () => e.load1(32),
    () => e.load1(2 * 65536 - 3),
    () => e.load0(65536 - 3),
    () => e.copy10(65536 - 2, 0, 4),
    () => e.copy10(0, 2 * 65536 - 2, 4),
    () => e.copy21(65534n, 0, 4),
    () => e.fill1(2 * 65536 - 1, 0, 2),
    () => e.init1(0, 2, 4),
  ]
    .map(outcome)
    .join(',');
export const memory64Run = (e) =>
  [
    () => e.load8(8n),
    () => (e.store(16n, 0x1122334455667788n), e.load(16n)),
    () => e.size(),
    () => e.grow(2n),
    () => e.size(),
    () => e.load(16n),
    () => e.grow(2n),
    () => e.grow(-1n),
    () => e.grow(2n ** 40n),
    () => (e.store(3n * 65536n - 8n, 5n), e.load(3n * 65536n - 8n)),
    () => e.load(3n * 65536n - 7n),
    () => e.load(2n ** 32n),
    () => e.load(-8n),
    () => e.far(0n),
    () => (e.fill(100n, 7, 10n), e.load8(105n)),
    () => e.fill(0n, 1, -1n),
    () => e.fill(-2n, 1, 4n),
    () => (e.copy(200n, 8n, 4n), e.load8(201n)),
    () => e.copy(0n, -2n, 4n),
    () => e.add(16n, 1n),
    () => e.load(16n),
    () => e.add(-8n, 1n),
    () => (e.init(300n, 0, 4), e.load8(300n)),
    () => e.init(-1n, 0, 1),
  ]
    .map(outcome)
    .join(',');

// Source text of all helpers for a test page
export const source = Object.entries({
  leb,
  str,
  sec,
  code,
  wasm,
  multiMemoryModule,
  memory64Module,
  outcome,
  multiMemoryRun,
  memory64Run,
})
  .map(([name, fn]) => `const ${name} = ${fn};`)
  .join('\n');
