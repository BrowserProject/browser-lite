// Calls in compiled code (docs/jit.md, run with BL_JIT=1): a site that calls many different
// functions, like an obfuscated VM's dispatch (handlers[op](state)), costs about as much as one that
// always calls the same (1.3 to 1.8 times, against 2.3 to 3 times with a cache per site, which
// missed on every call). Results of calls in WASM: jit.js.
const now = typeof preciseTime === "function" ? () => preciseTime() * 1000 : () => Date.now();
const n = 1000000;
const many = [];
for (let k = 0; k < 16; k++)
    many.push(new Function("s", "x", "return (s + x + " + k + ") | 0;"));
const one = many.map(() => many[3]);
function callAll(callees) {
    let s = 0;
    for (let i = 0; i < n; i++)
        s = callees[i & 15](s, i);
    return s;
}
// The fastest of rounds that alternate the two, so a busy machine slows both alike
function compare(name, f, a, twin, twinArgument, limit) {
    let fastest = Infinity;
    let twinFastest = Infinity;
    for (let round = 0; round < 15; round++) {
        let start = now();
        f(a);
        fastest = Math.min(fastest, now() - start);
        start = now();
        twin(twinArgument);
        twinFastest = Math.min(twinFastest, now() - start);
    }
    const ratio = Math.max(fastest, 0.1) / Math.max(twinFastest, 0.1);
    print(name + ": " + ratio.toFixed(2) + " times its twin");
    if (ratio > limit)
        throw new Error(name + " takes " + ratio.toFixed(2) + " times the time of its twin (at most " + limit + ")");
}
function expected(addend) {
    let s = 0;
    for (let i = 0; i < n; i++)
        s = (s + i + addend(i)) | 0;
    return s;
}
if (callAll(many) !== expected((i) => i & 15) || callAll(one) !== expected(() => 3))
    throw new Error("wrong result");
compare("many callees at one site", callAll, many, callAll, one, 2);
print("OK jit-calls");
