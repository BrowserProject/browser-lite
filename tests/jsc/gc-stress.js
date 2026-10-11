// GC-Stresstest. Zusammen mit --slowPathAllocsBetweenGCs=N laeuft der GC sehr
// oft, mitten in normaler Arbeit. Wenn der GC lebende Objekte nicht findet
// (z.B. Pointer nur in WASM-Locals), gibt es falsche Werte oder Abstuerze.
function assert(cond, msg) {
    if (!cond)
        throw new Error("assert: " + msg);
}

function makeTree(depth) {
    if (!depth)
        return { leaf: true, v: depth };
    return { left: makeTree(depth - 1), right: makeTree(depth - 1), v: depth, s: "n" + depth };
}

function checkTree(t, depth) {
    if (!depth)
        return t.leaf === true;
    return t.v === depth && t.s === "n" + depth && checkTree(t.left, depth - 1) && checkTree(t.right, depth - 1);
}

let checksum = 0;
for (let round = 0; round < 30; round++) {
    const keep = makeTree(10);
    // Viel Muell erzeugen waehrend "keep" nur in einem Local lebt
    const parts = [];
    for (let i = 0; i < 2000; i++) {
        const o = { i, str: "x".repeat(i % 50), arr: [i, i + 1, i + 2] };
        parts.push(JSON.stringify(o).length);
        if (i % 100 === 0)
            parts.length = 0;
    }
    const m = new Map();
    for (let i = 0; i < 500; i++)
        m.set("k" + i, { v: i * 2 });
    for (let i = 0; i < 500; i++)
        assert(m.get("k" + i).v === i * 2, "map value " + i);
    const strs = [];
    for (let i = 0; i < 300; i++)
        strs.push(("abc" + i).split("").reverse().join(""));
    assert(strs[299] === "992cba", "string ops");
    // Objekte mit vielen geloeschten Properties (Structure-Transitions)
    const o = {};
    for (let i = 0; i < 64; i++)
        o["p" + i] = i;
    for (let i = 0; i < 64; i += 2)
        delete o["p" + i];
    for (let i = 1; i < 64; i += 2)
        assert(o["p" + i] === i, "after delete " + i);
    assert(checkTree(keep, 10), "tree intact in round " + round);
    checksum += Object.keys(o).length;
}
assert(checksum === 30 * 32, "checksum " + checksum);
print("OK gc-stress");
