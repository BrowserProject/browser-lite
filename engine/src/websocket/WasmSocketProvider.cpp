#include "config.h"
#include "WasmSocketProvider.h"

#include "WebSocketChannel.h"
#include <WebCore/WebTransportSession.h>
#include <wtf/CompletionHandler.h>

namespace BrowserLite {

using namespace WebCore;

class WasmSocketProvider final : public SocketProvider {
public:
    static Ref<WasmSocketProvider> create() { return adoptRef(*new WasmSocketProvider); }

private:
    RefPtr<ThreadableWebSocketChannel> createWebSocketChannel(Document& document, WebSocketChannelClient& client, IsInitiatedByDedicatedWorker) final
    {
        return WebSocketChannel::create(document, client, *this);
    }

    std::pair<RefPtr<WebTransportSession>, Ref<WebTransportSessionPromise>> initializeWebTransportSession(ScriptExecutionContext&, WebTransportSessionClient&, const URL&, const WebTransportOptions&) final
    {
        return { nullptr, WebTransportSessionPromise::createAndReject() };
    }
};

Ref<SocketProvider> createSocketProvider()
{
    return WasmSocketProvider::create();
}

} // namespace BrowserLite
