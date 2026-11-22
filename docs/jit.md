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
  the `br_table`. A dense `switch` on an int32 or a double of an int32's value (an obfuscated VM's
  dispatch) takes a `br_table` of its own, other values and sparse tables ask C++ for the target.
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
  `llint_loop_osr` at loops) call the compiler instead of giving up, after 64 firings plus one
  per 6 bytes of bytecode, at most 512 (one is about 50 calls or 500 loop iterations; #566,
  #630). A compile costs in proportion to the code: the module is 8 to 20 times the bytecode and
  V8 compiles it with Liftoff on the engine thread at its first call (in the engine about 4 ms
  for 25 KB, 0.35 ms of that our compiler), and code fresh from Liftoff runs little faster than
  the interpreter, so a function compiles once it ran long enough to pay that back. The counter
  belongs to the `UnlinkedCodeBlock`, which all `CodeBlock`s of the same code share (the same
  script in other frames, the builtins of every global object, the one that replaces a
  `CodeBlock` thrown away), so it keeps firing after a compile instead of stopping for good, which
  had kept all of them interpreted. The JIT counts the firings by `UnlinkedCodeBlock` too: a full
  GC throws away a `CodeBlock` that is not compiled and older than 5 s, and counted by
  `CodeBlock` a large function started its warm-up again at every GC (#630). The entries age in
  fires of the thread instead of a clock read at every fire (the host's `performance.now()`, about
  0.7 us in a worker of Chromium), and once the map has 4096 entries those not fired among the
  last 65536 fires go; the next pruning waits until the map doubled. Before, while more than 4096
  functions had fired within a minute, every fire went through the whole map (#632).
- **Code size**: the fast paths of property access by id, element and keyed access, scope
  access (`resolve_scope`, `get_from_scope`, `put_to_scope`) and `Math.imul` are functions of the
  module that every site of the instruction calls with its operands' values, the metadata and
  the destination's address, and a slow path is called through one function of the module
  (#630). Inline at every site they made a module 25 to 40 times the bytecode, now 8 to 20 times:
  an obfuscated VM of 50 KB of bytecode was 1.6 MB of WASM, about 3 MB of machine code, and ran
  little faster than the interpreter, its code too large for the processor's instruction caches
  (`perf stat` on the engine thread: 0.58 instructions per cycle against the interpreter's 1.22,
  24 % of instruction fetches missed the L1 cache, 23 % of the cycles waited for them). A
  variable the bytecode generator resolved in a closure (`ResolvedClosureVar`) is read inline
  without a slow path, as linking makes it a `ClosureVar` for good. Arithmetic, bit operations,
  comparisons, equality and conditional jumps keep only their int32 path inline (and `if`, `!` and
  `&&` that of booleans and int32); doubles, ToInt32, cells and the slow path are one function of
  the module per opcode, called with the frame, the instruction and the operands' values, which
  returns whether the instruction threw or jumped. A constant operand's tag check is left out.
  Inline, `if (s) t = u` was about 260 bytes of WASM, `s = s ^ c` about 230, now about 75 and 90
  (`tests/jsc/jit-size.js` checks both).
- **Branch hints**: the module has a section of branch hints (the custom section
  `metadata.code.branch_hint` of the WebAssembly standard; a browser without them ignores it). The
  slow path after a fast path missed, the exits at an exception, the trap checks and the double
  and overflow side of int32 arithmetic and comparisons are marked unlikely, so V8's optimizing
  compiler puts their code behind the rest of the function and the code that runs stays dense in
  the instruction cache, which a phone has less of (#643). Equality, bit operations and
  conditions take their out-of-line side often (strings, objects, uint32 values above 2^31) and
  get no hint. `tests/jsc/jit-branch-hints.mjs` checks the section: V8 drops all of it when one
  entry is wrong.
- **Fast paths**: the interpreter's, reading its caches at run time: int32 and double arithmetic
  and comparisons, equality, property access (own, prototype, array length, unset, transitions;
  reads of own properties also from the last 4 structures of the site, until the next GC, looked
  up in C++ after the inline cache missed),
  array elements (int32, double, contiguous, array storage), scopes (closure, global), `switch`.
  Reads and writes with a string key (`o[key]`, which an obfuscated VM's handlers do for every
  property access of its program, so one site sees every key and shape) go through JSC's own
  megamorphic cache of the VM, which this build had but did not use: entries by structure and key
  for an own or prototype data property, its absence, a replacement and a transition without a new
  butterfly, emptied by every GC and every change of a prototype chain (its epoch). A helper
  function of the module looks the key up there in WASM (a string that is no rope: its atom), and
  the slow path fills it like JSC's JITs (`getByValMegamorphic`, `putByValMegamorphic`), atomizing
  the key first so the next access finds it; `length`, `name`, `prototype`, `__proto__`, index
  keys, getters and objects with their own lookup stay with the interpreter's slow path (#604).
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
  Varargs (`apply`, spread) get a frame like the interpreter's and then the same call.
  `Function.prototype.call` (a builtin in JS, which obfuscated code reaches as
  `f["call"](a, b)` and the bytecode's own shortcut for `f.call` does not catch) and bound
  functions without arguments of their own give way to the call they make: `this` and the arguments
  move in the frame and the target is called like any callee, where each of them had made a VM
  entry of the generic call (2 to 3 times faster); they stay out of the table. The interpreter's
  calls of compiled functions (`slow_path_enter`) find them in the same table.
- **Tail calls** (`return f()` in strict code, `op_tail_call` and `op_tail_call_varargs`): the
  callee's frame replaces the caller's, like in the interpreter, so no stack walk sees the frame
  that made the call. JSC's `Function.prototype.call` and `apply` and `Reflect.apply` end in such
  a call (`this.@apply(...)`): WebCore takes the incumbent realm (the `source` of `postMessage`,
  #626) from the first frame below the called function, which must not be theirs, and
  `Error.stack` does not list them either. A bound function's frame does not count for the
  incumbent realm either (patch 0164, like Chrome and Firefox), where compiled code calls its
  target directly anyway. The compiled function returns at the tail call with the
  call's bytecode offset in its frame (status -1, the call itself for the module's call function).
  The interpreter, when it ran the function, goes on at that instruction and makes the tail call
  itself; the call function of a compiled caller moves the callee's `this` and arguments to where
  the frame ended (`prepareForTailCall`) and calls a compiled callee there again, also the next
  tail calls, so a chain of them neither nests nor grows the JS stack, and a host function there
  too (its frame is the top frame for the stack check: with more arguments than the caller had,
  it covers the caller's header, whose code block a stale top frame pointed to and the check read
  garbage, an abort on developer.friendlycaptcha.com; for the same reason a call from compiled code
  makes its caller the top frame before its stack check, after a tail call to a compiled function
  that then calls a host function, which aborted weather.com and blick.ch); everything else
  (varargs, other callees) goes through `finishTailCall`, which does the same
  in C++ through the general path. Speed against the ordinary call before: about the same for
  compiled and host callees from compiled code, a strict recursion of 100 levels 7 to 9 times
  faster (it nested before), a compiled function with a tail call called from interpreted code
  about 120 ns slower per call (the interpreter's tail call and entry instead of a call in WASM).
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
  them. A compiled function checks the traps at its entry too, like the interpreter's stack check:
  calls between compiled functions check no limit that a trap moves, so code of calls without a
  loop reached no safepoint at all (no watchdog, no pause of a hidden view for the user, #585). JSC's generic call to a callee that is not compiled yet enters the VM again; between that
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
Loads of heavy sites (2026-11-14, local, Chromium host, load 1 to 6, 30 s after the load, 2 runs
each, without the JIT `BL_JIT=0`): the engine thread's RunLoop steps add up to 17.8 against 13.8 s
on ricardo.ch, 7.7 to 8.4 against 7.1 to 7.2 s on netflix.com and 11.5 to 13.6 against 10.0 to
11.6 s on webflow.com; the longest step takes 4.9 to 5.1 against 2.3 s on ricardo, 1.8 to 1.9
against 1.4 s on netflix. In a profile of ricardo (45 s) compiled code runs 5.3 s, as long as the
interpreter time it replaces (7.0 against 1.7 s), the calls between compiled and interpreted code
add about 2 s and the compiles 0.75 s. V8 tiering its optimized code in sooner
(`--wasm-tiering-budget=20000`) leaves compiled code at 4.5 s, so it is not Liftoff: on this code
compiled code saves nothing yet, open (phase 4).

Warm-up by size (#566, 2026-11-14, local, Chromium host, load 3 to 6): before, a function compiled
after 4000 / bytecode bytes firings (4 to 64), so a large one compiled first: the module function
of a bundle (8 KB of bytecode) whose loop ran a few thousand times once per page became 300 KB of
WASM. Speedometer 3.1 (NewsSite-Next and TodoMVC-React-Redux, 10 iterations, each in a new frame
whose `CodeBlock`s compile again) compiled 974 functions into 22.7 MB of WASM in 30 s, and V8's
compile of them took 3 to 4 s of the engine thread, about 4 ms per module (in node Liftoff
compiles them at 25 to 35 MB/s); the score was 0.94 to 1.01 against 1.54 to 1.71 without the
JIT. A higher counter threshold alone (`JSC_thresholdForJITAfterWarmUp`, which JSC clips at 1000)
and compiling only from loops still scored 0.8 and 1.1 to 1.2. Now the score is 1.21 to 1.56
(median 1.42, 3 runs; without the JIT 1.67 in the same round), Octane is unchanged (Richards 883
against 872, DeltaBlue 875 against 868, Crypto 1695 against 1767, NavierStokes 2803 against 2910,
RayTrace 1385 against 1421), and 20min.ch compiles 295 functions into 1.5 MB in its first 50 s
instead of 789 into 12.1 MB. Its tap on an article (`tests/engine/jit-warmup-test.mjs` checks
the warm-up itself): the click handlers 214 to 309 ms instead of 284 to 357, the data fetch of
the route starts 0.91 to 1.03 s after the click instead of 1.11 to 1.21 s (4 runs each).

Keyed reads and writes (#604, 2026-11-17, in the engine, `tests/jsc/jit-keyed.js`: 8 shapes and 16
keys at one site): 23 to 26 ms against 58 to 63 ms before, 1.1 to 1.2 times an array element's
read and write instead of 2.3 to 2.9 times. tiktok.com (local, Chromium host, load 6 to 9, 45 s,
3 runs each): its bot defence (`webmssdk.js`, an obfuscated VM) and app bundles spent 14 % of the
engine thread in the slow paths of `get_by_val` and `put_by_val` from compiled code, 4.4 % now
(what is left: getters such as a typed array's `length`, ropes without an atom, DOM objects); the
longest step took 5.5 to 6.7 s instead of 7.5 to 8.2 s. Chromium's longest task on the same page
is 0.35 to 0.6 s: the rest is compiled code (31 % of the engine thread), the interpreter (15 %) and
the calls between them.

Calls (#459, jsc shell, 2 million calls each, fastest of 3): one callee 84 against 62 ms, 16
callees at one site 232 against 116 ms, 2 alternating 219 against 100 ms, a VM of 8 handlers 235
against 130 ms, `fib(30)` 159 against 148 ms; in the engine 16 callees 216 against 126 ms, 2
alternating 190 against 115 ms, the VM 226 against 145 ms. Octane in the jsc shell: Richards 859
to 916 against 961 to 977, DeltaBlue 864 to 883 against 945 to 952, the score 1446 to 1491
against 1510 to 1517. A VM function of 45 KB of bytecode with 800 call sites: 988 against 1058 KB
of WASM, 40 runs 1033 against 863 ms (with the call's work at every site 1.4 MB and slower).

Code size (#630, 2026-11-19): the module of a VM-like function (`tests/jsc/jit-size.js`, 74 KB of
bytecode: global variables, closure variables, element and keyed access in 200 cases of a
switch) is 0.61 MB instead of 2.29 MB, per statement `s = g` 114 instead of 674 bytes, `s =
arr[i]` 179 instead of 1510, `arr[j] = s` 195 instead of 1534, `s = obj[k]` 287 instead of
2192, `s = obj.p` 179 instead of 1088, a call 359 instead of 536. The same dispatch with 256
cases (2.0 MB of WASM before, 0.58 MB now) ran a million steps in 470 ms in Liftoff and 270 ms
once optimized (after 5 s), with 16 cases (0.13 MB) in 85 ms: the work was the same, the code
too large. Now 120 to 160 ms from the start, with 16 cases 85 to 100 ms. On the engine thread
with Turnstile's challenge (`perf stat`): 0.58 instructions per cycle before, 24 % of the
instruction fetches missed the L1 cache and 23 % of the cycles waited for them (the interpreter
alone: 1.22, 7.5 %, 6 %); now 0.77, 19.5 % and 17 %. V8's optimizing compile of the VM's main
function took 12.3 s in the background before (1.6 MB). With the warm-up counted by
`UnlinkedCodeBlock` and the lower threshold, 17 % of the JS samples at the watchdog's checks are
interpreted instead of 37 % (the VM's functions of 4 to 12 KB stayed interpreted for a minute).
peet.ws's managed widget: the checkbox 31.5 to 44.2 s after the widget's start (median 40.1)
instead of 40.8 to 72.5 s (median 54.0), the longest step 9.7 to 17.3 s instead of 12.9 to
26.3 s (5 interleaved runs each). 20min.ch compiles 241 functions into 1.4 MB in its first
50 s instead of 181 into 1.1 MB.

Route changes of news sites (#632, 2026-11-20, local, phone emulation, the renderer at a fourth of
the CPU by cgroup; a build that counted the interpreter's calls and the counter's fires by
function): on Back on 20min.ch nine of ten interpreted calls went to functions whose warm-up was
not done. React's largest functions (3.7 KB of bytecode, 512 fires or about 17000 calls) had fired
507 times after 4 minutes on the page, others of 0.5 to 2.6 KB stood at 40 to 95 % of theirs. The
235 compiles during the 45 s of Back took 0.5 s, and 134 compiled `CodeBlock`s went away. A warm-up
4 times shorter for large functions (a fourth of the size term, at most 128 fires) scored 0.71 in
Speedometer 3.1 (NewsSite-Next and TodoMVC-React-Redux, 5 iterations) against 1.00 with the
current one and 0.97 without the JIT, and did not make the article tap faster; without the JIT
the article was in the DOM 24 to 26 s after the tap, with it 30 to 34 s (2 runs each). Such code
runs once per route: compiled sooner it does not pay back yet, the speed of compiled code itself
is the open part (phase 4). The warm-up's own bookkeeping read the host's clock at every fire:
during blick.ch's tap (2 profiles each) the tier-up took 3.3 to 3.6 % of the engine thread and
the clock 2.5 to 2.8 %, now 2.1 to 2.2 % (the compiles) and 1.5 to 1.7 % (`CodeBlock` creation,
the GC's age checks of `CodeBlock`s, regexps, events). `tests/jsc/jit-warmup-map.js` runs the
same calls with 8000 warm functions 5.7 to 6.8 times as long as with 500 before, 1.0 to 1.1 times
now (without the JIT 1.0).

Arithmetic, comparisons and conditions out of line (#636, 2026-11-20): per statement of the
dispatch in `tests/jsc/jit-size.js` (200 cases, 5 copies against 1) `if (s) t = u` takes 76 bytes
instead of 262, `s = s ^ c` 88 instead of 234, `s = s + j` 108 instead of 203, `if (s < j) t = u`
121 instead of 199; the module of the VM-like function is 0.39 MB instead of 0.61 MB (5.3 times
its bytecode instead of 8.3). peet.ws's managed widget (local, Chromium host at 1280x900, two
rounds of 5 runs interleaved with the engine before, load 2 to 17): on the engine thread 1.09 to
1.37 instructions per cycle instead of 0.98 to 1.16 and 14 to 16 % of the instruction fetches
missing the L1 cache instead of 18.5 % (`perf stat`, windows of 10 s), but the checkbox after
29.1 to 42.1 s (medians 36.3 and 36.8) against 30.3 to 44.5 s (medians 33.0 and 34.4), the longest
step 8.5 to 20.9 s against 7.5 to 15.6 s: within the spread of the runs. `BL_JIT=0` took 43.6 s.
Of that engine thread (CPU profile, 63 s) compiled code is 40 %, the interpreter 15 % (25 to 30 %
from 10 to 30 s, while the VM's functions of 24 to 51 KB of bytecode warm up: they compile 5 to
15 s after the widget's start, a fire every 30 to 50 ms), array literals (`new_array`) 5 %, the
interpreter's `get_by_val` with DOM getters 5 %, calls between compiled and interpreted code 4 %.
A 4 times shorter warm-up for all code (`JSC_thresholdForJITAfterWarmUp=125`) gave 35 and 41 s.
So the size of arithmetic was not what limits the challenge; with the JIT it takes about four
fifths of the time it takes without.

Branch hints (#643, 2026-11-22): on a Moto G71 (BrowserStack) the JS of the host page runs as
fast as on the desktop of the measurements (a loop 247 against 227 ms, optimized 29 against 29),
the engine's interpreter 1.8 to 2.3 times slower, but compiled code of large functions 2.8 to 3.4
times: a page in the engine running the dispatch of `tests/jsc/jit-size.js` (200 cases of a VM's
statements) did 1550 to 1580 statements per ms compiled against 1250 interpreted (desktop 5150
to 5300 against 2300), with 16 cases 3500 to 3800 against 1500, so for large functions the JIT
gave the phone little; its code did not stay in the phone's caches. With the hints the 200 cases
run 2181 per ms on the Moto (1.38 times), 16 cases of 12 statements 269 to 273 against 229, 16
cases and a tight int32 loop as before; on desktop (Chromium host) 6411 against 5155 per ms and
16 cases 8584 to 8678 against 8196 to 8204. In the jsc shell (node 26) the dispatch's module has
10819 hints (0.44 instead of 0.39 MB) and runs 6270 to 6850 against 5550 to 5920 steps per ms once
optimized, with V8's hints switched off (`--no-experimental-wasm-branch-hinting`) 5460 to 5750; the
tight loop 150 to 160 against 152 to 165 thousand iterations per ms (6 runs each, within the
spread). Turnstile's first phase was not measurably shorter: each challenge brings another VM and
its phases vary 4 to 10 times between runs. A 4 times shorter warm-up for all code
(`JSC_thresholdForJITAfterWarmUp=125`, 8 runs at a phone's viewport) compiled the VM's large
functions 5 to 8 s after the challenge's `fo` request instead of 17 to 20 s, but the first phase
took as long (4.3 to 19.5 s against 5.6 to 21.4 s): those functions run little faster compiled.
V8's optimized code of the dispatch's module (0.39 MB) took 0.45 s to compile in node, so it is
not the wait for TurboFan either.

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
   40 to 90 KB of bytecode; the fast paths of property, element, keyed and scope access in
   functions of the module made them 8 to 10 times that in WASM instead of 25 to 31 (#630).
   The double and slow paths of arithmetic, comparisons and conditions are out of line too
   (#636): about 75 to 120 bytes per such statement instead of 200 to 260, no faster on
   Turnstile's challenge. Branch hints keep the code of slow paths out of the instruction cache
   (#643): 1.38 times as fast for a VM's large function on a Moto G71, whose caches did not hold
   its code. Next: the code size of large functions (operands and frame accesses per instruction,
   values in WASM locals between safepoints: a register written and read again in a block is
   loaded from the frame each time) and array literals without a call into C++. A shorter
   warm-up of an obfuscated VM's large functions did not shorten Turnstile's first phase.
