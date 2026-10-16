// Scrollen im eigenen Thread (wie WPE: ScrollingCoordinatorCoordinated +
// EventDispatcher in WebKit2).
//
// WebCore baut einen Scrolling-Baum (ScrollingTreeCoordinated) mit den
// scrollbaren Bereichen und ihren Ebenen. Mausrad-Events gehen von der
// Oberflaeche ueber den Compositor-Thread direkt an WebCores Scroll-Thread.
// Der verschiebt die Ebenen und weckt den Compositor. Der Engine-Thread
// bekommt das Event nur, wenn die Seite es braucht (wheel-Listener, nicht
// scrollbare Bereiche), und erfaehrt die neue Scroll-Position danach.
// So scrollt die Seite fluessig, auch wenn ihr JS den Engine-Thread blockiert.
#pragma once

#include <WebCore/PlatformWheelEvent.h>

#if ENABLE(ASYNC_SCROLLING) && ENABLE(SCROLLING_THREAD)
#include <WebCore/ThreadedScrollingCoordinator.h>
#endif

namespace BrowserLite {

#if ENABLE(ASYNC_SCROLLING) && ENABLE(SCROLLING_THREAD)
class ScrollingCoordinatorWasm final : public WebCore::ThreadedScrollingCoordinator {
public:
    static Ref<ScrollingCoordinatorWasm> create(WebCore::Page&, int viewId);

private:
    ScrollingCoordinatorWasm(WebCore::Page&, int viewId);
    ~ScrollingCoordinatorWasm();

    void pageDestroyed() final;
    void didCompletePlatformRenderingUpdate() final;
    void hasNodeWithAnimatedScrollChanged(bool) final;

    const int m_viewId;
};
#endif

namespace Scrolling {

// Engine-Thread: Mausrad wieder ueber den Engine-Thread (z.B. nach GPU-Verlust)
void stopForView(int viewId);

// Compositor-Thread: Mausrad-Event an den Scroll-Thread, sonst an den
// Engine-Thread
void wheelEvent(int viewId, const WebCore::PlatformWheelEvent&);

// Compositor-Thread, nach jedem Bild: Scroll-Animationen weiterfuehren.
// true = es laeuft eine, also bald wieder ein Bild
bool displayDidRefresh(int viewId);

} // namespace Scrolling

} // namespace BrowserLite
