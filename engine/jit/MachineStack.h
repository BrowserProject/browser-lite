/*
 * The machine stack: the browser's own stack of a thread that WASM frames run on, apart from the
 * shadow stack in linear memory that JSC's limits measure (docs/architecture.md, JavaScript).
 * machineStackAllowsRecursion and machineStackEnteredVM are declared in VM.h (patch 0075).
 */
#pragma once

namespace JSC {

// Whether the machine stack has room for 214 KB more. Costs about 8 us: a probe.
bool machineStackHasRoom();

} // namespace JSC
