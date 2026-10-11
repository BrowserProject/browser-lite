#include "config.h"
#include "SocketStreamHandleCurl.h"

#include "SocketStreamHandleClient.h"
#include "Strategies.h"
#include <WebCore/CookieRequestHeaderFieldProxy.h>
#include <WebCore/CurlStreamScheduler.h>
#include <WebCore/NetworkStorageSession.h>
#include <WebCore/SharedBuffer.h>
#include <WebCore/SocketStreamError.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/UniqueArray.h>

namespace BrowserLite {

using namespace WebCore;

static CurlStreamScheduler& streamScheduler()
{
    static NeverDestroyed<CurlStreamScheduler> scheduler;
    return scheduler;
}

SocketStreamHandleCurl::SocketStreamHandleCurl(const URL& url, SocketStreamHandleClient& client)
    : SocketStreamHandle(url, client)
{
    m_streamID = streamScheduler().createStream(url, *this, CurlStream::ServerTrustEvaluation::Enable, CurlStream::LocalhostAlias::Disable);
}

SocketStreamHandleCurl::~SocketStreamHandleCurl()
{
    if (m_streamID != invalidCurlStreamID)
        streamScheduler().destroyStream(std::exchange(m_streamID, invalidCurlStreamID));
}

void SocketStreamHandleCurl::sendBytes(std::span<const uint8_t> data)
{
    if (data.empty() || m_streamID == invalidCurlStreamID)
        return;
    auto buffer = makeUniqueArray<uint8_t>(data.size());
    memcpy(buffer.get(), data.data(), data.size());
    m_bufferedAmount += data.size();
    streamScheduler().send(m_streamID, WTF::move(buffer), data.size());
    m_client.didUpdateBufferedAmount(*this, m_bufferedAmount);
}

void SocketStreamHandleCurl::platformSend(std::span<const uint8_t> data, Function<void(bool)>&& completionHandler)
{
    if (m_streamID == invalidCurlStreamID)
        return completionHandler(false);
    sendBytes(data);
    completionHandler(true);
}

void SocketStreamHandleCurl::platformSendHandshake(std::span<const uint8_t> data, const std::optional<CookieRequestHeaderFieldProxy>& cookieProxy, Function<void(bool, bool)>&& completionHandler)
{
    if (m_streamID == invalidCurlStreamID)
        return completionHandler(false, false);

    // Cookies der Seite kommen in den Handshake (vor die Leerzeile am Ende)
    bool secureCookiesAccessed = false;
    Vector<uint8_t> handshake;
    if (cookieProxy) {
        auto [cookies, secure] = networkStorageSession().cookieRequestHeaderFieldValue(*cookieProxy);
        secureCookiesAccessed = secure;
        if (!cookies.isEmpty() && data.size() > 2) {
            handshake.append(data.first(data.size() - 2));
            handshake.append("Cookie: "_span);
            handshake.append(cookies.utf8().span());
            handshake.append("\r\n\r\n"_span);
        }
    }
    sendBytes(handshake.isEmpty() ? data : handshake.span());
    completionHandler(true, secureCookiesAccessed);
}

void SocketStreamHandleCurl::platformClose()
{
    if (m_streamID != invalidCurlStreamID)
        streamScheduler().destroyStream(std::exchange(m_streamID, invalidCurlStreamID));
    m_client.didCloseSocketStream(*this);
}

void SocketStreamHandleCurl::didOpen(CurlStreamID)
{
    if (m_state != Connecting)
        return;
    m_state = Open;
    m_client.didOpenSocketStream(*this);
}

void SocketStreamHandleCurl::didSendData(CurlStreamID, size_t length)
{
    m_bufferedAmount -= std::min(length, m_bufferedAmount);
    m_client.didUpdateBufferedAmount(*this, m_bufferedAmount);
    if (m_state == Closing && !m_bufferedAmount)
        disconnect();
}

void SocketStreamHandleCurl::didReceiveData(CurlStreamID, const SharedBuffer& buffer)
{
    if (m_state != Open && m_state != Closing)
        return;
    // 0 Bytes: die Gegenseite hat die Verbindung geschlossen
    if (!buffer.size()) {
        disconnect();
        return;
    }
    m_client.didReceiveSocketStreamData(*this, buffer.span());
}

void SocketStreamHandleCurl::didFail(CurlStreamID, CURLcode errorCode, CertificateInfo&&)
{
    if (m_state == Closed)
        return;
    Ref protectedThis { *this };
    m_client.didFailSocketStream(*this, SocketStreamError(static_cast<int>(errorCode), m_url.string(), String::fromLatin1(curl_easy_strerror(errorCode))));
}

} // namespace BrowserLite
