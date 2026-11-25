// Strict equality of values with two tags (`o === undefined`, `o !== null` of an object) and of
// two atoms (`kind === "div"`) against the same loop over int32 (patch 0185 for the interpreter,
// docs/jit.md for compiled code): before both called C++ for every comparison, in the
// interpreter 1.39 to 1.48 times the int32 loop (now 1.16 to 1.19), in compiled code 4.0 to 5.3
// times (now 1.9 to 2.3). The limit is the argument after `--` (run.sh: one for each).
const now = typeof preciseTime === "function" ? () => preciseTime() * 1000 : () => Date.now();
const n = 262144;
const objects = [{}, undefined, null, {}, "div", "span", 7, true];
const kinds = ["div", "span", "div", "a", "span", "p", "div", "b"];
const numbers = [1, 2, 3, 4, 5, 6, 7, 8];
function mixed() {
    let c = 0;
    for (let i = 0; i < n; i++) {
        const o = objects[i & 7], k = kinds[(i >> 3) & 7];
        if (o === undefined)
            c++;
        if (o !== null)
            c += 2;
        if (k === "div")
            c += 4;
    }
    return c;
}
function int32() {
    let c = 0;
    for (let i = 0; i < n; i++) {
        const o = numbers[i & 7], k = numbers[(i >> 3) & 7];
        if (o === 2)
            c++;
        if (o !== 3)
            c += 2;
        if (k === 1)
            c += 4;
    }
    return c;
}
let fastest = Infinity, twinFastest = Infinity, result = 0;
for (let round = 0; round < 12; round++) {
    let start = now();
    result = mixed();
    fastest = Math.min(fastest, now() - start);
    start = now();
    int32();
    twinFastest = Math.min(twinFastest, now() - start);
}
if (result !== n / 8 * (1 + 2 * 7) + n / 8 * 3 * 4)
    throw new Error("wrong result " + result);
const ratio = Math.max(fastest, 0.1) / Math.max(twinFastest, 0.1);
print("strict equality of two tags and atoms: " + ratio.toFixed(2) + " times int32");
const limit = typeof arguments !== "undefined" && arguments.length ? Number(arguments[0]) : Infinity;
if (!(ratio <= limit))
    throw new Error("slow strict equality: " + ratio.toFixed(2) + " times the int32 loop");
print("OK " + ratio.toFixed(2));
