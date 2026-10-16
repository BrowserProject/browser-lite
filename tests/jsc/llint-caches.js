// Caches des Interpreters (LLInt) fuer fehlende Properties und instanceof
// (Patch 0031): nach Aenderungen an Objekt oder Prototyp-Kette muss das
// Ergebnis stimmen, nicht der alte Cache-Wert.
function check(name, actual, expected) {
    if (actual !== expected)
        throw new Error(name + ": " + actual + " statt " + expected);
}

// Fehlende Property, spaeter am Prototyp ergaenzt
function Base() {}
function readMissing(o) { return o.later; }
const b = new Base();
for (let i = 0; i < 100; i++)
    check("fehlt", readMissing(b), undefined);
Base.prototype.later = 42;
check("am Prototyp ergaenzt", readMissing(b), 42);
delete Base.prototype.later;
check("wieder geloescht", readMissing(b), undefined);
Object.prototype.later = "obj";
check("an Object.prototype", readMissing(b), "obj");
delete Object.prototype.later;
check("Object.prototype geloescht", readMissing(b), undefined);

// Fehlende Property, spaeter am Objekt selber
const own = new Base();
for (let i = 0; i < 100; i++)
    check("fehlt eigen", readMissing(own), undefined);
own.later = 7;
check("am Objekt ergaenzt", readMissing(own), 7);

// Prototyp ausgetauscht
const swapped = new Base();
for (let i = 0; i < 100; i++)
    check("vor Austausch", readMissing(swapped), undefined);
Object.setPrototypeOf(swapped, { later: "neu" });
check("Prototyp ausgetauscht", readMissing(swapped), "neu");

// Getter auf dem Prototyp nach Cache fuer "fehlt"
function Other() {}
const other = new Other();
for (let i = 0; i < 100; i++)
    check("fehlt (Getter)", readMissing(other), undefined);
Object.defineProperty(Other.prototype, "later", { get() { return "getter"; }, configurable: true });
check("Getter ergaenzt", readMissing(other), "getter");

// Strings: fehlende Methode, dann an String.prototype ergaenzt
function readStringMissing(s) { return s.blMissing; }
for (let i = 0; i < 100; i++)
    check("String fehlt", readStringMissing("abc"), undefined);
String.prototype.blMissing = 1;
check("String.prototype ergaenzt", readStringMissing("abc"), 1);
delete String.prototype.blMissing;

// instanceof: prototype ersetzt
function K() {}
function isK(o) { return o instanceof K; }
const k = new K();
for (let i = 0; i < 100; i++) {
    check("instanceof", isK(k), true);
    check("instanceof nein", isK({}), false);
}
K.prototype = {};
check("prototype ersetzt", isK(k), false);
check("neues Objekt", isK(new K()), true);

// instanceof: Symbol.hasInstance an der Funktion
function H() {}
function isH(o) { return o instanceof H; }
for (let i = 0; i < 100; i++)
    check("vor hasInstance", isH({}), false);
Object.defineProperty(H, Symbol.hasInstance, { value: () => true });
check("eigenes hasInstance", isH({}), true);

// instanceof: Symbol.hasInstance spaeter in der Prototyp-Kette der Funktion
// (Function.prototype[Symbol.hasInstance] selber ist nicht aenderbar)
function F() {}
const between = Object.create(Function.prototype);
Object.setPrototypeOf(F, between);
function isF(o) { return o instanceof F; }
for (let i = 0; i < 100; i++)
    check("vor hasInstance in der Kette", isF({}), false);
Object.defineProperty(between, Symbol.hasInstance, { value: () => true, configurable: true });
check("hasInstance in der Kette", isF({}), true);
delete between[Symbol.hasInstance];
check("wieder weg", isF({}), false);

// Viele Konstruktoren an derselben Stelle (Cache wird ueberschrieben)
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
check("viele Konstruktoren", hits, 50 * 8);

print("OK llint-caches");
