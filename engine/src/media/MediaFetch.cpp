// Daten fuer das Host-<video>: der Service Worker (web/sw.js) fragt ein Stueck
// der Datei an (Range), die Engine laedt es und gibt Kopf und Daten an die
// Oberflaeche weiter. HTTP mit curl ueber das Relay, mit Cookies und Referrer
// der Seite; blob: und data: aus dem Speicher (BlobResourceHandle, kann Range).
#include "config.h"
#include "MediaFetch.h"

#include "Engine.h"
#include "Host.h"
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

    // Laden loslassen (und abbrechen), danach kommt kein Rueckruf mehr
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
    static Ref<NetworkMediaFetch> create(int id, double start, double end, const String& referrer)
    {
        return adoptRef(*new NetworkMediaFetch(id, start, end, referrer));
    }

    void ref() const final { MediaFetch::ref(); }
    void deref() const final { MediaFetch::deref(); }

    void load(const URL& url)
    {
        auto request = this->request(url);
        request.setFirstPartyForCookies(url);
        if (!m_referrer.isEmpty())
            request.setHTTPReferrer(m_referrer);
        // Kein gzip: die Byte-Positionen muessen zur Datei passen
        request.setHTTPHeaderField(HTTPHeaderName::AcceptEncoding, "identity"_s);
        m_request = createCurlRequest(WTF::move(request), *this);
        m_request->resume();
    }

private:
    NetworkMediaFetch(int id, double start, double end, const String& referrer)
        : MediaFetch(id, start, end)
        , m_referrer(referrer)
    {
    }

    void detach(bool cancelLoad) final
    {
        if (auto request = std::exchange(m_request, nullptr)) {
            request->invalidateClient();
            if (cancelLoad)
                request->cancel();
        }
    }

    void curlDidSendData(CurlRequest&, unsigned long long, unsigned long long) final { }

    void curlDidReceiveResponse(CurlRequest& request, CurlResponse&& curlResponse) final
    {
        Ref protectedThis { *this };
        storeCookies(request.resourceRequest(), curlResponse);
        ResourceResponse response(curlResponse);
        if (isRedirect(response)) {
            if (auto error = followRedirect(m_request, *this, response, m_redirectCount); !error.isNull())
                fail(error);
            return;
        }
        sendHead(response);
        request.completeDidReceiveResponse();
    }

    void curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&& buffer) final
    {
        sendData(buffer->span());
    }

    void curlDidComplete(CurlRequest&, NetworkLoadMetrics&&) final
    {
        finish("end"_s, { });
    }

    void curlDidFailWithError(CurlRequest&, ResourceError&& error, CertificateInfo&&) final
    {
        fail(error);
    }

    String m_referrer;
    unsigned m_redirectCount { 0 };
    RefPtr<CurlRequest> m_request;
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
        sendMediaFetch(fetchId, "error"_s, "{\"message\":\"kein Player\"}"_s);
        return;
    }
    if (RefPtr blob = player->blob()) {
        Ref fetch = BlobMediaFetch::create(fetchId, start, end);
        fetches().set(fetchId, fetch.ptr());
        fetch->load(*blob, player->url());
        return;
    }
    Ref fetch = NetworkMediaFetch::create(fetchId, start, end, player->referrer());
    fetches().set(fetchId, fetch.ptr());
    fetch->load(player->url());
}

void cancelMediaFetch(int fetchId)
{
    if (RefPtr fetch = fetches().get(fetchId))
        fetch->cancel();
}

} // namespace BrowserLite
