# JIT to WebAssembly

JSC runs the C loop interpreter (`ENABLE_JIT=OFF`): plain JS is 20 to 40 times slower than in V8,
about 55 cycles per bytecode, and neither a tail-call interpreter nor more inline caches change
that (#321). The JIT compiles hot JSC bytecode into WebAssembly at runtime, in the thread of the
VM. Status: in work (#322), off by default (`BL_JIT=1` turns it on).

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
  one), adds its export to that thread's table (tables are per thread) and keeps the index in the
  `CodeBlock`'s own `JITCode`.
- **Entry**: a new glue label of the C loop (`llint_wasmjit_entry`) becomes the `CodeBlock`'s
  call address: prologue, then the compiled function `(cfr, entry) -> status`, then return or the
  interpreter's throw trampoline. Loops enter the same way from `op_loop_hint` with the index of
  the loop.
- **Tier-up**: the interpreter's counters with the JIT off (`llint_replace` at returns,
  `llint_loop_osr` at loops) call the compiler instead of giving up.
- **Calls**: compiled to compiled is a direct WASM call; to an interpreted function through the
  interpreter's call path.
- **Exceptions**: the compiled function returns a status, the interpreter unwinds; a `catch`
  goes on in the interpreter (its frame is the same).
- **GC**: at its safepoints (trap checks, calls) every live value is in the frame and the
  `CLoopStack` pointer is current, as in the interpreter (#60); nothing lives in WASM locals across
  them.

## Measured

Phase 1 in the `jsc` shell (node, 100 calls of a loop of 20000): an int32 loop 362 against
35 ms, with `%` 404 against 21 ms, property reads and writes through the interpreter's caches 485
against 53 ms.

## Phases

1. Infrastructure: emitter, install, entry and tier-up hooks, functions without calls (loops,
   arithmetic, property access), tests in the `jsc` shell and the engine.
2. Calls between compiled and interpreted functions, exceptions, entry into running loops.
3. Coverage of the remaining bytecodes; on by default when the suites and real sites pass.
4. Speed: values in WASM locals between safepoints, type checks folded, inlining of small
   functions.
