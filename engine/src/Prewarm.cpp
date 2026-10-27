// The first page of an engine paid for the setup of curl (OpenSSL's random generator), the
// cookie database (SQLite open, schema, first query) and the compiling of our page extensions
// (1450 lines of JS) on its critical path: in the CPU profile of Wikipedia 0.5 s before its first
// request and 1.5 s at its first script.
#include "config.h"
#include "Prewarm.h"

#include "Engine.h"
#include "Strategies.h"

#include <WebCore/CookieJarDB.h>
#include <WebCore/CurlContext.h>
#include <WebCore/DOMWrapperWorld.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/NetworkStorageSession.h>
#include <WebCore/ScriptController.h>
#include <wtf/MainThread.h>
#include <wtf/MonotonicTime.h>
#include <wtf/URL.h>

namespace BrowserLite {

using namespace WebCore;

void prewarmNetwork()
{
    auto start = MonotonicTime::now();
    CurlContext::singleton();
    URL url { "https://prewarm.invalid/"_s };
    networkStorageSession().cookieDatabase().searchCookies(url, url, std::nullopt, std::nullopt, std::nullopt);
    debugLog("Prewarm: curl and cookies %.0f ms", (MonotonicTime::now() - start).milliseconds());
}

void prewarmPageExtensionsSoon(LocalFrame& frame)
{
    static bool scheduled;
    RefPtr mainFrame = frame.localMainFrame();
    if (!mainFrame || std::exchange(scheduled, true))
        return;
    // Code the pages run anyway: a global object of its own would need deferred code (#238)
    callOnMainThread([weakFrame = WeakPtr { *mainFrame }] {
        RefPtr frame = weakFrame.get();
        if (!frame)
            return;
        auto start = MonotonicTime::now();
        frame->script().globalObject(mainThreadNormalWorldSingleton());
        debugLog("Prewarm: page extensions %.0f ms", (MonotonicTime::now() - start).milliseconds());
    });
}

} // namespace BrowserLite
