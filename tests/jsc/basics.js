// Basic functions of JavaScriptCore. Prints "OK basics" at the end.
function assert(cond, msg) {
    if (!cond)
        throw new Error("assert: " + msg);
}

assert(1 + 2 === 3, "math");
// Int32 division whose result is no int32 (patch 0068)
function divide(a, b) { return a / b; }
assert(divide(5, 0) === Infinity && divide(-5, 0) === -Infinity, "division by zero");
assert(divide(-2147483648, -1) === 2147483648 && Object.is(divide(0, -5), -0) && divide(7, 2) === 3.5, "division");
assert([3, 1, 2].sort().join() === "1,2,3", "sort");
assert(JSON.stringify({ a: [1, { b: 2 }] }) === '{"a":[1,{"b":2}]}', "json");
assert("Grüezi".toUpperCase() === "GRÜEZI", "unicode upper");
assert(/^1[\u2019']234[\u2019']567\.5$/.test(new Intl.NumberFormat("de-CH").format(1234567.5)), "intl number de-CH");
assert(["z", "ä", "a"].sort(new Intl.Collator("de").compare).join("") === "aäz", "intl collator");
// These must still work after the ICU data filter (deps/recipes/icu.sh)
assert(new Intl.NumberFormat("fr-CH", { style: "currency", currency: "CHF" }).format(5).includes("CHF"), "intl currency fr-CH");
assert(new Intl.DisplayNames("de", { type: "region" }).of("CH") === "Schweiz", "intl display names de");
assert(new Intl.DisplayNames("ja", { type: "language" }).of("de") === "ドイツ語", "intl display names ja");
assert(new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", timeZoneName: "long" }).format(new Date(Date.UTC(2026, 0, 1))).includes("Mitteleurop"), "intl time zone name");
assert(new Intl.NumberFormat("it-CH", { style: "unit", unit: "kilometer-per-hour" }).format(50).includes("km/h"), "intl unit");
assert(["b", "a", "c"].sort(new Intl.Collator("zh").compare).join("") === "abc", "intl collator zh");
assert(new Intl.Segmenter("ja", { granularity: "word" }).segment("日本語のテキスト")[Symbol.iterator]().next().value.segment.length > 0, "intl segmenter ja");
// A language outside the list: falls back to root, must not crash
assert(typeof new Intl.DisplayNames("yo", { type: "region" }).of("CH") === "string", "intl fallback");
assert(/(\d+)-(\d+)/.exec("10-20")[2] === "20", "regexp");
assert(new Map([[1, 2]]).get(1) === 2, "map");
assert(typeof Symbol.iterator === "symbol", "symbol");
assert(10n ** 20n === 100000000000000000000n, "bigint");
assert(Math.round(Math.sin(Math.PI / 2)) === 1, "sin");
assert(new Date(Date.UTC(2026, 9, 11)).toISOString() === "2026-10-11T00:00:00.000Z", "date");

class Animal {
    #name;
    constructor(name) { this.#name = name; }
    get name() { return this.#name; }
}
assert(new Animal("Cow").name === "Cow", "private fields");

function* gen() { yield 1; yield 2; }
assert([...gen()].length === 2, "generator");

// Conditional chains are parsed and emitted without recursion (webpack's map of chunk names)
let links = "";
for (let i = 0; i < 20000; i++)
    links += "x === " + i + " ? 'c" + i + "' : ";
const chainValue = new Function("x", "return " + links + "'none'");
assert(chainValue(0) + chainValue(19999) + chainValue(20000) === "c0c19999none", "conditional chain");
const chainCondition = new Function("x", "if (" + links.replace(/'c\d+'/g, "true") + "false) return 1; return 0");
assert(chainCondition(19999) === 1 && chainCondition(20000) === 0, "conditional chain as a condition");
function chainForm(params, body, ...args) {
    try {
        const r = new Function(params, body)(...args);
        return typeof r === "function" ? "fn" + r.length : String(r);
    } catch (e) {
        return e.name;
    }
}
assert([
    chainForm("x, y", "let z = 0; const r = x ? 1 : y ? 2 : z = 3; return r + '/' + z", 0, 0),
    chainForm("x", "return (x ? (a) => 1 : x === 0 ? (a) => a + 2 : (a) => 3)(5)", 0),
    chainForm("x", "function* g() { return x ? 1 : x === 0 ? yield 7 : 3; } const it = g(); return it.next().value + '/' + it.next(9).value", 0),
    chainForm("x", "let a, b; x ? 0 : x === 0 ? [a, b] = [1, 2] : 0; return a + b", 0),
    chainForm("x", "const async = (v) => v; return x ? 1 : async(0) ? 3 : x === 0 ? async (y) => y : 5", 0),
    chainForm("x", "const o = { b: 1 }; return 'a' in o ? 1 : 'b' in o ? x ? 2 : 3 : 4", 0),
    chainForm("x", "for (var i = x ? 1 : x === 0 ? 2 : 3; false; ); return i", 0),
    chainForm("x, y", "return x ? 1 : y ? 2 : 3 = 4", 0, 0),
    chainForm("x, y", "return (x ? 1 : y ? 2 : 3) = 4", 0, 0),
    chainForm("x", "return x ? 1 : x === 0 ? 2 :", 0),
].join() === "3/3,7,7/9,3,fn1,3,2,SyntaxError,SyntaxError,SyntaxError", "conditional chain forms");
// A deep literal fails in time instead of retrying its alternatives at every level
for (const [open, close] of [["[", "]"], ["({a:", "})"]]) {
    let error = "";
    try {
        new Function("return " + open.repeat(100000) + "0" + close.repeat(100000));
    } catch (e) {
        error = e.name;
    }
    assert(error === "RangeError", "deep literal " + open);
}

let resolved = false;
Promise.resolve(42).then(v => { resolved = v === 42; });
async function af() { return 7; }
af().then(v => {
    assert(resolved, "promise");
    assert(v === 7, "async");
    print("OK basics");
});
