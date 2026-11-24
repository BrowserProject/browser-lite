// Speed of what an obfuscated decoder or VM does for every byte (docs/jit.md, run.sh runs it with
// BL_JIT=1; HUMAN's auditor.js decrypts its bytecode in a Uint8Array with Math.imul and reads
// its operands with DataView getters). Each against the same loop over an int32 array, whose
// reads and writes are inline: a Uint8Array's element, a DataView getter and charCodeAt. Before
// they were 2.3 to 2.4, 7.4 to 8.1 and 6.5 to 7.2 times the loop, now 1.1 to 1.3, 1.5 to 1.7
// and 1.5 to 1.6.
var now = typeof preciseTime === "function" ? () => preciseTime() * 1000 : () => Date.now();
// The fastest of 7 rounds of each, the functions taking turns, so a busy machine slows all alike
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
const bytes = new Uint8Array(4096);
const ints = new Array(4096).fill(0);
for (let i = 0; i < 4096; i++) {
    bytes[i] = (i * 31) & 255;
    ints[i] = (i * 31) & 255;
}
const view = new DataView(bytes.buffer);
const text = Array.from(bytes.subarray(0, 2048), (b) => String.fromCharCode(32 + (b & 63))).join("");
// The loop all are measured against: reads and writes of an int32 array
function plain(n) {
    const a = ints;
    let s = 0;
    for (let i = 0; i < n; i++) {
        const k = i & 4095;
        a[k] = (a[k] ^ s) & 255;
        s = (s + a[k ^ 1]) & 0xffff;
    }
    sink = s;
}
function typed(n) {
    const a = bytes;
    let s = 0;
    for (let i = 0; i < n; i++) {
        const k = i & 4095;
        a[k] = (a[k] ^ s) & 255;
        s = (s + a[k ^ 1]) & 0xffff;
    }
    sink = s;
}
function dataView(n) {
    const a = ints, v = view;
    let s = 0;
    for (let i = 0; i < n; i++) {
        const k = i & 4095;
        a[k] = (a[k] ^ s) & 255;
        s = (s + v.getUint16(k & 4094, true)) & 0xffff;
    }
    sink = s;
}
function charCodes(n) {
    const a = ints, t = text;
    let s = 0;
    for (let i = 0; i < n; i++) {
        const k = i & 4095;
        a[k] = (a[k] ^ s) & 255;
        s = (s + t.charCodeAt(k & 2047)) & 0xffff;
    }
    sink = s;
}
// Compiled before timing
for (let i = 0; i < 300; i++) { plain(200); typed(200); dataView(200); charCodes(200); }
const [base, ...others] = fastest([plain, typed, dataView, charCodes], 1000000);
const ratios = others.map((t) => t / base);
const limits = [1.6, 2.5, 2.5];
const textOut = ratios.map((r) => r.toFixed(2)).join(" ");
if (ratios.some((r, i) => r > limits[i]))
    throw new Error("typed array, DataView or charCodeAt too slow: " + textOut + " times the int32 array loop (limits " + limits.join(" ") + ")");
print("OK " + textOut);
