# engine/jit

The JIT to WebAssembly ([docs/jit.md](../../docs/jit.md)): compiles hot JSC bytecode into WASM
functions at run time. Built into JavaScriptCore of the engine and of the `jsc` shell through
`jit.cmake`, which `Source/JavaScriptCore/CMakeLists.txt` includes (patch 0067); the C loop calls
it through `LLIntWasmJIT.h`. On unless `BL_JIT=0`.

| File | |
|---|---|
| `WasmJIT.cpp` | Hooks of the C loop (entry at `op_enter`, tier-up at `llint_replace` and `llint_loop_osr`), calls from compiled code (compiled and host callees through the VM's callee table, compiled ones in WASM with the C loop's stack fields of patch 0096, `Function.prototype.call` and bound functions unwrapped; the VM entries of its generic calls counted for the GC, `wasmJITGenericEntries`, patch 0090), which `CodeBlock`s the GC keeps for their compiled code (`wasmJITHasCompiledCode`, patch 0095) and the compiler of a `CodeBlock` with its fast paths |
| `MachineStack.cpp` | Probe of the browser's machine stack for the JIT and for JSC's recursion checks (patch 0075) |
| `WasmModule.cpp` | Writes the WASM module of one compiled function and its helper for calls |

Tests: `tests/jsc/jit.js` (results against the interpreter's), `tests/jsc/jit-hash.js` (speed of the
fast paths for hashing code against their int32 twins), `tests/jsc/jit-recompile.js` (compiled code
through a full GC, and code thrown away compiles again), `tests/jsc/jit-tierup.js` (a loop entered
once gets V8's optimized code), `tests/jsc/jit-calls.js` (many callees at one site cost about
as much as one), `tests/engine/gc-test.mjs` (the GC inside a generic call of compiled code).
