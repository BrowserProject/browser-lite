// Compiled code and the GC (docs/jit.md). run.sh runs this with BL_JIT=2 and counts the compiles
// of `hot` in the log: a full GC keeps a compiled CodeBlock older than the 5 s after which JSC
// throws away interpreted ones (one compile), and a CodeBlock thrown away anyway
// (--forceCodeBlockToJettisonDueToOldAge, like deleteAllCode when memory is short) is replaced by
// one that warms up and compiles again (two compiles).
function hot(a) { return (a * 3 + 1) | 0; }
function drive(n) { let s = 0; for (let i = 0; i < n; i++) s = hot(s + i); return s; }

const first = drive(200000);
sleepSeconds(5.5);
fullGC();
if (drive(200000) !== first)
    throw new Error("different result after the GC");
print("OK jit-recompile");
