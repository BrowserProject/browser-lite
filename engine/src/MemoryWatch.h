// Watches the engine's WASM memory: releases caches as malloc grows, finds
// out at runtime how far the memory can grow and reports memory pressure in
// time (MemoryWatch.cpp).
#pragma once

namespace BrowserLite {

// After every work item on the engine thread; cheap unless malloc grew by 32 MB.
void checkMemory();

} // namespace BrowserLite
