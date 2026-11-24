// Global variables and functions in compiled code (docs/jit.md, run.sh runs it with BL_JIT=1): an
// obfuscated script keeps its state and its functions at the top level, so its VM reads a global
// for many of its instructions. A site of scope access has its fast path inline for the type it
// had when its function compiled, where it called a function of the module for every access.
// Before, reading three globals or three closure variables took 4.3 to 5.1 times as long as three
// locals, now 1.6 to 1.9 times; three writes of closure variables 3.9 to 4.2 times as long as of
// locals, now 2.2 to 2.4 times. Results of every type against the interpreter: jit.js.
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
// A global variable (GlobalVar), a global `let` (GlobalLexicalVar) and a property of the global
// object made at run time (GlobalProperty)
var globalVariable = 3;
let globalLexical = 5;
globalThis.globalProperty = 7;
function globals(n) {
    let s = 0;
    for (let i = 0; i < n; i++)
        s = (s + globalVariable + globalLexical + globalProperty) & 0xffff;
    sink = s;
}
// The same through variables of a closure (a free variable of a function resolves like a global
// in the bytecode and is linked as a closure variable some levels up)
const closures = (() => {
    var closureVariable = 3;
    let closureLexical = 5;
    const closureConstant = 7;
    return function closures(n) {
        let s = 0;
        for (let i = 0; i < n; i++)
            s = (s + closureVariable + closureLexical + closureConstant) & 0xffff;
        sink = s;
    };
})();
// Writes of a closure's variables (an obfuscated VM's handlers move its program counter, `M += 2`)
const closureWrites = (() => {
    var counter = 0;
    let state = 0;
    return function closureWrites(n) {
        for (let i = 0; i < n; i++) {
            counter = (counter + 3) & 0xffff;
            state = (state + counter) & 0xffff;
            counter = (counter ^ state) & 0xffff;
        }
        sink = counter + state;
    };
})();
// And through local variables, which are registers of the frame
function localWrites(n) {
    let counter = 0, state = 0;
    for (let i = 0; i < n; i++) {
        counter = (counter + 3) & 0xffff;
        state = (state + counter) & 0xffff;
        counter = (counter ^ state) & 0xffff;
    }
    sink = counter + state;
}
function locals(n) {
    const localVariable = 3, localLexical = 5, localConstant = 7;
    let s = 0;
    for (let i = 0; i < n; i++)
        s = (s + localVariable + localLexical + localConstant) & 0xffff;
    sink = s;
}
// Compiled before timing
for (let i = 0; i < 300; i++) { globals(100); closures(100); locals(100); closureWrites(100); localWrites(100); }
const [global, closure, local, closureWrite, localWrite] = fastest([globals, closures, locals, closureWrites, localWrites], 1500000);
const ratios = [global / local, closure / local, closureWrite / localWrite];
const text = ratios.map((r) => r.toFixed(1)).join(" ");
if (ratios.some((r) => r > 3))
    throw new Error("scope access too slow: " + text + " times local variables (limit 3)");
print("OK " + text);
