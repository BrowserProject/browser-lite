// Socket for the pages' WebSockets (ws:// and wss://) through libcurl. WebCore's
// CurlStreamScheduler makes the connection (own thread, curl in CONNECT_ONLY
// mode with TLS). The sockets go through the transport like all others.
// Structure based on WebKit's old SocketStreamHandleImplCurl.
#pragma once

#include "SocketStreamHandle.h"
#include <WebCore/CurlStream.h>

namespace BrowserLite {

class SocketStreamHandleCurl final : public WebCore::SocketStreamHandle, public WebCore::CurlStream::Client {
public:
    static Ref<SocketStreamHandleCurl> create(const URL& url, WebCore::SocketStreamHandleClient& client)
    {
        return adoptRef(*new SocketStreamHandleCurl(url, client));
    }
    ~SocketStreamHandleCurl();

private:
    SocketStreamHandleCurl(const URL&, WebCore::SocketStreamHandleClient&);

    size_t bufferedAmount() final { return m_bufferedAmount; }
    void platformSend(std::span<const uint8_t>, Function<void(bool)>&&) final;
    void platformSendHandshake(std::span<const uint8_t>, const std::optional<WebCore::CookieRequestHeaderFieldProxy>&, Function<void(bool, bool)>&&) final;
    void platformClose() final;

    void sendBytes(std::span<const uint8_t>);

    // CurlStream::Client, arrives on the engine thread
    void didOpen(WebCore::CurlStreamID) final;
    void didSendData(WebCore::CurlStreamID, size_t) final;
    void didReceiveData(WebCore::CurlStreamID, const WebCore::SharedBuffer&) final;
    void didFail(WebCore::CurlStreamID, CURLcode, WebCore::CertificateInfo&&) final;

    WebCore::CurlStreamID m_streamID { WebCore::invalidCurlStreamID };
    size_t m_bufferedAmount { 0 };
};

} // namespace BrowserLite
