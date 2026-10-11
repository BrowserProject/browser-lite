// Event-Loop der Engine.
//
// WebCore benutzt den generischen WTF RunLoop. Normalerweise wuerde ein Thread
// in RunLoop::run() blockieren. In einem Web Worker geht das nicht: der Worker
// muss immer wieder in den JS-Event-Loop zurueck, sonst kommen keine
// Nachrichten (Netzwerk, UI-Befehle) mehr an.
//
// Darum treiben wir den RunLoop von aussen:
// - RunLoop meldet "es gibt Arbeit" ueber den WakeUp-Callback (von jedem Thread)
//   -> wir planen einen Pump-Schritt auf dem Engine-Thread ein (zusammengefasst)
// - nach jedem Pump-Schritt stellen wir einen Timer auf den naechsten
//   faelligen WebCore-Timer (RunLoop::nextTimerFireTime, Patch 0005)

#include "config.h"
#include "Engine.h"

#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <emscripten/emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <pthread.h>
#include <wtf/MonotonicTime.h>
#include <wtf/RunLoop.h>

namespace BrowserLite {

static pthread_t s_engineThread;
static std::atomic<bool> s_engineThreadSet { false };

void setEngineThread()
{
    s_engineThread = pthread_self();
    s_engineThreadSet.store(true, std::memory_order_release);
}

bool isEngineThread()
{
    return s_engineThreadSet.load(std::memory_order_acquire) && pthread_equal(pthread_self(), s_engineThread);
}

static void runFunction(void* arg)
{
    auto* function = static_cast<Function<void()>*>(arg);
    (*function)();
    delete function;
}

void runOnEngineThread(Function<void()>&& function)
{
    RELEASE_ASSERT(s_engineThreadSet.load(std::memory_order_acquire));
    auto* heapFunction = new Function<void()>(WTF::move(function));
    // Auch vom Engine-Thread selber erlaubt: dann laeuft es beim naechsten
    // Durchgang durch den JS-Event-Loop (wie ein setTimeout(0), aber ohne Drosselung).
    if (!emscripten_proxy_async(emscripten_proxy_get_system_queue(), s_engineThread, runFunction, heapFunction)) {
        delete heapFunction;
        log("runOnEngineThread: proxy_async fehlgeschlagen");
    }
}

static std::atomic<bool> s_pumpScheduled { false };
static long s_timerId { 0 };
static double s_timerDeadline { 0 };

static void pumpRunLoop();

static void timerFired(void*)
{
    s_timerId = 0;
    s_timerDeadline = 0;
    pumpRunLoop();
}

static void armTimerForNextScheduledTask()
{
    auto next = WTF::RunLoop::nextTimerFireTime();
    if (!next) {
        if (s_timerId) {
            emscripten_clear_timeout(s_timerId);
            s_timerId = 0;
            s_timerDeadline = 0;
        }
        return;
    }
    double deadline = next->secondsSinceEpoch().milliseconds();
    if (s_timerId && s_timerDeadline <= deadline)
        return; // ein frueherer Timer laeuft schon
    if (s_timerId)
        emscripten_clear_timeout(s_timerId);
    double delay = std::max(0.0, deadline - WTF::MonotonicTime::now().secondsSinceEpoch().milliseconds());
    s_timerDeadline = deadline;
    s_timerId = emscripten_set_timeout(timerFired, delay, nullptr);
}

static void pumpRunLoop()
{
    s_pumpScheduled.store(false, std::memory_order_release);
    // Einmal alle faelligen Timer und wartenden Aufgaben abarbeiten
    WTF::RunLoop::cycle();
    armTimerForNextScheduledTask();
}

void scheduleRunLoopPump()
{
    if (s_pumpScheduled.exchange(true, std::memory_order_acq_rel))
        return;
    auto* heapFunction = new Function<void()>([] { pumpRunLoop(); });
    if (!emscripten_proxy_async(emscripten_proxy_get_system_queue(), s_engineThread, runFunction, heapFunction)) {
        delete heapFunction;
        s_pumpScheduled.store(false, std::memory_order_release);
    }
}

void initializeEngineLoop()
{
    RELEASE_ASSERT(isEngineThread());
    // Wird aufgerufen, waehrend der RunLoop sein Lock haelt, eventuell von
    // einem anderen Thread: hier nur einplanen, nie direkt arbeiten.
    WTF::RunLoop::setWakeUpCallback([] {
        scheduleRunLoopPump();
    });
    scheduleRunLoopPump();
}

void log(const char* format, ...)
{
    va_list args;
    va_start(args, format);
    char buffer[2048];
    vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    std::fprintf(stderr, "[engine] %s\n", buffer);
}

} // namespace BrowserLite
