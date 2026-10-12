// Resizable ArrayBuffer und growable SharedArrayBuffer (ES2024). JSC reserviert
// dafuer "virtuellen" Speicher ueber bmalloc; unter Emscripten stuerzte das ab
// (Patch 0023).
function assert(cond, message) {
    if (!cond)
        throw new Error("Fehler: " + message);
}

const buffer = new ArrayBuffer(4, { maxByteLength: 1024 });
assert(buffer.resizable && buffer.byteLength === 4 && buffer.maxByteLength === 1024, "erzeugen");
const tracking = new Uint8Array(buffer);
const fixed = new Uint8Array(buffer, 0, 4);
tracking[3] = 7;
buffer.resize(100);
assert(buffer.byteLength === 100 && tracking.length === 100 && fixed.length === 4, "wachsen");
assert(tracking[3] === 7 && tracking[99] === 0, "Inhalt nach dem Wachsen");
tracking[99] = 9;
buffer.resize(10);
assert(tracking.length === 10, "schrumpfen");
buffer.resize(100);
assert(tracking[99] === 0, "neuer Bereich ist genullt");
let threw = false;
try { buffer.resize(2000); } catch (e) { threw = e instanceof RangeError; }
assert(threw, "ueber das Maximum");

// Viele kleine und ein paar grosse
const many = [];
for (let i = 0; i < 200; i++)
    many.push(new ArrayBuffer(i, { maxByteLength: 4096 + i }));
assert(many[199].maxByteLength === 4295, "viele");
const large = new ArrayBuffer(0, { maxByteLength: 16 * 1024 * 1024 });
large.resize(16 * 1024 * 1024);
new Uint8Array(large).fill(1);
assert(new Uint8Array(large)[16 * 1024 * 1024 - 1] === 1, "gross");

// transfer
const moved = buffer.transfer(50);
assert(buffer.detached && moved.byteLength === 50 && moved.resizable, "transfer");
const fixedCopy = moved.transferToFixedLength();
assert(moved.detached && !fixedCopy.resizable && fixedCopy.byteLength === 50, "transferToFixedLength");
const movedResizable = new ArrayBuffer(8, { maxByteLength: 64 }).transfer();
assert(movedResizable.resizable && movedResizable.maxByteLength === 64, "transfer resizable");

// growable SharedArrayBuffer
const shared = new SharedArrayBuffer(8, { maxByteLength: 256 });
assert(shared.growable, "growable");
const view = new Int32Array(shared);
Atomics.store(view, 1, 42);
shared.grow(128);
assert(shared.byteLength === 128 && view.length === 32 && Atomics.load(view, 1) === 42, "grow");

print("OK resizable");
