// A navigation of the user stops the script of the page it leaves, like Firefox
// (dom.ipc.cancel_content_js_when_navigating, BrowserParent::CanCancelContentJS). All views share
// the engine thread, and a command of the host runs only once the running task ends: a script of
// seconds (on a slow phone a chart in an iframe ran 9 s) kept the page the user left on screen,
// the back arrow already grey. Browsers with site isolation do not wait for a cross-site frame
// (its own process), and Firefox also stops the page's own script.
//
// The export of the command (bl_load_url, bl_go) records the request on the host's thread before
// it goes to the engine thread. The script watchdog (EngineLoop.cpp) looks at the trap points of
// the running entry into JS; when a waiting request of its view leaves the document of the main
// frame, it terminates the entry like a script that blocks too long. Requests count only until
// their command runs. Only a navigation that surely replaces the main frame's document stops
// scripts (a different address apart from the fragment, a history entry of another document),
// and only on http(s) and file: pages; reload waits as in Firefox. If the page stays after
// all (a download, beforeunload), it goes on with that entry terminated, like after the watchdog.
// A page with a stopped script stays out of the back/forward cache, as in Firefox.
#include "config.h"
#include "UserNavigation.h"

#include "Engine.h"
#include "EngineConfig.h"
#include "WebView.h"

#include <WebCore/BackForwardController.h>
#include <WebCore/Document.h>
#include <WebCore/DocumentPage.h>
#include <WebCore/HistoryItem.h>
#include <WebCore/JSDOMGlobalObject.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/Page.h>
#include <atomic>
#include <wtf/Lock.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/Vector.h>
#include <wtf/WeakHashSet.h>

namespace BrowserLite {

using namespace WebCore;

namespace {

struct Request {
    uint64_t id;
    int viewID;
    // Back (negative) or forward in the history; 0: the typed address
    int offset;
    String address;
};

}

static Lock s_lock;
static uint64_t s_lastRequest WTF_GUARDED_BY_LOCK(s_lock);
static Vector<Request>& requests() WTF_REQUIRES_LOCK(s_lock)
{
    static NeverDestroyed<Vector<Request>> requests;
    return requests;
}
// Whether requests wait, read by the watchdog without the lock
static std::atomic<bool> s_waiting;

static uint64_t addRequest(int viewID, int offset, String&& address)
{
    Locker locker { s_lock };
    uint64_t id = ++s_lastRequest;
    requests().append({ id, viewID, offset, WTF::move(address) });
    s_waiting.store(true, std::memory_order_release);
    return id;
}

uint64_t userNavigationRequested(int viewID, int offset)
{
    return addRequest(viewID, offset, { });
}

uint64_t userNavigationRequested(int viewID, const String& address)
{
    // The command's copy goes to the engine thread on its own
    return addRequest(viewID, 0, address.isolatedCopy());
}

void userNavigationTaken(uint64_t request)
{
    Locker locker { s_lock };
    requests().removeFirstMatching([&](auto& waiting) { return waiting.id == request; });
    s_waiting.store(!requests().isEmpty(), std::memory_order_release);
}

// Whether the request surely replaces the document of the view's main frame
static bool leavesDocument(WebView& view, const Request& request)
{
    RefPtr frame = view.mainFrame();
    RefPtr document = frame ? frame->document() : nullptr;
    if (!document)
        return false;
    // Like Firefox: other pages (about:, data:, blob:) run to completion
    const URL& current = document->url();
    if (!current.protocolIsInHTTPFamily() && !current.protocolIsFile())
        return false;
    if (!request.offset) {
        URL target = WebView::typedAddress(request.address);
        return target.isValid() && !target.protocolIsJavaScript() && !equalIgnoringFragmentIdentifier(target, current);
    }
    // Firefox takes a change of origin between the entries as the sign of another document;
    // WebKit's entries know their document
    auto& history = view.page().backForward();
    RefPtr target = history.itemAtIndex(request.offset);
    RefPtr currentItem = history.currentItem();
    return target && (!currentItem || !currentItem->shouldDoSameDocumentNavigationTo(*target));
}

static WeakHashSet<Document, WeakPtrImplWithEventTargetData>& stoppedDocuments()
{
    static NeverDestroyed<WeakHashSet<Document, WeakPtrImplWithEventTargetData>> documents;
    return documents;
}

bool userNavigationStopsScript(JSC::JSGlobalObject& globalObject)
{
    if (!s_waiting.load(std::memory_order_acquire) || !engineConfig().navigationStopsScripts)
        return false;
    auto* domGlobalObject = dynamicDowncast<JSDOMGlobalObject>(globalObject);
    RefPtr document = dynamicDowncast<Document>(domGlobalObject ? domGlobalObject->scriptExecutionContext() : nullptr);
    RefPtr page = document ? document->page() : nullptr;
    if (!page)
        return false;
    int stoppedFor = 0;
    {
        Locker locker { s_lock };
        for (auto& request : requests()) {
            auto* view = WebView::fromID(request.viewID);
            if (view && &view->page() == page.get() && leavesDocument(*view, request)) {
                stoppedFor = request.viewID;
                break;
            }
        }
    }
    if (!stoppedFor)
        return false;
    stoppedDocuments().add(*document);
    log("View %d: script stopped, the user leaves the page", stoppedFor);
    return true;
}

bool scriptStoppedForUserNavigation(const Document& document)
{
    return stoppedDocuments().contains(document);
}

} // namespace BrowserLite
