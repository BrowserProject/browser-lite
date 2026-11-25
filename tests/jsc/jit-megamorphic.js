// Property reads by name (get_by_id) at sites that see many shapes, in compiled code through the
// VM's megamorphic cache (docs/jit.md): results against Reflect.get for own, prototype and absent
// properties, getters, prototypes and properties that change, dictionaries, proxies, functions'
// `name` and `prototype`, and the speed against a site that sees one shape. Before, every read
// of such a site took the interpreter's slow path, which replaced its cache: 7 to 10.5 times the
// monomorphic site (now 1.0 to 1.1).
const now = typeof preciseTime === "function" ? () => preciseTime() * 1000 : () => Date.now();

class Base { get g() { return this.a * 2; } method() { return 1; } }
const proto = { p: "proto", shared: 1 };
function makeObjects() {
    const objects = [];
    for (let s = 0; s < 24; s++) {
        let o;
        if (s % 6 === 0)
            o = new Base();
        else if (s % 6 === 1)
            o = Object.create(proto);
        else
            o = {};
        for (let k = 0; k < s % 7; k++)
            o["pad" + s + "_" + k] = k;
        if (s % 3)
            o.a = s;
        if (s % 4 === 0)
            o.p = "own" + s;
        if (s % 5 === 0)
            Object.defineProperty(o, "b", { get() { return s + 100; }, configurable: true });
        objects.push(o);
    }
    // A dictionary, a proxy, a function, an array with names, a boxed string
    const dictionary = { a: 1, p: "dict" };
    for (let k = 0; k < 80; k++)
        dictionary["x" + k] = k;
    for (let k = 0; k < 70; k++)
        delete dictionary["x" + k];
    objects.push(dictionary);
    objects.push(new Proxy({ a: "proxied" }, { get(target, key) { return key === "b" ? "trap" : target[key]; } }));
    objects.push(function named() {});
    const array = [1, 2, 3];
    array.a = "array";
    objects.push(array);
    objects.push(new String("boxed"));
    return objects;
}
function readA(o) { return o.a; }
function readB(o) { return o.b; }
function readP(o) { return o.p; }
function readG(o) { return o.g; }
function readName(o) { return o.name; }
function readPrototype(o) { return o.prototype; }
function readMissing(o) { return o.missing; }
const readers = [[readA, "a"], [readB, "b"], [readP, "p"], [readG, "g"], [readName, "name"], [readPrototype, "prototype"], [readMissing, "missing"]];
function check(objects, round) {
    for (const [read, key] of readers) {
        for (let i = 0; i < objects.length; i++) {
            const o = objects[i];
            const value = read(o), expected = Reflect.get(o, key);
            if (!Object.is(value, expected))
                throw new Error("round " + round + ": " + key + " of object " + i + " is " + String(value) + ", expected " + String(expected));
        }
    }
}
let objects = makeObjects();
for (let round = 0; round < 400; round++) {
    check(objects, round);
    // Changes the caches must see: a prototype's property, an own property, a getter, a new set
    if (round === 100)
        proto.p = "changed";
    if (round === 150)
        delete objects[1].a;
    if (round === 200)
        Object.defineProperty(Base.prototype, "g", { get() { return "redefined"; }, configurable: true });
    if (round === 250)
        Object.setPrototypeOf(objects[7], { p: "new prototype", a: "from prototype" });
    if (round === 300)
        objects = makeObjects();
    if (round === 350)
        proto.missing = "now present";
}

// Speed: one site over 16 shapes against the same site over one shape
const shapes = [];
for (let s = 0; s < 16; s++) {
    const o = {};
    for (let k = 0; k < s; k++)
        o["q" + k] = k;
    o.value = s;
    shapes.push(o);
}
const one = [];
for (let s = 0; s < 16; s++)
    one.push({ value: s });
function sum(list) {
    let total = 0;
    for (let i = 0; i < 1000000; i++)
        total += list[i & 15].value;
    return total;
}
let fastest = Infinity, twinFastest = Infinity;
for (let round = 0; round < 12; round++) {
    let start = now();
    const a = sum(shapes);
    fastest = Math.min(fastest, now() - start);
    start = now();
    const b = sum(one);
    twinFastest = Math.min(twinFastest, now() - start);
    if (a !== b)
        throw new Error("wrong sum " + a + " " + b);
}
const ratio = Math.max(fastest, 0.1) / Math.max(twinFastest, 0.1);
print("16 shapes: " + ratio.toFixed(2) + " times one shape (" + fastest.toFixed(1) + " against " + twinFastest.toFixed(1) + " ms)");
// The limit is the argument after `--` (run.sh: none for the interpreter)
const limit = typeof arguments !== "undefined" && arguments.length ? Number(arguments[0]) : Infinity;
if (!(ratio <= limit))
    throw new Error("megamorphic reads " + ratio.toFixed(2) + " times a monomorphic one");
print("OK " + ratio.toFixed(2));
