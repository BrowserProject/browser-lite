// The JIT's fast paths for hashing code (docs/jit.md, run with BL_JIT=1): bit operations on uint32
// values above 2^31 (doubles), typed array elements and Math.imul run inline, about as fast as
// their twins on int32 values in an array (several times slower through the interpreter's slow
// paths).
const now = typeof preciseTime === "function" ? () => preciseTime() * 1000 : () => Date.now();
const n = 1000000;
const bytes = new Uint8Array(n);
const plain = [];
for (let i = 0; i < n; i++) {
    bytes[i] = (i * 2654435761) >>> 24;
    plain.push(bytes[i]);
}
function unsignedBits(a) {
    let h = 0x811c9dc5;
    for (let i = 0; i < n; i++) {
        h = (h ^ a[i]) >>> 0;
        h = ((h << 13) | (h >>> 19)) >>> 0;
    }
    return h;
}
function signedBits(a) {
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < n; i++) {
        h = (h ^ a[i]) | 0;
        h = ((h << 13) | (h >>> 19)) | 0;
    }
    return h;
}
function update(a) {
    for (let i = 0; i < n; i++)
        a[i] = (a[i] + 7) & 255;
    return a[n - 1];
}
function imul(a) {
    let h = 1;
    for (let i = 0; i < n; i++)
        h = Math.imul(h, 0xcc9e2d51) ^ a[i];
    return h;
}
function add(a) {
    let h = 1;
    for (let i = 0; i < n; i++)
        h = ((h & 0xffff) + 0x1b873593) ^ a[i];
    return h;
}
function best(f, a) {
    let fastest = Infinity;
    for (let round = 0; round < 7; round++) {
        const start = now();
        f(a);
        fastest = Math.min(fastest, now() - start);
    }
    return Math.max(fastest, 0.1);
}
function compare(name, f, a, twin, twinArgument, limit) {
    const ratio = best(f, a) / best(twin, twinArgument);
    print(name + ": " + ratio.toFixed(2) + " times its twin");
    if (ratio > limit)
        throw new Error(name + " is " + ratio.toFixed(1) + " times slower than its twin");
}
if (unsignedBits(bytes) !== signedBits(plain) >>> 0 || imul(plain) !== 1213271617)
    throw new Error("wrong hash");
compare("uint32 bits", unsignedBits, bytes, signedBits, plain, 3);
compare("typed array", update, bytes, update, plain, 2);
compare("Math.imul", imul, plain, add, plain, 3.5);
print("OK jit-hash");
