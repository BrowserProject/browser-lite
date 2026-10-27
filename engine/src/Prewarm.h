#pragma once

// Work the first page load of an engine would do on the engine thread itself, done ahead while
// the thread waits anyway.

namespace BrowserLite {

// Curl with OpenSSL and the cookie database: otherwise before the first request goes out.
// Engine thread, once at the start.
void prewarmNetwork();

// Bytecode of our page extensions (installPageExtensions): otherwise when the first script of
// the first page runs. Engine thread, when a request went out: after the current task, while the
// answer is on the way; the first call only.
void prewarmPageExtensionsSoon();

} // namespace BrowserLite
