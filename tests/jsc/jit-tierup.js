// A loop entered once gets V8's optimized code too (docs/jit.md, run with BL_JIT=1). V8 compiles
// the JIT's WebAssembly in two tiers and a function keeps the code it was called with: a long
// loop in a function called once stayed in the first tier, about 2.5x slower. Loops return every
// 10000 iterations and are called again, so one long call is about as fast as many short ones.
function trial(index) {
    const work = new Function("n", `
        let s = ${index}, a = 1, b = 2;
        for (let i = 0; i < n; i++) { s = (s + (i ^ a) * 3) | 0; a = (a + b) & 1023; b = (b ^ s) & 255; }
        return s;`);
    // The first call: the loop gets hot, compiles and goes on in the compiled code (first tier)
    let start = preciseTime();
    work(10000000);
    const long = preciseTime() - start;
    start = preciseTime();
    for (let i = 0; i < 1000; i++)
        work(10000);
    const short = preciseTime() - start;
    return long / short;
}

let best = Infinity;
for (let i = 0; i < 3; i++)
    best = Math.min(best, trial(i));
if (best > 1.6)
    throw new Error("one long call took " + best.toFixed(2) + "x as long as many short ones (at most 1.6)");
print("OK jit-tierup " + best.toFixed(2));
