#pragma once

// Work the first page load of an engine would do on the engine thread itself, done ahead while
// the thread waits anyway.

namespace WebCore {
class LocalFrame;
}

namespace BrowserLite {

// Curl with OpenSSL and the cookie database: otherwise before the first request goes out.
// Engine thread, once at the start.
void prewarmNetwork();

// Bytecode of our page extensions (installPageExtensions): otherwise when the first script of
// the first page runs. Engine thread, when a request of `frame` went out: after the current task,
// while the answer is on the way, the window of its main frame's document is made (usually the
// initial empty one), which installs them; JSC's code cache keeps their bytecode for the next
// windows. The first call only.
void prewarmPageExtensionsSoon(WebCore::LocalFrame&);

} // namespace BrowserLite
