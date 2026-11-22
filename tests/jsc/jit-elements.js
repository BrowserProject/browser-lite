// Element reads and writes in compiled code (docs/jit.md, run.sh runs it with BL_JIT=1): an
// obfuscated VM reads and writes its stack, registers and operands in arrays for nearly every
// instruction. A site whose profile saw only int32 and contiguous butterflies within bounds reads
// and writes the element inline, where it called a function of the module for every access: three
// reads took 2.0 to 2.1 times the same arithmetic without them, now 1.3 to 1.5; three writes 3.1 to
// 3.5 times, now 1.7 to 1.9 (a CI runner: 1.67 and 2.50). Results of every kind of element against
// the interpreter: jit.js.
var now = typeof preciseTime === "function" ? () => preciseTime() * 1000 : () => Date.now();
// The fastest of 7 rounds of each, the functions taking turns, so a busy machine slows both alike
function fastest(functions, n) {
    const best = functions.map(() => Infinity);
    for (let round = 0; round < 7; round++) {
        functions.forEach((f, i) => {
            const start = now();
            f(n);
            best[i] = Math.min(best[i], now() - start);
        });
    }
    return best;
}
var sink = 0;
const int32s = [1, 2, 3, 4, 5, 6, 7, 8];
const values = [1, "two", 3, {}, 5, null, 7, 8];
// Three reads of an int32 and a contiguous array
function elements(n) {
    const a = int32s, b = values;
    let s = 0;
    for (let i = 0; i < n; i++)
        s = (s + a[i & 7] + a[(i + 1) & 7] + (b[(i + 2) & 6] | 0)) & 0xffff;
    sink = s;
}
// Three writes of an int32 and a contiguous array
function writes(n) {
    const a = int32s, b = values;
    let s = 0;
    for (let i = 0; i < n; i++) {
        a[i & 7] = s;
        a[(i + 1) & 7] = i & 0xff;
        b[(i + 2) & 6] = s;
        s = (s + (i & 7) + ((i + 1) & 7) + ((i + 2) & 6)) & 0xffff;
    }
    sink = s;
}
// The same arithmetic without the reads and writes
function arithmetic(n) {
    const a = 1, b = 2, c = 3;
    let s = 0;
    for (let i = 0; i < n; i++)
        s = (s + (a + (i & 7)) + (b + ((i + 1) & 7)) + ((c + ((i + 2) & 6)) | 0)) & 0xffff;
    sink = s;
}
// Compiled before timing
for (let i = 0; i < 300; i++) { elements(100); writes(100); arithmetic(100); }
const [element, write, plain] = fastest([elements, writes, arithmetic], 1000000);
const ratios = [element / plain, write / plain];
const limits = [1.9, 2.9];
const text = ratios.map((r) => r.toFixed(2)).join(" ");
if (ratios.some((r, i) => r > limits[i]))
    throw new Error("element reads or writes too slow: " + text + " times the arithmetic alone (limits " + limits.join(" ") + ")");
print("OK " + text);
