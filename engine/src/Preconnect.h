// Connections ahead of the requests (<link rel=preconnect>, see Preconnect.cpp).
#pragma once

#include <wtf/URL.h>

namespace BrowserLite {

// Opens a connection (TCP through the transport, TLS, HTTP/2) to the origin of `url` into curl's
// pool, which the next requests to it take. On the engine thread; again for the same origin
// within a few seconds does nothing.
void preconnect(const URL&);

} // namespace BrowserLite
