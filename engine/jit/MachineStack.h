/*
 * The machine stack: the browser's own stack of a thread that WASM frames run on, apart from the
 * shadow stack in linear memory that JSC's limits measure (docs/architecture.md, JavaScript).
 * machineStackAllowsRecursion and machineStackEnteredVM are declared in VM.h (patch 0075).
 */
#pragma once

namespace JSC {

// Makes the probes on the page main thread, once at the start: V8 keeps the code it compiled for
// a module and gives it to the other threads of the page that compile the same bytes (about 2 ms
// for the frame, 30 to 50 ms on the engine thread at a load of 40). Elsewhere it costs about as
// much once on the main thread.
void prepareMachineStackProbes();

// Whether the machine stack has room for 214 KB more. Costs about 8 us: a probe.
bool machineStackHasRoom();

} // namespace JSC
