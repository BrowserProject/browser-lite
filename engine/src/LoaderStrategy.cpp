// Netzwerk-Lader fuer single-process WebCore.
//
// In WebKit2 laufen Ladevorgaenge im Network-Prozess (NetworkDataTaskCurl).
// Wir haben keinen eigenen Prozess: jeder WebCore ResourceLoader bekommt hier
// direkt einen CurlRequest. Aufbau angelehnt an NetworkDataTaskCurl (WebKit)
// und BibResourceLoad aus github.com/theogbob/WebkitWasm (BSD-2-Clause,
// Copyright (c) 2026 theogbob).

#include "config.h"
#include "LoaderStrategy.h"
#include "ServiceWorkerWasm.h"

#include "BytecodeCache.h"
#include "Engine.h"
#include "Host.h"
#include "HttpCache.h"
#include "Strategies.h"

#include <WebCore/BlobRegistry.h>
#include <WebCore/BlobRegistryImpl.h>
#include <WebCore/BlobResourceHandle.h>
#include <WebCore/CacheValidation.h>
#include <WebCore/CachedResource.h>
#include <WebCore/ContentSecurityPolicy.h>
#include <WebCore/CrossOriginAccessControl.h>
#include <WebCore/CrossOriginPreflightResultCache.h>
#include <WebCore/CurlRequest.h>
#include <WebCore/CurlRequestClient.h>
#include <WebCore/CurlResponse.h>
#include <WebCore/DataURLDecoder.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/DocumentPage.h>
#include <WebCore/FrameLoader.h>
#include <WebCore/HTTPHeaderNames.h>
#include <WebCore/LoaderStrategy.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/MIMETypeRegistry.h>
#include <WebCore/NetworkLoadMetrics.h>
#include <WebCore/NetworkStateNotifier.h>
#include <WebCore/NetworkStorageSession.h>
#include <WebCore/OriginAccessPatterns.h>
#include <WebCore/Page.h>
#include <WebCore/ResourceError.h>
#include <WebCore/ResourceLoader.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/ResourceResponse.h>
#include <WebCore/SecurityOrigin.h>
#include <WebCore/SharedBuffer.h>
#include <WebCore/SubresourceLoader.h>
#include <WebCore/UserAgent.h>
#include <wtf/Expected.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite {

using namespace WebCore;

static constexpr auto errorDomain = "BrowserLite"_s;

static void addCookieHeader(ResourceRequest& request)
{
    auto& session = networkStorageSession();
    auto includeSecureCookies = request.url().protocolIs("https"_s) ? IncludeSecureCookies::Yes : IncludeSecureCookies::No;
    auto [cookies, secureCookiesAccessed] = session.cookieRequestHeaderFieldValue(request.firstPartyForCookies(), SameSiteInfo::create(request), request.url(), std::nullopt, std::nullopt, includeSecureCookies, ApplyTrackingPrevention::No, ShouldRelaxThirdPartyCookieBlocking::No, IsKnownCrossSiteTracker::No);
    UNUSED_PARAM(secureCookiesAccessed);
    if (!cookies.isEmpty())
        request.setHTTPHeaderField(HTTPHeaderName::Cookie, cookies);
}

// allowCookies ist false bei credentials: 'omit' oder fremden CSP-Reports
Ref<CurlRequest> createCurlRequest(ResourceRequest&& request, CurlRequestClient& client)
{
    if (request.httpUserAgent().isEmpty())
        request.setHTTPUserAgent(standardUserAgent());
    if (request.allowCookies())
        addCookieHeader(request);
    return CurlRequest::create(request, client);
}

void storeCookies(const ResourceRequest& request, const CurlResponse& response)
{
    if (!request.allowCookies())
        return;
    static constexpr auto setCookie = "set-cookie:"_s;
    for (auto& header : response.headers) {
        if (!header.startsWithIgnoringASCIICase(setCookie))
            continue;
        String value = header.substring(setCookie.length()).trim(isASCIIWhitespace<char16_t>);
        networkStorageSession().setCookiesFromHTTPResponse(request.firstPartyForCookies(), response.url, value);
    }
}

bool isRedirect(const ResourceResponse& response)
{
    int status = response.httpStatusCode();
    if (status < 300 || status >= 400 || status == 300 || status == 304 || status == 305 || status == 306)
        return false;
    return !response.httpHeaderField(HTTPHeaderName::Location).isEmpty();
}

static bool redirectAsGET(const ResourceRequest& request, const ResourceResponse& response, bool crossOrigin)
{
    if (request.httpMethod() == "GET"_s || request.httpMethod() == "HEAD"_s)
        return false;
    if (!request.url().protocolIsInHTTPFamily() || response.isSeeOther())
        return true;
    if ((response.isMovedPermanently() || response.isFound()) && request.httpMethod() == "POST"_s)
        return true;
    return crossOrigin && request.httpMethod() == "DELETE"_s;
}

// Naechste Anfrage nach einem Redirect wie in Chrome (Methode, Fragment,
// Zugangsdaten). redirectCount zaehlt diesen Redirect schon mit.
static Expected<ResourceRequest, ResourceError> redirectedRequest(const ResourceRequest& current, const ResourceResponse& response, unsigned redirectCount)
{
    if (redirectCount > 20)
        return makeUnexpected(ResourceError(errorDomain, 0, response.url(), "Too many redirects"_s));

    URL target { response.url(), response.httpHeaderField(HTTPHeaderName::Location) };
    // Eine Webseite darf nie auf lokale Dateien im WASM-Dateisystem umleiten
    if (target.protocolIsFile())
        return makeUnexpected(ResourceError(errorDomain, 0, response.url(), "Redirect to file: blocked"_s));

    ResourceRequest request = current;
    if (!target.hasFragmentIdentifier() && request.url().hasFragmentIdentifier())
        target.setFragmentIdentifier(request.url().fragmentIdentifier());

    bool crossOrigin = !protocolHostAndPortAreEqual(request.url(), target);
    request.setURL(WTF::move(target));
    if (redirectAsGET(request, response, crossOrigin)) {
        request.setHTTPMethod("GET"_s);
        request.setHTTPBody(nullptr);
        request.clearHTTPContentType();
    }
    request.removeCredentials();
    if (crossOrigin) {
        request.clearHTTPAuthorization();
        request.clearHTTPOrigin();
    }
    // Die Cookies fuer das neue Ziel setzt createCurlRequest
    request.removeHTTPHeaderField(HTTPHeaderName::Cookie);
    return request;
}

ResourceError followRedirect(RefPtr<CurlRequest>& curlRequest, CurlRequestClient& client, const ResourceResponse& response, unsigned& redirectCount)
{
    auto next = redirectedRequest(curlRequest->resourceRequest(), response, ++redirectCount);
    if (auto old = std::exchange(curlRequest, nullptr)) {
        old->cancel();
        old->invalidateClient();
    }
    if (!next)
        return next.error();
    if (!next->url().protocolIsInHTTPFamily())
        return ResourceError(errorDomain, 0, response.url(), "Redirect to unsupported URL"_s);
    curlRequest = createCurlRequest(WTF::move(*next), client);
    curlRequest->resume();
    return { };
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
        debugLog("lade %s", m_loader->request().url().string().utf8().data());
        auto& request = m_loader->request();
        // Zuerst im HTTP-Cache nachsehen (HttpCache.cpp), ausser beim Neuladen
        if (HttpCache::canUse(request) && request.cachePolicy() != ResourceRequestCachePolicy::ReloadIgnoringCacheData) {
            HttpCache::lookup(request, [this, protectedThis = Ref { *this }](std::unique_ptr<HttpCache::Entry>&& entry) {
                if (!m_loader)
                    return;
                ResourceRequest request { m_loader->request() };
                if (entry) {
                    auto use = HttpCache::decide(*entry, request);
                    debugLog("Cache %s: %s", use == HttpCache::Use::Fresh ? "frisch" : use == HttpCache::Use::Revalidate ? "nachpruefen" : "nicht nutzbar", request.url().string().utf8().data());
                    switch (use) {
                    case HttpCache::Use::Fresh:
                        serveFromCache(WTF::move(entry), ResourceResponse::Source::DiskCache);
                        return;
                    case HttpCache::Use::Revalidate:
                        HttpCache::addValidationHeaders(request, *entry);
                        m_cachedEntry = WTF::move(entry);
                        break;
                    case HttpCache::Use::None:
                        break;
                    }
                }
                startNetwork(WTF::move(request));
            });
            return;
        }
        startNetwork(ResourceRequest { request });
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

    void startNetwork(ResourceRequest&& request)
    {
        m_curlRequest = createCurlRequest(WTF::move(request), *this);
        m_curlRequest->resume();
    }

    void serveFromCache(std::unique_ptr<HttpCache::Entry>&& entry, ResourceResponse::Source source)
    {
        debugLog("aus dem Cache %s", m_loader->request().url().string().utf8().data());
        m_response = entry->response;
        m_response.setSource(source);
        m_loader->didReceiveResponse(ResourceResponse { m_response }, [this, protectedThis = Ref { *this }, body = WTF::move(entry->body)] {
            if (!m_loader)
                return;
            RefPtr loader = m_loader;
            if (body->size())
                loader->didReceiveBuffer(body.get(), body->size(), DataPayloadBytes);
            if (!m_loader)
                return;
            finish();
            NetworkLoadMetrics metrics;
            metrics.markComplete();
            loader->didFinishLoading(metrics);
        });
    }

    void finish()
    {
        if (auto done = std::exchange(m_done, nullptr))
            done(*this);
    }

    // Der ResourceLoader entscheidet ueber das neue Ziel (CORS, CSP, Service Worker)
    void redirect()
    {
        auto request = redirectedRequest(m_loader->request(), m_response, ++m_redirectCount);
        if (!request) {
            fail(request.error());
            return;
        }

        m_loader->willSendRequest(WTF::move(*request), ResourceResponse { m_response }, [this, protectedThis = Ref { *this }](ResourceRequest&& newRequest) {
            if (auto old = std::exchange(m_curlRequest, nullptr)) {
                old->cancel();
                old->invalidateClient();
            }
            if (newRequest.isNull() || !m_loader) {
                finish();
                return;
            }
            m_curlRequest = createCurlRequest(WTF::move(newRequest), *this);
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
        // Ohne Content-Type raten wie andere Browser: nach der Endung, sonst HTML
        if (m_response.mimeType().isEmpty()) {
            auto type = MIMETypeRegistry::mimeTypeForPath(m_response.url().path());
            m_response.setMimeType(type.isEmpty() || type == "application/octet-stream"_s ? "text/html"_s : WTF::move(type));
        }
        debugLog("Antwort %d %s", m_response.httpStatusCode(), m_response.url().string().utf8().data());
        storeCookies(request.resourceRequest(), curlResponse);

        // Bedingte Anfrage aus dem Cache: 304 heisst, der gespeicherte Inhalt stimmt noch
        if (auto entry = std::exchange(m_cachedEntry, nullptr); entry && m_response.httpStatusCode() == 304) {
            if (auto old = std::exchange(m_curlRequest, nullptr)) {
                old->cancel();
                old->invalidateClient();
            }
            updateResponseHeadersAfterRevalidation(entry->response, m_response);
            entry->responseTime = WallTime::now();
            HttpCache::store(m_loader->request(), entry->response, entry->responseTime, entry->body.get());
            serveFromCache(WTF::move(entry), ResourceResponse::Source::DiskCacheAfterValidation);
            return;
        }

        if (isRedirect(m_response)) {
            redirect();
            return;
        }

        // Cachebar? Dann den Inhalt mitschreiben (HttpCache.cpp)
        m_storing = HttpCache::isStorable(m_loader->request(), m_response);
        m_responseTime = WallTime::now();
        m_cacheBody.reset();

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
        if (m_storing) {
            if (m_cacheBody.size() + size > HttpCache::maximumEntrySize) {
                m_storing = false;
                m_cacheBody.reset();
            } else
                m_cacheBody.append(buffer.get());
        }
        m_loader->didReceiveBuffer(buffer.get(), size, DataPayloadBytes);
    }

    void curlDidComplete(CurlRequest& request, NetworkLoadMetrics&& metrics) final
    {
        Ref protectedThis { *this };
        if (!m_loader || m_curlRequest != &request)
            return;
        RefPtr loader = m_loader;
        debugLog("fertig %s", loader->url().string().utf8().data());
        if (std::exchange(m_storing, false))
            HttpCache::store(loader->request(), m_response, m_responseTime, m_cacheBody.takeBuffer().get());
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
    unsigned m_redirectCount { 0 };
    // HTTP-Cache: Eintrag, der gerade nachgeprueft wird, und was gespeichert wird
    std::unique_ptr<HttpCache::Entry> m_cachedEntry;
    bool m_storing { false };
    WallTime m_responseTime;
    SharedBufferBuilder m_cacheBody;
};

// Fire-and-forget fuer sendBeacon, <a ping> und Reports, die Seite sieht die
// Antwort nicht. Prueft wie NetworkLoadChecker fuer PingLoad in WebKit2: Cookies
// nach credentials, im Modus cors fuer fremde Ziele Origin und Preflight, bei
// Redirects CORS und CSP (connect-src) fuer das neue Ziel. Die erste Anfrage
// hat WebCore schon gegen die CSP geprueft. Reports folgen keinem Redirect.
class PingLoad final : public RefCounted<PingLoad>, public CurlRequestClient {
public:
    static void start(Document& document, const ResourceRequest& request, const HTTPHeaderMap& originalHeaders, const FetchOptions& options, ContentSecurityPolicyImposition policyCheck, LoaderStrategy::PingLoadCompletionHandler&& completion)
    {
        Ref ping = adoptRef(*new PingLoad(document, request, originalHeaders, options, policyCheck, WTF::move(completion)));
        ping->m_self = ping.ptr();
        ping->check(ResourceRequest { request });
    }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    PingLoad(Document& document, const ResourceRequest& request, const HTTPHeaderMap& originalHeaders, const FetchOptions& options, ContentSecurityPolicyImposition policyCheck, LoaderStrategy::PingLoadCompletionHandler&& completion)
        : m_options(options)
        , m_origin(document.securityOrigin())
        , m_topOrigin(document.topOrigin())
        , m_sessionID(document.page() ? document.page()->sessionID() : PAL::SessionID::defaultSessionID())
        , m_originalHeaders(originalHeaders)
        , m_allowCookies(request.allowCookies())
        , m_credentials(options.credentials == FetchOptions::Credentials::Omit ? StoredCredentialsPolicy::DoNotUse : StoredCredentialsPolicy::Use)
        , m_completion(WTF::move(completion))
    {
        // Eine Kopie: das Dokument kann weg sein, bevor der Redirect kommt
        if (auto* policy = document.contentSecurityPolicy(); policy && policyCheck == ContentSecurityPolicyImposition::DoPolicyCheck && !document.shouldBypassMainWorldContentSecurityPolicy()) {
            m_contentSecurityPolicy = makeUnique<ContentSecurityPolicy>(URL { m_origin->toRawString() }, nullptr, nullptr);
            m_contentSecurityPolicy->didReceiveHeaders(policy->responseHeaders(), String { request.httpReferrer() }, ContentSecurityPolicy::ReportParsingErrors::No);
        }
    }

    bool canRequest(const URL& url) const { return m_origin->canRequest(url, OriginAccessPatternsForWebProcess::singleton()); }

    // Fuer Preflight und Preflight-Cache zaehlen die Header der Seite, nicht
    // die von WebCore dazugefuegten
    ResourceRequest withOriginalHeaders(const ResourceRequest& request) const
    {
        ResourceRequest copy { request };
        copy.setHTTPHeaderFields(HTTPHeaderMap { m_originalHeaders });
        return copy;
    }

    // NetworkLoadChecker::continueCheckingRequest und checkCORSRequest
    void check(ResourceRequest&& request)
    {
        bool sameOrigin = canRequest(request.url());
        if (m_options.credentials == FetchOptions::Credentials::SameOrigin)
            m_credentials = m_isSameOriginRequest && sameOrigin ? StoredCredentialsPolicy::Use : StoredCredentialsPolicy::DoNotUse;
        m_isSameOriginRequest = m_isSameOriginRequest && sameOrigin;
        request.setAllowCookies(m_allowCookies && m_credentials == StoredCredentialsPolicy::Use);
        if (m_options.mode != FetchOptions::Mode::Cors || m_isSameOriginRequest)
            return send(WTF::move(request));
        updateRequestForAccessControl(request, m_origin.get(), m_credentials);
        if (isSimpleCrossOriginAccessRequest(request.httpMethod(), m_originalHeaders)
            || CrossOriginPreflightResultCache::singleton().canSkipPreflight(m_sessionID, { m_topOrigin->data(), m_origin->data() }, request.url(), m_credentials, request.httpMethod(), m_originalHeaders))
            return send(WTF::move(request));
        auto preflight = createAccessControlPreflightRequest(withOriginalHeaders(request), m_origin.get(), request.httpReferrer(), true);
        m_afterPreflight = WTF::move(request);
        send(WTF::move(preflight));
    }

    // NetworkLoadChecker::checkRedirection
    void redirect()
    {
        if (m_options.redirect != FetchOptions::Redirect::Follow)
            return fail("Not allowed to follow redirects"_s);
        if (m_options.mode == FetchOptions::Mode::Cors && !m_isSameOriginRequest) {
            if (auto result = passesAccessControlCheck(m_response, m_credentials, m_origin.get(), &CrossOriginAccessControlCheckDisabler::singleton()); !result)
                return fail(makeString("Cross-origin redirection denied by Cross-Origin Resource Sharing policy: "_s, result.error()));
            if (URL { m_response.url(), m_response.httpHeaderField(HTTPHeaderName::Location) }.hasCredentials())
                return fail("Cross-origin redirection to a URL with credentials"_s);
        }
        URL previousURL = m_request->resourceRequest().url();
        String previousMethod = m_request->resourceRequest().httpMethod();
        auto next = redirectedRequest(m_request->resourceRequest(), m_response, ++m_redirectCount);
        if (!next)
            return done(next.error());
        if (!next->url().protocolIsInHTTPFamily())
            return fail("Redirect to unsupported URL"_s);
        if (m_contentSecurityPolicy) {
            m_contentSecurityPolicy->upgradeInsecureRequestIfNeeded(*next, ContentSecurityPolicy::InsecureRequestType::Load);
            if (!m_contentSecurityPolicy->allowConnectToSource(next->url(), { }, ContentSecurityPolicy::RedirectResponseReceived::Yes))
                return fail("Blocked by Content Security Policy"_s);
        }
        if (next->httpMethod() != previousMethod)
            m_originalHeaders.removeRequestBodyHeaders();
        // Fetch, HTTP-redirect fetch Schritt 10: weiter mit undurchsichtigem Ursprung
        if (m_options.mode == FetchOptions::Mode::Cors && !canRequest(previousURL) && !protocolHostAndPortAreEqual(previousURL, next->url()))
            m_origin = SecurityOrigin::createOpaque();
        check(WTF::move(*next));
    }

    void send(ResourceRequest&& request)
    {
        stop();
        m_request = createCurlRequest(WTF::move(request), *this);
        m_request->resume();
    }

    void stop()
    {
        if (auto request = std::exchange(m_request, nullptr)) {
            request->cancel();
            request->invalidateClient();
        }
    }

    void fail(String&& message)
    {
        done(ResourceError(errorDomain, 0, m_response.url(), WTF::move(message), ResourceError::Type::AccessControl));
    }

    void done(const ResourceError& error)
    {
        if (auto completion = std::exchange(m_completion, nullptr))
            completion(error, m_response);
        stop();
        m_self = nullptr; // gibt uns frei
    }

    void curlDidSendData(CurlRequest&, unsigned long long, unsigned long long) final { }
    void curlDidReceiveResponse(CurlRequest& request, CurlResponse&& response) final
    {
        Ref protectedThis { *this };
        storeCookies(request.resourceRequest(), response);
        m_response = ResourceResponse(response);
        if (auto pending = std::exchange(m_afterPreflight, std::nullopt)) {
            if (auto result = validatePreflightResponse(m_sessionID, withOriginalHeaders(*pending), m_response, m_credentials, m_topOrigin.get(), m_origin.get(), &CrossOriginAccessControlCheckDisabler::singleton()); !result)
                return fail(WTF::move(result.error()));
            return send(WTF::move(*pending));
        }
        if (isRedirect(m_response))
            return redirect();
        request.completeDidReceiveResponse();
    }
    void curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&&) final { }
    void curlDidComplete(CurlRequest&, NetworkLoadMetrics&&) final
    {
        Ref protectedThis { *this };
        done({ });
    }
    void curlDidFailWithError(CurlRequest&, ResourceError&& error, CertificateInfo&&) final
    {
        Ref protectedThis { *this };
        done(error);
    }

    FetchOptions m_options;
    Ref<SecurityOrigin> m_origin;
    Ref<SecurityOrigin> m_topOrigin;
    PAL::SessionID m_sessionID;
    HTTPHeaderMap m_originalHeaders;
    std::unique_ptr<ContentSecurityPolicy> m_contentSecurityPolicy;
    bool m_allowCookies;
    bool m_isSameOriginRequest { true };
    StoredCredentialsPolicy m_credentials;
    LoaderStrategy::PingLoadCompletionHandler m_completion;
    RefPtr<CurlRequest> m_request;
    std::optional<ResourceRequest> m_afterPreflight;
    RefPtr<PingLoad> m_self;
    ResourceResponse m_response;
    unsigned m_redirectCount { 0 };
};

// Download: eigener CurlRequest, die Daten gehen stueckweise an die Oberflaeche,
// die daraus eine Datei (Blob) macht. data: und blob: hat die Engine schon
// selber, die gehen ohne Netz.
class Download final : public RefCounted<Download>, public CurlRequestClient {
public:
    static void start(int viewId, ResourceRequest&& request, const String& suggestedFilename, bool viewSource = false)
    {
        static int nextID = 1;
        Ref download = adoptRef(*new Download(nextID++, viewId, suggestedFilename, viewSource));
        if (request.url().protocolIsData() || request.url().protocolIsBlob()) {
            download->loadLocally(request.url());
            return;
        }
        download->m_self = download.ptr();
        download->m_request = createCurlRequest(WTF::move(request), download.get());
        download->m_request->resume();
    }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    Download(int id, int viewId, const String& suggestedFilename, bool viewSource)
        : m_id(id)
        , m_viewId(viewId)
        , m_filename(suggestedFilename)
        , m_viewSource(viewSource)
    {
    }

    void loadLocally(const URL& url)
    {
        ResourceResponse response;
        ResourceError error;
        Vector<uint8_t> data;
        if (url.protocolIsData()) {
            if (auto result = DataURLDecoder::decode(url)) {
                response = ResourceResponse { URL { url }, WTF::move(result->mimeType), static_cast<long long>(result->data.size()), WTF::move(result->charset) };
                data = WTF::move(result->data);
            } else
                error = ResourceError(errorDomain, 0, url, "Invalid data: URL"_s);
        } else {
            RefPtr blob = blobRegistry()->blobRegistryImpl()->blobDataFromURL(url);
            BlobResourceHandle::loadResourceSynchronously(blob.get(), ResourceRequest { URL { url } }, error, response, data);
        }
        if (response.url().isEmpty())
            response.setURL(URL { url });
        announce(response);
        if (!error.isNull()) {
            finish(errorText(error));
            return;
        }
        sendDownloadData(m_id, data.span());
        finish({ });
    }

    // download-start: Name wie in Chrome aus download=, Content-Disposition
    // oder der Adresse. Eine data:-Adresse hat keinen Namen und ist oft riesig.
    void announce(const ResourceResponse& response)
    {
        bool isData = response.url().protocolIsData();
        String filename = m_filename;
        if (filename.isEmpty())
            filename = response.suggestedFilename();
        if (filename.isEmpty() && !isData)
            filename = response.url().lastPathComponent().toString();
        if (filename.isEmpty())
            filename = "download"_s;
        notifyHost(m_viewId, "download-start", makeString("{\"id\":"_s, m_id, ",\"url\":\""_s, isData ? String { "data:"_s } : jsonEscape(response.url().string()),
            "\",\"filename\":\""_s, jsonEscape(filename), "\",\"mime\":\""_s, jsonEscape(response.mimeType()),
            "\",\"size\":"_s, response.expectedContentLength(), m_viewSource ? ",\"viewSource\":true}"_s : "}"_s));
    }

    static String errorText(const ResourceError& error)
    {
        return error.localizedDescription().isEmpty() ? "Fehler"_s : error.localizedDescription();
    }

    void finish(const String& error)
    {
        notifyHost(m_viewId, "download-done", makeString("{\"id\":"_s, m_id, ",\"error\":\""_s, jsonEscape(error), "\"}"_s));
        if (auto request = std::exchange(m_request, nullptr)) {
            request->cancel();
            request->invalidateClient();
        }
        m_self = nullptr; // gibt uns frei
    }

    void curlDidSendData(CurlRequest&, unsigned long long, unsigned long long) final { }
    void curlDidReceiveResponse(CurlRequest& request, CurlResponse&& curlResponse) final
    {
        Ref protectedThis { *this };
        storeCookies(request.resourceRequest(), curlResponse);
        ResourceResponse response(curlResponse);
        if (isRedirect(response)) {
            if (auto error = followRedirect(m_request, *this, response, m_redirectCount); !error.isNull()) {
                announce(response);
                finish(errorText(error));
            }
            return;
        }
        announce(response);
        // Wie Chrome: eine Fehlerseite ist keine Datei (Quelltext zeigt sie aber)
        if (!m_viewSource && response.httpStatusCode() >= 400) {
            finish(makeString("HTTP "_s, response.httpStatusCode()));
            return;
        }
        request.completeDidReceiveResponse();
    }
    void curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&& buffer) final
    {
        sendDownloadData(m_id, buffer->span());
    }
    void curlDidComplete(CurlRequest&, NetworkLoadMetrics&&) final
    {
        Ref protectedThis { *this };
        finish({ });
    }
    void curlDidFailWithError(CurlRequest&, ResourceError&& error, CertificateInfo&&) final
    {
        Ref protectedThis { *this };
        finish(errorText(error));
    }

    int m_id;
    int m_viewId;
    String m_filename;
    // Quelltext anzeigen: die Oberflaeche zeigt die Daten als Text statt zu speichern
    bool m_viewSource { false };
    unsigned m_redirectCount { 0 };
    RefPtr<CurlRequest> m_request;
    RefPtr<Download> m_self;
};

void startDownload(int viewId, const ResourceRequest& request, const String& suggestedFilename)
{
    auto copy = request;
    Download::start(viewId, WTF::move(copy), suggestedFilename);
}

void startViewSource(int viewId, const URL& url)
{
    ResourceRequest request { URL { url } };
    request.setFirstPartyForCookies(url);
    Download::start(viewId, WTF::move(request), { }, true);
}

// Favicon fuer den Tab: klein, ganz im Speicher, geht als Ganzes an die Oberflaeche
class IconLoad final : public RefCounted<IconLoad>, public CurlRequestClient {
public:
    static void start(int viewId, const URL& url)
    {
        ResourceRequest request(URL { url });
        request.setHTTPHeaderField(HTTPHeaderName::Accept, "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5"_s);
        request.setFirstPartyForCookies(url);
        Ref load = adoptRef(*new IconLoad(viewId, url));
        load->m_self = load.ptr();
        load->m_request = createCurlRequest(WTF::move(request), load.get());
        load->m_request->resume();
    }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    static constexpr size_t maxSize = 512 * 1024;

    IconLoad(int viewId, const URL& url)
        : m_viewId(viewId)
        , m_url(url)
    {
    }

    void done(bool success)
    {
        // Auch ohne Icon melden, damit die Oberflaeche das alte Icon entfernt
        if (!success)
            m_data.clear();
        sendIconData(m_viewId, m_url.string(), m_mimeType, m_data.span());
        if (auto request = std::exchange(m_request, nullptr)) {
            request->cancel();
            request->invalidateClient();
        }
        m_self = nullptr; // gibt uns frei
    }

    void curlDidSendData(CurlRequest&, unsigned long long, unsigned long long) final { }
    void curlDidReceiveResponse(CurlRequest& request, CurlResponse&& curlResponse) final
    {
        Ref protectedThis { *this };
        storeCookies(request.resourceRequest(), curlResponse);
        ResourceResponse response(curlResponse);
        // /favicon.ico liegt oft hinter einem Redirect (http -> https, www, CDN)
        if (isRedirect(response)) {
            if (!followRedirect(m_request, *this, response, m_redirectCount).isNull())
                done(false);
            return;
        }
        m_ok = response.httpStatusCode() >= 200 && response.httpStatusCode() < 300;
        m_mimeType = response.mimeType();
        request.completeDidReceiveResponse();
    }
    void curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&& buffer) final
    {
        if (m_data.size() + buffer->size() > maxSize) {
            m_ok = false;
            return;
        }
        m_data.append(buffer->span());
    }
    void curlDidComplete(CurlRequest&, NetworkLoadMetrics&&) final
    {
        Ref protectedThis { *this };
        done(m_ok);
    }
    void curlDidFailWithError(CurlRequest&, ResourceError&&, CertificateInfo&&) final
    {
        Ref protectedThis { *this };
        done(false);
    }

    int m_viewId;
    URL m_url;
    String m_mimeType;
    bool m_ok { false };
    unsigned m_redirectCount { 0 };
    Vector<uint8_t> m_data;
    RefPtr<CurlRequest> m_request;
    RefPtr<IconLoad> m_self;
};

void loadIcon(int viewId, const URL& url)
{
    IconLoad::start(viewId, url);
}

class WasmLoaderStrategy final : public LoaderStrategy {
private:
    void schedule(ResourceLoader& loader)
    {
        // data: und blob: kann WebCore selber (ResourceLoader::start)
        if (loader.request().url().protocolIsData() || loader.request().url().protocolIsBlob()) {
            loader.start();
            return;
        }
        // Zuerst ein zustaendiger Service Worker; der kann es ans Netz zurueckgeben
        if (ServiceWorkers::startFetch(loader, [this, loader = Ref { loader }] { startNetworkLoad(loader); }))
            return;
        startNetworkLoad(loader);
    }

    void startNetworkLoad(ResourceLoader& loader)
    {
        auto load = ResourceLoad::create(loader, [this](ResourceLoad& load) {
            if (auto* loader = load.loader())
                m_loads.remove(loader);
        });
        m_loads.set(&loader, load.copyRef());
        load->start();
    }

    void loadResource(LocalFrame& frame, CachedResource& resource, ResourceRequest&& request, const ResourceLoaderOptions& options, CompletionHandler<void(RefPtr<SubresourceLoader>&&)>&& completion) final
    {
        // Gespeicherten Bytecode holen, waehrend das Skript laedt
        if (resource.type() == CachedResource::Type::Script)
            BytecodeCache::prefetch(request.url());
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
        if (loader)
            ServiceWorkers::cancelFetch(*loader);
        if (auto load = m_loads.take(loader))
            load->cancel();
    }

    void setDefersLoading(ResourceLoader&, bool) final { }
    void crossOriginRedirectReceived(ResourceLoader*, const URL&) final { }
    void servePendingRequests(ResourceLoadPriority) final { }
    void suspendPendingRequests() final { }
    void resumePendingRequests() final { }

    void startPingLoad(LocalFrame& frame, ResourceRequest& request, const HTTPHeaderMap& originalRequestHeaders, const FetchOptions& options, ContentSecurityPolicyImposition policyCheck, PingLoadCompletionHandler&& completion) final
    {
        RefPtr document = frame.document();
        if (!document) {
            if (completion)
                completion(cancelledError(request), { });
            return;
        }
        PingLoad::start(*document, request, originalRequestHeaders, options, policyCheck, WTF::move(completion));
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
        RefPtr loader = resource.loader();
        callback(!loader || (!m_loads.contains(loader.get()) && !ServiceWorkers::isFetching(*loader)));
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
