// WASM memory never shrinks, and how far it can grow depends on the browser:
// up to 4 GB in a 64 bit browser, about 1 GB in a 32 bit one. One build
// serves both, so the engine finds the limit at runtime instead of guessing it
// from the user agent. After every engine task it
// - releases what WebKit otherwise only releases under memory pressure
//   (caches, decoded images, back/forward cache) above BL_MEMORY_RELEASE_MB at
//   every growth of malloc by 32 MB, so free space is reused first. The
//   compiled JS of the pages (bytecode and JIT code) and the page left last
//   (kept in the back/forward cache) go too only once memory is short (see
//   limitIsNear): rebuilding the code blocked the pages for seconds, the GC
//   already ages out the code that does not run, and a page loaded again on
//   back shows its top until the load is complete.
//   JSC's code cache goes at every release and whenever a view leaves its
//   page: it holds the bytecode and the sources of every script evaluated,
//   also of the pages that are gone, which the code of the pages that live
//   does not need
// - at every growth of malloc by 32 MB, once the malloc area ends above
//   reserveFrom, grows the memory ahead so that a reserve stays free above the
//   malloc area; when that fails, the current size is the limit
// - then reports "memory-pressure" {footprint, limit, level}: "critical" once
//   memory is short, else "moderate" above BL_MEMORY_PRESSURE_MB (fragmentation
//   and big blocks make 4 GB scarce even when little is in use; on iPhone and
//   iPad, where a growth never fails, the budget of the core). The host then
//   discards a background view. The footprint is a high-water mark: one heavy
//   page keeps it above the budget for good, often with most of it free again
//   after the release, so above the budget memory is short only while the
//   area stays full.
// malloc_footprint() costs nothing (mallinfo() walks the whole heap and cost
// about 25 ms per call on CNN).

#include "config.h"
#include "MemoryWatch.h"

#include "Engine.h"
#include "EngineConfig.h"
#include "Host.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdint>
#include <emscripten/emscripten.h>
#include <emscripten/heap.h>
#include <malloc.h>
#include <pthread.h>
#include <JavaScriptCore/CodeCacheRelease.h>
#include <WebCore/BackForwardCache.h>
#include <WebCore/CommonVM.h>
#include <WebCore/MemoryRelease.h>
#include <wtf/MonotonicTime.h>
#include <wtf/text/MakeString.h>

// From Emscripten's dlmalloc, not declared in any header
extern "C" size_t malloc_footprint(void);

namespace BrowserLite {

static constexpr uint64_t checkStep = 32 << 20;

// Free memory kept above the malloc area. It holds what malloc takes between
// two checks (up to 83 MB measured while CNN loads: a step plus the big
// allocations of one task) and what the pages take until the host has
// discarded a view.
static constexpr uint64_t memoryReserve = 128 << 20;

// The reserve is kept only once the malloc area ends above this. Below it no
// browser runs out (in i386 Chromium the engine reached 977 to 1015 MB, a
// second memory 640 MB), and ordinary pages keep the memory size they have
// without the reserve (CNN about 300 MB of malloc area): Emscripten grows the
// memory only by 20 %, at most 96 MB, beyond what malloc asks for, so the
// reserve would make it about 128 MB bigger. The first check above this still
// finds a limit from about 600 MB on in time.
static constexpr uint64_t reserveFrom = 384 << 20;

// Engine thread only
static uint64_t s_footprintAtRelease;
static uint64_t s_footprintAtCheck;
// The memory cannot grow beyond this size, 0 = not reached yet
static uint64_t s_limit;
// bl_memory_limit_for_testing, 0 = none; read by every growth
static std::atomic<uint64_t> s_testLimit;

static uint64_t mb(uint64_t bytes)
{
    return bytes >> 20;
}

// End of the malloc area (malloc_footprint() leaves out the static data and
// the stack below it)
static uint64_t mallocEnd()
{
    return __atomic_load_n(emscripten_get_sbrk_ptr(), __ATOMIC_SEQ_CST);
}

// Every growth of the memory holds this lock. sbrk reads the memory size and
// then grows it; when another thread grew it in between, the growth fails (the
// requested size is not above the current one) and so would malloc. malloc
// calls sbrk under its own lock, keepReserve does not. sbrk is wrapped at link
// time (engine/engine.cmake), the engine never calls it itself.
static pthread_mutex_t s_growLock = PTHREAD_MUTEX_INITIALIZER;

// Memory is short when less than the reserve is left: below the limit, or,
// above BL_MEMORY_PRESSURE_MB, inside the malloc area after a release. The
// budget is no limit, the area may grow beyond it and what is free inside it is
// used first. Below a limit only the room above the area counts: there a big
// block that finds no free space of its size makes malloc fail.
static bool limitIsNear()
{
    return s_limit && mallocEnd() + memoryReserve > s_limit;
}

static bool overBudget(uint64_t footprint)
{
    return footprint >= static_cast<uint64_t>(engineConfig().memoryPressureMB) << 20;
}

// mallinfo() walks the whole heap, so only above the budget
static bool areaIsFull()
{
    return mallinfo().fordblks < memoryReserve;
}

static bool releaseIsDue(uint64_t footprint)
{
    uint64_t threshold = static_cast<uint64_t>(engineConfig().memoryReleaseMB) << 20;
    return threshold && footprint >= threshold && footprint >= s_footprintAtRelease + checkStep;
}

static void releaseCaches(uint64_t footprint, bool memoryShort)
{
    auto start = WTF::MonotonicTime::now();
    size_t usedBefore = debugEnabled() ? mallinfo().uordblks : 0;
    // Before the release, so that its GC collects the pruned pages
    WebCore::BackForwardCache::singleton().pruneToSizeNow(memoryShort ? 0 : 1, WebCore::PruningReason::MemoryPressure);
    WebCore::releaseMemory(WTF::Critical::Yes, WTF::Synchronous::Yes, WebCore::MaintainBackForwardCache::Yes, WebCore::MaintainMemoryCache::No,
        memoryShort ? WebCore::MaintainJSCode::No : WebCore::MaintainJSCode::Yes);
    if (debugEnabled()) {
        debugLog("Memory released%s (malloc area %llu MB, memory %llu MB): used %zu -> %zu MB in %.0f ms", memoryShort ? " with the JS code and the back/forward cache" : "",
            mb(footprint), mb(emscripten_get_heap_size()), usedBefore >> 20, static_cast<size_t>(mallinfo().uordblks) >> 20,
            (WTF::MonotonicTime::now() - start).milliseconds());
    }
}

// Makes the memory at least size bytes big; false when it cannot grow that far
// (also beyond the test limit, as sbrk then fails)
static bool growTo(uint64_t size)
{
    uint64_t testLimit = s_testLimit.load();
    if ((testLimit && size > testLimit) || size > emscripten_get_heap_max())
        return false;
    pthread_mutex_lock(&s_growLock);
    bool grown = emscripten_get_heap_size() >= size || emscripten_resize_heap(static_cast<size_t>(size));
    pthread_mutex_unlock(&s_growLock);
    return grown;
}

// Grows the memory so that the reserve is free above the malloc area. When it
// cannot grow that far, the limit is reached.
static void keepReserve()
{
    uint64_t end = mallocEnd();
    if (s_limit || end < reserveFrom || growTo(end + memoryReserve))
        return;
    uint64_t testLimit = s_testLimit.load();
    s_limit = testLimit ? testLimit : emscripten_get_heap_size();
    debugLog("Memory limit %llu MB (malloc area %llu MB)", mb(s_limit), mb(malloc_footprint()));
}

void checkMemory(ReleaseCaches release)
{
    uint64_t footprint = malloc_footprint();
    bool releaseDue = release == ReleaseCaches::Yes && releaseIsDue(footprint);
    bool checkDue = footprint >= s_footprintAtCheck + checkStep;
    if (!releaseDue && !checkDue)
        return;
    bool budgetExceeded = overBudget(footprint);
    // Full above the budget, measured after the release that keeps the JS code
    // and the page left last; then they go too
    bool areaFull = false;
    if (releaseDue) {
        s_footprintAtRelease = footprint;
        bool limitNear = limitIsNear();
        releaseCaches(footprint, limitNear);
        areaFull = !limitNear && budgetExceeded && areaIsFull();
        if (areaFull)
            releaseCaches(footprint, true);
    } else
        areaFull = checkDue && budgetExceeded && areaIsFull();
    if (!checkDue)
        return;
    s_footprintAtCheck = footprint;
    keepReserve();
    bool critical = areaFull || limitIsNear();
    if (!critical && !budgetExceeded)
        return;
    uint64_t limit = s_limit ? s_limit : emscripten_get_heap_max();
    auto level = critical ? "critical"_s : "moderate"_s;
    debugLog("Memory pressure (%s): malloc area %llu MB, limit %llu MB", level.characters(), mb(footprint), mb(limit));
    notifyHost(0, "memory-pressure", makeString("{\"footprint\":"_s, footprint, ",\"limit\":"_s, limit, ",\"level\":\""_s, level, "\"}"_s));
}

void pageLeft()
{
    JSC::clearCodeCache(WebCore::commonVM());
}

} // namespace BrowserLite

using namespace BrowserLite;

extern "C" void* __real_sbrk(intptr_t increment);

extern "C" void* __wrap_sbrk(intptr_t increment)
{
    pthread_mutex_lock(&s_growLock);
    // Like Emscripten's sbrk, the increment counts as unsigned
    uint64_t testLimit = s_testLimit.load();
    void* result;
    if (testLimit && mallocEnd() + static_cast<uintptr_t>(increment) > testLimit) {
        errno = ENOMEM;
        result = reinterpret_cast<void*>(-1);
    } else
        result = __real_sbrk(increment);
    pthread_mutex_unlock(&s_growLock);
    return result;
}

// For tests, only with BL_TEST_HOOKS=1: the memory cannot grow beyond this
// size (0 = the real limit), malloc fails there; checked at the next work item.
extern "C" EMSCRIPTEN_KEEPALIVE void bl_memory_limit_for_testing(int megabytes)
{
    runOnEngineThread([megabytes] {
        if (!engineConfig().testHooks)
            return;
        s_testLimit = static_cast<uint64_t>(std::max(megabytes, 0)) << 20;
        s_limit = 0;
        s_footprintAtCheck = 0;
    });
}
