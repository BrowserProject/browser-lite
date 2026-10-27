// <link rel=preconnect> and Link headers: without it the first request to a font or CDN origin
// waits a round trip for its TLS handshake through the relay. curl never reuses a connection of
// CURLOPT_CONNECT_ONLY, our patch adds 3 (deps/patches/curl): connect, then back into the pool.

#include "config.h"
#include "Preconnect.h"

#include <WebCore/CurlContext.h>
#include <WebCore/CurlRequestScheduler.h>
#include <WebCore/CurlRequestSchedulerClient.h>
#include <WebCore/SecurityOriginData.h>
#include <wtf/HashMap.h>
#include <wtf/MainThread.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/ThreadSafeRefCounted.h>

namespace BrowserLite {

using namespace WebCore;

// curl keeps an idle connection longer than this; a preconnect within it would only open another
static constexpr Seconds repeatAfter { 10_s };

class PreconnectTransfer final : public ThreadSafeRefCounted<PreconnectTransfer>, public CurlRequestSchedulerClient {
public:
    explicit PreconnectTransfer(const URL& url)
        : m_url(url.isolatedCopy())
    {
    }

    void retain() final { ref(); }
    void release() final { deref(); }
    CURL* handle() final { return m_handle ? m_handle->handle() : nullptr; }

    // On curl's thread. Set up like the requests of CurlRequest, so curl takes the connection
    // for them (same TLS and HTTP version settings)
    CURL* setupTransfer() final
    {
        m_handle = makeUnique<CurlHandle>();
        m_handle->setURL(m_url, CurlHandle::LocalhostAlias::Disable);
        m_handle->enableHttpGetRequest();
        curl_easy_setopt(m_handle->handle(), CURLOPT_CONNECT_ONLY, 3L);
        return m_handle->handle();
    }

    void didCompleteTransfer(CURLcode) final { }
    void didCancelTransfer() final { }

private:
    URL m_url;
    std::unique_ptr<CurlHandle> m_handle;
};

void preconnect(const URL& url)
{
    ASSERT(isMainThread());
    if (!url.protocolIsInHTTPFamily())
        return;
    static NeverDestroyed<HashMap<String, MonotonicTime>> recent;
    auto origin = SecurityOriginData::fromURL(url).toString();
    auto now = MonotonicTime::now();
    auto last = recent->get(origin);
    if (last && now - last < repeatAfter)
        return;
    recent->set(origin, now);
    Ref transfer = adoptRef(*new PreconnectTransfer(url));
    CurlContext::singleton().scheduler().add(transfer.ptr());
}

} // namespace BrowserLite
