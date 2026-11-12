// Hidden views wait while the user works in a visible one (#364, #394). All views share the engine
// thread, and input only jumps ahead between two tasks (EngineLoop.cpp): a heavy page loading in
// a background tab ran scripts, parser slices and network callbacks of up to seconds each, and
// typing in the front tab lagged by as much (Chrome runs the tab in another process). Hidden
// views without sound wait like the pages below a dialog (setPageWaits) and go on where they
// stopped when the user no longer needs the engine thread:
// - input to a visible view: until no input came for quietTime. Input is what goes through
//   withInput (Exports.cpp): keys, text, clicks, touches, drags; hovering and wheel scrolling on
//   the scrolling thread are not.
// - typing: while the focus of a visible view stays in a text field, until no key or text came
//   for typingQuietTime. A task that runs when a key comes still finishes first, so the pauses
//   of a writer (more than a second between two words or sentences) must not let hidden views
//   start one.
// - a visible view loads a new page: until it commits (at most navigationWait), then quietTime
//   for its first parsing and layout. A navigation of the host (withNavigation in Exports.cpp)
//   counts as input as soon as the running task ends.
// - a view becomes visible (a switch of tabs, bl_set_visible): like input from the end of the
//   running task on, and until it made the frame that was due, at most firstFrameWait. A tab that
//   loaded in the background never painted, its first layout and paint come with that frame,
//   and the user looks at an empty page until then; meanwhile hidden tabs (also the one just
//   left) started tasks of seconds between its steps.
#include "config.h"
#include "HiddenViews.h"

#include "EditorClient.h"
#include "Engine.h"
#include "WebView.h"

#include <WebCore/ActiveDOMObject.h>
#include <WebCore/Document.h>
#include <WebCore/FrameLoader.h>
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
// Covers the pauses of someone who writes and thinks; a chat or a form left with the focus in a
// field holds the background tabs no longer than this
static constexpr Seconds typingQuietTime = 10_s;
// A visible page that does not answer does not stop the background tabs for longer
static constexpr Seconds navigationWait = 10_s;
// The first frame of a view just shown, also a page that loaded in the background (its first
// layout and paint), needs no longer than this
static constexpr Seconds firstFrameWait = 5_s;
// How often the holds of the visible views (focus, navigation) are checked while hidden views wait
static constexpr Seconds checkInterval = 250_ms;

static bool s_waiting;
static MonotonicTime s_lastInput;
// NaN until the first time: no comparison holds
static MonotonicTime s_lastTyping = MonotonicTime::nan();
static MonotonicTime s_navigationStart = MonotonicTime::nan();
static MonotonicTime s_shownAt = MonotonicTime::nan();

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

static void startWaiting(Seconds delay)
{
    if (std::exchange(s_waiting, true))
        return;
    quietTimer().startOneShot(delay);
    debugLog("Hidden views wait for the user");
    updateViews();
}

static bool navigates(WebView& view)
{
    RefPtr frame = view.mainFrame();
    return frame && (frame->loader().provisionalDocumentLoader() || frame->loader().policyDocumentLoader());
}

// Whether a visible view still needs the engine thread after the quiet time of its last input
static bool visibleViewHolds(MonotonicTime now)
{
    bool typing = now < s_lastTyping + typingQuietTime;
    bool navigation = now < s_navigationStart + navigationWait;
    bool shown = now < s_shownAt + firstFrameWait;
    bool holds = false;
    WebView::forEach([&](WebView& view) {
        if (holds || !view.isVisible() || !view.mainFrame())
            return;
        holds = (navigation && navigates(view)) || (typing && takesTextInput(view.page())) || (shown && view.waitsForFrameSinceShown());
    });
    return holds;
}

static void quietTimerFired()
{
    auto now = MonotonicTime::now();
    auto left = s_lastInput + quietTime - now;
    if (left > 0_s) {
        quietTimer().startOneShot(left);
        return;
    }
    if (visibleViewHolds(now)) {
        quietTimer().startOneShot(checkInterval);
        return;
    }
    s_waiting = false;
    debugLog("Hidden views go on");
    updateViews();
}

void userWorksInVisibleView(UserInput input)
{
    s_lastInput = MonotonicTime::now();
    if (input == UserInput::Typing)
        s_lastTyping = s_lastInput;
    startWaiting(quietTime);
}

void visibleViewMayNavigate(WebView& view)
{
    if (!view.isVisible() || !navigates(view))
        return;
    s_navigationStart = MonotonicTime::now();
    startWaiting(checkInterval);
}

void visibleViewShown(WebView& view)
{
    if (!view.isVisible())
        return;
    if (view.waitsForFrameSinceShown())
        s_shownAt = MonotonicTime::now();
    userWorksInVisibleView();
    visibleViewMayNavigate(view);
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
    // The order of PageGroupLoadDeferrer: the parser is suspended before loading defers. Style
    // and layout run from timers of their own that the suspension does not cover: a stylesheet
    // or a change of the DOM shortly before made a hidden page recalculate its style and lay
    // itself out in tasks of seconds while the user typed.
    if (waits) {
        forEachDocument([](Document& document) {
            document.suspendScheduledTasks(ReasonForSuspension::WillDeferLoading);
        });
        page.setDefersLoading(true);
        page.setDefersStyleAndLayout(true);
        return;
    }
    page.setDefersStyleAndLayout(false);
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
