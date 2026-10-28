#include "config.h"
#include "ScrollingWasm.h"

#include "Engine.h"
#include "LayerTreeHostWasm.h"
#include "WebView.h"

#if ENABLE(ASYNC_SCROLLING) && ENABLE(SCROLLING_THREAD)
#include <WebCore/ScrollingThread.h>
#include <WebCore/ScrollingTreeCoordinated.h>
#include <wtf/Condition.h>
#include <wtf/HashMap.h>
#include <wtf/Lock.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/ThreadSafeRefCounted.h>

namespace BrowserLite {

using namespace WebCore;

namespace {

struct Entry {
    RefPtr<ThreadedScrollingTree> tree;
    bool animatedScroll { false };
    // A wheel event scrolled, the next frame of the compositor has not come yet
    bool wheelScrolled { false };
    // Until then wheel events over listeners that may cancel them scroll without waiting for the
    // engine thread, which did not take one in time (blockingWheelEvent)
    MonotonicTime nonBlockingUntil;
};

// Like Safari for a trackpad gesture (ThreadedScrollingTree::waitForEventToBeProcessedByMainThread):
// a wheel event over a listener that may cancel it waits for the engine thread, but not while that
// thread is in a long script of the page: then the scrolling thread scrolls and the page gets the
// event later as not cancelable. The following events of that burst do not wait. Pages with long
// scripts (ads) otherwise scrolled seconds late.
constexpr Seconds longTask = 100_ms;
constexpr Seconds nonBlockingBurst = 500_ms;

// Who handles a blocking wheel event: the engine thread when it starts it in time, else the
// scrolling thread
class WheelClaim : public ThreadSafeRefCounted<WheelClaim> {
public:
    enum class Owner : uint8_t { None, Engine, ScrollingThread };
    static Ref<WheelClaim> create() { return adoptRef(*new WheelClaim); }

    // Returns whether the caller got it
    bool take(Owner owner)
    {
        Locker locker { m_lock };
        if (m_owner != Owner::None)
            return m_owner == owner;
        m_owner = owner;
        m_condition.notifyAll();
        return true;
    }
    // Scrolling thread: whether the engine thread took it within timeout
    bool waitForEngine(Seconds timeout)
    {
        Locker locker { m_lock };
        m_condition.waitFor(m_lock, timeout, [&] { return m_owner != Owner::None; });
        return m_owner == Owner::Engine;
    }

private:
    Lock m_lock;
    Condition m_condition;
    Owner m_owner WTF_GUARDED_BY_LOCK(m_lock) { Owner::None };
};

Lock s_lock;

// Scrolling trees of the views, accessed from engine and compositor thread
HashMap<int, Entry>& entries() WTF_REQUIRES_LOCK(s_lock)
{
    static NeverDestroyed<HashMap<int, Entry>> map;
    return map;
}

// The next tick comes with the next frame of the compositor
void requestTick(int viewId)
{
    if (RefPtr scene = CompositorScene::forView(viewId))
        scene->requestScrollingTick();
}

RefPtr<ThreadedScrollingTree> treeForView(int viewId)
{
    Locker locker { s_lock };
    auto it = entries().find(viewId);
    return it == entries().end() ? nullptr : it->value.tree;
}

// Without a scrolling thread: DOM event and scrolling on the engine thread
void sendToEngine(int viewId, const PlatformWheelEvent& event, OptionSet<WheelEventProcessingSteps> steps)
{
    runOnEngineThread([viewId, event, steps] {
        if (auto* view = WebView::fromID(viewId))
            view->dispatchWheelEvent(event, steps);
    });
}

// A wheel event over a listener that may cancel it (blocking, the engine thread scrolls): sent to
// the engine thread, which takes it when it gets to it in time; else the scrolling thread scrolls
// and the page gets it as not cancelable
void blockingWheelEvent(int viewId, ThreadedScrollingTree& tree, const PlatformWheelEvent& event, OptionSet<WheelEventProcessingSteps> steps)
{
    auto claim = WheelClaim::create();
    runOnEngineThread([viewId, event, steps, claim] {
        auto* view = WebView::fromID(viewId);
        if (!view)
            return;
        if (claim->take(WheelClaim::Owner::Engine))
            view->dispatchWheelEvent(event, steps);
        else
            view->dispatchWheelEvent(event, { WheelEventProcessingSteps::NonBlockingDOMEventDispatch });
    });
    // Wait unless the engine thread is in a long script
    while (!claim->waitForEngine(10_ms)) {
        if (engineThreadInLongScript(longTask) && claim->take(WheelClaim::Owner::ScrollingThread))
            break;
    }
    if (claim->waitForEngine(0_s)) {
        tree.willSendEventToMainThread(event);
        tree.waitForEventToBeProcessedByMainThread(event);
        return;
    }
    {
        Locker locker { s_lock };
        auto it = entries().find(viewId);
        if (it != entries().end())
            it->value.nonBlockingUntil = MonotonicTime::now() + nonBlockingBurst;
    }
    auto result = tree.handleWheelEvent(event, { WheelEventProcessingSteps::AsyncScrolling });
    if (result.wasHandled) {
        tree.didScheduleRenderingUpdate();
        Locker locker { s_lock };
        auto it = entries().find(viewId);
        if (it != entries().end())
            it->value.wheelScrolled = true;
    }
    if (result.wasHandled)
        requestTick(viewId);
}

bool inNonBlockingBurst(int viewId)
{
    Locker locker { s_lock };
    auto it = entries().find(viewId);
    return it != entries().end() && MonotonicTime::now() < it->value.nonBlockingUntil;
}

} // namespace

Ref<ScrollingCoordinatorWasm> ScrollingCoordinatorWasm::create(Page& page, int viewId)
{
    return adoptRef(*new ScrollingCoordinatorWasm(page, viewId));
}

ScrollingCoordinatorWasm::ScrollingCoordinatorWasm(Page& page, int viewId)
    : ThreadedScrollingCoordinator(&page)
    , m_viewId(viewId)
{
    Ref tree = ScrollingTreeCoordinated::create(*this);
    setScrollingTree(tree.copyRef());
    Locker locker { s_lock };
    entries().set(viewId, Entry { WTF::move(tree), false });
    debugLog("View %d: scrolling in its own thread", viewId);
}

ScrollingCoordinatorWasm::~ScrollingCoordinatorWasm() = default;

void ScrollingCoordinatorWasm::pageDestroyed()
{
    Scrolling::stopForView(m_viewId);
    ThreadedScrollingCoordinator::pageDestroyed();
}

void ScrollingCoordinatorWasm::didCompletePlatformRenderingUpdate()
{
    if (RefPtr tree = scrollingTree())
        downcast<ScrollingTreeCoordinated>(*tree).didCompletePlatformRenderingUpdate();
}

void ScrollingCoordinatorWasm::hasNodeWithAnimatedScrollChanged(bool hasAnimatedScroll)
{
    {
        Locker locker { s_lock };
        auto it = entries().find(m_viewId);
        if (it != entries().end())
            it->value.animatedScroll = hasAnimatedScroll;
    }
    // Schedules a rendering update, afterwards the compositor drives the animation
    ThreadedScrollingCoordinator::hasNodeWithAnimatedScrollChanged(hasAnimatedScroll);
}

namespace Scrolling {

void stopForView(int viewId)
{
    Locker locker { s_lock };
    entries().remove(viewId);
}

void wheelEvent(int viewId, const PlatformWheelEvent& event)
{
    RefPtr tree = treeForView(viewId);
    if (!tree) {
        sendToEngine(viewId, event, { WheelEventProcessingSteps::SynchronousScrolling, WheelEventProcessingSteps::BlockingDOMEventDispatch });
        return;
    }

    // Like EventDispatcher::internalWheelEvent() in WebKit2
    auto steps = tree->determineWheelEventProcessing(event);
    bool useEngineThreadForScrolling = steps.contains(WheelEventProcessingSteps::SynchronousScrolling);
    // In a burst the engine thread missed: scroll here, the page gets it as not cancelable
    if (useEngineThreadForScrolling && inNonBlockingBurst(viewId)) {
        steps = { WheelEventProcessingSteps::AsyncScrolling, WheelEventProcessingSteps::NonBlockingDOMEventDispatch };
        useEngineThreadForScrolling = false;
    }
    tree->willProcessWheelEvent();

    ScrollingThread::dispatch([tree = WTF::move(tree), viewId, event, steps, useEngineThreadForScrolling] {
        if (useEngineThreadForScrolling) {
            // The page has a wheel listener that can prevent scrolling
            blockingWheelEvent(viewId, *tree, event, steps);
            return;
        }

        auto result = tree->handleWheelEvent(event, steps);
        // The scrolling thread applies the new position on the next tick if no
        // rendering update of the engine thread comes until then (it may be
        // busy with the page's JS)
        if (result.wasHandled) {
            tree->didScheduleRenderingUpdate();
            {
                Locker locker { s_lock };
                auto it = entries().find(viewId);
                if (it != entries().end())
                    it->value.wheelScrolled = true;
            }
            requestTick(viewId);
        }
        if (result.needsMainThreadProcessing())
            sendToEngine(viewId, event, result.steps);
    });
}

bool displayDidRefresh(int viewId)
{
    RefPtr<ThreadedScrollingTree> tree;
    bool animatedScroll = false;
    bool wheelScrolled = false;
    {
        Locker locker { s_lock };
        auto it = entries().find(viewId);
        if (it == entries().end())
            return false;
        tree = it->value.tree;
        animatedScroll = it->value.animatedScroll;
        wheelScrolled = std::exchange(it->value.wheelScrolled, false);
    }
    // The tree only takes a refresh within 50 ms of the last wheel event
    // (ScrollingTree::hasRecentActivity). On a slow machine this frame may come
    // later, then the new position would wait for the engine thread, which may
    // be busy with the page's JS.
    if (wheelScrolled)
        tree->willProcessWheelEvent();
    // Scroll animation: apply new positions, even without a rendering update
    if (animatedScroll)
        tree->didScheduleRenderingUpdate();
    tree->displayDidRefresh(tree->displayID());
    return animatedScroll;
}

bool mayCancelWheelEvent(int viewId, const PlatformWheelEvent& event)
{
    RefPtr tree = treeForView(viewId);
    return !tree || tree->determineWheelEventProcessing(event).contains(WheelEventProcessingSteps::BlockingDOMEventDispatch);
}

} // namespace Scrolling

} // namespace BrowserLite

#else

namespace BrowserLite::Scrolling {

// Without a scrolling thread the engine thread scrolls
void stopForView(int) { }
void wheelEvent(int viewId, const WebCore::PlatformWheelEvent& event)
{
    runOnEngineThread([viewId, event] {
        if (auto* view = WebView::fromID(viewId))
            view->dispatchWheelEvent(event, { WebCore::WheelEventProcessingSteps::SynchronousScrolling, WebCore::WheelEventProcessingSteps::BlockingDOMEventDispatch });
    });
}
bool mayCancelWheelEvent(int, const WebCore::PlatformWheelEvent&) { return true; }
bool displayDidRefresh(int) { return false; }

} // namespace BrowserLite::Scrolling

#endif
