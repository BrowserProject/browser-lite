// Grundfunktionen von JavaScriptCore. Gibt am Ende "OK basics" aus.
function assert(cond, msg) {
    if (!cond)
        throw new Error("assert: " + msg);
}

assert(1 + 2 === 3, "math");
assert([3, 1, 2].sort().join() === "1,2,3", "sort");
assert(JSON.stringify({ a: [1, { b: 2 }] }) === '{"a":[1,{"b":2}]}', "json");
assert("Grüezi".toUpperCase() === "GRÜEZI", "unicode upper");
assert(/^1[\u2019']234[\u2019']567\.5$/.test(new Intl.NumberFormat("de-CH").format(1234567.5)), "intl number de-CH");
assert(["z", "ä", "a"].sort(new Intl.Collator("de").compare).join("") === "aäz", "intl collator");
// Nach dem ICU-Datenfilter (deps/recipes/icu.sh) muessen diese noch gehen
assert(new Intl.NumberFormat("fr-CH", { style: "currency", currency: "CHF" }).format(5).includes("CHF"), "intl currency fr-CH");
assert(new Intl.DisplayNames("de", { type: "region" }).of("CH") === "Schweiz", "intl display names de");
assert(new Intl.DisplayNames("ja", { type: "language" }).of("de") === "ドイツ語", "intl display names ja");
assert(new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", timeZoneName: "long" }).format(new Date(Date.UTC(2026, 0, 1))).includes("Mitteleurop"), "intl time zone name");
assert(new Intl.NumberFormat("it-CH", { style: "unit", unit: "kilometer-per-hour" }).format(50).includes("km/h"), "intl unit");
assert(["b", "a", "c"].sort(new Intl.Collator("zh").compare).join("") === "abc", "intl collator zh");
assert(new Intl.Segmenter("ja", { granularity: "word" }).segment("日本語のテキスト")[Symbol.iterator]().next().value.segment.length > 0, "intl segmenter ja");
// Sprache ausserhalb der Liste: faellt auf root zurueck, darf nicht abstuerzen
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
assert(new Animal("Kuh").name === "Kuh", "private fields");

function* gen() { yield 1; yield 2; }
assert([...gen()].length === 2, "generator");

let resolved = false;
Promise.resolve(42).then(v => { resolved = v === 42; });
async function af() { return 7; }
af().then(v => {
    assert(resolved, "promise");
    assert(v === 7, "async");
    print("OK basics");
});
