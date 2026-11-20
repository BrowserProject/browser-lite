// The JIT's warm-up bookkeeping stays cheap on a page with thousands of warm functions (docs/jit.md,
// run with the JIT on). The JIT counts the interpreter's counter fires by function; its map dropped
// cold entries once it held 4096, and while more than 4096 functions had fired within the last
// minute (a news site's bundles) every fire went through the whole map without dropping any: the
// same calls cost 3 times as much as with a few hundred warm functions. The map is now scanned
// again only after it doubled, and its entries age in fires instead of a clock read at every fire.
function makeFunctions(count, tag) {
    var functions = [];
    for (var i = 0; i < count; i++)
        functions.push(new Function("x", "return x + " + i + "; // " + tag));
    return functions;
}

function run(functions, rounds) {
    var s = 0;
    for (var r = 0; r < rounds; r++) {
        for (var i = 0; i < functions.length; i++)
            s = (s + functions[i](r)) | 0;
    }
    return s;
}

// The fastest of 3 runs, each with new functions, so none gets hot enough to compile
function fastest(count, rounds, tag) {
    var best = Infinity;
    for (var attempt = 0; attempt < 3; attempt++) {
        var functions = makeFunctions(count, tag + attempt);
        run(functions, 2);
        var start = Date.now();
        run(functions, rounds);
        best = Math.min(best, Date.now() - start);
    }
    return Math.max(1, best);
}

// The same number of calls (800000) and fires, the few first while the map is small
var fewTime = fastest(500, 1600, "few");
var manyTime = fastest(8000, 100, "many");
var ratio = manyTime / fewTime;
if (ratio > 1.6)
    throw new Error("calls with 8000 warm functions took " + ratio.toFixed(2) + " times as long as with 500 (" + manyTime + " against " + fewTime + " ms)");
print("OK jit-warmup-map " + ratio.toFixed(2));
