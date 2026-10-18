// Persistent bytecode cache for scripts (see BytecodeCache.cpp).
#pragma once

#include <wtf/URL.h>

namespace BrowserLite::BytecodeCache {

// Enables the cache when a build ID is known (BL_BYTECODE_CACHE, BL_BUILD_ID)
void initialize();

// Fetch stored bytecode for this script ahead of time (when loading starts)
void prefetch(const URL&);

// Store new bytecode soon (after a page loaded)
void scheduleCommit();

} // namespace BrowserLite::BytecodeCache
