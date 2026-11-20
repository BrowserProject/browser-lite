# engine/jit

The JIT to WebAssembly ([docs/jit.md](../../docs/jit.md)): compiles hot JSC bytecode into WASM
functions at run time. Built into JavaScriptCore of the engine and of the `jsc` shell through
`jit.cmake`, which `Source/JavaScriptCore/CMakeLists.txt` includes (patch 0067); the C loop calls
it through `LLIntWasmJIT.h`. On unless `BL_JIT=0`.

| File | |
|---|---|
| `WasmJIT.cpp` | Hooks of the C loop (entry at `op_enter`, tier-up at `llint_replace` and `llint_loop_osr`), calls from compiled code (compiled and host callees through the VM's callee table, compiled ones in WASM with the C loop's stack fields of patch 0096, `Function.prototype.call` and bound functions unwrapped, tail calls in place of the caller's frame: the interpreter makes them or `finishTailCall` and the module's call function; the VM entries of its generic calls counted for the GC, `wasmJITGenericEntries`, patch 0090, with `GenericEntry`, which JSC's bound functions use too, patch 0115), which `CodeBlock`s the GC keeps for their compiled code (`wasmJITHasCompiledCode`, patch 0095) reads and writes with string keys through the VM's megamorphic cache (filled by JSC's megamorphic lookup, looked up by helper functions of the module), and the compiler of a `CodeBlock` with its fast paths (the trap check of `op_check_traps` also at the function's entry, a safepoint like the interpreter's stack check; those of property, element, keyed and scope access and `Math.imul` in functions of the module that all sites call, which keeps large functions small, #630; arithmetic, comparisons, equality and conditions keep their int32 path inline and call one out-of-line function per opcode for doubles, cells and the slow path, #636), and the warm-up before a compile (counted by `UnlinkedCodeBlock`, so a `CodeBlock` the GC replaces keeps it; entries age in fires of the thread, without a clock read) |
| `MachineStack.cpp` | Probes of the browser's machine stack for the JIT and for JSC's recursion checks (patch 0075): a WASM function with a 94 KB frame that only runs its prologue, trusted after a test against a WASM recursion of known frame size, which probes until then and for the JIT |
| `WasmModule.cpp` | Writes the WASM module of one compiled function and its helper for calls |

Tests: `tests/jsc/jit.js` (results against the interpreter's, also of ToBoolean and of the out-of-line paths: atoms, ropes, constants, exceptions in a `try`, switches on doubles), `tests/jsc/jit-hash.js` (speed of the
fast paths for hashing code against their int32 twins), `tests/jsc/jit-recompile.js` (compiled code
through a full GC, and code thrown away compiles again), `tests/jsc/jit-tierup.js` (a loop entered
once gets V8's optimized code), `tests/jsc/jit-calls.js` (many callees at one site cost about
as much as one), `tests/jsc/jit-keyed.js` (many keys and shapes at one site cost about an array element's
access), `tests/jsc/jit-size.js` (the module of a large VM-like function stays at most 12 times its bytecode, and `if (s) t = u` and `s = s ^ c` at most 130 and 115 bytes of WASM per statement; run.sh reads the sizes in the JIT's log), `tests/jsc/jit-warmup-map.js` (calls with 8000 warm functions cost about as much as with 500), `tests/engine/gc-test.mjs` (the GC inside a generic call of compiled code and inside a bound
function's call of its target), `tests/engine/jit-warmup-test.mjs` (code that ran briefly stays
interpreted, a large function warms up longer than a small one, hot code compiles), `tests/engine/pages/tail-calls.html` (no frame of a tail call in stack walks after tier-up: postMessage's source through `call`, `apply`, `Reflect.apply` and bound functions of another frame, `Error.stack`, results of tail calls, also of a host function with more arguments than its caller had and of a function with more arguments that calls a host function).
