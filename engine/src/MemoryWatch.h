// Watches the engine's WASM memory: releases caches as malloc grows, finds
// out at runtime how far the memory can grow and reports memory pressure in
// time (MemoryWatch.cpp).
#pragma once

namespace BrowserLite {

// After every work item on the engine thread; cheap unless malloc grew by 32 MB.
// Inside a dialog's nested event loop (script of the page waits below) caches
// are not released, the reserve and the pressure report still work.
enum class ReleaseCaches : bool { No, Yes };
void checkMemory(ReleaseCaches = ReleaseCaches::Yes);

} // namespace BrowserLite
