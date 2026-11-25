// `===` and `!==` against a reference that uses no strict equality, in the interpreter (patch 0185:
// two tags, the same cell and atoms without C++) and in compiled code (docs/jit.md), for every
// pair of values of every kind: numbers as int32 and double, NaN, -0, atoms, ropes, strings made at
// run time and substrings, symbols, BigInts, objects, functions, booleans, null and undefined.
// The text of two strings by relational comparison, which takes no path of `===`
function text(a, b) { return !(a < b || a > b); }
function same(a, b) {
    const ta = typeof a, tb = typeof b;
    if (!text(ta, tb))
        return false;
    if (text(ta, "number"))
        return !(a < b || a > b || Number.isNaN(a) || Number.isNaN(b));
    if (text(ta, "string")) {
        if (a.length < b.length || a.length > b.length)
            return false;
        for (let i = 0; i < a.length; i++) {
            const d = a.charCodeAt(i) - b.charCodeAt(i);
            if (d < 0 || d > 0)
                return false;
        }
        return true;
    }
    if (text(ta, "bigint"))
        return a <= b && a >= b;
    return Object.is(a, b);
}
const obj = {}, fn = function () {}, sym = Symbol("s");
const made = ["ab", "c"].join("");
const values = [0, 1, -1, 1.5, -0, 0.5 + 0.5, NaN, 2 ** 31, Infinity, "", "abc", "ab" + "c", made,
    made.slice(0, 2), "xabcx".substring(1, 4), "abc".repeat(1), "a".repeat(40), "a".repeat(39) + "a", "1", "true",
    "undefined", true, false, null, undefined, obj, {}, fn, [], sym, Symbol("s"), 1n, 2n ** 70n, 2n ** 70n, String(Number("1"))];
// A rope: a concatenation made at run time, not flattened before the comparison
function rope(s) { return s + ""; }
function eq(a, b) { return a === b; }
function neq(a, b) { return a !== b; }
function jump(a, b) { if (a === b) return 1; return 0; }
function notJump(a, b) { if (a !== b) return 0; return 1; }
let checked = 0;
for (let round = 0; round < 300; round++) {
    for (let i = 0; i < values.length; i++) {
        for (let j = 0; j < values.length; j++) {
            let a = values[i], b = values[j];
            if (round & 1 && text(typeof a, "string"))
                a = rope(a.length ? a.slice(0, 1) : "") + a.slice(1);
            const expected = same(a, b);
            if (eq(a, b) !== expected || neq(a, b) === expected || jump(a, b) !== +expected || notJump(a, b) !== +expected)
                throw new Error("wrong result for " + String(i) + " and " + String(j) + " in round " + round + ": expected " + expected);
            ++checked;
        }
    }
}
print("OK " + checked + " comparisons");
