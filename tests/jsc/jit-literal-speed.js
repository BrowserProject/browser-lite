// Array literals and getters in compiled code (docs/jit.md, run.sh runs it with BL_JIT=1): an
// obfuscated VM makes an array literal and reads a getter for many of its instructions. Compiled
// code makes a literal without a call into C++ and calls a getter without a VM entry. Before, a
// literal of three values cost 3.2 to 3.6 times three element writes through the module's function
// (then 1.0 to 1.2), a literal of constants 1.6 to 2.0 times (then 0.7 to 0.8); against the inline
// element writes of #646 a literal is 2.8 to 4.0 times, one of constants 1.8 to 2.3 times. A getter
// took 4.8 to 5.4 times a method call (now 2.9 to 3.9, also read with a key). A CI runner measured
// 3.0 3.0 3.2 3.3 for the four ratios below. `jit-literals.js` checks their results.
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
let sink = null;
function literals(n) { for (let i = 0; i < n; i++) sink = [i, i, 3]; }
const target = [0, 0, 0];
function writes(n) { const a = target; for (let i = 0; i < n; i++) { a[0] = i; a[1] = i; a[2] = 3; } sink = a; }
function constants(n) { for (let i = 0; i < n; i++) sink = [1, 2, 3, 4]; }
class Box { constructor() { this._v = 2; } get v() { return this._v; } m() { return this._v; } }
const box = new Box();
function getters(n) { let s = 0; for (let i = 0; i < n; i++) s += box.v; sink = s; }
function methods(n) { let s = 0; for (let i = 0; i < n; i++) s += box.m(); sink = s; }
const key = "v";
function keyedGetters(n) { let s = 0; for (let i = 0; i < n; i++) s += box[key]; sink = s; }
// Compiled before timing
for (let i = 0; i < 300; i++) { literals(100); writes(100); constants(100); getters(100); methods(100); keyedGetters(100); }
const n = 300000;
const [literal, constant, write] = fastest([literals, constants, writes], n);
const [getter, keyed, method] = fastest([getters, keyedGetters, methods], n);
const ratios = [literal / write, constant / write, getter / method, keyed / method];
const limits = [5, 4, 4.5, 4.5];
const text = ratios.map((r) => r.toFixed(1)).join(" ");
for (let i = 0; i < ratios.length; i++) {
    if (ratios[i] > limits[i])
        throw new Error("too slow: " + text + " (limits " + limits.join(" ") + ")");
}
print("OK " + text);
