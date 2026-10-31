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
function fourParameters(a, b, c, d) { return [a, b, c, d, arguments.length].join(); }
function callFewer(x) { return fourParameters() + "|" + fourParameters(x) + "|" + fourParameters(x, x, x); }
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
// The interpreter's other fast paths: doubles, arrays, transitions, prototypes, scopes, switch
function addition(a, b) { return a + b; }
function product(a, b) { return a * b; }
function quotient(a, b) { return a / b; }
function lessThan(a, b) { return a < b; }
function jumpLess(a, b) { if (a < b) return 1; return 0; }
function jumpNotLess(a, b) { if (!(a < b)) return 1; return 0; }
function strictEqual(a, b) { return a === b; }
function looseEqual(a, b) { return a == b; }
function jumpStrictEqual(a, b) { if (a === b) return "y"; return "n"; }
function negative(a) { return -a; }
function not(a) { return !a; }
function shiftLeft(a, b) { return a << b; }
function shiftRight(a, b) { return a >> b; }
function shiftUnsigned(a, b) { return a >>> b; }
function plus(a) { return +a; }
function truthy(a) { if (a) return 1; return 0; }
function sumAll(list) { let s = 0; for (let i = 0; i < list.length; i++) s += list[i]; return s; }
function setAt(list, i, v) { list[i] = v; return list; }
function literalFirst() { const list = [1, 2, 3]; list[0] = 9; return list[0] + [1, 2, 3][0]; }
function lengthOf(x) { return x.length; }
class Animal { constructor(name) { this.name = name; } speak() { return "I am " + this.name; } }
function speak(a) { return a.speak(); }
function maybe(o) { return o.later; }
function Pair(a, b) { this.a = a; this.b = b; }
function pairB(x) { return new Pair(x, x).b; }
let globalCount = 0;
function incrementGlobal() { globalCount++; return globalCount; }
var globalVariable = 0;
function setGlobalVariable(v) { globalVariable = v; return globalVariable; }
const constant = 1;
function setConstant() { constant = 2; }
function kindOfThis() { return typeof this; }
function number(x) { switch (x) { case 1: return "one"; case 2: return "two"; case 5: return "five"; default: return "other"; } }
function character(c) { switch (c) { case "a": return 1; case "b": return 2; default: return 0; } }
function word(w) { switch (w) { case "hello": return 1; case "world": return 2; default: return 0; } }
function sumArguments() { let s = 0; for (let i = 0; i < arguments.length; i++) s += arguments[i]; return s; }
function applyAll(list) { return sumArguments.apply(null, list); }
function collectN(a, b, c) { const junk = []; for (let i = 0; i < 1000; i++) junk.push({ i }); return a.n + b.n + c.n; }
function spreadAll(list) { return sumArguments(...list); }
function constructSpread(list) { return new Point(...list).x; }
function tailSum(n, total) { "use strict"; if (n === 0) return total; return tailSum(n - 1, total + n); }
class Base { constructor(x) { this.x = x; } }
class Derived extends Base { constructor(x) { super(x); this.y = 2; } }
function derivedSum(x) { const d = new Derived(x); return d.x + d.y; }
function Replaced() { this.a = 1; return { b: 2 }; }
function replacedB() { return new Replaced().b; }
function Target() { this.ok = new.target === Target; }
function targetOk() { return new Target().ok; }
function isUndefined(x) { return typeof x === "undefined"; }
function isString(x) { return typeof x === "string"; }
function jumpNull(x) { if (x == null) return "null"; return "value"; }
function beforeInit(early) { if (early) return read(); let v = 1; function read() { return v; } return read(); }
// try: the handler in compiled code
function safeRead(o) { try { return o.value.x; } catch (e) { return "caught " + (e instanceof TypeError); } }
function rethrow(x) { try { thrower(x); return "no"; } catch (e) { throw new Error("again"); } }
function withFinally(list) { let r = 0; try { r = list.length; } finally { r += 100; } return r; }
function nestedTry(x) { try { try { thrower(x); } catch (e) { throw "inner"; } } catch (e) { return e; } return "none"; }
function catchInLoop(n) { let caught = 0; for (let i = 0; i < n; i++) { try { if (i % 3 === 0) throw i; } catch (e) { caught += e >= 0 ? 1 : 0; } } return caught; }
function throughMap(n) { return n > 0 ? [n].map((x) => throughMap(x - 1))[0] + 1 : 0; }
function deepTry(n) { try { return deepTry(n + 1); } catch (e) { return n; } }
function complement(x) { return ~x; }
function power(a, b) { return a ** b; }
function keysOf(o) { let k = ""; for (const key in o) k += key + o[key]; return k; }
function hasEach(o) { let n = 0; for (const key in o) if (key in o) n++; return n; }
async function awaitValue(v) { return await v; }
function* counting(n) { for (let i = 0; i < n; i++) yield i; }
function sumGenerator(n) { let s = 0; const g = counting(n); for (let r = g.next(); !r.done; r = g.next()) s += r.value; return s; }
function sumOf(iterable) { let s = 0; for (const v of iterable) s += v; return s; }
function entriesOf(map) { let s = ""; for (const [k, v] of map) s += k + v; return s; }
function charsOf(text) { let n = 0; for (const c of text) n += c.length; return n; }
const customIterable = { *[Symbol.iterator]() { yield 1; yield 2; } };
const badIterable = { [Symbol.iterator]() { return 5; } };
function sloppyArguments(a) { a = a + 1; return arguments[0] + arguments.length; }
function sloppyWrite(a) { arguments[0] = 10; return a; }
class Account { #balance = 0; static #count = 0; deposit(v) { this.#balance += v; Account.#count++; return this.#balance; } #check() { return this.#balance >= 0; } valid() { return this.#check(); } static has(o) { return #balance in o; } }
// A host function that enters the VM again (a bound Error): the stack walk through compiled frames
const makeError = Error.bind(null);
function errorThroughBound(i) { return makeError("x" + i); }
function stackOf(i) { return errorThroughBound(i).stack; }
// One property of objects of several shapes: more than the interpreter's cache holds
function readKind(node) { return node.kind; }
const shapes = [{ kind: 1 }, { a: 0, kind: 2 }, { b: 0, c: 0, kind: 3 }, { d: 0, kind: 4, e: 0 }, { f: 0, g: 0, h: 0, kind: 5 }];
function sumKinds(n) { let s = 0; for (let i = 0; i < n; i++) s += readKind(shapes[i % shapes.length]); return s; }
// Loops that get hot while running: the rest of the call runs compiled
function longLoop(n) { let s = 0; for (let i = 0; i < n; i++) s = (s + i * 3) % 1000003; return s; }
function longLoopThrows(n) { for (let i = 0; i < n; i++) { if (i === n - 1) throw new Error("end"); } }
function longLoopCalls(n) { let s = 0; for (let i = 0; i < n; i++) s += add3(i, 1, 2) & 7; return s; }

const loops = 200000;
check("loop entry", longLoop(loops), (3 * loops * (loops - 1) / 2) % 1000003);
let loopThrew = null;
try {
    longLoopThrows(loops);
} catch (e) {
    loopThrew = e;
}
check("loop entry throws", loopThrew && loopThrew.message, "end");
let expectedCalls = 0;
for (let i = 0; i < loops; i++)
    expectedCalls += (i + 3) & 7;
check("loop entry calls", longLoopCalls(loops), expectedCalls);
// Compiled functions that die: their table slots serve the next ones
for (let i = 0; i < 300; i++) {
    const f = new Function("x", "return x * 2 + " + i);
    let s = 0;
    for (let k = 0; k < 300; k++)
        s += f(k);
    check("short-lived " + i, s, 300 * 299 + 300 * i);
    if (i % 50 === 49)
        gc();
}
// A function too large to compile (over 100 KB of bytecode) with a hot loop stays interpreted
const large = new Function("n", "let x = 0; for (let i = 0; i < n; i++) { " + "x = (x + i) | 0; ".repeat(12000) + "} return x;");
check("too large to compile", large(1500), (1499 * 1500 / 2) * 12000 | 0);
const proto = {};
const child = Object.create(proto);
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
    check("double add", addition(0.1, 0.2), 0.30000000000000004);
    check("int and double", addition(1, 0.5), 1.5);
    check("add overflow", addition(2147483647, 2147483647), 4294967294);
    check("add strings", addition("a", 1), "a1");
    check("mul overflow", product(65536, 65536), 4294967296);
    check("mul -0 double", product(-0, 5), -0);
    check("mul doubles", product(1.5, -2), -3);
    check("div int", quotient(6, 3), 2);
    check("div fraction", quotient(1, 4), 0.25);
    check("div -0", quotient(-0, 5), -0);
    check("div by -", quotient(0, -5), -0);
    check("div by 0", quotient(5, 0), Infinity);
    check("div 0 by 0", quotient(0, 0), NaN);
    check("div min", quotient(-2147483648, -1), 2147483648);
    check("div string", quotient("9", 3), 3);
    check("< doubles", lessThan(1.5, 2), true);
    check("< NaN", lessThan(NaN, 1), false);
    check("< mixed", lessThan(2, 2.5), true);
    check("< strings", lessThan("a", "b"), true);
    check("jless NaN", jumpLess(1, NaN), 0);
    check("jless double", jumpLess(-0.5, 0), 1);
    check("jnless NaN", jumpNotLess(NaN, 1), 1);
    check("jnless double", jumpNotLess(0.5, 0.25), 1);
    check("=== strings", strictEqual("ab", "a" + "b"), true);
    check("=== objects", strictEqual(o, o), true);
    check("=== other objects", strictEqual(o, {}), false);
    check("=== int double", strictEqual(1, 1.0), true);
    check("=== -0", strictEqual(0, -0), true);
    check("=== NaN", strictEqual(NaN, NaN), false);
    check("=== null undefined", strictEqual(null, undefined), false);
    check("=== string number", strictEqual("1", 1), false);
    check("=== booleans", strictEqual(true, true), true);
    check("== null undefined", looseEqual(null, undefined), true);
    check("== string number", looseEqual("1", 1), true);
    check("== doubles", looseEqual(1, 1.5), false);
    check("== objects", looseEqual(o, o), true);
    check("jstricteq", jumpStrictEqual("x", "x"), "y");
    check("jstricteq no", jumpStrictEqual(1, 2), "n");
    check("negate", negative(5), -5);
    check("negate 0", negative(0), -0);
    check("negate min", negative(-2147483648), 2147483648);
    check("negate double", negative(1.5), -1.5);
    check("negate string", negative("3"), -3);
    check("not", not(true), false);
    check("not 0", not(0), true);
    check("not string", not(""), true);
    check("<<", shiftLeft(1, 33), 2);
    check(">>", shiftRight(-8, 1), -4);
    check(">>> big", shiftUnsigned(-1, 0), 4294967295);
    check(">>> small", shiftUnsigned(8, 1), 4);
    check("to number", plus("5"), 5);
    check("to number double", plus(2.5), 2.5);
    check("truthy object", truthy({}), 1);
    check("truthy undefined", truthy(undefined), 0);
    check("truthy null", truthy(null), 0);
    check("truthy string", truthy("x"), 1);
    check("truthy empty string", truthy(""), 0);
    check("truthy double", truthy(0.5), 1);
    check("truthy NaN", truthy(NaN), 0);
    check("int array", sumAll([1, 2, 3]), 6);
    check("double array", sumAll([1.5, 2.5]), 4);
    check("contiguous array", sumAll([1, "x"]), "1x");
    check("holes", sumAll([1, , 3]), NaN);
    check("typed array", sumAll(new Float64Array([0.5, 0.25])), 0.75);
    check("arguments", sumAll((function () { return arguments; })(4, 5)), 9);
    check("put int", setAt([1, 2, 3], 1, 7)[1], 7);
    check("put double into ints", setAt([1, 2, 3], 1, 2.5)[1], 2.5);
    check("put int into doubles", setAt([1.5, 2.5], 0, 3)[0], 3);
    check("put NaN into doubles", setAt([1.5, 2.5], 0, NaN)[0], NaN);
    check("put object into ints", setAt([1, 2], 0, o)[0], o);
    check("put extends", setAt([1, 2], 2, 3).length, 3);
    check("put far", setAt([1, 2], 50, 3).length, 51);
    check("put on object", setAt({}, 0, "z")[0], "z");
    check("put negative index", setAt([], -1, "n")[-1], "n");
    check("copy on write", literalFirst(), 10);
    check("array length", lengthOf([1, 2, 3]), 3);
    check("string length", lengthOf("abcd"), 4);
    check("length property", lengthOf({ length: "own" }), "own");
    check("prototype method", speak(new Animal("cat")), "I am cat");
    if (round === 150)
        proto.later = 5;
    check("unset", maybe(child), round >= 150 ? 5 : undefined);
    if (round === 150)
        Object.defineProperty(Pair.prototype, "b", { set(v) { this.doubled = v * 2; }, get() { return this.doubled; } });
    check("transition", pairB(round), round >= 150 ? round * 2 : round);
    check("global let write", incrementGlobal(), round + 1);
    check("global var write", setGlobalVariable(round), round);
    let constThrew = null;
    try {
        setConstant();
    } catch (e) {
        constThrew = e;
    }
    check("const write", constThrew instanceof TypeError, true);
    check("this of a primitive", kindOfThis.call(1), "object");
    check("this of an object", kindOfThis.call(o), "object");
    check("switch", number(2), "two");
    check("switch default", number(3), "other");
    check("switch double", number(5.0), "five");
    check("switch fraction", number(1.5), "other");
    check("switch string", number("1"), "other");
    check("switch char", character("b"), 2);
    check("switch char long", character("ab"), 0);
    check("switch char other", character(1), 0);
    check("switch string", word("world"), 2);
    check("switch string other", word("x"), 0);
    check("apply", applyAll([1, 2, 3]), 6);
    check("apply empty", applyAll(undefined), 0);
    if (round % 100 === 99) {
        // A GC while the arguments load: the frame below the caller holds the earlier ones
        const holder = { length: 3, 0: { n: 1 }, get 1() { gc(); return { n: 2 }; }, 2: { n: 3 } };
        check("apply with GC", collectN.apply(null, holder), 6);
    }
    let applyThrew = null;
    try {
        applyAll(5);
    } catch (e) {
        applyThrew = e;
    }
    check("apply not array-like", applyThrew instanceof TypeError, true);
    check("spread", spreadAll([4, 5]), 9);
    check("construct spread", constructSpread([round]), round);
    check("tail call", tailSum(100, 0), 5050);
    check("derived", derivedSum(round), round + 2);
    check("constructor returns object", replacedB(), 2);
    check("new.target", targetOk(), true);
    check("typeof undefined", isUndefined(undefined), true);
    check("typeof undefined object", isUndefined({}), false);
    check("typeof string", isString("s"), true);
    check("typeof not string", isString(1), false);
    check("jeq null", jumpNull(null), "null");
    check("jeq undefined", jumpNull(undefined), "null");
    check("jeq value", jumpNull(0), "value");
    check("initialized", beforeInit(false), 1);
    let early = null;
    try {
        beforeInit(true);
    } catch (e) {
        early = e;
    }
    check("before initialization", early instanceof ReferenceError, true);
    check("try", safeRead({ value: { x: 1 } }), 1);
    check("catch", safeRead({}), "caught true");
    let again = null;
    try {
        rethrow(1);
    } catch (e) {
        again = e;
    }
    check("throw in catch", again && again.message, "again");
    check("finally", withFinally([1, 2]), 102);
    let afterFinally = null;
    try {
        withFinally(null);
    } catch (e) {
        afterFinally = e;
    }
    check("finally rethrows", afterFinally instanceof TypeError, true);
    check("nested try", nestedTry(1), "inner");
    check("nested try no throw", nestedTry(0), "none");
    check("catch in loop", catchInLoop(30), 10);
    if (round === 299) {
        check("stack overflow caught", deepTry(0) > 100, true);
        // Through a host function: the machine stack would run out before JSC's limit
        let viaHost = null;
        try {
            throughMap(100000);
        } catch (e) {
            viaHost = e;
        }
        check("stack overflow through a host function", viaHost instanceof RangeError, true);
        check("deep through a host function", throughMap(2000), 2000);
    }
    check("~", complement(5), -6);
    check("~ double", complement(1.5), -2);
    check("**", power(2, 10), 1024);
    check("for in", keysOf({ a: 1, b: 2 }), "a1b2");
    check("for in array", keysOf([7, 8]), "0718");
    check("for in in", hasEach({ x: 1, y: 2 }), 2);
    check("generator", sumGenerator(5), 10);
    awaitValue(round).then((v) => check("await", v, round));
    check("for of array", sumOf([1, 2, 3]), 6);
    check("for of set", sumOf(new Set([4, 5])), 9);
    check("for of map", entriesOf(new Map([["a", 1], ["b", 2]])), "a1b2");
    check("for of string", charsOf("h\u{1F600}"), 3);
    check("for of generator", sumOf(customIterable), 3);
    check("for of keys", sumOf([5, 6].keys()), 1);
    let notIterator = null;
    try {
        sumOf(badIterable);
    } catch (e) {
        notIterator = e;
    }
    check("for of not an object", notIterator instanceof TypeError, true);
    let notIterable = null;
    try {
        sumOf(7);
    } catch (e) {
        notIterable = e;
    }
    check("for of not iterable", notIterable instanceof TypeError, true);
    check("arguments mapped", sloppyArguments(1), 3);
    check("arguments write", sloppyWrite(1), 10);
    const account = new Account();
    account.deposit(round);
    check("private field", account.deposit(1), round + 1);
    check("private method", account.valid(), true);
    check("private in", Account.has(account) && !Account.has({}), true);
    let privateThrew = null;
    try {
        Account.prototype.deposit.call({}, 1);
    } catch (e) {
        privateThrew = e;
    }
    check("private missing", privateThrew instanceof TypeError, true);
    const trace = stackOf(round);
    check("stack through a host function", trace.includes("errorThroughBound") && trace.includes("stackOf"), true);
    check("polymorphic read", sumKinds(50), 150);
    if (round % 100 === 50) {
        gc();
        // New objects of other shapes after a GC
        check("polymorphic after GC", readKind({ z: 9, y: 8, kind: 7 }) + readKind({ kind: "s" }), "7s");
    }
    check("fib", fib(15), 610);
    check("host functions", maxOf(3, 8), 8 + 98);
    check("push", pushTwice([], round), 2);
    check("bound", callBound(add3.bind(null, 10, 20)), 31);
    check("arity", callShort(), NaN);
    check("arity shift", callFewer(round), ",,,,0|" + round + ",,,,1|" + round + "," + round + "," + round + ",,3");
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
