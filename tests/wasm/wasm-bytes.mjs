// WebAssembly-Module von Hand fuer die Tests: tests/wasm und e2e/wasm-test.mjs
// (dort als Quelltext in die Testseite eingesetzt, darum ohne Abhaengigkeiten
// ausser untereinander)
export const leb = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
export const str = (t) => { const b = [...new TextEncoder().encode(t)]; return [...leb(b.length), ...b]; };
export const sec = (id, ...items) => { const body = [...leb(items.length), ...items.flat()]; return [id, ...leb(body.length), ...body]; };
export const code = (...instr) => { const body = [0, ...instr, 11]; return [...leb(body.length), ...body]; };
export const wasm = (...sections) => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...sections.flat()]);

// Quelltext aller Hilfen fuer eine Testseite
export const source = Object.entries({ leb, str, sec, code, wasm }).map(([name, fn]) => `const ${name} = ${fn};`).join('\n');
