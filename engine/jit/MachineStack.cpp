/*
 * The machine stack (MachineStack.h). The browser stops a WASM thread whose machine stack is full
 * with a RangeError in the middle of the engine's C++, which leaves the engine broken. JSC's
 * limits only see the shadow stack (4 MB per thread), while a Chromium worker has about 500 KB of
 * machine stack left when a page's script runs: deep C++ recursion (chains of proxies, getters,
 * toString) filled it first. So JSC's recursion checks (VM::isSafeToRecurse, patch 0075) also
 * probe the machine stack.
 */
#include "config.h"
#include "MachineStack.h"

#include <emscripten/em_js.h>

namespace JSC {

// Whether the machine stack has room for frames more levels of a WASM recursion with frames of
// known size (32 values live across each call, about 290 bytes in V8), which the browser stops
// with a RangeError where it would not fit, caught right there with nothing of the engine between
EM_JS(int, probeMachineStack, (int frames), {
    let probe = globalThis.blMachineStackProbe;
    if (!probe) {
        const values = 32;
        const body = [1, values, 0x7e];
        for (let k = 1; k <= values; k++)
            body.push(0x20, 0, 0xad, 0x42, k, 0x7c, 0x21, k);
        body.push(0x20, 0, 0x45, 0x04, 0x7f, 0x41, 0, 0x05, 0x20, 0, 0x41, 1, 0x6b, 0x10, 0, 0x0b, 0x20, 1);
        for (let k = 2; k <= values; k++)
            body.push(0x20, k, 0x7c);
        body.push(0xa7, 0x6a, 0x0b);
        const leb = (n) => (n < 128 ? [n] : [(n & 0x7f) | 0x80, n >> 7]);
        const code = [1, ...leb(body.length), ...body];
        const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f, 3, 2, 1, 0,
            7, 5, 1, 1, 0x70, 0, 0, 10, ...leb(code.length), ...code]);
        probe = globalThis.blMachineStackProbe = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.p;
    }
    try {
        probe(frames);
        return 1;
    } catch (e) {
        return 0;
    }
});

bool machineStackHasRoom()
{
    return probeMachineStack(700);
}

// A probe holds while the shadow stack grows by less than this: deep C++ recursion took up to
// 2.5 times as much machine stack as shadow stack in Chromium (getters calling getters), so
// about 10 KB of the 200 KB a probe found. Unwound by more than reset, the stack may have grown
// again along another path: probe again.
constexpr uintptr_t shadowStep = 4 * 1024;
constexpr uintptr_t reset = 64 * 1024;

// Shadow stack pointer of the last probe with room since the VM was entered (0: none)
static thread_local uintptr_t probedAt;

bool machineStackAllowsRecursion(void* stackPointer)
{
    auto pointer = reinterpret_cast<uintptr_t>(stackPointer);
    if (probedAt && pointer + shadowStep >= probedAt && pointer < probedAt + reset)
        return true;
    if (!machineStackHasRoom())
        return false;
    probedAt = pointer;
    return true;
}

void machineStackEnteredVM()
{
    probedAt = 0;
}

} // namespace JSC
