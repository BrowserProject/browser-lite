// Calls through the call caches of the interpreter (patch 0019): one target, several targets,
// closures, a changing target, a wrong argument count, new, apply/spread, tail recursion, native
// functions, exceptions. Every call site runs often enough to get linked.
let checks = 0;
function check(name, actual, expected) {
    checks++;
    if (actual !== expected)
        throw new Error(name + ": expected " + expected + ", got " + actual);
}

const N = 2000;

// One target
function add(a, b) { return a + b; }
let s = 0;
for (let i = 0; i < N; i++)
    s = add(s, i);
check("monomorph", s, N * (N - 1) / 2);

// Several targets at the same place
const targets = [(x) => x + 1, (x) => x * 2, (x) => x - 3, function (x) { return x; }, Math.abs, String];
let r = 0;
for (let i = 0; i < N; i++) {
    const v = targets[i % targets.length](i);
    r += typeof v === "string" ? v.length : v;
}
let expected = 0;
for (let i = 0; i < N; i++) {
    const k = i % 6;
    expected += [i + 1, i * 2, i - 3, i, Math.abs(i), String(i).length][k];
}
check("polymorph", r, expected);

// Many closures of the same function (closure call), then more than the cache holds
const closures = [];
for (let i = 0; i < 50; i++)
    closures.push(() => i);
let c = 0;
for (let k = 0; k < 40; k++) {
    for (const f of closures)
        c += f();
}
check("closures", c, 40 * 49 * 50 / 2);
const many = [];
for (let i = 0; i < 40; i++)
    many.push(new Function("x", "return x + " + i));
let m = 0;
for (let k = 0; k < 20; k++) {
    for (let i = 0; i < many.length; i++)
        m += many[i](1);
}
check("megamorph", m, 20 * (40 + 39 * 40 / 2));

// The target changes after linking
let current = (x) => x;
function callCurrent(x) { return current(x); }
for (let i = 0; i < N; i++)
    callCurrent(i);
current = (x) => -x;
check("switch", callCurrent(5), -5);
current = 42;
let threw = false;
try {
    callCurrent(1);
} catch (e) {
    threw = e instanceof TypeError;
}
check("no-function", threw, true);
current = (x) => x * 10;
check("function-again", callCurrent(3), 30);

// Wrong argument count
function three(a, b, c) { return (a | 0) + (b | 0) + (c | 0) + arguments.length * 1000; }
let a = 0;
for (let i = 0; i < N; i++)
    a += three(1) + three(1, 2, 3, 4);
check("arity", a, N * (1 + 1000 + 6 + 4000));

// new, classes, inheritance
class Base { constructor(x) { this.x = x; } get() { return this.x; } }
class Derived extends Base { constructor(x) { super(x * 2); } get() { return super.get() + 1; } }
let o = 0;
for (let i = 0; i < N; i++)
    o += new Base(i).get() + new Derived(i).get();
check("construct", o, (N * (N - 1) / 2) * 3 + N);
threw = false;
try {
    const arrow = () => 1;
    new arrow();
} catch (e) {
    threw = e instanceof TypeError;
}
check("no-constructor", threw, true);

// apply, call, spread, bind
function sum(...xs) { let t = 0; for (const x of xs) t += x; return t; }
const bound = sum.bind(null, 100);
let v = 0;
for (let i = 0; i < N; i++)
    v += sum.apply(null, [i, 1]) + sum.call(null, i) + sum(...[1, 2, 3]) + bound(i);
check("varargs", v, 2 * (N * (N - 1) / 2) + N + 6 * N + 100 * N + N * (N - 1) / 2);

// Tail recursion (strict)
const tail = (function () {
    "use strict";
    function loop(n, acc) { if (!n) return acc; return loop(n - 1, acc + 1); }
    return loop;
})();
check("tail-recursion", tail(100000, 0), 100000);

// Deep recursion and exceptions through linked calls
function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
check("fib", fib(20), 6765);
function thrower(i) { if (i % 7 === 3) throw new Error("x" + i); return i; }
let caught = 0;
for (let i = 0; i < N; i++) {
    try {
        thrower(i);
    } catch (e) {
        caught++;
    }
}
check("exceptions", caught, Math.floor((N - 4) / 7) + 1);

// Getters/setters, Proxy, native callbacks
const obj = { _v: 0, get v() { return this._v; }, set v(x) { this._v = x; } };
for (let i = 0; i < N; i++)
    obj.v = obj.v + 1;
check("getter", obj.v, N);
const proxied = new Proxy(function (x) { return x; }, { apply: (t, self, args) => args[0] * 3 });
let p = 0;
for (let i = 0; i < N; i++)
    p += proxied(i);
check("proxy", p, 3 * N * (N - 1) / 2);
const arr = Array.from({ length: N }, (_, i) => i);
check("native", arr.map((x) => x * 2).filter((x) => x % 4).reduce((t, x) => t + x, 0), N * N / 2);
check("sort", [5, 3, 9, 1].sort((x, y) => x - y).join(), "1,3,5,9");

// GC between the calls (callees must stay alive)
for (let k = 0; k < 20; k++) {
    const fns = [];
    for (let i = 0; i < 20; i++)
        fns.push(new Function("return " + i));
    if (typeof gc === "function")
        gc();
    let t = 0;
    for (const f of fns)
        t += f();
    check("gc", t, 190);
}

print("OK calls " + checks + " checks");
