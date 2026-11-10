// view-source: documents (ViewSource.h). The text comes from its own request like a download:
// cookies of the address, redirects followed, the body whatever the status. The page itself is
// sandboxed and allows no script, so neither the source nor its address can run anything.

#include "config.h"
#include "ViewSource.h"

#include "Engine.h"
#include "LoaderStrategy.h"

#include <WebCore/CachedResource.h>
#include <WebCore/CurlRequest.h>
#include <WebCore/CurlRequestClient.h>
#include <WebCore/CurlResponse.h>
#include <WebCore/HTTPHeaderNames.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/NetworkLoadMetrics.h>
#include <WebCore/ResourceError.h>
#include <WebCore/ResourceLoader.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/ResourceResponse.h>
#include <WebCore/Settings.h>
#include <WebCore/SharedBuffer.h>
#include <WebCore/TextResourceDecoder.h>
#include <pal/text/TextEncoding.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/StringBuilder.h>

namespace BrowserLite {

using namespace WebCore;

static constexpr auto scheme = "view-source"_s;

bool isViewSourceURL(const URL& url)
{
    return url.protocolIs(scheme);
}

// The address whose source is shown, without its fragment (it never reaches a server)
static URL sourceURL(const URL& url)
{
    URL inner { url.string().substring(scheme.length() + 1) };
    inner.removeFragmentIdentifier();
    return inner;
}

static void appendEscaped(StringBuilder& builder, StringView text)
{
    for (auto character : text.codeUnits()) {
        if (character == '&')
            builder.append("&amp;"_s);
        else if (character == '<')
            builder.append("&lt;"_s);
        else
            builder.append(character);
    }
}

// One numbered line per line of the text (LF, CRLF or CR)
static String sourcePage(const URL& url, const String& text)
{
    StringBuilder page;
    page.append("<!doctype html><meta charset=\"utf-8\"><title>"_s);
    appendEscaped(page, url.string());
    page.append("</title><style>body{margin:8px 0;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all}"
        "ol{margin:0;padding-left:5em}li{padding-left:1em}li::marker{color:#999}</style><ol>"_s);
    unsigned start = 0;
    for (unsigned i = 0; i <= text.length(); ++i) {
        if (i < text.length() && text[i] != '\n' && text[i] != '\r')
            continue;
        page.append("<li>"_s);
        appendEscaped(page, StringView(text).substring(start, i - start));
        page.append("</li>"_s);
        if (i + 1 < text.length() && text[i] == '\r' && text[i + 1] == '\n')
            ++i;
        start = i + 1;
    }
    page.append("</ol>"_s);
    return page.toString();
}

class ViewSourceLoad final : public RefCounted<ViewSourceLoad>, public CurlRequestClient {
public:
    static void start(ResourceLoader& loader)
    {
        Ref load = adoptRef(*new ViewSourceLoad(loader));
        loads().set(&loader, load.copyRef());
        const auto& url = loader.request().url();
        RefPtr frame = loader.frame();
        auto* resource = loader.cachedResource();
        bool document = frame && frame->isMainFrame() && resource && resource->type() == CachedResource::Type::MainResource;
        auto source = sourceURL(url);
        if (!document || !source.protocolIsInHTTPFamily())
            return load->failLater(ResourceError(loadErrorDomain, static_cast<int>(LoadErrorCode::CannotShowURL), url, "Cannot show URL"_s, ResourceError::Type::AccessControl));
        if (auto reason = refusedReason(source))
            return load->failLater(refusedError(source, *reason));

        load->m_defaultEncoding = frame->settings().defaultTextEncodingName();
        ResourceRequest request { WTF::move(source) };
        request.setFirstPartyForCookies(request.url());
        load->m_request = createCurlRequest(WTF::move(request), load.get());
        load->m_request->resume();
    }

    static void cancel(ResourceLoader& loader)
    {
        if (RefPtr load = loads().take(&loader))
            load->stop();
    }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    static HashMap<ResourceLoader*, Ref<ViewSourceLoad>>& loads()
    {
        static NeverDestroyed<HashMap<ResourceLoader*, Ref<ViewSourceLoad>>> loads;
        return loads;
    }

    explicit ViewSourceLoad(ResourceLoader& loader)
        : m_loader(&loader)
    {
    }

    void stop()
    {
        m_loader = nullptr;
        if (auto request = std::exchange(m_request, nullptr)) {
            request->cancel();
            request->invalidateClient();
        }
    }

    // The loader leaves the list before it hears of the result
    RefPtr<ResourceLoader> takeLoader()
    {
        RefPtr loader = std::exchange(m_loader, nullptr);
        if (loader)
            loads().remove(loader.get());
        stop();
        return loader;
    }

    // In a later task: WebCore does not know the loader yet within start()
    void failLater(ResourceError&& error)
    {
        runOnEngineThread([this, protectedThis = Ref { *this }, error = WTF::move(error)] {
            if (RefPtr loader = takeLoader())
                loader->didFail(error);
        });
    }

    // The error page of the view-source: address names the error of the source's request
    void fail(const ResourceError& error)
    {
        if (RefPtr loader = takeLoader())
            loader->didFail(error);
    }

    void deliverPage()
    {
        RefPtr loader = takeLoader();
        if (!loader)
            return;
        Ref decoder = TextResourceDecoder::create(m_mimeType, PAL::TextEncoding { m_defaultEncoding });
        if (!m_charset.isEmpty())
            decoder->setEncoding(PAL::TextEncoding { m_charset }, TextResourceDecoder::EncodingFromHTTPHeader);
        auto text = decoder->decodeAndFlush(m_body.span());
        m_body = { };
        auto utf8 = sourcePage(loader->url(), text).utf8();

        ResourceResponse response { URL { loader->url() }, "text/html"_s, static_cast<long long>(utf8.length()), "UTF-8"_s };
        response.setHTTPStatusCode(200);
        response.setHTTPHeaderField(HTTPHeaderName::ContentSecurityPolicy, "sandbox; default-src 'none'; style-src 'unsafe-inline'"_s);
        Ref body = SharedBuffer::create(utf8.span());
        loader->didReceiveResponse(WTF::move(response), [loader, body] {
            if (loader->reachedTerminalState())
                return;
            loader->didReceiveBuffer(body, body->size(), DataPayloadBytes);
            if (loader->reachedTerminalState())
                return;
            NetworkLoadMetrics metrics;
            metrics.markComplete();
            loader->didFinishLoading(metrics);
        });
    }

    // CurlRequestClient (calls arrive on the engine thread)
    void curlDidSendData(CurlRequest&, unsigned long long, unsigned long long) final { }
    void curlDidReceiveResponse(CurlRequest& request, CurlResponse&& curlResponse) final
    {
        Ref protectedThis { *this };
        if (!m_loader || m_request != &request)
            return;
        storeCookies(request.resourceRequest(), curlResponse);
        auto response = networkResponse(curlResponse);
        if (isRedirect(response)) {
            if (auto error = followRedirect(m_request, *this, request.resourceRequest(), response, m_redirectCount); !error.isNull())
                fail(error);
            return;
        }
        // Like Chrome also the body of an error status: that is what the server sent
        m_mimeType = response.mimeType();
        m_charset = response.textEncodingName();
        request.completeDidReceiveResponse();
    }
    void curlDidReceiveData(CurlRequest& request, Ref<SharedBuffer>&& buffer) final
    {
        if (m_loader && m_request == &request)
            m_body.append(buffer->span());
    }
    void curlDidComplete(CurlRequest& request, NetworkLoadMetrics&&) final
    {
        Ref protectedThis { *this };
        if (m_loader && m_request == &request)
            deliverPage();
    }
    void curlDidFailWithError(CurlRequest& request, ResourceError&& error, CertificateInfo&&) final
    {
        Ref protectedThis { *this };
        if (m_loader && m_request == &request)
            fail(error);
    }

    RefPtr<ResourceLoader> m_loader;
    RefPtr<CurlRequest> m_request;
    unsigned m_redirectCount { 0 };
    String m_defaultEncoding;
    String m_mimeType;
    String m_charset;
    Vector<uint8_t> m_body;
};

void startViewSourceLoad(ResourceLoader& loader)
{
    ViewSourceLoad::start(loader);
}

void cancelViewSourceLoad(ResourceLoader& loader)
{
    ViewSourceLoad::cancel(loader);
}

} // namespace BrowserLite
