// Persistent HTTP cache of the engine.
//
// Without a network process WebKit only has the memory cache (MemoryCache)
// here, which disappears with the engine. So that not every visit of a page
// fetches everything through the transport again, cacheable responses are kept
// in the Cache API of the host browser (on disk, only read when needed),
// accessed through engine/js/http-cache.js on the main thread. BL_HTTP_CACHE=0
// turns it off.
//
// Flow (lookupForLoad, for all loaders): look before the network. Fresh:
// straight from the cache. Stale but with ETag/Last-Modified: conditional
// request, on 304 from the cache. Cacheable 200 responses (up to 10 MB) are
// stored. WebCore computes freshness and age (CacheValidation.h) like in the
// network process.
//
// Ranges (media loads a file piece by piece) like Chrome's sparse entries: a
// 206 response with a strong validator is stored as a range of its resource
// (up to 10 MB in total). Ranges of one version (validator and Vary values)
// make up the resource, another version replaces them. A range request comes
// from the cache only when the ranges of the newest version cover the whole
// resource, so the pieces of one playback never mix versions; freshness and
// revalidation go by the newest range. A whole response does not serve ranges
// and ranges do not serve a request for the whole resource.
//
// Every entry belongs to a partition (top site, frame site, subframe document;
// partition()) like in Chrome, so a page cannot tell from cache hits which
// other sites were visited. WebCore's MemoryCache stays shared inside the engine.

#include "config.h"
#include "HttpCache.h"

#include "Engine.h"
#include "EngineConfig.h"
#include "Strategies.h"

#include <WebCore/CacheValidation.h>
#include <WebCore/CachedResource.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/DocumentPage.h>
#include <WebCore/FetchOptions.h>
#include <WebCore/HTTPHeaderNames.h>
#include <WebCore/HTTPParsers.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/Page.h>
#include <WebCore/ParsedContentRange.h>
#include <WebCore/ResourceLoader.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/SecurityOrigin.h>
#include <WebCore/SecurityOriginData.h>
#include <WebCore/Site.h>
#include <emscripten/emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <wtf/HashMap.h>
#include <wtf/HexNumber.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/WeakHashMap.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>

// Run on the main thread (engine/js/http-cache.js)
// start < 0: the whole resource, end < 0: up to its end
EM_JS(void, blJsHttpCacheLookup, (int id, const char* partition, const char* url, double start, double end), {
    blHttpCache.lookup(id, UTF8ToString(partition), UTF8ToString(url), start, end);
});
// start < 0: a whole response, else a range of a resource of total bytes and this version
EM_JS(void, blJsHttpCacheStore, (const char* partition, const char* url, int status, const char* headers, const uint8_t* body, int length, double start, double total, const char* version), {
    blHttpCache.store(UTF8ToString(partition), UTF8ToString(url), status, UTF8ToString(headers), HEAPU8.slice(body, body + length), start, total, UTF8ToString(version));
});

namespace BrowserLite::HttpCache {

using namespace WebCore;

// Own headers in the stored entry
static constexpr auto timeHeader = "x-bl-time"_s;
static constexpr auto varyHeader = "x-bl-vary"_s;
static constexpr auto statusTextHeader = "x-bl-status-text"_s;

using Completion = CompletionHandler<void(std::unique_ptr<Entry>&&)>;

struct PendingLookup {
    URL url;
    Completion completion;
};

static HashMap<int, PendingLookup>& pendingLookups()
{
    static NeverDestroyed<HashMap<int, PendingLookup>> lookups;
    return lookups;
}

static String cacheKey(const URL& url)
{
    return url.viewWithoutFragmentIdentifier().toString();
}

String partition(const SecurityOriginData& topOrigin, const SecurityOriginData& frameOrigin, bool isSubframeDocument)
{
    if (topOrigin.isNull() || topOrigin.isOpaque() || frameOrigin.isNull() || frameOrigin.isOpaque())
        return { };
    // Without a registrable domain (file:) there is no site to keep apart
    Site topSite { topOrigin };
    Site frameSite { frameOrigin };
    if (topSite.isEmpty() || frameSite.isEmpty())
        return { };
    return makeString(isSubframeDocument ? "s_"_s : ""_s, topSite.toString(), ' ', frameSite.toString());
}

// Origin of a document at this URL: a blob: URL has the origin of its creator
static SecurityOriginData originOf(const URL& url)
{
    return SecurityOrigin::create(url)->data();
}

static WeakHashMap<Page, SecurityOriginData>& workerOrigins()
{
    static NeverDestroyed<WeakHashMap<Page, SecurityOriginData>> origins;
    return origins;
}

void setWorkerOrigin(Page& page, const SecurityOriginData& origin)
{
    workerOrigins().set(page, SecurityOriginData { origin });
}

// Origin of the context the frame loads for: the worker of a worker page, else the document
static SecurityOriginData contextOrigin(const LocalFrame& frame)
{
    if (RefPtr page = frame.page()) {
        auto worker = workerOrigins().find(*page);
        if (worker != workerOrigins().end())
            return worker->value;
    }
    RefPtr document = frame.document();
    return document ? document->securityOrigin().data() : SecurityOriginData { };
}

static String partition(const LocalFrame& frame, const ResourceRequest& request, const FetchOptions& options, const SecurityOrigin* requester)
{
    auto topOrigin = originOf(request.firstPartyForCookies());
    if (options.mode == FetchOptions::Mode::Navigate) {
        // A frame sandboxed without allow-same-origin gets an opaque origin
        if (frame.effectiveSandboxFlags().contains(SandboxFlag::Origin))
            return { };
        return partition(topOrigin, originOf(request.url()), !frame.isMainFrame());
    }
    // WebCore makes the requester opaque for a CORS load after a cross-origin redirect (a data:
    // worker is opaque too): then the context decides, which is opaque in a sandboxed document
    if (requester && !requester->isOpaque())
        return partition(topOrigin, requester->data(), false);
    return partition(topOrigin, contextOrigin(frame), false);
}

String partition(const ResourceLoader& loader)
{
    RefPtr frame = loader.frame();
    if (!frame)
        return { };
    RefPtr resource = loader.cachedResource();
    return partition(*frame, loader.request(), loader.options(), resource ? resource->origin() : nullptr);
}

String partition(const Document& document)
{
    return partition(originOf(document.firstPartyForCookies()), document.securityOrigin().data(), false);
}

// Range of a request: none without the header, nullopt for one the cache does not
// handle (several ranges, the last n bytes)
static std::optional<HTTPRange> requestRange(const ResourceRequest& request)
{
    auto header = request.httpHeaderField(HTTPHeaderName::Range);
    if (header.isNull())
        return HTTPRange { };
    auto range = parseRange(header, RangeAllowWhitespace::No);
    if (!range || !range->start)
        return std::nullopt;
    return range;
}

bool canUse(const ResourceRequest& request)
{
    if (!engineConfig().httpCache || request.httpMethod() != "GET"_s || !request.url().protocolIsInHTTPFamily())
        return false;
    if (request.cachePolicy() == ResourceRequestCachePolicy::DoNotUseAnyCache || !requestRange(request))
        return false;
    // WebCore's own conditional requests go straight to the network
    for (auto name : { HTTPHeaderName::IfNoneMatch, HTTPHeaderName::IfModifiedSince, HTTPHeaderName::IfMatch, HTTPHeaderName::IfUnmodifiedSince, HTTPHeaderName::IfRange, HTTPHeaderName::Authorization }) {
        if (request.hasHTTPHeaderField(name))
            return false;
    }
    return true;
}

static bool hasValidators(const ResourceResponse& response)
{
    return !response.httpHeaderField(HTTPHeaderName::ETag).isEmpty() || !response.httpHeaderField(HTTPHeaderName::LastModified).isEmpty();
}

// RFC 9110 8.8.1, like HttpUtil::HasStrongValidators in Chrome: a strong ETag, or a
// Last-Modified at least 60 s before the Date of the response
static bool hasStrongValidator(const ResourceResponse& response)
{
    auto etag = response.httpHeaderField(HTTPHeaderName::ETag);
    if (!etag.isEmpty() && !etag.startsWith("W/"_s))
        return true;
    auto lastModified = response.lastModified();
    auto date = response.date();
    return lastModified && date && *date - *lastModified >= 60_s;
}

// The range a 206 response holds, if it may be stored as a range of its resource
static std::optional<ParsedContentRange> storableRange(const ResourceRequest& request, const ResourceResponse& response)
{
    auto range = requestRange(request);
    ParsedContentRange content { response.httpHeaderField(HTTPHeaderName::ContentRange) };
    if (!range || !range->start || !content.isValid() || content.instanceLength() == ParsedContentRange::unknownLength)
        return std::nullopt;
    if (static_cast<uint64_t>(content.firstBytePosition()) != *range->start || (range->end && static_cast<uint64_t>(content.lastBytePosition()) > *range->end))
        return std::nullopt;
    if (static_cast<uint64_t>(content.instanceLength()) > maximumEntrySize || !hasStrongValidator(response))
        return std::nullopt;
    // Positions of the encoded bytes, but curl decodes them
    auto encoding = response.httpHeaderField(HTTPHeaderName::ContentEncoding);
    if (!encoding.isEmpty() && !equalLettersIgnoringASCIICase(encoding, "identity"_s))
        return std::nullopt;
    return content;
}

Use decide(const Entry& entry, const ResourceRequest& request)
{
    if (!verifyVaryingRequestHeaders(&networkStorageSession(), entry.varyingHeaders, request))
        return Use::None;
    auto policy = request.cachePolicy();
    if (policy == ResourceRequestCachePolicy::ReturnCacheDataElseLoad || policy == ResourceRequestCachePolicy::ReturnCacheDataDontLoad)
        return Use::Fresh;

    auto revalidateOrNot = hasValidators(entry.response) ? Use::Revalidate : Use::None;
    if (policy == ResourceRequestCachePolicy::RefreshAnyCacheData)
        return revalidateOrNot;
    auto requestDirectives = parseCacheControlDirectives(request.httpHeaderFields());
    if (requestDirectives.noCache || (requestDirectives.maxAge && !*requestDirectives.maxAge) || equalLettersIgnoringASCIICase(request.httpHeaderField(HTTPHeaderName::Pragma), "no-cache"_s))
        return revalidateOrNot;
    auto responseDirectives = parseCacheControlDirectives(entry.response.httpHeaderFields());
    if (responseDirectives.noCache)
        return revalidateOrNot;

    auto age = computeCurrentAge(entry.response, entry.responseTime);
    auto lifetime = computeFreshnessLifetimeForHTTPFamily(entry.response, entry.responseTime);
    if (age < lifetime)
        return Use::Fresh;
    return revalidateOrNot;
}

void addValidationHeaders(ResourceRequest& request, const Entry& entry)
{
    auto etag = entry.response.httpHeaderField(HTTPHeaderName::ETag);
    if (!etag.isEmpty())
        request.setHTTPHeaderField(HTTPHeaderName::IfNoneMatch, etag);
    auto lastModified = entry.response.httpHeaderField(HTTPHeaderName::LastModified);
    if (!lastModified.isEmpty())
        request.setHTTPHeaderField(HTTPHeaderName::IfModifiedSince, lastModified);
}

bool isStorable(const String& partition, const ResourceRequest& request, const ResourceResponse& response)
{
    if (partition.isNull() || !canUse(request) || cacheKey(response.url()) != cacheKey(request.url()))
        return false;
    if (response.httpStatusCode() == 206) {
        if (!storableRange(request, response))
            return false;
    } else if ((response.httpStatusCode() != 200 && response.httpStatusCode() != 203) || !response.httpHeaderField(HTTPHeaderName::ContentRange).isEmpty())
        return false;
    if (parseCacheControlDirectives(response.httpHeaderFields()).noStore || parseCacheControlDirectives(request.httpHeaderFields()).noStore)
        return false;
    if (response.httpHeaderField(HTTPHeaderName::Vary).contains('*'))
        return false;
    if (response.expectedContentLength() > static_cast<long long>(maximumEntrySize))
        return false;
    // Ends only with the connection (HTTP/1 without length, not chunked): an
    // abort then looks like the end (CurlRequest::didCompleteTransfer also
    // takes a read error as the end), the response may be truncated
    if (response.httpVersion().startsWith("HTTP/1"_s) && response.httpHeaderField(HTTPHeaderName::ContentLength).isEmpty()
        && !response.httpHeaderField(HTTPHeaderName::TransferEncoding).containsIgnoringASCIICase("chunked"_s))
        return false;
    return hasValidators(response) || computeFreshnessLifetimeForHTTPFamily(response, WallTime::now()) > 0_s;
}

// Value for x-bl-vary: name=value pairs, percent-encoded, separated by &
static String encodeVary(const Vector<std::pair<String, String>>& headers)
{
    StringBuilder builder;
    auto encode = [&](const String& text) {
        for (auto byte : text.utf8().span()) {
            if (isASCIIAlphanumeric(byte) || byte == '-' || byte == '_' || byte == '.')
                builder.append(static_cast<char>(byte));
            else
                builder.append('%', hex(static_cast<uint8_t>(byte), 2));
        }
    };
    for (auto& [name, value] : headers) {
        if (!builder.isEmpty())
            builder.append('&');
        encode(name);
        builder.append('=');
        encode(value);
    }
    return builder.toString();
}

static Vector<std::pair<String, String>> decodeVary(StringView text)
{
    auto decode = [](StringView part) {
        Vector<uint8_t> bytes;
        for (size_t i = 0; i < part.length(); ++i) {
            auto c = part[i];
            if (c == '%' && i + 2 < part.length() && isASCIIHexDigit(part[i + 1]) && isASCIIHexDigit(part[i + 2])) {
                bytes.append(toASCIIHexValue(part[i + 1], part[i + 2]));
                i += 2;
            } else
                bytes.append(static_cast<uint8_t>(c));
        }
        return String::fromUTF8(bytes.span());
    };
    Vector<std::pair<String, String>> headers;
    for (auto pair : text.split('&')) {
        auto equal = pair.find('=');
        if (equal == notFound)
            continue;
        headers.append({ decode(pair.left(equal)), decode(pair.substring(equal + 1)) });
    }
    return headers;
}

void lookup(const String& partition, const ResourceRequest& request, Completion&& completion)
{
    if (partition.isNull())
        return completion(nullptr);
    auto range = requestRange(request);
    if (!range)
        return completion(nullptr);
    static int nextId;
    int id = ++nextId;
    pendingLookups().add(id, PendingLookup { request.url(), WTF::move(completion) });
    struct Job {
        int id;
        CString partition;
        CString url;
        double start;
        double end;
    };
    auto* job = new Job { id, partition.utf8(), cacheKey(request.url()).utf8(),
        range->start ? static_cast<double>(*range->start) : -1, range->end ? static_cast<double>(*range->end) : -1 };
    emscripten_proxy_async(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(), [](void* argument) {
        std::unique_ptr<Job> job(static_cast<Job*>(argument));
        blJsHttpCacheLookup(job->id, job->partition.data(), job->url.data(), job->start, job->end);
    }, job);
}

// Evaluates the main thread's answer on the engine thread
static void didLookup(int id, int status, char* headers, int headersLength, uint8_t* body, int bodyLength)
{
    auto pending = pendingLookups().take(id);
    std::unique_ptr<Entry> entry;
    if (status) {
        HTTPHeaderMap fields;
        WallTime time;
        String statusText;
        Vector<std::pair<String, String>> varying;
        // UTF-8 like when storing (store, UTF8ToString in http-cache.js)
        auto text = String::fromUTF8(std::span(byteCast<char8_t>(headers), headersLength));
        for (auto line : StringView(text).split('\n')) {
            auto colon = line.find(':');
            if (colon == notFound)
                continue;
            auto name = line.left(colon).trim(isASCIIWhitespace<char16_t>).toString();
            auto value = line.substring(colon + 1).trim(isASCIIWhitespace<char16_t>).toString();
            if (equalIgnoringASCIICase(name, timeHeader))
                time = WallTime::fromRawSeconds(value.toDouble() / 1000);
            else if (equalIgnoringASCIICase(name, varyHeader))
                varying = decodeVary(value);
            else if (equalIgnoringASCIICase(name, statusTextHeader))
                statusText = value;
            else
                fields.add(name, value);
        }
        auto contentType = fields.get(HTTPHeaderName::ContentType);
        auto response = ResourceResponse(URL { pending.url }, extractMIMETypeFromMediaType(contentType), bodyLength, extractCharsetFromMediaType(contentType).toString());
        response.setHTTPStatusCode(status);
        if (statusText.isEmpty())
            statusText = status == 206 ? "Partial Content"_s : "OK"_s;
        response.setHTTPStatusText(WTF::move(statusText));
        for (auto& field : fields)
            response.setHTTPHeaderField(field.key, field.value);
        entry = std::unique_ptr<Entry>(new Entry {
            WTF::move(response),
            time,
            SharedBuffer::create(std::span<const uint8_t>(body, bodyLength)),
            WTF::move(varying),
        });
    }
    free(headers);
    free(body);
    if (pending.completion)
        pending.completion(WTF::move(entry));
}

void store(const String& partition, const ResourceRequest& request, const ResourceResponse& response, WallTime responseTime, const FragmentedSharedBuffer& body)
{
    if (partition.isNull())
        return;
    std::optional<ParsedContentRange> range;
    if (response.httpStatusCode() == 206) {
        range = storableRange(request, response);
        // A range cut short is not stored
        if (!range || static_cast<uint64_t>(range->lastBytePosition() - range->firstBytePosition() + 1) != body.size())
            return;
    }
    // Headers without those that are no longer right (curl already decoded the body)
    StringBuilder headers;
    for (auto& field : response.httpHeaderFields()) {
        if (field.keyAsHTTPHeaderName) {
            switch (*field.keyAsHTTPHeaderName) {
            case HTTPHeaderName::SetCookie:
            case HTTPHeaderName::SetCookie2:
            case HTTPHeaderName::ContentEncoding:
            case HTTPHeaderName::ContentLength:
            case HTTPHeaderName::TransferEncoding:
            case HTTPHeaderName::Connection:
            case HTTPHeaderName::KeepAlive:
                continue;
            default:
                break;
            }
        }
        if (field.value.contains('\n') || field.value.contains('\r'))
            continue;
        headers.append(field.key, ": "_s, field.value, '\n');
    }
    if (!response.mimeType().isEmpty() && response.httpHeaderField(HTTPHeaderName::ContentType).isEmpty())
        headers.append("Content-Type: "_s, response.mimeType(), '\n');
    headers.append(timeHeader, ": "_s, String::number(responseTime.secondsSinceEpoch().milliseconds()), '\n');
    if (!response.httpStatusText().isEmpty())
        headers.append(statusTextHeader, ": "_s, response.httpStatusText(), '\n');
    auto varying = encodeVary(collectVaryingRequestHeaders(&networkStorageSession(), request, response));
    if (!varying.isEmpty())
        headers.append(varyHeader, ": "_s, varying, '\n');
    // Ranges of the same version make up one resource
    auto version = range ? makeString(response.httpHeaderField(HTTPHeaderName::ETag), '\n', response.httpHeaderField(HTTPHeaderName::LastModified), '\n', varying) : String { };

    struct Job {
        CString partition;
        CString url;
        int status;
        CString headers;
        uint8_t* body;
        size_t length;
        double start;
        double total;
        CString version;
    };
    auto contiguous = body.makeContiguous();
    auto* data = static_cast<uint8_t*>(malloc(std::max<size_t>(contiguous->size(), 1)));
    if (!data)
        return;
    memcpySpan(std::span(data, contiguous->size()), contiguous->span());
    auto* job = new Job { partition.utf8(), cacheKey(request.url()).utf8(), response.httpStatusCode(), headers.toString().utf8(), data, contiguous->size(),
        range ? static_cast<double>(range->firstBytePosition()) : -1, range ? static_cast<double>(range->instanceLength()) : 0, version.utf8() };
    emscripten_proxy_async(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(), [](void* argument) {
        std::unique_ptr<Job> job(static_cast<Job*>(argument));
        blJsHttpCacheStore(job->partition.data(), job->url.data(), job->status, job->headers.data(), job->body, job->length, job->start, job->total, job->version.data());
        free(job->body);
    }, job);
}

void Writer::start(const String& partition, const ResourceRequest& request, const ResourceResponse& response)
{
    m_body.reset();
    m_storing = isStorable(partition, request, response);
    if (!m_storing)
        return;
    m_partition = partition;
    m_request = request;
    m_response = response;
    m_responseTime = WallTime::now();
}

void Writer::append(const SharedBuffer& buffer)
{
    if (!m_storing)
        return;
    if (m_body.size() + buffer.size() > maximumEntrySize) {
        m_storing = false;
        m_body.reset();
        return;
    }
    m_body.append(buffer);
}

void Writer::finish()
{
    if (std::exchange(m_storing, false))
        store(m_partition, m_request, m_response, m_responseTime, m_body.takeBuffer().get());
}

void lookupForLoad(const String& partition, ResourceRequest&& request, bool alwaysRevalidate, CompletionHandler<void(Lookup&&)>&& completion)
{
    if (partition.isNull() || !canUse(request) || request.cachePolicy() == ResourceRequestCachePolicy::ReloadIgnoringCacheData)
        return completion({ WTF::move(request) });
    ResourceRequest key { request };
    lookup(partition, key, [request = WTF::move(request), alwaysRevalidate, completion = WTF::move(completion)](std::unique_ptr<Entry>&& entry) mutable {
        auto use = entry ? decide(*entry, request) : Use::None;
        if (entry)
            debugLog("Cache %s: %s", use == Use::Fresh ? "fresh" : use == Use::Revalidate ? "revalidate" : "not usable", request.url().string().utf8().data());
        if (use == Use::Fresh && !alwaysRevalidate)
            return completion({ WTF::move(request), WTF::move(entry), true });
        if (use == Use::None)
            return completion({ WTF::move(request) });
        addValidationHeaders(request, *entry);
        completion({ WTF::move(request), WTF::move(entry) });
    });
}

void didRevalidate(const String& partition, const ResourceRequest& request, Entry& entry, const ResourceResponse& notModified)
{
    updateResponseHeadersAfterRevalidation(entry.response, notModified);
    entry.responseTime = WallTime::now();
    store(partition, request, entry.response, entry.responseTime, entry.body.get());
}

} // namespace BrowserLite::HttpCache

using namespace BrowserLite;

extern "C" {

// From the main thread (engine/js/http-cache.js): status 0 = not in the cache.
// headers and body belong to us afterwards (malloc).
EMSCRIPTEN_KEEPALIVE void bl__http_cache_result(int id, int status, char* headers, int headersLength, uint8_t* body, int bodyLength)
{
    runOnEngineThread([=] {
        HttpCache::didLookup(id, status, headers, headersLength, body, bodyLength);
    });
}

} // extern "C"
