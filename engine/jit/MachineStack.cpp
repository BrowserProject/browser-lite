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

#include <emscripten/em_asm.h>
#include <emscripten/em_js.h>

namespace JSC {

// Whether the machine stack has room for `bytes` more: 0 no, 1 yes (measured by a recursion),
// 2 yes (measured by a frame, which costs nearly nothing). A probe is a WASM function that the
// browser stops with a RangeError where it would not fit, caught right here with nothing of the
// engine between.
// - The recursion: frames of known size (32 values live across each call, about 313 bytes in
//   V8) as deep as `bytes` needs. About 8 us for 94 KB.
// - The frame (only for 94 KB): one function with a frame that large, which holds loaded values
//   across a call on a path it never takes, so it only runs its prologue. That checks the stack
//   pointer minus the frame size against the limit (V8's both tiers do, SpiderMonkey's measured
//   too) without touching the frame. About 0.1 us. It is made at the first probe and trusted once
//   a test in a later task showed that it fails where the recursion fails: other engines or tiers
//   may make a large frame without checking it. The test runs frames like the recursion's as deep
//   as the stack goes, counting them into memory, then again to where the recursion finds no room
//   for 90 % of the frame, and calls the frame there: about 1 ms per thread in Chromium once the
//   page main thread compiled the frame (prepareMachineStackProbes), else about 3 ms. Deeper and
//   deeper JS frames probing every 16 levels took 8 to 11 ms, and 60 to 1000 ms under V8's
//   sampling profiler, which walks the whole stack at every sample. Without WebAssembly SIMD the
//   frame's module fails and the recursion probes.
EM_JS(int, probeMachineStack, (int bytes), {
    const fits = (probe, argument) => {
        try {
            probe(argument);
            return true;
        } catch (e) {
            return false;
        }
    };
    // Per thread: the engine's workers keep it as a global (tests read it), the page main thread
    // (prepareMachineStackProbes) in the module, not in the host page's window
    const home = typeof ENVIRONMENT_IS_PTHREAD != 'undefined' && ENVIRONMENT_IS_PTHREAD ? globalThis : Module;
    let stack = home.blMachineStack;
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
        // A module of functions (func (param i32) (result i32)) with these bodies, exported as
        // a, b and so on, and its memory of one page exported as m
        const module = (...bodies) => {
            let code = [bodies.length];
            const exports = [bodies.length + 1, 1, 0x6d, 2, 0];
            bodies.forEach((body, k) => {
                // Not push(...body): as many arguments as the frame's body has bytes overflow
                code = code.concat(leb(body.length), body);
                exports.push(1, 0x61 + k, 0, k);
            });
            return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f,
                3, bodies.length + 1, bodies.length, ...bodies.map(() => 0), 5, 3, 1, 0, 1,
                7, ...leb(exports.length), ...exports, 10, ...leb(code.length), ...code]);
        };
        // n nested frames of the function `self`, each with 32 values live across its call, each
        // first with `entry`, the innermost with `bottom`
        const values = 32;
        const nested = (self, entry, bottom) => {
            const body = [1, values, 0x7e, ...entry];
            for (let k = 1; k <= values; k++)
                body.push(0x20, 0, 0xad, 0x42, k, 0x7c, 0x21, k);
            body.push(0x20, 0, 0x45, 0x04, 0x7f, ...bottom, 0x05, 0x20, 0, 0x41, 1, 0x6b, 0x10, self, 0x0b, 0x20, 1);
            for (let k = 2; k <= values; k++)
                body.push(0x20, k, 0x7c);
            body.push(0xa7, 0x6a, 0x0b);
            return body;
        };
        // a(n): n nested frames
        const recursion = nested(0, [], [0x41, 0]);
        // a(0) = 1 from a frame of 94 KB: else load the vectors, call a(0) and add them all to it.
        // 6016 vectors of 16 bytes: V8 compiles the frame on its first call, in about 2 ms instead
        // of the 3.5 to 7 ms of 12032 values of 8 bytes. Nested smaller frames would compile
        // faster, but Firefox did not fail them where the recursion fails, not even two of 47 KB.
        const frameBytes = 94 * 1024;
        const frame = [0, 0x20, 0, 0x45, 0x04, 0x7f, 0x41, 1, 0x05];
        for (let k = 0; k < frameBytes / 16; k++)
            frame.push(0x41, 0, 0xfd, 0, 4, ...leb(k * 16));
        frame.push(0x41, 0, 0x10, 0, 0xfd, 0x11);
        for (let k = 0; k < frameBytes / 16; k++)
            frame.push(0xfd, 0x6e);
        frame.push(0xfd, 0x1b, 0, 0x0b, 0x0b);

        stack = home.blMachineStack = {
            recursion: new WebAssembly.Instance(new WebAssembly.Module(module(recursion))).exports.a,
            frame: null,
            instance: null,
            // How long the test of the frame took (tests/core/stack-test.mjs)
            calibrationMs: null,
        };
        const frames = (size) => Math.ceil(size / 313);
        // b(n): n + 1 nested frames like the recursion's, each storing its n at address 0, the
        // innermost calling a(0) of the frame
        const descent = nested(1, [0x41, 0, 0x20, 0, 0x36, 2, 0], [0x41, 0, 0x10, 0]);
        WebAssembly.instantiate(module(frame, descent)).then(({ instance }) => {
            // Kept: the other threads find the code V8 compiled for it (prepareMachineStackProbes)
            stack.instance = instance;
            const { a: probe, b: descend, m: memory } = instance.exports;
            const level = new Int32Array(memory.buffer);
            // As deep as the stack goes, then the frame where the recursion finds no room for
            // 90 % of it. Tried again when the descent did not reach it: a tier of other frame
            // sizes may have taken over in between.
            const failsNearTheEnd = () => {
                const deepest = 0x40000000;
                if (fits(descend, deepest))
                    return false;
                const depth = deepest - level[0] + 1 - frames(0.9 * frameBytes);
                level[0] = -1;
                return depth > 0 && !fits(descend, depth) && level[0] === 0;
            };
            const start = performance.now();
            try {
                if (fits(probe, 0) && (failsNearTheEnd() || failsNearTheEnd() || failsNearTheEnd()))
                    stack.frame = probe;
            } catch (e) {
            }
            stack.calibrationMs = performance.now() - start;
        }, () => {});
    }
    if (bytes === 94 * 1024 && stack.frame)
        return fits(stack.frame, 0) ? 2 : 0;
    return fits(stack.recursion, Math.ceil(bytes / 313)) ? 1 : 0;
});

// Declared in engine/src/main.cpp, which calls it (MachineStack.h is private to JavaScriptCore)
void prepareMachineStackProbes()
{
    MAIN_THREAD_ASYNC_EM_ASM({ probeMachineStack(94 * 1024); });
}

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
