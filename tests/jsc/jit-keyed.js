// Reads and writes with string keys in compiled code (docs/jit.md, run with BL_JIT=1): a site that
// reads and writes many keys of objects of many shapes, like an obfuscated VM's handler for every
// property access of its program (o[key]), costs a few times an array element's access through the
// VM's megamorphic cache (in the engine 1.1 to 1.2 times; before it every access took the
// interpreter's slow path, 2.3 to 2.9 times). Since an element read of a site that saw only int32
// and contiguous arrays is inline (#646) the elements take less: 1.6 to 1.8 times.
// Results with every kind of key: jit.js.
const now = typeof preciseTime === "function" ? () => preciseTime() * 1000 : () => Date.now();
const n = 400000;
const names = [];
for (let k = 0; k < 16; k++)
    names.push("key" + k);
const objects = [];
for (let s = 0; s < 8; s++) {
    const o = {};
    for (let k = 0; k < s; k++)
        o["pad" + k] = k;
    for (const name of names)
        o[name] = s;
    objects.push(o);
}
const elements = [];
for (let i = 0; i < 128; i++)
    elements.push(i >> 4);
function keyed() {
    let s = 0;
    for (let i = 0; i < n; i++) {
        const o = objects[i & 7];
        const k = names[(i >> 3) & 15];
        o[k] = o[k] + 1;
        s += o[k];
    }
    return s;
}
function indexed() {
    let s = 0;
    for (let i = 0; i < n; i++) {
        const k = (i & 7) + ((i >> 3) & 15) * 8;
        elements[k] = elements[k] + 1;
        s += elements[k];
    }
    return s;
}
// The fastest of rounds that alternate the two, so a busy machine slows both alike
let fastest = Infinity;
let twinFastest = Infinity;
for (let round = 0; round < 15; round++) {
    let start = now();
    keyed();
    fastest = Math.min(fastest, now() - start);
    start = now();
    indexed();
    twinFastest = Math.min(twinFastest, now() - start);
}
// Each object and key, and each element, once in 128 iterations
if (objects[3].key5 !== 3 + 15 * n / 128 || elements[45] !== (45 >> 4) + 15 * n / 128)
    throw new Error("wrong result " + objects[3].key5 + " " + elements[45]);
const ratio = Math.max(fastest, 0.1) / Math.max(twinFastest, 0.1);
print("keyed reads and writes: " + ratio.toFixed(2) + " times element reads and writes");
if (ratio > 2.5)
    throw new Error("keyed reads and writes take " + ratio.toFixed(2) + " times the time of element ones (at most 2.5)");
print("OK jit-keyed");
