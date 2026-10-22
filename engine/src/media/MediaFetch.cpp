// Data for the host <video>: the service worker asks for a piece of the file
// (Range), the engine loads it and hands head and data to the host. HTTP from
// the HTTP cache of the page's partition or with curl through the transport,
// with cookies and referrer of the page; blob: and data: from memory
// (BlobResourceHandle, can do Range).
#include "config.h"
#include "MediaFetch.h"

#include "Engine.h"
#include "Host.h"
#include "HttpCache.h"
#include "../LoaderStrategy.h"
#include "MediaPlayerPrivateWasm.h"

#include <WebCore/BlobResourceHandle.h>
#include <WebCore/CurlRequest.h>
#include <WebCore/CurlRequestClient.h>
#include <WebCore/CurlResponse.h>
#include <WebCore/HTTPHeaderNames.h>
#include <WebCore/NetworkLoadMetrics.h>
#include <WebCore/ResourceError.h>
#include <WebCore/ResourceHandleClient.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/ResourceResponse.h>
#include <WebCore/SharedBuffer.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite {

using namespace WebCore;

class MediaFetch;

static HashMap<int, RefPtr<MediaFetch>>& fetches()
{
    static NeverDestroyed<HashMap<int, RefPtr<MediaFetch>>> map;
    return map;
}

class MediaFetch : public RefCounted<MediaFetch> {
public:
    virtual ~MediaFetch() = default;

    void cancel()
    {
        Ref protectedThis { *this };
        detach(true);
        fetches().remove(m_id);
    }

protected:
    MediaFetch(int id, double start, double end)
        : m_id(id)
    {
        if (start > 0 || end >= 0)
            m_range = end >= 0 ? makeString("bytes="_s, static_cast<uint64_t>(start), '-', static_cast<uint64_t>(end)) : makeString("bytes="_s, static_cast<uint64_t>(start), '-');
    }

    // Let go of the load (and cancel it), no callback comes afterwards
    virtual void detach(bool cancelLoad) = 0;

    ResourceRequest request(const URL& url) const
    {
        ResourceRequest request(URL { url });
        if (!m_range.isEmpty())
            request.setHTTPHeaderField(HTTPHeaderName::Range, m_range);
        return request;
    }

    void sendHead(const ResourceResponse& response)
    {
        auto header = [&](HTTPHeaderName name) {
            return jsonEscape(response.httpHeaderField(name));
        };
        sendMediaFetch(m_id, "head"_s, makeString("{\"status\":"_s, response.httpStatusCode(),
            ",\"type\":\""_s, header(HTTPHeaderName::ContentType),
            "\",\"length\":\""_s, header(HTTPHeaderName::ContentLength),
            "\",\"range\":\""_s, header(HTTPHeaderName::ContentRange),
            "\",\"acceptRanges\":\""_s, header(HTTPHeaderName::AcceptRanges), "\"}"_s));
    }

    void sendData(std::span<const uint8_t> data)
    {
        sendMediaFetch(m_id, "data"_s, { }, data);
    }

    void finish(ASCIILiteral type, const String& json)
    {
        Ref protectedThis { *this };
        sendMediaFetch(m_id, type, json);
        detach(false);
        fetches().remove(m_id);
    }

    void fail(const ResourceError& error)
    {
        finish("error"_s, makeString("{\"message\":\""_s, jsonEscape(error.localizedDescription()), "\"}"_s));
    }

private:
    const int m_id;
    String m_range;
};

class NetworkMediaFetch final : public MediaFetch, public CurlRequestClient {
public:
    static Ref<NetworkMediaFetch> create(int id, double start, double end, const String& referrer, const String& partition)
    {
        return adoptRef(*new NetworkMediaFetch(id, start, end, referrer, partition));
    }

    void ref() const final { MediaFetch::ref(); }
    void deref() const final { MediaFetch::deref(); }

    void load(const URL& url)
    {
        auto request = this->request(url);
        request.setFirstPartyForCookies(url);
        if (!m_referrer.isEmpty())
            request.setHTTPReferrer(m_referrer);
        // No gzip: the byte positions have to match the file
        request.setHTTPHeaderField(HTTPHeaderName::AcceptEncoding, "identity"_s);
        m_cacheRequest = request;
        HttpCache::lookupForLoad(m_partition, WTF::move(request), false, [this, protectedThis = Ref { *this }](HttpCache::Lookup&& lookup) {
            if (m_detached)
                return;
            if (lookup.fresh)
                return serveFromCache(*lookup.entry);
            m_cachedEntry = WTF::move(lookup.entry);
            m_request = createCurlRequest(WTF::move(lookup.request), *this);
            m_request->resume();
        });
    }

private:
    NetworkMediaFetch(int id, double start, double end, const String& referrer, const String& partition)
        : MediaFetch(id, start, end)
        , m_referrer(referrer)
        , m_partition(partition)
    {
    }

    void detach(bool cancelLoad) final
    {
        m_detached = true;
        if (auto request = std::exchange(m_request, nullptr)) {
            request->invalidateClient();
            if (cancelLoad)
                request->cancel();
        }
    }

    void serveFromCache(const HttpCache::Entry& entry)
    {
        sendHead(entry.response);
        entry.body->forEachSegment([&](auto segment) {
            sendData(segment);
        });
        finish("end"_s, { });
    }

    void curlDidSendData(CurlRequest&, unsigned long long, unsigned long long) final { }

    void curlDidReceiveResponse(CurlRequest& request, CurlResponse&& curlResponse) final
    {
        Ref protectedThis { *this };
        storeCookies(request.resourceRequest(), curlResponse);
        ResourceResponse response(curlResponse);
        // Conditional request from the cache: 304 means the stored range is still right
        if (auto entry = std::exchange(m_cachedEntry, nullptr); entry && response.httpStatusCode() == 304) {
            HttpCache::didRevalidate(m_partition, m_cacheRequest, *entry, response);
            detach(true);
            serveFromCache(*entry);
            return;
        }
        if (isRedirect(response)) {
            if (auto error = followRedirect(m_request, *this, response, m_redirectCount); !error.isNull())
                fail(error);
            return;
        }
        // Without the validation headers; the target of a redirect is not stored (its URL differs)
        m_cacheWriter.start(m_partition, m_cacheRequest, response);
        sendHead(response);
        request.completeDidReceiveResponse();
    }

    void curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&& buffer) final
    {
        m_cacheWriter.append(buffer.get());
        sendData(buffer->span());
    }

    void curlDidComplete(CurlRequest&, NetworkLoadMetrics&&) final
    {
        m_cacheWriter.finish();
        finish("end"_s, { });
    }

    void curlDidFailWithError(CurlRequest&, ResourceError&& error, CertificateInfo&&) final
    {
        fail(error);
    }

    String m_referrer;
    unsigned m_redirectCount { 0 };
    RefPtr<CurlRequest> m_request;
    bool m_detached { false };
    // HTTP cache: partition of the page, the request as looked up, entry being
    // revalidated, and what is stored
    String m_partition;
    ResourceRequest m_cacheRequest;
    std::unique_ptr<HttpCache::Entry> m_cachedEntry;
    HttpCache::Writer m_cacheWriter;
};

class BlobMediaFetch final : public MediaFetch, public ResourceHandleClient {
public:
    static Ref<BlobMediaFetch> create(int id, double start, double end)
    {
        return adoptRef(*new BlobMediaFetch(id, start, end));
    }

    void load(BlobData& blob, const URL& url)
    {
        Ref handle = BlobResourceHandle::createAsync(&blob, request(url), this);
        handle->start();
        m_handle = WTF::move(handle);
    }

private:
    BlobMediaFetch(int id, double start, double end)
        : MediaFetch(id, start, end)
    {
    }

    void detach(bool cancelLoad) final
    {
        if (RefPtr handle = std::exchange(m_handle, nullptr)) {
            handle->clearClient();
            if (cancelLoad)
                handle->cancel();
        }
    }

    void willSendRequestAsync(ResourceHandle*, ResourceRequest&& request, ResourceResponse&&, CompletionHandler<void(ResourceRequest&&)>&& completion) final
    {
        completion(WTF::move(request));
    }

    void didReceiveResponseAsync(ResourceHandle*, ResourceResponse&& response, CompletionHandler<void()>&& completion) final
    {
        sendHead(response);
        completion();
    }

#if USE(PROTECTION_SPACE_AUTH_CALLBACK)
    void canAuthenticateAgainstProtectionSpaceAsync(ResourceHandle*, const ProtectionSpace&, CompletionHandler<void(bool)>&& completion) final
    {
        completion(false);
    }
#endif

    void didReceiveData(ResourceHandle*, const SharedBuffer& buffer, int) final
    {
        sendData(buffer.span());
    }

    void didFinishLoading(ResourceHandle*, const NetworkLoadMetrics&) final
    {
        finish("end"_s, { });
    }

    void didFail(ResourceHandle*, const ResourceError& error) final
    {
        fail(error);
    }

    RefPtr<ResourceHandle> m_handle;
};

void startMediaFetch(int playerId, int fetchId, double start, double end)
{
    auto* player = MediaPlayerPrivateWasm::fromId(playerId);
    if (!player) {
        sendMediaFetch(fetchId, "error"_s, "{\"message\":\"no player\"}"_s);
        return;
    }
    if (RefPtr blob = player->blob()) {
        Ref fetch = BlobMediaFetch::create(fetchId, start, end);
        fetches().set(fetchId, fetch.ptr());
        fetch->load(*blob, player->url());
        return;
    }
    Ref fetch = NetworkMediaFetch::create(fetchId, start, end, player->referrer(), player->httpCachePartition());
    fetches().set(fetchId, fetch.ptr());
    fetch->load(player->url());
}

void cancelMediaFetch(int fetchId)
{
    if (RefPtr fetch = fetches().get(fetchId))
        fetch->cancel();
}

} // namespace BrowserLite
