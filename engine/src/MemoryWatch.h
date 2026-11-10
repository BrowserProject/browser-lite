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

// A view left its page (a new document committed in its main frame) or closed: drops JSC's code
// cache, so the bytecode and the sources of pages that are gone go with the next GC.
void pageLeft();

// A view closed: like pageLeft, and a full GC collects what its pages left once no view closed for
// a moment and the user does not work in a visible view. JSC itself learns of the garbage only at
// its next full collection, which a big heap without allocations reached only after minutes.
void viewClosed();

} // namespace BrowserLite
