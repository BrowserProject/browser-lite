// Synchronous loads (see SyncLoad.h). WebKit2 sends them to the network process
// and blocks the web process until the answer. Here curl's answers arrive as
// tasks of the engine thread, so the waiting script runs a nested event loop
// like a dialog: WebCore defers the page group (timers, tasks, parser, loads),
// its views drop input and paint nothing, all other views go on.

#include "config.h"
#include "SyncLoad.h"

#include "Clients.h"
#include "Engine.h"
#include "HttpCache.h"
#include "LoaderStrategy.h"
#include "WebView.h"
// Not among WebCore's forwarding headers
#include "PageGroupLoadDeferrer.h"

#include <WebCore/CurlRequest.h>
#include <WebCore/CurlRequestClient.h>
#include <WebCore/CurlResponse.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/FetchOptions.h>
#include <WebCore/DocumentPage.h>
#include <WebCore/FrameLoader.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/NetworkLoadMetrics.h>
#include <WebCore/OriginAccessPatterns.h>
#include <WebCore/Page.h>
#include <WebCore/ResourceError.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/ResourceResponse.h>
#include <WebCore/SecurityOrigin.h>
#include <WebCore/SharedBuffer.h>
#include <wtf/FileSystem.h>

namespace BrowserLite {

using namespace WebCore;

namespace {

// One synchronous load: the HTTP cache, then curl (one request after the other with redirects)
class SyncLoad final : public RefCounted<SyncLoad>, public CurlRequestClient {
public:
    static Ref<SyncLoad> create(ResourceRequest&& request, FetchOptions::Credentials credentials, Ref<SecurityOrigin>&& origin, String&& partition)
    {
        return adoptRef(*new SyncLoad(WTF::move(request), credentials, WTF::move(origin), WTF::move(partition)));
    }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    bool isDone() const { return m_done; }

    void start()
    {
        HttpCache::lookupForLoad(m_partition, ResourceRequest { m_request }, false, [this, protectedThis = Ref { *this }](HttpCache::Lookup&& lookup) {
            if (m_done)
                return;
            if (lookup.fresh)
                return finishFromCache(*lookup.entry, ResourceResponse::Source::DiskCache);
            m_cachedEntry = WTF::move(lookup.entry);
            send(WTF::move(lookup.request));
        });
    }

    void cancel()
    {
        if (!m_done)
            fail(ResourceError(loadErrorDomain, 0, m_request.url(), "Cancelled"_s, ResourceError::Type::Cancellation));
    }

    // Only after isDone()
    void takeResult(ResourceError& error, ResourceResponse& response, Vector<uint8_t>& data)
    {
        error = WTF::move(m_error);
        // A load that failed after its response (a connection closed mid body) failed as a whole
        if (error.isNull()) {
            response = WTF::move(m_response);
            data = WTF::move(m_data);
        }
    }

private:
    SyncLoad(ResourceRequest&& request, FetchOptions::Credentials credentials, Ref<SecurityOrigin>&& origin, String&& partition)
        : m_request(WTF::move(request))
        , m_credentials(credentials)
        , m_origin(WTF::move(origin))
        , m_partition(WTF::move(partition))
    {
    }

    void send(ResourceRequest&& request)
    {
        stopRequest();
        m_curlRequest = createCurlRequest(WTF::move(request), *this);
        m_curlRequest->resume();
    }

    void stopRequest()
    {
        if (auto request = std::exchange(m_curlRequest, nullptr)) {
            request->cancel();
            request->invalidateClient();
        }
    }

    void finish()
    {
        stopRequest();
        m_cachedEntry = nullptr;
        m_done = true;
    }

    void fail(ResourceError&& error)
    {
        m_error = WTF::move(error);
        finish();
    }

    void finishFromCache(HttpCache::Entry& entry, ResourceResponse::Source source)
    {
        m_response = entry.response;
        m_response.setSource(source);
        m_data = entry.body->copyData();
        finish();
    }

    // Like the redirects of ResourceLoad, but without a ResourceLoader to ask:
    // credentials same-origin end at the first foreign target (fetch)
    void redirect()
    {
        auto next = redirectedRequest(m_request, m_response, ++m_redirectCount);
        if (!next)
            return fail(WTF::move(next.error()));
        if (!next->url().protocolIsInHTTPFamily())
            return fail(ResourceError(loadErrorDomain, 0, m_response.url(), "Redirect to unsupported URL"_s));
        if (m_credentials == FetchOptions::Credentials::SameOrigin && !m_origin->canRequest(next->url(), OriginAccessPatternsForWebProcess::singleton()))
            next->setAllowCookies(false);
        stopRequest();
        m_request = WTF::move(*next);
        start();
    }

    // CurlRequestClient (calls arrive on the engine thread, in the nested event loop)
    void curlDidSendData(CurlRequest&, unsigned long long, unsigned long long) final { }

    void curlDidReceiveResponse(CurlRequest& request, CurlResponse&& curlResponse) final
    {
        if (m_curlRequest != &request)
            return;
        m_response = networkResponse(curlResponse);
        storeCookies(request.resourceRequest(), curlResponse);
        // Conditional request from the cache: 304 means the stored content is still right
        if (auto entry = std::exchange(m_cachedEntry, nullptr); entry && m_response.httpStatusCode() == 304) {
            HttpCache::didRevalidate(m_partition, m_request, *entry, m_response);
            return finishFromCache(*entry, ResourceResponse::Source::DiskCacheAfterValidation);
        }
        if (isRedirect(m_response))
            return redirect();
        m_cacheWriter.start(m_partition, m_request, m_response);
        request.completeDidReceiveResponse();
    }

    void curlDidReceiveData(CurlRequest& request, Ref<SharedBuffer>&& buffer) final
    {
        if (m_curlRequest != &request)
            return;
        m_cacheWriter.append(buffer.get());
        m_data.append(buffer->span());
    }

    void curlDidComplete(CurlRequest& request, NetworkLoadMetrics&&) final
    {
        if (m_curlRequest != &request)
            return;
        m_cacheWriter.finish();
        finish();
    }

    void curlDidFailWithError(CurlRequest& request, ResourceError&& error, CertificateInfo&&) final
    {
        if (m_curlRequest != &request)
            return;
        log("Synchronous load failed (%d): %s %s", error.errorCode(), error.failingURL().string().utf8().data(), error.localizedDescription().utf8().data());
        fail(WTF::move(error));
    }

    // The request so far, without what curl adds (cookies, validation headers)
    ResourceRequest m_request;
    FetchOptions::Credentials m_credentials;
    Ref<SecurityOrigin> m_origin;
    String m_partition;
    RefPtr<CurlRequest> m_curlRequest;
    std::unique_ptr<HttpCache::Entry> m_cachedEntry;
    HttpCache::Writer m_cacheWriter;
    unsigned m_redirectCount { 0 };
    bool m_done { false };
    ResourceError m_error;
    ResourceResponse m_response;
    Vector<uint8_t> m_data;
};

} // namespace

void loadSynchronously(FrameLoader& frameLoader, const ResourceRequest& request, const FetchOptions& options, ResourceError& error, ResourceResponse& response, Vector<uint8_t>& data)
{
    const auto& url = request.url();
    if (url.protocolIsData() || url.protocolIsBlob())
        return loadLocalResource(url, error, response, data);

    Ref frame = frameLoader.frame();
    RefPtr document = frame->document();
    RefPtr page = frame->page();
    if (!document || !page) {
        error = ResourceError(loadErrorDomain, 0, url, "No document"_s);
        return;
    }
    // Chrome refuses them there; the page being left must not wait for the network
    if (frameLoader.pageDismissalEventBeingDispatched() != FrameLoader::PageDismissalType::None) {
        error = ResourceError(loadErrorDomain, 0, url, "Synchronous loads are not allowed during page dismissal"_s);
        return;
    }
    if (auto reason = refusedReason(url)) {
        error = refusedError(url, *reason);
        return;
    }
    if (!url.protocolIsInHTTPFamily() && !url.protocolIsFile()) {
        error = ResourceError(loadErrorDomain, 0, url, "Unsupported URL"_s);
        return;
    }
    // curl reports a response for file: before it opens the file
    if (url.protocolIsFile() && FileSystem::fileTypeFollowingSymlinks(url.fileSystemPath()) != FileSystem::FileType::Regular) {
        error = ResourceError(loadErrorDomain, static_cast<int>(LoadErrorCode::FileNotFound), url, "File not found"_s);
        return;
    }

    ResourceRequest first { request };
    if (options.credentials == FetchOptions::Credentials::Omit)
        first.setAllowCookies(false);
    Ref load = SyncLoad::create(WTF::move(first), options.credentials, Ref { document->securityOrigin() }, HttpCache::partition(*document));

    // Pages of service and shared workers belong to no view
    RefPtr<WebView> view;
    WebView::forEach([&](WebView& candidate) {
        if (&candidate.page() == page.get())
            view = &candidate;
    });
    {
        PageGroupLoadDeferrer deferrer(*page, true);
        load->start();
        waitHoldingPageGroup(*page, [&] {
            // The tab closed: its script ends without the answer
            if (view && !view->isOpen())
                load->cancel();
            return load->isDone();
        });
    }
    load->takeResult(error, response, data);
}

} // namespace BrowserLite
