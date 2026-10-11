// Daten fuer das Host-<video>: der Service Worker (web/sw.js) fragt ein Stueck
// der Datei an (Range), die Engine laedt es mit curl ueber das Relay und gibt
// Kopf und Daten an die Oberflaeche weiter. Mit Cookies und Referrer der Seite.
#include "config.h"
#include "MediaFetch.h"

#include "Engine.h"
#include "Host.h"
#include "../LoaderStrategy.h"
#include "MediaPlayerPrivateWasm.h"

#include <WebCore/CurlRequest.h>
#include <WebCore/CurlRequestClient.h>
#include <WebCore/CurlResponse.h>
#include <WebCore/HTTPHeaderNames.h>
#include <WebCore/NetworkLoadMetrics.h>
#include <WebCore/ResourceError.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/ResourceResponse.h>
#include <WebCore/SharedBuffer.h>
#include <WebCore/UserAgent.h>
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

class MediaFetch final : public RefCounted<MediaFetch>, public CurlRequestClient {
public:
    static void start(int fetchId, MediaPlayerPrivateWasm& player, double start, double end)
    {
        Ref fetch = adoptRef(*new MediaFetch(fetchId, player.referrer()));
        if (start > 0 || end >= 0)
            fetch->m_range = end >= 0 ? makeString("bytes="_s, static_cast<uint64_t>(start), '-', static_cast<uint64_t>(end)) : makeString("bytes="_s, static_cast<uint64_t>(start), '-');
        fetches().set(fetchId, fetch.ptr());
        fetch->load(player.url());
    }

    void cancel()
    {
        if (auto request = std::exchange(m_request, nullptr)) {
            request->invalidateClient();
            request->cancel();
        }
        fetches().remove(m_id);
    }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    MediaFetch(int id, const String& referrer)
        : m_id(id)
        , m_referrer(referrer)
    {
    }

    void load(const URL& url)
    {
        ResourceRequest request(URL { url });
        request.setHTTPUserAgent(standardUserAgent());
        request.setFirstPartyForCookies(url);
        if (!m_referrer.isEmpty())
            request.setHTTPReferrer(m_referrer);
        // Kein gzip: die Byte-Positionen muessen zur Datei passen
        request.setHTTPHeaderField(HTTPHeaderName::AcceptEncoding, "identity"_s);
        if (!m_range.isEmpty())
            request.setHTTPHeaderField(HTTPHeaderName::Range, m_range);
        addCookieHeader(request);
        m_url = url;
        m_request = CurlRequest::create(request, *this);
        m_request->resume();
    }

    void finish(ASCIILiteral type, const String& json)
    {
        Ref protectedThis { *this };
        sendMediaFetch(m_id, type, json);
        if (auto request = std::exchange(m_request, nullptr))
            request->invalidateClient();
        fetches().remove(m_id);
    }

    void curlDidSendData(CurlRequest&, unsigned long long, unsigned long long) final { }

    void curlDidReceiveResponse(CurlRequest& request, CurlResponse&& curlResponse) final
    {
        Ref protectedThis { *this };
        ResourceResponse response(curlResponse);
        // Weiterleitungen selber folgen (curl macht das hier nicht)
        auto location = response.httpHeaderField(HTTPHeaderName::Location);
        if (response.isRedirection() && !location.isEmpty() && m_redirects++ < 10) {
            URL target { m_url, location };
            if (auto old = std::exchange(m_request, nullptr)) {
                old->invalidateClient();
                old->cancel();
            }
            if (target.protocolIsInHTTPFamily()) {
                load(target);
                return;
            }
            finish("error"_s, "{\"message\":\"Weiterleitung\"}"_s);
            return;
        }
        auto header = [&](HTTPHeaderName name) {
            return jsonEscape(response.httpHeaderField(name));
        };
        sendMediaFetch(m_id, "head"_s, makeString("{\"status\":"_s, response.httpStatusCode(),
            ",\"type\":\""_s, header(HTTPHeaderName::ContentType),
            "\",\"length\":\""_s, header(HTTPHeaderName::ContentLength),
            "\",\"range\":\""_s, header(HTTPHeaderName::ContentRange),
            "\",\"acceptRanges\":\""_s, header(HTTPHeaderName::AcceptRanges), "\"}"_s));
        request.completeDidReceiveResponse();
    }

    void curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&& buffer) final
    {
        sendMediaFetch(m_id, "data"_s, { }, buffer->span());
    }

    void curlDidComplete(CurlRequest&, NetworkLoadMetrics&&) final
    {
        finish("end"_s, { });
    }

    void curlDidFailWithError(CurlRequest&, ResourceError&& error, CertificateInfo&&) final
    {
        finish("error"_s, makeString("{\"message\":\""_s, jsonEscape(error.localizedDescription()), "\"}"_s));
    }

    int m_id;
    String m_referrer;
    String m_range;
    URL m_url;
    int m_redirects { 0 };
    RefPtr<CurlRequest> m_request;
};

void startMediaFetch(int playerId, int fetchId, double start, double end)
{
    auto* player = MediaPlayerPrivateWasm::fromId(playerId);
    if (!player) {
        sendMediaFetch(fetchId, "error"_s, "{\"message\":\"kein Player\"}"_s);
        return;
    }
    MediaFetch::start(fetchId, *player, start, end);
}

void cancelMediaFetch(int fetchId)
{
    if (RefPtr fetch = fetches().get(fetchId))
        fetch->cancel();
}

} // namespace BrowserLite
