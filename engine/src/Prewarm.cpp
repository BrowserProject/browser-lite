// The first page of an engine paid for the setup of curl (OpenSSL's random generator), the
// cookie database (SQLite open, schema, first query) and the compiling of our page extensions
// (1450 lines of JS) on its critical path: in the CPU profile of Wikipedia 0.5 s before its first
// request and 1.5 s at its first script. JSC's code cache keeps the bytecode of the extensions
// for every later window.
#include "config.h"
#include "Prewarm.h"

#include "Engine.h"
#include "Strategies.h"
#include "WebPlatformExtras.h"

#include <WebCore/CookieJarDB.h>
#include <WebCore/CurlContext.h>
#include <WebCore/NetworkStorageSession.h>
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

void prewarmPageExtensionsSoon()
{
    static bool scheduled;
    if (std::exchange(scheduled, true))
        return;
    callOnMainThread([] {
        auto start = MonotonicTime::now();
        compilePageExtensions();
        debugLog("Prewarm: page extensions %.0f ms", (MonotonicTime::now() - start).milliseconds());
    });
}

} // namespace BrowserLite
