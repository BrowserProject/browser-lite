/*
 * The machine stack (MachineStack.h). The browser stops a WASM thread whose machine stack is full
 * with a RangeError in the middle of the engine's C++, which leaves the engine broken. JSC's
 * limits only see the shadow stack (4 MB per thread), while a Chromium worker has about 500 KB of
 * machine stack left when a page's script runs: deep C++ recursion (chains of proxies, getters,
 * toString, the code of long expressions) filled it first. So JSC's recursion checks
 * (VM::isSafeToRecurse, patch 0075) also probe the machine stack.
 */
#include "config.h"
#include "MachineStack.h"

#include <emscripten/em_js.h>

namespace JSC {

// Whether the machine stack has room for `bytes` more: 0 no, 1 yes (measured by a recursion),
// 2 yes (measured by a frame, which costs nearly nothing). A probe is a WASM function that the
// browser stops with a RangeError where it would not fit, caught right here with nothing of the
// engine between.
// - The recursion: frames of known size (32 values live across each call, about 313 bytes in
//   V8) as deep as `bytes` needs. About 8 us for 94 KB.
// - The frame (only for 94 KB): one function with a frame that large, which holds 12032 loaded
//   values across a call on a path it never takes, so it only runs its prologue. That checks the
//   stack pointer minus the frame size against the limit (V8's both tiers do, SpiderMonkey's
//   measured too) without touching the frame. About 0.1 us. It is made at the first probe and
//   trusted once a test in a later task, from a shallow stack, showed that it fails where the
//   recursion fails: other engines or tiers may make a large frame without checking it.
EM_JS(int, probeMachineStack, (int bytes), {
    const fits = (probe, argument) => {
        try {
            probe(argument);
            return true;
        } catch (e) {
            return false;
        }
    };
    let stack = globalThis.blMachineStack;
    if (!stack) {
        const leb = (n) => {
            const out = [];
            do {
                const low = n & 0x7f;
                n >>>= 7;
                out.push(n ? low | 0x80 : low);
            } while (n);
            return out;
        };
        // A module of one (func (param i32) (result i32)) with this body and one memory
        const module = (body) => {
            const code = [1, ...leb(body.length), ...body];
            return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f, 3, 2, 1, 0,
                5, 3, 1, 0, 1, 7, 5, 1, 1, 0x70, 0, 0, 10, ...leb(code.length), ...code]);
        };
        // p(n): n nested frames, each with 32 values live across its call
        const values = 32;
        const recursion = [1, values, 0x7e];
        for (let k = 1; k <= values; k++)
            recursion.push(0x20, 0, 0xad, 0x42, k, 0x7c, 0x21, k);
        recursion.push(0x20, 0, 0x45, 0x04, 0x7f, 0x41, 0, 0x05, 0x20, 0, 0x41, 1, 0x6b, 0x10, 0, 0x0b, 0x20, 1);
        for (let k = 2; k <= values; k++)
            recursion.push(0x20, k, 0x7c);
        recursion.push(0xa7, 0x6a, 0x0b);
        // p(0) = 1 from a frame of 94 KB: else load the values, call p(0) and add them all to it
        const loads = 94 * 1024 / 8;
        const frame = [0, 0x20, 0, 0x45, 0x04, 0x7f, 0x41, 1, 0x05];
        for (let k = 0; k < loads; k++)
            frame.push(0x41, ...leb(k * 8), 0x29, 3, 0);
        frame.push(0x41, 0, 0x10, 0, 0xad);
        for (let k = 0; k < loads; k++)
            frame.push(0x7c);
        frame.push(0xa7, 0x0b, 0x0b);

        stack = globalThis.blMachineStack = {
            recursion: new WebAssembly.Instance(new WebAssembly.Module(module(recursion))).exports.p,
            frame: null,
        };
        const frames = (size) => Math.ceil(size / 313);
        WebAssembly.instantiate(module(frame)).then(({ instance }) => {
            const probe = instance.exports.p;
            // Deeper and deeper JS frames until the recursion finds no room for 90 % of the frame
            const failsWithRecursion = (depth) => {
                if (depth % 16 === 0 && !fits(stack.recursion, frames(0.9 * loads * 8)))
                    return !fits(probe, 0);
                const result = failsWithRecursion(depth + 1);
                return result;
            };
            try {
                if (fits(probe, 0) && failsWithRecursion(0))
                    stack.frame = probe;
            } catch (e) {
            }
        }, () => {});
    }
    if (bytes === 94 * 1024 && stack.frame)
        return fits(stack.frame, 0) ? 2 : 0;
    return fits(stack.recursion, Math.ceil(bytes / 313)) ? 1 : 0;
});

bool machineStackHasRoom()
{
    return probeMachineStack(214 * 1024);
}

// A probe holds while the shadow stack grows by less than this: deep C++ recursion took 2.5
// (getters calling getters) to 9 times (the code of a long || chain) as much machine stack as
// shadow stack in Chromium, so 10 to 36 KB. Unwound by more than reset, the frames below are new
// ones, which may be larger than those the probe saw (V8 optimized their function in between, the
// || chain then took 140 instead of 102 bytes per level): probe again. With 64 KB a second deep
// recursion in the same task ran past the probe's room and crashed the engine; 16 KB probes as
// often as 64 KB on page loads (weather.com, YouTube, Reddit, Walmart), 8 KB twice as often.
constexpr uintptr_t shadowStep = 4 * 1024;
constexpr uintptr_t reset = 16 * 1024;

// A probe also holds for this many checks at most: some recursions take no shadow stack at all
// (the code of a long chain of === took about 110 bytes of machine stack per level and none of
// the shadow stack, and crashed the engine past 4500 levels), so 7 KB for them after a probe by
// a frame. A probe by the recursion is too costly for that (every 128 checks took 2 to 5 % of a
// page load): 28 KB until the frame is trusted, a few milliseconds after the first probe.
constexpr unsigned checksPerFrameProbe = 64;
constexpr unsigned checksPerRecursionProbe = 256;

// Room a recursion check asks for: for the growth between two probes and the RangeError JSC then
// builds. Measured in Chromium: getters calling getters crashed the engine with 43 KB and were
// safe with 58 KB; 214 KB (the JIT's) stopped Instagram, Twitch and Walmart, whose scripts
// recurse that deep, with a RangeError.
constexpr int reserveBytes = 94 * 1024;

// Shadow stack pointer of the last probe with room since the VM was entered (0: none), the
// checks since and how many it holds for
static thread_local uintptr_t probedAt;
static thread_local unsigned checks;
static thread_local unsigned checksPerProbe;

bool machineStackAllowsRecursion(void* stackPointer)
{
    auto pointer = reinterpret_cast<uintptr_t>(stackPointer);
    if (probedAt && pointer + shadowStep >= probedAt && pointer < probedAt + reset && ++checks < checksPerProbe)
        return true;
    int probe = probeMachineStack(reserveBytes);
    if (!probe)
        return false;
    probedAt = pointer;
    checks = 0;
    checksPerProbe = probe == 2 ? checksPerFrameProbe : checksPerRecursionProbe;
    return true;
}

void machineStackEnteredVM()
{
    probedAt = 0;
}

} // namespace JSC
