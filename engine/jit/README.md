# engine/jit

The JIT to WebAssembly ([docs/jit.md](../../docs/jit.md)): compiles hot JSC bytecode into WASM
functions at run time. Built into JavaScriptCore of the engine and of the `jsc` shell through
`jit.cmake`, which `Source/JavaScriptCore/CMakeLists.txt` includes (patch 0067); the C loop calls
it through `LLIntWasmJIT.h`. Off unless `BL_JIT=1`.

| File | |
|---|---|
| `WasmJIT.cpp` | Hooks of the C loop: entry at `op_enter`, tier-up at `llint_replace` |
