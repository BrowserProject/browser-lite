// The JIT to WebAssembly (docs/jit.md): hooks of the C loop (LLIntWasmJIT.h, patch 0067).
#include "config.h"
#include "LLIntWasmJIT.h"

#include "CodeBlock.h"
#include <cstdlib>

namespace JSC::LLInt {

// BL_JIT=1 turns it on (off by default while it grows)
static bool enabled()
{
    static const bool on = [] {
        auto* value = getenv("BL_JIT");
        return value && value[0] == '1';
    }();
    return on;
}

const JSInstruction* wasmJITEnter(CallFrame*, CodeBlock*)
{
    return nullptr;
}

void wasmJITTierUp(VM&, CodeBlock*)
{
    if (!enabled())
        return;
}

} // namespace JSC::LLInt
