// A property read that sees two shapes (patch 0179): the interpreter's cache of a get_by_id or
// get_length keeps the structure it had as a second one, and compiled code checks it too. The
// result must stay right when the shapes change, die or turn into dictionaries; and two shapes
// at one site must cost about what one costs (before, 2.2 times in the interpreter: every
// alternation went to the slow path and replaced the other shape).
function check(name, actual, expected) {
    if (actual !== expected)
        throw new Error(name + ": " + actual + " instead of " + expected);
}

function readX(o) { return o.x; }
function readLength(o) { return o.length; }

// Two shapes alternating, each with x at another offset
const a = { x: 1 };
const b = { y: 0, z: 0, x: 2 };
for (let i = 0; i < 200; i++)
    check("two shapes", readX(i & 1 ? b : a), i & 1 ? 2 : 1);

// The value changes in place: the second entry reads the slot, not a copy
b.x = 20;
check("changed in place", readX(b), 20);
check("first still right", readX(a), 1);

// The second shape changes: a deleted property and one added later
const c = { p: 0, x: 3 };
for (let i = 0; i < 200; i++)
    check("before delete", readX(i & 1 ? c : a), i & 1 ? 3 : 1);
delete c.x;
check("deleted", readX(c), undefined);
c.x = 4;
check("added again", readX(c), 4);
Object.prototype.x = "proto";
check("from the prototype", readX({ q: 1 }), "proto");
delete Object.prototype.x;
check("prototype gone", readX({ q: 1 }), undefined);

// Out-of-line offsets and dictionaries
const wide = {};
for (let i = 0; i < 300; i++)
    wide["p" + i] = i;
wide.x = 5;
const dict = {};
for (let i = 0; i < 100; i++)
    dict["d" + i] = i;
dict.x = 6;
for (let i = 0; i < 200; i++) {
    check("out of line", readX(i & 1 ? wide : a), i & 1 ? 5 : 1);
    check("dictionary", readX(i & 1 ? dict : wide), i & 1 ? 6 : 5);
}
delete dict.d50;
dict.added = 7;
check("dictionary after delete", readX(dict), 6);
delete dict.x;
dict.other = 8;
check("dictionary without x", readX(dict), undefined);

// Shapes that die: the GC drops a second structure, new objects may get its memory
function shaped(k) {
    const o = {};
    for (let i = 0; i < k; i++)
        o["s" + k + "_" + i] = i;
    o.x = k;
    return o;
}
for (let round = 0; round < 20; round++) {
    let first = shaped(round), second = shaped(round + 100);
    for (let i = 0; i < 50; i++)
        check("round " + round, readX(i & 1 ? second : first), i & 1 ? round + 100 : round);
    first = second = null;
    if (round % 5 === 4)
        fullGC();
    const other = { u: round, v: round, x: -round };
    check("after gc " + round, readX(other), -round);
}

// get_length: arrays, strings and objects at one site
const arr = [1, 2, 3];
const lengthy = { length: 9 };
const lengthier = { w: 0, length: 10 };
for (let i = 0; i < 300; i++) {
    const kind = i % 4;
    const value = kind === 0 ? arr : kind === 1 ? "abcd" : kind === 2 ? lengthy : lengthier;
    check("length " + kind, readLength(value), [3, 4, 9, 10][kind]);
}
check("rope", readLength("ab" + String(Math.random()).slice(0, 4)), 6);
lengthier.length = 11;
check("length in place", readLength(lengthier), 11);

// Speed: the same reads with one shape and with two (fastest of 5)
function make(k) {
    const o = {};
    for (let i = 0; i < k; i++)
        o["p" + i] = i;
    o.x = 1;
    return o;
}
function loop(objects, n) {
    let sum = 0;
    const mask = objects.length - 1;
    for (let i = 0; i < n; i++) {
        const o = objects[i & mask];
        sum += o.x + o.x + o.x + o.x;
    }
    return sum;
}
function time(shapes) {
    const objects = [];
    for (let s = 0; s < shapes; s++)
        objects.push(make(s));
    let best = Infinity;
    for (let round = 0; round < 5; round++) {
        const start = Date.now();
        check("sum", loop(objects, 600000), 2400000);
        best = Math.min(best, Date.now() - start);
    }
    return best;
}
const one = time(1);
const two = time(2);
const ratio = two / Math.max(one, 1);
if (ratio > 1.4)
    throw new Error("two shapes took " + ratio.toFixed(2) + " times one shape (" + two + " against " + one + " ms)");

print("OK llint-two-shapes (two shapes " + ratio.toFixed(2) + " times one)");
