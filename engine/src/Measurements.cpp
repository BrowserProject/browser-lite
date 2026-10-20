#include "config.h"
#include "Measurements.h"

#include "EngineConfig.h"
#include <atomic>
#include <cstdint>
#include <emscripten/emscripten.h>
#include <emscripten/heap.h>
#include <pthread.h>

namespace BrowserLite::Measurements {

// Times are emscripten_get_now() (milliseconds since the epoch on every thread)
static std::atomic<double> s_marks[3];
static std::atomic<unsigned> s_framesShown { 0 };
static std::atomic<unsigned> s_contentFramesShown { 0 };
static std::atomic<bool> s_videoPainted { false };

constexpr unsigned maxThreadTimes = 32;
static std::atomic<unsigned> s_threadsBeforeReady { 0 };
static std::atomic<double> s_threadTimes[maxThreadTimes];

void mark(Mark which)
{
    double expected = 0;
    s_marks[static_cast<unsigned>(which)].compare_exchange_strong(expected, emscripten_get_now());
}

void videoPainted()
{
    s_videoPainted.store(true, std::memory_order_relaxed);
}

bool takeVideoPainted()
{
    return s_videoPainted.exchange(false, std::memory_order_relaxed);
}

void frameShown(bool newContent)
{
    s_framesShown.fetch_add(1, std::memory_order_relaxed);
    if (newContent)
        s_contentFramesShown.fetch_add(1, std::memory_order_relaxed);
}

} // namespace BrowserLite::Measurements

using namespace BrowserLite::Measurements;

extern "C" {
int __real_pthread_create(pthread_t*, const pthread_attr_t*, void* (*)(void*), void*);
int __wrap_pthread_create(pthread_t*, const pthread_attr_t*, void* (*)(void*), void*);
}

// Linked with --wrap=pthread_create (engine.cmake): the time of every new
// thread until the engine is ready. Runs before main() too (the engine thread).
int __wrap_pthread_create(pthread_t* thread, const pthread_attr_t* attributes, void* (*start)(void*), void* argument)
{
    if (!s_marks[static_cast<unsigned>(Mark::Ready)].load(std::memory_order_relaxed)) {
        unsigned index = s_threadsBeforeReady.fetch_add(1, std::memory_order_relaxed);
        if (index < maxThreadTimes)
            s_threadTimes[index].store(emscripten_get_now(), std::memory_order_relaxed);
    }
    return __real_pthread_create(thread, attributes, start, argument);
}

// Layout of the readings (doubles), see bl_measurements in engine/abi.json
enum Reading : unsigned {
    MemoryBytes,
    FramesShown,
    ContentFramesShown,
    MainTime,
    CompositorReadyTime,
    ReadyTime,
    ThreadsBeforeReady,
    ThreadTimes,
    ReadingCount = ThreadTimes + maxThreadTimes,
};
static double s_readings[ReadingCount];

// Synchronous, from the main thread of the page. Only with BL_TEST_HOOKS=1, 0 otherwise.
extern "C" EMSCRIPTEN_KEEPALIVE uintptr_t bl_measurements()
{
    if (!BrowserLite::engineConfig().testHooks)
        return 0;
    s_readings[MemoryBytes] = emscripten_get_heap_size();
    s_readings[FramesShown] = s_framesShown.load(std::memory_order_relaxed);
    s_readings[ContentFramesShown] = s_contentFramesShown.load(std::memory_order_relaxed);
    s_readings[MainTime] = s_marks[static_cast<unsigned>(Mark::Main)].load();
    s_readings[CompositorReadyTime] = s_marks[static_cast<unsigned>(Mark::CompositorReady)].load();
    s_readings[ReadyTime] = s_marks[static_cast<unsigned>(Mark::Ready)].load();
    unsigned threads = s_threadsBeforeReady.load();
    s_readings[ThreadsBeforeReady] = threads;
    for (unsigned i = 0; i < maxThreadTimes; ++i)
        s_readings[ThreadTimes + i] = i < threads ? s_threadTimes[i].load(std::memory_order_relaxed) : 0;
    return reinterpret_cast<uintptr_t>(s_readings);
}
