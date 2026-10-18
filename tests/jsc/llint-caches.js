// Caches of the interpreter (LLInt) for missing properties and instanceof (patch 0031): after
// changes of the object or the prototype chain the result must be right, not the old cached
// value.
function check(name, actual, expected) {
    if (actual !== expected)
        throw new Error(name + ": " + actual + " instead of " + expected);
}

// Missing property, added to the prototype later
function Base() {}
function readMissing(o) { return o.later; }
const b = new Base();
for (let i = 0; i < 100; i++)
    check("missing", readMissing(b), undefined);
Base.prototype.later = 42;
check("added to the prototype", readMissing(b), 42);
delete Base.prototype.later;
check("deleted again", readMissing(b), undefined);
Object.prototype.later = "obj";
check("on Object.prototype", readMissing(b), "obj");
delete Object.prototype.later;
check("Object.prototype deleted", readMissing(b), undefined);

// Missing property, later on the object itself
const own = new Base();
for (let i = 0; i < 100; i++)
    check("missing own", readMissing(own), undefined);
own.later = 7;
check("added to the object", readMissing(own), 7);

// Prototype replaced
const swapped = new Base();
for (let i = 0; i < 100; i++)
    check("before the swap", readMissing(swapped), undefined);
Object.setPrototypeOf(swapped, { later: "new" });
check("prototype swapped", readMissing(swapped), "new");

// Getter on the prototype after a cache for "missing"
function Other() {}
const other = new Other();
for (let i = 0; i < 100; i++)
    check("missing (getter)", readMissing(other), undefined);
Object.defineProperty(Other.prototype, "later", { get() { return "getter"; }, configurable: true });
check("getter added", readMissing(other), "getter");

// Strings: missing method, then added to String.prototype
function readStringMissing(s) { return s.blMissing; }
for (let i = 0; i < 100; i++)
    check("string missing", readStringMissing("abc"), undefined);
String.prototype.blMissing = 1;
check("String.prototype added", readStringMissing("abc"), 1);
delete String.prototype.blMissing;

// instanceof: prototype replaced
function K() {}
function isK(o) { return o instanceof K; }
const k = new K();
for (let i = 0; i < 100; i++) {
    check("instanceof", isK(k), true);
    check("instanceof no", isK({}), false);
}
K.prototype = {};
check("prototype replaced", isK(k), false);
check("new object", isK(new K()), true);

// instanceof: Symbol.hasInstance on the function
function H() {}
function isH(o) { return o instanceof H; }
for (let i = 0; i < 100; i++)
    check("before hasInstance", isH({}), false);
Object.defineProperty(H, Symbol.hasInstance, { value: () => true });
check("own hasInstance", isH({}), true);

// instanceof: Symbol.hasInstance later in the prototype chain of the function
// (Function.prototype[Symbol.hasInstance] itself cannot be changed)
function F() {}
const between = Object.create(Function.prototype);
Object.setPrototypeOf(F, between);
function isF(o) { return o instanceof F; }
for (let i = 0; i < 100; i++)
    check("before hasInstance in the chain", isF({}), false);
Object.defineProperty(between, Symbol.hasInstance, { value: () => true, configurable: true });
check("hasInstance in the chain", isF({}), true);
delete between[Symbol.hasInstance];
check("gone again", isF({}), false);

// Many constructors at the same place (the cache is overwritten)
const ctors = [];
for (let i = 0; i < 8; i++)
    ctors.push(function () {});
let hits = 0;
for (let r = 0; r < 50; r++) {
    for (let i = 0; i < ctors.length; i++) {
        const o = new ctors[i]();
        for (let j = 0; j < ctors.length; j++)
            hits += (o instanceof ctors[j]) ? 1 : 0;
    }
}
check("many constructors", hits, 50 * 8);

print("OK llint-caches");
