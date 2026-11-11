# JIT to WebAssembly

JSC runs the C loop interpreter (`ENABLE_JIT=OFF`): plain JS is 20 to 40 times slower than in V8,
about 55 cycles per bytecode, and neither a tail-call interpreter nor more inline caches change
that (#321). The JIT compiles hot JSC bytecode into WebAssembly at runtime, in the thread of the
VM. On by default (#324), `BL_JIT=0` turns it off.

## Shape

A baseline JIT like JSC's own: one WASM function per hot `CodeBlock`, every virtual register in
its slot of the call frame (tag and payload in linear memory), so the frames look exactly like
the interpreter's. The function has no dispatch and no operand decoding; the fast paths of the
interpreter are inlined (int32 arithmetic, comparisons, branches, property access through the
`CodeBlock`'s metadata), everything else calls the interpreter's slow paths
(`llint_slow_path_*`, `slow_path_*`) through the function table. Metadata is read at run time,
never baked into the code (the GC resets inline caches).

- **Control flow**: the basic blocks of the bytecode are WASM blocks nested in one loop with a
  `br_table` at its head. The code of block i sits after the end of the i-th of them, so a jump
  forward is a branch out to the end of its target's block and only a jump back goes through
  the `br_table`. A dense `switch` on an int32 (an obfuscated VM's dispatch) takes a `br_table`
  of its own, other values and sparse tables ask C++ for the target.
- **Install**: the compiler writes a module that imports the engine's memory and function table,
  compiles it synchronously in its thread (`new WebAssembly.Module`, about 0.1 ms for a small
  one) and adds its export to that thread's table (tables are per thread); a map of the thread
  keeps the index by `CodeBlock`.
- **Entry**: the compiled function is `(cfr, block) -> status` and starts at a basic block.
  `slow_path_enter` runs it from the first block and hands the C loop an `op_ret` of the `this`
  slot, where compiled code leaves the return value. A hot loop (`llint_loop_osr`) compiles the
  function and runs the rest of the call from the block after its `op_loop_hint`, then points the
  frame's bytecode offset (which the C loop reloads) at that `op_ret`.
- **Loops call again**: V8 compiles WebAssembly in two tiers, Liftoff first and the optimized code
  in the background, and a running function keeps the code it was called with (no on-stack
  replacement for WebAssembly). A loop entered once, like an obfuscated VM's dispatch or a proof
  of work, ran to its end in Liftoff, about 2.5x slower. At every `op_loop_hint` the function
  counts down from 10000 and at 0 returns 2 plus the block after it, and `runCompiled` calls it
  again from there (the frame holds every value), so the next call takes the optimized code
  once it is ready (`tests/jsc/jit-tierup.js`: one long call 2.3 to 2.9x the time of many short
  ones before, 0.9 to 1.3x now).
- **Tier-up**: the interpreter's counters with the JIT off (`llint_replace` at returns,
  `llint_loop_osr` at loops) call the compiler instead of giving up, after 4000 / bytecode bytes
  firings (4 to 64; one is about 50 calls or 500 loop iterations): a compile costs about 1 ms
  whatever the size, a call saves more the larger the function. The counter belongs to the
  `UnlinkedCodeBlock`, which all `CodeBlock`s of the same code share (the same script in other
  frames, the builtins of every global object, the one that replaces a `CodeBlock` thrown away),
  so it keeps firing after a compile instead of stopping for good, which had kept all of them
  interpreted.
- **Fast paths**: the interpreter's, reading its caches at run time: int32 and double arithmetic
  and comparisons, equality, property access (own, prototype, array length, unset, transitions;
  reads of own properties also from the last 4 structures of the site, until the next GC, looked
  up in C++ after the inline cache missed),
  array elements (int32, double, contiguous, array storage), scopes (closure, global), `switch`.
  Beyond the interpreter, for hashing code (bot checks, fingerprinting, #424): bit operations
  and `~` also on doubles (ToInt32 inline, `i64.trunc_sat` below 2^63, so uint32 values above
  2^31 stay inline), `op_unsigned` (`x >>> 0`) and `>>>` with any result, elements of typed
  arrays (all but Float16, BigInt and resizable ones; a Uint32 above 2^31 and Float32 too, NaN
  made pure) read and written with the conversions of the spec, and `Math.imul(a, b)` inline
  (its host function, which JSC keeps static, taken from a Math object of the JIT's own).
  ToBoolean (`if`, `while`, `&&`, `!`) also of strings and doubles, where the interpreter takes
  only booleans (`!`) or booleans, int32, undefined, null and objects: a string is false only
  as the VM's empty string, which every empty string is (JSC's own JITs rely on that too), a
  double unless it is 0, -0 or NaN (#502).
- **Calls**: to a compiled function directly in the frame the bytecode prepared. The VM's callee
  table (direct mapped by the callee's executable, 2048 entries) holds what a call needs of a
  compiled or host callee: its `CodeBlock`, table index and frame sizes, or its host function. One
  table serves every call site, so a site that calls many functions (an obfuscated VM that calls
  its handlers from one site) hits it like a site with one. Its epoch moves at the start and the
  end of every GC (a `HeapObserver`), which empties it; it lives while the VM has compiled code. A
  call of a compiled callee in the table with enough arguments and shallow nesting runs in WASM,
  without a call into C++: the callee's frame like `op_enter`, the C loop's stack pointer below it
  (patch 0096 gives its offset and that of the stack's limit), `call_indirect` of the callee and
  its calls again after a loop's return (see below). That work is a second function of the module,
  which the sites call with their operands (done at every site instead, it made compiled code 20 to
  40 % larger and a large VM function slower). Everything else goes through C++: host functions
  like the interpreter calls them, in the callee's realm (`Math.max`, `charCodeAt`, DataView
  getters), and the general path, which fills the table, moves the frame down for missing arguments
  (like the interpreter's arity fixup) and leaves the rest to JSC's generic call or construct.
  Varargs (`apply`, spread) get a frame like the interpreter's and then the same call, tail calls
  are ordinary calls. `Function.prototype.call` (a builtin in JS, which obfuscated code reaches as
  `f["call"](a, b)` and the bytecode's own shortcut for `f.call` does not catch) and bound
  functions without arguments of their own give way to the call they make: `this` and the arguments
  move in the frame and the target is called like any callee, where each of them had made a VM
  entry of the generic call (2 to 3 times faster); they stay out of the table. The interpreter's
  calls of compiled functions (`slow_path_enter`) find them in the same table.
- **Exceptions**: an instruction within a `try` goes to its handler (known by its bytecode offset),
  whose `op_catch` takes the exception like the interpreter's; otherwise the compiled function
  returns a status and the interpreter unwinds.
- **Machine stack**: compiled calls nest on the host's stack, which JSC does not see and which V8
  would stop halfway. Past 64 levels a probe (`MachineStack.cpp`: a WASM recursion of known
  frame size) checks for 214 KB of room at every 8 levels beyond the deepest checked one
  (per outermost run); without room the interpreter takes the calls. JSC's own recursion checks
  probe too (patch 0075, [architecture](architecture.md#javascript)).
- **GC**: at its safepoints (trap checks, calls) every live value is in the frame and the
  `CLoopStack` pointer is current, as in the interpreter (#60); nothing lives in WASM locals across
  them. JSC's generic call to a callee that is not compiled yet enters the VM again; between that
  entry and the compiled caller C++ holds no JS values outside the frames, so the safepoint GC
  looks through these entries (the JIT counts them, `wasmJITGenericEntries`, patch 0090, #448).
  Before, the GC waited inside them until the task ended: Cloudflare's Turnstile piled up 0.5 to
  1.5 GB of garbage that way, which the WASM memory kept for good. JSC's bound functions count
  their call of a JS target with the same `GenericEntry` (patch 0115, #516).
- **Code lifetime**: the compiled code belongs to its `CodeBlock` (JSC's baseline code goes on to
  the next `CodeBlock` of the same code, this cannot: constants and caches are baked in). A full
  GC throws away every `CodeBlock` that is not running and older than 5 s; one with compiled
  code stays (patch 0095), until its function goes away or memory is short (`deleteAllCode`,
  #441). Before, every full GC sent the hot code of a page back to warm-up, and the counter
  above then kept it interpreted for good (6x slower for a hot loop, `tests/jsc/jit-recompile.js`).

## Measured

In the `jsc` shell (node), interpreter against compiled: an int32 loop 352 against 28 ms, with
`%` 494 against 18 ms, property reads and writes 451 against 41 ms, `fib(25)` 37 against 13 ms,
a call 174 against 43 ns. Octane scores (higher is better): Richards 275 against 666 to 748,
DeltaBlue 263 against 705 to 723, Crypto 312 against 1516, RayTrace 698 against 1181,
NavierStokes 422 against 2508. The TypeScript
compiler (transpiling 176 KB) runs about 13 % faster: its many small functions are compiled once
each (V8 compiles a module at its first call) and called a few times. In the engine (Chromium, 2026-10-31) Octane ran 2x faster
(Richards 324 against 671, DeltaBlue 348 against 696, Crypto 646 against 1453, NavierStokes 876
against 1736), on an iPhone 16 with iOS 18 (BrowserStack) 3 to 7x (Richards 701 against 2123,
DeltaBlue 713 against 2072, Crypto 660 against 4658); page loads take as long as without it (the
code of a load runs once; as long as functions compiled after 50 calls, weather.com loaded 18 %
slower, #327). The
modules of the TypeScript compiler (1772 functions) are 11.9 MB of WASM; functions with more than
100 KB of bytecode stay interpreted (YouTube's bundles gave modules of 19 and 102 MB). With
YouTube open the engine's memory is the same as without the JIT, the renderer about 25 MB more.
React's hydration of blick.ch, one task of cold code (2026-11-11, local, 3 runs each): 3.3 to 3.6 s
with the JIT, 3.1 to 3.4 s with a 4 times higher warm-up (`JSC_thresholdForJITAfterWarmUp=2000`),
2.5 to 2.8 s without it. In its profile the calls between compiled and interpreted code take about
15 % (`slow_path_enter` with the lookup of compiled code, `callFromCompiledCode`, `callInFrame`
with the VM entry of a generic call), the compiles 4 %, compiled code 22 %. A cache of
CodeBlocks known to have no compiled code in front of that lookup measured no gain.

Calls (#459, jsc shell, 2 million calls each, fastest of 3): one callee 84 against 62 ms, 16
callees at one site 232 against 116 ms, 2 alternating 219 against 100 ms, a VM of 8 handlers 235
against 130 ms, `fib(30)` 159 against 148 ms; in the engine 16 callees 216 against 126 ms, 2
alternating 190 against 115 ms, the VM 226 against 145 ms. Octane in the jsc shell: Richards 859
to 916 against 961 to 977, DeltaBlue 864 to 883 against 945 to 952, the score 1446 to 1491
against 1510 to 1517. A VM function of 45 KB of bytecode with 800 call sites: 988 against 1058 KB
of WASM, 40 runs 1033 against 863 ms (with the call's work at every site 1.4 MB and slower).

Hashing code (#424, `tests/jsc/jit-hash.js`, jsc shell): bit operations on uint32 values 5x and
typed array elements 3x the time of their int32 twins before, now 1.8x and 1.3x; `Math.imul` 6.5x
an addition before, 2x now; a host call about 20 % cheaper. In the engine, the loops of
`bench.js` of the LinkedIn report (#424) ran 2 to 4 times faster (murmur 4.4 to 6.0 s against 1.7
to 2.7 s, Chromium 24 to 44 ms).

## Phases

1. Infrastructure: emitter, install, entry and tier-up hooks, functions without calls (loops,
   arithmetic, property access), tests in the `jsc` shell and the engine.
2. Calls between compiled and interpreted functions, exceptions, entry into running loops.
3. Coverage of the remaining bytecodes; on by default when the suites and real sites pass.
4. Speed: values in WASM locals between safepoints, type checks folded, inlining of small
   functions; less code per bytecode. Calls of compiled functions run in WASM through the
   callee table (#459). Obfuscated VMs (Cloudflare's Turnstile) bring functions of
   40 to 90 KB of bytecode, which become about 17 times that in WASM (54 KB: 0.9 MB), and V8 runs
   such a function in Liftoff for seconds while it optimizes it (`jsc` shell: 470 ms a run in
   Liftoff, 240 ms once optimized after about 2.5 s).
