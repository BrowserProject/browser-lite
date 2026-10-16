#include "config.h"
#include "ScrollingWasm.h"

#include "Engine.h"
#include "LayerTreeHostWasm.h"
#include "WebView.h"

#if ENABLE(ASYNC_SCROLLING) && ENABLE(SCROLLING_THREAD)
#include <WebCore/ScrollingThread.h>
#include <WebCore/ScrollingTreeCoordinated.h>
#include <wtf/HashMap.h>
#include <wtf/Lock.h>
#include <wtf/NeverDestroyed.h>

namespace BrowserLite {

using namespace WebCore;

namespace {

struct Entry {
    RefPtr<ThreadedScrollingTree> tree;
    bool animatedScroll { false };
};

Lock s_lock;

// Scrolling-Baeume der Tabs, Zugriff von Engine- und Compositor-Thread
HashMap<int, Entry>& entries() WTF_REQUIRES_LOCK(s_lock)
{
    static NeverDestroyed<HashMap<int, Entry>> map;
    return map;
}

HashMap<int, RefPtr<CompositorScene>>& scenes() WTF_REQUIRES_LOCK(s_lock)
{
    static NeverDestroyed<HashMap<int, RefPtr<CompositorScene>>> map;
    return map;
}

// Der naechste Takt kommt mit dem naechsten Bild des Compositors
void requestTick(int viewId)
{
    RefPtr<CompositorScene> scene;
    {
        Locker locker { s_lock };
        scene = scenes().get(viewId);
    }
    if (scene)
        scene->requestScrollingTick();
}

RefPtr<ThreadedScrollingTree> treeForView(int viewId)
{
    Locker locker { s_lock };
    auto it = entries().find(viewId);
    return it == entries().end() ? nullptr : it->value.tree;
}

// Ohne Scroll-Thread: DOM-Event und Scrollen im Engine-Thread
void sendToEngine(int viewId, const PlatformWheelEvent& event, OptionSet<WheelEventProcessingSteps> steps)
{
    runOnEngineThread([viewId, event, steps] {
        if (auto* view = WebView::fromID(viewId))
            view->dispatchWheelEvent(event, steps);
    });
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
    debugLog("View %d: Scrollen im eigenen Thread", viewId);
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
    // Plant ein Rendering-Update ein, danach treibt der Compositor die Animation
    ThreadedScrollingCoordinator::hasNodeWithAnimatedScrollChanged(hasAnimatedScroll);
}

namespace Scrolling {

void setScene(int viewId, CompositorScene* scene)
{
    Locker locker { s_lock };
    if (scene)
        scenes().set(viewId, scene);
    else
        scenes().remove(viewId);
}

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

    // Wie EventDispatcher::internalWheelEvent() in WebKit2
    auto steps = tree->determineWheelEventProcessing(event);
    bool useEngineThreadForScrolling = steps.contains(WheelEventProcessingSteps::SynchronousScrolling);
    tree->willProcessWheelEvent();

    ScrollingThread::dispatch([tree = WTF::move(tree), viewId, event, steps, useEngineThreadForScrolling] {
        if (useEngineThreadForScrolling) {
            // Die Seite hat einen wheel-Listener, der scrollen verhindern kann
            tree->willSendEventToMainThread(event);
            sendToEngine(viewId, event, steps);
            tree->waitForEventToBeProcessedByMainThread(event);
            return;
        }

        auto result = tree->handleWheelEvent(event, steps);
        // Der Scroll-Thread wendet die neue Position beim naechsten Takt an,
        // wenn bis dahin kein Rendering-Update des Engine-Threads kommt (der
        // ist vielleicht mit dem JS der Seite beschaeftigt)
        if (result.wasHandled) {
            tree->didScheduleRenderingUpdate();
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
    {
        Locker locker { s_lock };
        auto it = entries().find(viewId);
        if (it == entries().end())
            return false;
        tree = it->value.tree;
        animatedScroll = it->value.animatedScroll;
    }
    // Scroll-Animation: neue Positionen anwenden, auch ohne Rendering-Update
    if (animatedScroll)
        tree->didScheduleRenderingUpdate();
    tree->displayDidRefresh(tree->displayID());
    return animatedScroll;
}

} // namespace Scrolling

} // namespace BrowserLite

#else

namespace BrowserLite::Scrolling {

// Ohne Scroll-Thread scrollt der Engine-Thread
void setScene(int, CompositorScene*) { }
void stopForView(int) { }
void wheelEvent(int viewId, const WebCore::PlatformWheelEvent& event)
{
    runOnEngineThread([viewId, event] {
        if (auto* view = WebView::fromID(viewId))
            view->dispatchWheelEvent(event, { WebCore::WheelEventProcessingSteps::SynchronousScrolling, WebCore::WheelEventProcessingSteps::BlockingDOMEventDispatch });
    });
}
bool displayDidRefresh(int) { return false; }

} // namespace BrowserLite::Scrolling

#endif
