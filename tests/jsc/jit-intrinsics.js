// Host functions that compiled code runs itself at a call site that reads them by name
// (Math.imul, String.prototype.charCodeAt, the DataView getters) and typed array elements inline
// where the site's profile saw one type (docs/jit.md; run.sh runs it with and without the JIT).
// The results must be the host functions' and the interpreter's, also once the site sees other
// callees, `this` values, typed array types, detached and resizable buffers.
function check(name, actual, expected) {
    if (!Object.is(actual, expected))
        throw new Error(name + ": " + actual + " instead of " + expected);
}
const show = (v) => (Object.is(v, -0) ? "-0" : String(v));
const rounds = 12000;

// DataView getters at every offset, both byte orders, against the host function called through
// Function.prototype.call (which no site reads by name)
const getters = ["getInt8", "getUint8", "getInt16", "getUint16", "getInt32", "getUint32", "getFloat32", "getFloat64"];
const sizes = { getInt8: 1, getUint8: 1, getInt16: 2, getUint16: 2, getInt32: 4, getUint32: 4, getFloat32: 4, getFloat64: 8 };
const bytes = new Uint8Array(24);
for (let i = 0; i < bytes.length; i++)
    bytes[i] = (i * 73 + 0x81) & 255;
// A float NaN with other bits and the largest uint32
bytes.set([0x7f, 0xf8, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xff, 0xff, 0xff, 0xff], 12);
const readers = {};
for (const name of getters) {
    readers[name] = {
        little: new Function("view", "i", "return view." + name + "(i, true);"),
        big: new Function("view", "i", "return view." + name + "(i, false);"),
        implicit: new Function("view", "i", "return view." + name + "(i);"),
        truthy: new Function("view", "i", "return view." + name + "(i, 1);"),
        ignored: new Function("view", "i", "view." + name + "(i, true); return 0;"),
    };
}
function reference(view, name, i, littleEndian) {
    try {
        return show(DataView.prototype[name].call(view, i, littleEndian));
    } catch (e) {
        return e.constructor.name;
    }
}
function attempt(f, view, i) {
    try {
        return show(f(view, i));
    } catch (e) {
        return e.constructor.name;
    }
}
function checkView(label, view, offsets) {
    for (const name of getters) {
        const r = readers[name];
        for (const i of offsets) {
            check(label + " " + name + " little " + i, attempt(r.little, view, i), reference(view, name, i, true));
            check(label + " " + name + " big " + i, attempt(r.big, view, i), reference(view, name, i, false));
            check(label + " " + name + " implicit " + i, attempt(r.implicit, view, i), reference(view, name, i, undefined));
            check(label + " " + name + " truthy " + i, attempt(r.truthy, view, i), reference(view, name, i, 1));
        }
    }
}
const view = new DataView(bytes.buffer);
const offsetView = new DataView(bytes.buffer, 5, 11);
const offsets = [0, 1, 3, 4, 8, 12, 13, 16, 17, 20, 21, 23, 24, 25, -1, 1.5, 2 ** 31, "2"];
// Hot first, so the checks below run compiled code
for (let round = 0; round < rounds; round++) {
    const i = round % 17;
    for (const name of getters) {
        const r = readers[name];
        r.little(view, i);
        r.big(view, i);
        r.implicit(view, i);
        r.truthy(view, i);
        r.ignored(view, i);
    }
}
checkView("view", view, offsets);
checkView("offset view", offsetView, offsets);
// Other `this` values, a detached buffer, a resizable one
checkView("typed array", new Uint8Array(8), [0]);
check("own getUint16", readers.getUint16.little({ getUint16: (i, littleEndian) => [i, littleEndian].join() }, 3), "3,true");
const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
const resizableView = new DataView(resizable);
new Uint8Array(resizable).set([1, 2, 3, 4, 5, 6, 7, 8]);
checkView("resizable", resizableView, [0, 4, 7, 8]);
resizable.resize(16);
checkView("resized", resizableView, [8, 12, 15]);
const detachable = new ArrayBuffer(8);
const detachedView = new DataView(detachable);
detachable.transfer();
checkView("detached", detachedView, [0]);

// charCodeAt of 8-bit and 16-bit strings, ropes and substrings, out of range, other `this` values
function codeAt(s, i) { return s.charCodeAt(i); }
function codeAtIgnored(s, i) { s.charCodeAt(i); return 0; }
const latin = "hello, w\xf6rld";
const wide = "中文 text 😀";
for (let round = 0; round < rounds; round++) {
    codeAt(round & 1 ? latin : wide, round % 12);
    codeAtIgnored(latin, round % 12);
}
for (let i = 0; i < 13; i++) {
    check("charCodeAt latin " + i, show(codeAt(latin, i)), show(String.prototype.charCodeAt.call(latin, i)));
    check("charCodeAt wide " + i, show(codeAt(wide, i)), show(String.prototype.charCodeAt.call(wide, i)));
}
let rope = "";
for (let i = 0; i < 40; i++)
    rope += String.fromCharCode(65 + i);
const substring = (latin + wide + latin).slice(3, 30);
for (const [label, s] of [["rope", rope], ["substring", substring], ["wide rope", wide + rope], ["empty", ""]]) {
    for (const i of [0, 1, 5, 26, 39, 40, -1, 1.5, "2", undefined, NaN])
        check("charCodeAt " + label + " " + String(i), show(codeAt(s, i)), show(String.prototype.charCodeAt.call(s, i)));
}
check("charCodeAt String object", codeAt(new String("abc"), 1), 98);
check("charCodeAt own method", codeAt({ charCodeAt: (i) => i * 2 }, 4), 8);
let notCallable = null;
try {
    codeAt(null, 0);
} catch (e) {
    notCallable = e;
}
check("charCodeAt of null", notCallable instanceof TypeError, true);

// Math.imul, and a site named imul that calls something else
function imul(a, b) { return Math.imul(a, b); }
function imulOf(o, a, b) { return o.imul(a, b); }
const adder = { imul: (a, b) => a + b };
for (let round = 0; round < rounds; round++) {
    check("imul", imul(round * 0x9e3779b1, 0x85ebca6b), Math.imul(round * 0x9e3779b1 >>> 0, -2048144789));
    check("imul of Math", imulOf(Math, round, 3), round * 3);
}
check("imul other object", imulOf(adder, 2, 3), 5);
check("imul strings", imul("6", "7"), 42);
check("imul objects", imul({ valueOf: () => 3 }, 5), 15);

// Typed arrays: a site per type that saw only that type, then other types, plain arrays,
// detached and resizable buffers, indexes beyond the end
const typedValues = [-1.5, 300, 2 ** 32 + 7, NaN, 2.5, 0x80000001, -0, Infinity, 1e20, 0.5, 254.5, -3, "7", null];
const types = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array];
// Expected: the same stores and loads through sites that see every type (the generic paths)
function genericStore(array, i, v) { array[i] = v; }
function genericLoad(array, i) { return array[i]; }
for (const Type of [...types, Array])
    genericStore(new Type(1), 0, genericLoad([1], 0));
function expected(Type, values) {
    const array = new Type(values.length);
    for (let i = 0; i < values.length; i++)
        genericStore(array, i, values[i]);
    let out = "";
    for (let i = 0; i <= values.length; i++)
        out += show(genericLoad(array, i)) + ",";
    return out;
}
for (const Type of types) {
    const store = new Function("array", "values", "for (let i = 0; i < values.length; i++) array[i] = values[i];");
    const load = new Function("array", "show", "let out = ''; for (let i = 0; i <= array.length; i++) out += show(array[i]) + ','; return out;");
    const ints = Array.from({ length: 64 }, (_, i) => (i * 37) & 127);
    for (let round = 0; round < 200; round++) {
        const array = new Type(64);
        store(array, ints);
        check(Type.name + " hot", load(array, show), expected(Type, ints));
    }
    const array = new Type(typedValues.length);
    store(array, typedValues);
    check(Type.name + " values", load(array, show), expected(Type, typedValues));
    for (const Other of [...types, Array]) {
        const other = new Other(typedValues.length);
        store(other, typedValues);
        check(Type.name + " site with " + Other.name, load(other, show), expected(Other, typedValues));
    }
    const buffer = new ArrayBuffer(Type.BYTES_PER_ELEMENT * 4);
    const view = new Type(buffer);
    store(view, [1, 2, 3, 4]);
    buffer.transfer();
    check(Type.name + " detached", load(view, show), "undefined,");
    store(view, [5]);
    const growable = new ArrayBuffer(Type.BYTES_PER_ELEMENT * 2, { maxByteLength: Type.BYTES_PER_ELEMENT * 4 });
    const growing = new Type(growable);
    store(growing, [1, 2, 3]);
    check(Type.name + " resizable", load(growing, show), "1,2,undefined,");
    growable.resize(Type.BYTES_PER_ELEMENT * 4);
    store(growing, [1, 2, 3, 4]);
    check(Type.name + " resized", load(growing, show), "1,2,3,4,undefined,");
}

// A page that replaces the host functions gets its own
DataView.prototype.getUint16 = function (i) { return "own " + i; };
String.prototype.charCodeAt = function (i) { return "own " + i; };
Math.imul = (a, b) => "own " + a * b;
check("replaced getUint16", readers.getUint16.little(view, 2), "own 2");
check("replaced charCodeAt", codeAt("abc", 1), "own 1");
check("replaced imul", imul(2, 3), "own 6");
print("OK jit-intrinsics");
