// Hidden views wait while the user works in a visible one (#364). All views share the engine
// thread, and input only jumps ahead between two tasks (EngineLoop.cpp): a heavy page loading in
// a background tab ran scripts, parser slices and network callbacks of up to seconds each, and
// typing in the front tab lagged by as much (Chrome runs the tab in another process). Input to a
// visible view starts a quiet period: hidden views without sound wait like the pages below a
// dialog (setPageWaits) until no input came for quietTime, then they go on where they stopped. A
// task that already runs when the first input comes still finishes first. Input is what goes
// through withInput (Exports.cpp): keys, text, clicks, touches, drags; hovering and wheel
// scrolling on the scrolling thread are not.
#include "config.h"
#include "HiddenViews.h"

#include "Engine.h"
#include "WebView.h"

#include <WebCore/ActiveDOMObject.h>
#include <WebCore/Document.h>
#include <WebCore/FrameTree.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/Page.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>

namespace BrowserLite {

using namespace WebCore;

// Longer than the pause between two keys or taps, short enough that a background tab goes on
// while the user reads
static constexpr Seconds quietTime = 1_s;

static bool s_waiting;
static MonotonicTime s_lastInput;

static void updateViews()
{
    WebView::forEach([](WebView& view) {
        view.updateWaitForUser();
    });
}

static void quietTimerFired();

static RunLoop::Timer& quietTimer()
{
    static NeverDestroyed<RunLoop::Timer> timer(RunLoop::mainSingleton(), "HiddenViews"_s, quietTimerFired);
    return timer;
}

static void quietTimerFired()
{
    auto left = s_lastInput + quietTime - MonotonicTime::now();
    if (left > 0_s) {
        quietTimer().startOneShot(left);
        return;
    }
    s_waiting = false;
    debugLog("Hidden views go on");
    updateViews();
}

void userWorksInVisibleView()
{
    s_lastInput = MonotonicTime::now();
    if (std::exchange(s_waiting, true))
        return;
    quietTimer().startOneShot(quietTime);
    debugLog("Hidden views wait for the user");
    updateViews();
}

bool hiddenViewsWaitForUser()
{
    return s_waiting;
}

void setPageWaits(Page& page, bool waits)
{
    auto forEachDocument = [&](const auto& function) {
        for (RefPtr<Frame> frame = page.mainFrame(); frame; frame = frame->tree().traverseNext()) {
            if (RefPtr localFrame = dynamicDowncast<LocalFrame>(*frame)) {
                if (RefPtr document = localFrame->document())
                    function(*document);
            }
        }
    };
    // The order of PageGroupLoadDeferrer: the parser is suspended before loading defers
    if (waits) {
        forEachDocument([](Document& document) {
            document.suspendScheduledTasks(ReasonForSuspension::WillDeferLoading);
        });
        page.setDefersLoading(true);
        return;
    }
    page.setDefersLoading(false);
    // Only suspended documents (resumeScheduledTasks checks the reason): one that came meanwhile
    // (back from the back/forward cache) was never suspended, and resuming twice resumes its
    // objects twice
    forEachDocument([](Document& document) {
        if (document.activeDOMObjectsAreSuspended())
            document.resumeScheduledTasks(ReasonForSuspension::WillDeferLoading);
    });
}

} // namespace BrowserLite
