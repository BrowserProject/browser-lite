// Netzwerk-Lader fuer single-process WebCore.
//
// In WebKit2 laufen Ladevorgaenge im Network-Prozess (NetworkDataTaskCurl).
// Wir haben keinen eigenen Prozess: jeder WebCore ResourceLoader bekommt hier
// direkt einen CurlRequest. Aufbau angelehnt an NetworkDataTaskCurl (WebKit)
// und BibResourceLoad aus github.com/theogbob/WebkitWasm (BSD-2-Clause,
// Copyright (c) 2026 theogbob).

#include "config.h"
#include "LoaderStrategy.h"

#include "Engine.h"
#include "Strategies.h"

#include <WebCore/CachedResource.h>
#include <WebCore/CurlRequest.h>
#include <WebCore/CurlRequestClient.h>
#include <WebCore/CurlResponse.h>
#include <WebCore/FrameLoader.h>
#include <WebCore/HTTPHeaderNames.h>
#include <WebCore/LoaderStrategy.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/NetworkLoadMetrics.h>
#include <WebCore/NetworkStateNotifier.h>
#include <WebCore/NetworkStorageSession.h>
#include <WebCore/ResourceError.h>
#include <WebCore/ResourceLoader.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/ResourceResponse.h>
#include <WebCore/SharedBuffer.h>
#include <WebCore/SubresourceLoader.h>
#include <WebCore/UserAgent.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>

namespace BrowserLite {

using namespace WebCore;

static constexpr auto errorDomain = "BrowserLite"_s;

static void addCookieHeader(ResourceRequest& request)
{
    auto& session = networkStorageSession();
    auto includeSecureCookies = request.url().protocolIs("https"_s) ? IncludeSecureCookies::Yes : IncludeSecureCookies::No;
    auto [cookies, secureCookiesAccessed] = session.cookieRequestHeaderFieldValue(request.firstPartyForCookies(), SameSiteInfo::create(request), request.url(), std::nullopt, std::nullopt, includeSecureCookies, ApplyTrackingPrevention::No, ShouldRelaxThirdPartyCookieBlocking::No);
    UNUSED_PARAM(secureCookiesAccessed);
    if (!cookies.isEmpty())
        request.setHTTPHeaderField(HTTPHeaderName::Cookie, cookies);
}

// Ein Ladevorgang: ein ResourceLoader, ein CurlRequest (bei Redirects nacheinander mehrere)
class ResourceLoad final : public RefCounted<ResourceLoad>, public CurlRequestClient {
public:
    static Ref<ResourceLoad> create(ResourceLoader& loader, Function<void(ResourceLoad&)>&& done)
    {
        return adoptRef(*new ResourceLoad(loader, WTF::move(done)));
    }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    ResourceLoader* loader() const { return m_loader.get(); }

    void start()
    {
        m_curlRequest = createCurlRequest(ResourceRequest { m_loader->request() });
        m_curlRequest->resume();
    }

    void cancel()
    {
        m_loader = nullptr;
        if (auto request = std::exchange(m_curlRequest, nullptr)) {
            request->cancel();
            request->invalidateClient();
        }
    }

private:
    ResourceLoad(ResourceLoader& loader, Function<void(ResourceLoad&)>&& done)
        : m_loader(&loader)
        , m_done(WTF::move(done))
    {
    }

    Ref<CurlRequest> createCurlRequest(ResourceRequest&& request)
    {
        if (request.httpUserAgent().isEmpty())
            request.setHTTPUserAgent(standardUserAgent());
        addCookieHeader(request);
        return CurlRequest::create(request, *this);
    }

    void storeCookies(const ResourceRequest& request, const CurlResponse& response)
    {
        static constexpr auto setCookie = "set-cookie:"_s;
        for (auto& header : response.headers) {
            if (!header.startsWithIgnoringASCIICase(setCookie))
                continue;
            String value = header.substring(setCookie.length()).trim(isASCIIWhitespace<char16_t>);
            networkStorageSession().setCookiesFromHTTPResponse(request.firstPartyForCookies(), response.url, value);
        }
    }

    void finish()
    {
        if (auto done = std::exchange(m_done, nullptr))
            done(*this);
    }

    bool isRedirect() const
    {
        int status = m_response.httpStatusCode();
        if (status < 300 || status >= 400 || status == 300 || status == 304 || status == 305 || status == 306)
            return false;
        return !m_response.httpHeaderField(HTTPHeaderName::Location).isEmpty();
    }

    bool redirectAsGET(const ResourceRequest& request, bool crossOrigin) const
    {
        if (request.httpMethod() == "GET"_s || request.httpMethod() == "HEAD"_s)
            return false;
        if (!request.url().protocolIsInHTTPFamily() || m_response.isSeeOther())
            return true;
        if ((m_response.isMovedPermanently() || m_response.isFound()) && request.httpMethod() == "POST"_s)
            return true;
        return crossOrigin && request.httpMethod() == "DELETE"_s;
    }

    void redirect()
    {
        if (++m_redirectCount > 20) {
            fail(ResourceError(errorDomain, 0, m_response.url(), "Too many redirects"_s));
            return;
        }

        URL target { m_response.url(), m_response.httpHeaderField(HTTPHeaderName::Location) };
        // Eine Webseite darf nie auf lokale Dateien im WASM-Dateisystem umleiten
        if (target.protocolIsFile()) {
            fail(ResourceError(errorDomain, 0, m_response.url(), "Redirect to file: blocked"_s));
            return;
        }

        ResourceRequest request = m_loader->request();
        if (!target.hasFragmentIdentifier() && request.url().hasFragmentIdentifier())
            target.setFragmentIdentifier(request.url().fragmentIdentifier());

        bool crossOrigin = !protocolHostAndPortAreEqual(request.url(), target);
        request.setURL(WTF::move(target));
        if (redirectAsGET(request, crossOrigin)) {
            request.setHTTPMethod("GET"_s);
            request.setHTTPBody(nullptr);
            request.clearHTTPContentType();
        }
        request.removeCredentials();
        if (crossOrigin) {
            request.clearHTTPAuthorization();
            request.clearHTTPOrigin();
        }

        m_loader->willSendRequest(WTF::move(request), ResourceResponse { m_response }, [this, protectedThis = Ref { *this }](ResourceRequest&& newRequest) {
            if (auto old = std::exchange(m_curlRequest, nullptr)) {
                old->cancel();
                old->invalidateClient();
            }
            if (newRequest.isNull() || !m_loader) {
                finish();
                return;
            }
            m_curlRequest = createCurlRequest(WTF::move(newRequest));
            m_curlRequest->resume();
        });
    }

    void fail(const ResourceError& error)
    {
        RefPtr loader = m_loader;
        finish();
        if (loader)
            loader->didFail(error);
    }

    // CurlRequestClient (Aufrufe kommen auf dem Engine-Thread an)
    void curlDidSendData(CurlRequest&, unsigned long long sent, unsigned long long total) final
    {
        Ref protectedThis { *this };
        if (m_loader)
            m_loader->didSendData(sent, total);
    }

    void curlDidReceiveResponse(CurlRequest& request, CurlResponse&& curlResponse) final
    {
        Ref protectedThis { *this };
        if (!m_loader || m_curlRequest != &request)
            return;

        m_response = ResourceResponse(curlResponse);
        storeCookies(request.resourceRequest(), curlResponse);

        if (isRedirect()) {
            redirect();
            return;
        }

        m_loader->didReceiveResponse(ResourceResponse { m_response }, [this, protectedThis = Ref { *this }] {
            if (m_curlRequest && m_loader)
                m_curlRequest->completeDidReceiveResponse();
        });
    }

    void curlDidReceiveData(CurlRequest& request, Ref<SharedBuffer>&& buffer) final
    {
        Ref protectedThis { *this };
        if (!m_loader || m_curlRequest != &request)
            return;
        auto size = buffer->size();
        m_loader->didReceiveBuffer(buffer.get(), size, DataPayloadBytes);
    }

    void curlDidComplete(CurlRequest& request, NetworkLoadMetrics&& metrics) final
    {
        Ref protectedThis { *this };
        if (!m_loader || m_curlRequest != &request)
            return;
        RefPtr loader = m_loader;
        finish();
        loader->didFinishLoading(metrics);
    }

    void curlDidFailWithError(CurlRequest& request, ResourceError&& error, CertificateInfo&&) final
    {
        Ref protectedThis { *this };
        log("Laden fehlgeschlagen (%d): %s %s", error.errorCode(), error.failingURL().string().utf8().data(), error.localizedDescription().utf8().data());
        if (!m_loader || m_curlRequest != &request)
            return;
        fail(error);
    }

    RefPtr<ResourceLoader> m_loader;
    RefPtr<CurlRequest> m_curlRequest;
    Function<void(ResourceLoad&)> m_done;
    ResourceResponse m_response;
    int m_redirectCount { 0 };
};

// Fire-and-forget fuer sendBeacon, <a ping>, CSP-Reports
class PingLoad final : public RefCounted<PingLoad>, public CurlRequestClient {
public:
    static void start(ResourceRequest&& request, LoaderStrategy::PingLoadCompletionHandler&& completion)
    {
        if (request.httpUserAgent().isEmpty())
            request.setHTTPUserAgent(standardUserAgent());
        Ref ping = adoptRef(*new PingLoad(WTF::move(completion)));
        ping->m_self = ping.ptr();
        ping->m_request = CurlRequest::create(request, ping.get());
        ping->m_request->resume();
    }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    explicit PingLoad(LoaderStrategy::PingLoadCompletionHandler&& completion)
        : m_completion(WTF::move(completion))
    {
    }

    void done(const ResourceError& error, const ResourceResponse& response)
    {
        if (auto completion = std::exchange(m_completion, nullptr))
            completion(error, response);
        if (auto request = std::exchange(m_request, nullptr))
            request->invalidateClient();
        m_self = nullptr; // gibt uns frei
    }

    void curlDidSendData(CurlRequest&, unsigned long long, unsigned long long) final { }
    void curlDidReceiveResponse(CurlRequest& request, CurlResponse&& response) final
    {
        Ref protectedThis { *this };
        m_response = ResourceResponse(response);
        request.completeDidReceiveResponse();
    }
    void curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&&) final { }
    void curlDidComplete(CurlRequest&, NetworkLoadMetrics&&) final
    {
        Ref protectedThis { *this };
        done({ }, m_response);
    }
    void curlDidFailWithError(CurlRequest&, ResourceError&& error, CertificateInfo&&) final
    {
        Ref protectedThis { *this };
        done(error, m_response);
    }

    LoaderStrategy::PingLoadCompletionHandler m_completion;
    RefPtr<CurlRequest> m_request;
    RefPtr<PingLoad> m_self;
    ResourceResponse m_response;
};

class WasmLoaderStrategy final : public LoaderStrategy {
private:
    void schedule(ResourceLoader& loader)
    {
        // data: und blob: kann WebCore selber (ResourceLoader::start)
        if (loader.request().url().protocolIsData() || loader.request().url().protocolIsBlob()) {
            loader.start();
            return;
        }
        auto load = ResourceLoad::create(loader, [this](ResourceLoad& load) {
            if (auto* loader = load.loader())
                m_loads.remove(loader);
        });
        m_loads.set(&loader, load.copyRef());
        load->start();
    }

    void loadResource(LocalFrame& frame, CachedResource& resource, ResourceRequest&& request, const ResourceLoaderOptions& options, CompletionHandler<void(RefPtr<SubresourceLoader>&&)>&& completion) final
    {
        SubresourceLoader::create(frame, resource, WTF::move(request), options, [this, completion = WTF::move(completion)](RefPtr<SubresourceLoader>&& loader) mutable {
            if (loader)
                schedule(*loader);
            completion(WTF::move(loader));
        });
    }

    void loadResourceSynchronously(FrameLoader&, ResourceLoaderIdentifier, const ResourceRequest& request, ClientCredentialPolicy, const FetchOptions&, const HTTPHeaderMap&, ResourceError& error, ResourceResponse&, Vector<uint8_t>&) final
    {
        // Synchrones XHR wuerde den einzigen Engine-Thread blockieren, waehrend
        // die Antwort genau auf diesem Thread verarbeitet werden muesste.
        error = ResourceError(errorDomain, 0, request.url(), "Synchronous loads are not supported"_s);
    }

    void pageLoadCompleted(Page&) final { }
    void browsingContextRemoved(LocalFrame&) final { }

    void remove(ResourceLoader* loader) final
    {
        if (auto load = m_loads.take(loader))
            load->cancel();
    }

    void setDefersLoading(ResourceLoader&, bool) final { }
    void crossOriginRedirectReceived(ResourceLoader*, const URL&) final { }
    void servePendingRequests(ResourceLoadPriority) final { }
    void suspendPendingRequests() final { }
    void resumePendingRequests() final { }

    void startPingLoad(LocalFrame&, ResourceRequest& request, const HTTPHeaderMap&, const FetchOptions&, ContentSecurityPolicyImposition, PingLoadCompletionHandler&& completion) final
    {
        PingLoad::start(ResourceRequest { request }, WTF::move(completion));
    }

    void preconnectTo(FrameLoader&, ResourceRequest&&, StoredCredentialsPolicy, ShouldPreconnectAsFirstParty, PreconnectCompletionHandler&& completion) final
    {
        // curl hat seinen eigenen Verbindungs-Pool, vorab verbinden lohnt sich nicht
        if (completion)
            completion({ });
    }

    void setCaptureExtraNetworkLoadMetricsEnabled(bool) final { }

    bool isOnLine() const final { return NetworkStateNotifier::singleton().onLine(); }
    void addOnlineStateChangeListener(Function<void(bool)>&& listener) final
    {
        NetworkStateNotifier::singleton().addListener(WTF::move(listener));
    }

    void isResourceLoadFinished(CachedResource& resource, CompletionHandler<void(bool)>&& callback) final
    {
        callback(!resource.loader() || !m_loads.contains(resource.loader()));
    }

    ResourceError makeError(const URL& url, ASCIILiteral message, ResourceError::Type type = ResourceError::Type::General) const
    {
        return ResourceError(errorDomain, 0, url, String { message }, type);
    }

    ResourceError cancelledError(const ResourceRequest& r) const final { return makeError(r.url(), "Load cancelled"_s, ResourceError::Type::Cancellation); }
    ResourceError blockedError(const ResourceRequest& r) const final { return makeError(r.url(), "Load blocked"_s, ResourceError::Type::AccessControl); }
    bool isBlockedError(const ResourceError& e) const final { return e.domain() == errorDomain && e.localizedDescription() == "Load blocked"_s; }
    ResourceError blockedByContentBlockerError(const ResourceRequest& r) const final { return makeError(r.url(), "Blocked by content blocker"_s, ResourceError::Type::AccessControl); }
    ResourceError cannotShowURLError(const ResourceRequest& r) const final { return makeError(r.url(), "Cannot show URL"_s, ResourceError::Type::AccessControl); }
    ResourceError interruptedForPolicyChangeError(const ResourceRequest& r) const final { return makeError(r.url(), "Interrupted for policy change"_s); }
    ResourceError blockedByContentFilterError(const ResourceRequest& r) const final { return makeError(r.url(), "Blocked by content filter"_s, ResourceError::Type::AccessControl); }
    ResourceError cannotShowMIMETypeError(const ResourceResponse& r) const final { return makeError(r.url(), "Cannot show MIME type"_s); }
    ResourceError fileDoesNotExistError(const ResourceResponse& r) const final { return makeError(r.url(), "File does not exist"_s); }
    ResourceError httpsUpgradeRedirectLoopError(const ResourceRequest& r) const final { return makeError(r.url(), "HTTPS upgrade redirect loop"_s); }
    ResourceError httpNavigationWithHTTPSOnlyError(const ResourceRequest& r) const final { return makeError(r.url(), "HTTP navigation with HTTPS-only"_s); }
    bool isHttpNavigationWithHTTPSOnlyError(const ResourceError& e) const final { return e.domain() == errorDomain && e.localizedDescription() == "HTTP navigation with HTTPS-only"_s; }
    ResourceError pluginWillHandleLoadError(const ResourceResponse& r) const final { return makeError(r.url(), "Plugin will handle load"_s); }

    HashMap<ResourceLoader*, Ref<ResourceLoad>> m_loads;
};

LoaderStrategy& loaderStrategy()
{
    static NeverDestroyed<WasmLoaderStrategy> strategy;
    return strategy.get();
}

} // namespace BrowserLite
