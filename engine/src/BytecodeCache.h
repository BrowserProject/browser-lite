// Persistent bytecode cache for scripts (see BytecodeCache.cpp).
#pragma once

#include <wtf/URL.h>

namespace WebCore {
class CachedResource;
}

namespace BrowserLite::BytecodeCache {

// Enables the cache when a build ID is known (BL_BYTECODE_CACHE, BL_BUILD_ID) and
// gives JSC the final BL_BUILD_ID: call before any other thread starts
void initialize();

// A script resource starts loading from the network with this request: remembers
// its key and fetches stored bytecode for it ahead of time
void prefetch(const WebCore::CachedResource&, const URL& requestURL);

// Store new bytecode soon (after a page loaded)
void scheduleCommit();

} // namespace BrowserLite::BytecodeCache
