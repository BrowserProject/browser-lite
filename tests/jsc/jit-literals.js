// Array literals and getters from compiled code (docs/jit.md, run.sh runs it with BL_JIT=0 and 1,
// also while the GC collects continuously). Compiled code makes array literals without the
// interpreter's slow path (the elements checked against the indexing type the site's profile
// selects) and calls getters in a frame of its own instead of a VM entry: the results must equal
// the interpreter's, also when the profile, the shape of the elements, the getter or the prototype
// chain changes while the code runs.
function check(name, actual, expected) {
    if (!Object.is(actual, expected))
        throw new Error(name + ": " + actual + " instead of " + expected);
}

function describe(array) {
    const parts = [];
    for (let i = 0; i < array.length; i++)
        parts.push(i in array ? String(Object.is(array[i], -0) ? "-0" : array[i]) : "hole");
    return array.length + ":" + parts.join(",");
}

// Literals of registers: int32, doubles (also NaN, a double array's hole, and -0), objects, mixed,
// empty, longer than the vector of small literals
function ints(i) { return [i, i + 1, 3]; }
function doubles(x) { return [x, 0.5, 2]; }
function mixed(i, o) { return [i, o, "s", undefined, null, true]; }
function empty() { return []; }
function long(i) { return [i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i, i]; }
function one(v) { return [v]; }
// Literals of constants (copy-on-write butterflies), written to afterwards
function constants() { return [1, 2, 3, 4]; }
function constantDoubles() { return [1.5, 2.5]; }
function constantStrings() { return ["a", "b", "c"]; }

for (let round = 0; round < 20000; round++) {
    check("ints", describe(ints(round)), "3:" + round + "," + (round + 1) + ",3");
    const d = doubles(round + 0.25);
    check("doubles", describe(d), "3:" + (round + 0.25) + ",0.5,2");
    check("mixed", describe(mixed(round, round & 1 ? null : {})), "6:" + round + "," + (round & 1 ? "null" : "[object Object]") + ",s,undefined,null,true");
    const e = empty();
    check("empty", e.length, 0);
    e.push(round);
    check("empty push", describe(e), "1:" + round);
    check("long", long(round).length, 40);
    check("long last", long(round)[39], round);
    const c = constants();
    check("constants", describe(c), "4:1,2,3,4");
    c[1] = round;
    check("constants written", describe(c), "4:1," + round + ",3,4");
    check("constants fresh", describe(constants()), "4:1,2,3,4");
    const cd = constantDoubles();
    cd.push("x");
    check("constant doubles", describe(cd), "3:1.5,2.5,x");
    check("constant strings", constantStrings().join(""), "abc");
    // The profile learns that the arrays of a site change shape
    const v = one(round);
    if (round > 10000)
        v[0] = { round };
    check("one", typeof one(round)[0], "number");
}
// Shapes the profile does not expect: an int32 site gets doubles, NaN, objects, -0
check("ints double", describe(ints(0.5)), "3:0.5,1.5,3");
check("doubles NaN", describe(doubles(NaN)), "3:NaN,0.5,2");
check("doubles object", describe(doubles("x")), "3:x,0.5,2");
check("doubles -0", describe(doubles(-0)), "3:-0,0.5,2");
check("one undefined", describe(one(undefined)), "1:undefined");
check("holes after", describe(ints(1).concat([, 5])), "5:1,2,3,hole,5");
// Many literals while collections run: the cells stay intact
let kept = [];
for (let i = 0; i < 200000; i++) {
    const a = mixed(i, { i });
    if (i % 1000 === 0)
        kept.push(a);
}
for (let i = 0; i < kept.length; i++)
    check("kept", kept[i][1].i, i * 1000);
// A global object having a bad time (an indexed accessor on Array.prototype) makes array storage
// arrays: from the slow path, which reads the accessor for holes
function badTime() { return [1, 2]; }
for (let i = 0; i < 20000; i++)
    badTime();

// Getters: own accessors, class accessors on prototypes, host getters (a typed array's length),
// keyed reads with a constant, computed or rope key, setters without getters, getters that throw,
// change, become data properties or go away, prototype changes
const own = { _v: 2, get v() { return this._v * 2; } };
class Base { constructor() { this._x = 3; } get x() { return this._x + 1; } }
class Derived extends Base { get y() { return this.x * 10; } }
const derived = new Derived();
const view = new Uint8Array(7);
const setterOnly = { set w(value) { this._w = value; } };
function readOwn(o) { return o.v; }
function readX(o) { return o.x; }
function readY(o) { return o.y; }
function readLength(t) { return t.length; }
function readKeyed(o, k) { return o[k]; }
function readRope(o, a, b) { return o[a + b]; }
function readW(o) { return o.w; }
const throwing = { get boom() { throw new RangeError("boom"); } };
function readBoom(o) { try { return o.boom; } catch (e) { return e.constructor.name; } }
function readBoomKeyed(o, k) { try { return o[k]; } catch (e) { return e.message; } }

for (let round = 0; round < 20000; round++) {
    check("own", readOwn(own), 4);
    check("class", readX(derived), 4);
    check("derived", readY(derived), 40);
    check("length", readLength(view), 7);
    check("keyed own", readKeyed(own, "v"), 4);
    check("keyed class", readKeyed(derived, round & 1 ? "x" : "y"), round & 1 ? 4 : 40);
    check("keyed length", readKeyed(view, "length"), 7);
    check("keyed byteLength", readKeyed(view, "byteLength"), 7);
    check("rope", readRope(derived, "x", ""), 4);
    check("setter only", readW(setterOnly), undefined);
    check("throws", readBoom(throwing), "RangeError");
    check("throws keyed", readBoomKeyed(throwing, "boom"), "boom");
}
// The getter changes, becomes a data property, goes away; the prototype changes
Object.defineProperty(Base.prototype, "x", { get() { return 99; }, configurable: true });
check("redefined", readX(derived), 99);
check("redefined keyed", readKeyed(derived, "x"), 99);
check("redefined derived", readY(derived), 990);
Object.defineProperty(Base.prototype, "x", { value: 5, configurable: true, writable: true });
check("data", readX(derived), 5);
check("data keyed", readKeyed(derived, "x"), 5);
delete Base.prototype.x;
check("gone", readX(derived), undefined);
check("gone keyed", readKeyed(derived, "x"), undefined);
Object.setPrototypeOf(derived, { get x() { return "swapped"; } });
check("swapped", readX(derived), "swapped");
check("swapped keyed", readKeyed(derived, "x"), "swapped");
Object.defineProperty(own, "v", { value: "plain", configurable: true });
check("own data", readOwn(own), "plain");
check("own data keyed", readKeyed(own, "v"), "plain");
Object.defineProperty(view, "length", { value: 1 });
check("own length", readLength(view), 1);
check("own length keyed", readKeyed(view, "length"), 1);
check("other view", readLength(new Uint8Array(3)), 3);
// A getter deep in recursion runs out of stack like a call
const recursive = { get r() { return this.r; } };
let overflow = "none";
try { recursive.r; } catch (e) { overflow = e.constructor.name; }
check("recursive getter", overflow, "RangeError");
// After all of that, a bad time: array literals of sites that compiled before
Object.defineProperty(Array.prototype, 1, { get() { return "accessor"; }, set(v) { }, configurable: true });
const bad = badTime();
check("bad time", bad.length, 2);
check("bad time element", bad[1], 2);
check("bad time hole", describe([0, , 2]), "3:0,accessor,2");
print("OK " + kept.length);
