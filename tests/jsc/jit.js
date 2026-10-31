// The JIT to WebAssembly (docs/jit.md, run with BL_JIT=1): functions without calls become hot
// (many returns) and run compiled. Their results must equal the interpreter's, also on the
// slow paths (doubles, strings, overflow, exceptions).
function check(name, actual, expected) {
    if (!Object.is(actual, expected))
        throw new Error(name + ": " + actual + " instead of " + expected);
}

function sum(n) { let s = 0; for (let i = 0; i < n; i++) s += i % 7; return s; }
function arith(a, b) { return (a + b) * (a - b) - (a * 3 | 0) + (a ^ b) + (a & 255); }
function overflow(a) { return a + 1; }
function negativeZero(a, b) { return a * b; }
function compare(a, b) { if (a < b) return -1; if (a > b) return 1; return a === b ? 0 : 2; }
function strings(a, b) { return a + "-" + b; }
function property(o) { o.count = (o.count | 0) + 1; return o.value * 2 + o.count; }
function element(array, i) { array[i] = array[i] + 1; return array[i]; }
function missing(o) { return o.nothing; }
function throws(o) { return o.deep.field; }
function kind(x) { return typeof x; }
function loopWithBreak(limit) { let i = 0; while (true) { i++; if (i >= limit) break; } return i; }
function unsignedShift(a) { return a >>> 1; }
function division(a, b) { return a / b; }
let captured = 0;
function closure() { captured++; return captured; }

const o = { value: 21 };
const array = [1, 2, 3];
for (let round = 0; round < 300; round++) {
    check("sum", sum(100), 295);
    check("arith ints", arith(7, 3), 40 - 21 + 4 + 7);
    check("arith doubles", arith(1.5, 0.5), 2 * 1 - 4 + 1 + 1);
    check("overflow", overflow(2147483647), 2147483648);
    check("int", overflow(41), 42);
    check("-0", negativeZero(0, -5), -0);
    check("mul", negativeZero(6, 7), 42);
    check("less", compare(1, 2), -1);
    check("greater", compare(2.5, 1), 1);
    check("equal", compare(3, 3), 0);
    check("NaN", compare(NaN, 1), 2);
    check("strings", strings("a", 1), "a-1");
    check("property", property(o), 42 + round + 1);
    check("element", element(array, 1), 3 + round);
    check("missing", missing(o), undefined);
    check("typeof", kind(round), "number");
    check("typeof string", kind("x"), "string");
    check("break", loopWithBreak(10), 10);
    check(">>>", unsignedShift(-2), 2147483647);
    check("/", division(7, 2), 3.5);
    check("closure", closure(), round + 1);
    let caught = null;
    try {
        throws({});
    } catch (e) {
        caught = e;
    }
    check("exception", caught instanceof TypeError, true);
}
print("OK jit");
