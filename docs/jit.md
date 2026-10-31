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

- **Install**: the compiler writes a module that imports the engine's memory and function table,
  compiles it synchronously in its thread (`new WebAssembly.Module`, about 0.1 ms for a small
  one) and adds its export to that thread's table (tables are per thread); a map of the thread
  keeps the index by `CodeBlock`.
- **Entry**: the compiled function is `(cfr, block) -> status` and starts at a basic block.
  `slow_path_enter` runs it from the first block and hands the C loop an `op_ret` of the `this`
  slot, where compiled code leaves the return value. A hot loop (`llint_loop_osr`) compiles the
  function and runs the rest of the call from the block after its `op_loop_hint`, then points the
  frame's bytecode offset (which the C loop reloads) at that `op_ret`.
- **Tier-up**: the interpreter's counters with the JIT off (`llint_replace` at returns,
  `llint_loop_osr` at loops) call the compiler instead of giving up.
- **Fast paths**: the interpreter's, reading its caches at run time: int32 and double arithmetic
  and comparisons, equality, property access (own, prototype, array length, unset, transitions),
  array elements (int32, double, contiguous, array storage), scopes (closure, global), `switch`.
- **Calls**: to a compiled function directly in the frame the bytecode prepared (moved down for
  missing arguments, like the interpreter's arity fixup), found through a cache per call site
  (the callee's executable, valid until the next GC); to a host function like the interpreter;
  else JSC's generic call or construct. Varargs (`apply`, spread) get a frame like the
  interpreter's and then the same call, tail calls are ordinary calls.
- **Exceptions**: an instruction within a `try` goes to its handler (known by its bytecode offset),
  whose `op_catch` takes the exception like the interpreter's; otherwise the compiled function
  returns a status and the interpreter unwinds.
- **GC**: at its safepoints (trap checks, calls) every live value is in the frame and the
  `CLoopStack` pointer is current, as in the interpreter (#60); nothing lives in WASM locals across
  them.

## Measured

In the `jsc` shell (node), interpreter against compiled: an int32 loop 352 against 28 ms, with
`%` 494 against 18 ms, property reads and writes 451 against 41 ms, `fib(25)` 261 against 89 ms.
Octane scores (higher is better): Richards 275 against 659, DeltaBlue 263 against 581, Crypto
312 against 1308, RayTrace 713 against 993, NavierStokes 422 against 1943. The TypeScript compiler
(transpiling 176 KB) gains only about 10 %: its many small calls cost about as much through C++
as in the interpreter, and V8 runs the many small modules in its baseline tier at first.

## Phases

1. Infrastructure: emitter, install, entry and tier-up hooks, functions without calls (loops,
   arithmetic, property access), tests in the `jsc` shell and the engine.
2. Calls between compiled and interpreted functions, exceptions, entry into running loops.
3. Coverage of the remaining bytecodes; on by default when the suites and real sites pass.
4. Speed: values in WASM locals between safepoints, type checks folded, inlining of small
   functions.
