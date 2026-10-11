// WebSockets fuer die Seiten: WebSocketChannel (aus WebKitLegacy) mit unserem
// curl-Socket. WebTransport gibt es nicht.
#pragma once

#include <WebCore/SocketProvider.h>

namespace BrowserLite {

Ref<WebCore::SocketProvider> createSocketProvider();

} // namespace BrowserLite
