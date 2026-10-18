// WebSockets for the pages: WebSocketChannel (from WebKitLegacy) with our curl
// socket. There is no WebTransport.
#pragma once

#include <WebCore/SocketProvider.h>

namespace BrowserLite {

Ref<WebCore::SocketProvider> createSocketProvider();

} // namespace BrowserLite
