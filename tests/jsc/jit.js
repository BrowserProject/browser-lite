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
function readX(o) { return o.x; }
function writeX(o, v) { o.x = v; return o.x; }
function remainder(a, b) { return a % b; }
function manyProperties() { const o = {}; for (let i = 0; i < 80; i++) o["p" + i] = i; return o; }
// Calls from compiled code: compiled callees, host functions, everything else generic
function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
function maxOf(a, b) { return Math.max(a, b) + "abc".charCodeAt(1); }
function pushTwice(list, v) { list.push(v); list.push(v); return list.length; }
function add3(a, b, c) { return a + b + c; }
function callBound(f) { return f(1); }
function callShort() { return add3(1, 2); }
function countArguments() { return arguments.length; }
function callArguments() { return countArguments(1, 2, 3); }
function thrower(x) { if (x > 0) throw new RangeError("x"); return x; }
function callThrower(x) { return thrower(x); }
function callNotAFunction(o) { return o.missing(); }
function deep(n) { return n ? deep(n - 1) + 1 : 0; }
// Scopes: closure variables some levels up, global let (also before its initialization), var
function makeCounter() { let count = 0; return function outer() { return (function inner() { count++; return count; })(); }; }
function readLate() { return lateLet; }
var globalVar = 5;
function readGlobalVar() { return globalVar; }
globalThis.globalProperty = 1;
function readGlobalProperty() { return globalProperty; }
// More instructions: construct, instanceof, in, delete, regexp, closures, nullish jumps
function Point(x) { this.x = x; }
class Box { constructor(v) { this.v = v; } }
function makeThings(n) { const p = new Point(n); const b = new Box(n); const a = new Array(2); return p.x + b.v + a.length + (p instanceof Point ? 1 : 0); }
function hasKeys(o) { return ("x" in o ? 1 : 0) + ("nope" in o ? 10 : 0); }
function removeKey(o) { delete o.gone; return o.gone === undefined; }
function matches(text) { return /b+/.test(text); }
function adder(n) { const add = (x) => x + n; return add(1); }
function nullish(x) { return x ?? "default"; }
function isNullish(x) { return x == null; }
function secondArgument() { return arguments[1]; }
let captured = 0;
function closure() { captured++; return captured; }

const counter = makeCounter();
let tdz = null;
try {
    readLate();
} catch (e) {
    tdz = e;
}
check("TDZ", tdz instanceof ReferenceError, true);
let lateLet = "late";
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
    // Property caches: one shape, then others (the cache misses, the slow path answers)
    const plain = { x: round };
    check("get cached", readX(plain), round);
    check("get other shape", readX({ y: 1, x: "s" }), "s");
    check("get getter", readX({ get x() { return 7; } }), 7);
    check("get prototype", readX(Object.create({ x: 9 })), 9);
    const big = manyProperties();
    big.x = round * 2;
    check("get out of line", readX(big), round * 2);
    check("put cached", writeX(plain, round + 1), round + 1);
    check("put out of line", writeX(big, "o"), "o");
    check("put new property", writeX({}, 3), 3);
    check("put cell", writeX(plain, plain), plain);
    check("%", remainder(17, 5), 2);
    check("% negative", remainder(-7, 3), -1);
    check("% -0", remainder(-6, 3), -0);
    check("% 0", remainder(5, 0), NaN);
    check("% min", remainder(-2147483648, -1), -0);
    check("% double", remainder(5.5, 2), 1.5);
    check("closure levels", counter(), round + 1);
    check("global let", readLate(), "late");
    check("global var", readGlobalVar(), 5);
    check("global property", readGlobalProperty(), round === 0 ? 1 : round);
    globalThis.globalProperty = round + 1;
    check("construct", makeThings(round), round * 2 + 3);
    check("in", hasKeys({ x: 1 }), 1);
    check("delete", removeKey({ gone: 1 }), true);
    check("regexp", matches("abbc"), true);
    check("closure creation", adder(round), round + 1);
    check("??", nullish(null), "default");
    check("?? value", nullish(0), 0);
    check("== null", isNullish(undefined), true);
    check("== null object", isNullish({}), false);
    check("missing argument", secondArgument(1), undefined);
    check("argument", secondArgument(1, 2), 2);
    check("fib", fib(15), 610);
    check("host functions", maxOf(3, 8), 8 + 98);
    check("push", pushTwice([], round), 2);
    check("bound", callBound(add3.bind(null, 10, 20)), 31);
    check("arity", callShort(), NaN);
    check("arguments", callArguments(), 3);
    check("callee returns", callThrower(0), 0);
    let calleeThrew = null;
    try {
        callThrower(1);
    } catch (e) {
        calleeThrew = e;
    }
    check("callee throws", calleeThrew instanceof RangeError, true);
    let notFunction = null;
    try {
        callNotAFunction({});
    } catch (e) {
        notFunction = e;
    }
    check("not a function", notFunction instanceof TypeError, true);
    let tooDeep = null;
    if (round === 299) {
        try {
            deep(1e6);
        } catch (e) {
            tooDeep = e;
        }
        check("stack overflow", tooDeep instanceof RangeError, true);
    }
    check("deep enough", deep(500), 500);
    let caught = null;
    try {
        throws({});
    } catch (e) {
        caught = e;
    }
    check("exception", caught instanceof TypeError, true);
}
print("OK jit");
