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

#include "config.h"
#include "HttpCache.h"

#include "Engine.h"
#include "EngineConfig.h"
#include "Strategies.h"

#include <WebCore/CacheValidation.h>
#include <WebCore/HTTPHeaderNames.h>
#include <WebCore/HTTPParsers.h>
#include <WebCore/ResourceRequest.h>
#include <emscripten/emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <wtf/HashMap.h>
#include <wtf/HexNumber.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>

// Run on the main thread (engine/js/http-cache.js)
EM_JS(void, blJsHttpCacheLookup, (int id, const char* url), {
    blHttpCache.lookup(id, UTF8ToString(url));
});
EM_JS(void, blJsHttpCacheStore, (const char* url, int status, const char* headers, const uint8_t* body, int length), {
    blHttpCache.store(UTF8ToString(url), status, UTF8ToString(headers), HEAPU8.slice(body, body + length));
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

bool canUse(const ResourceRequest& request)
{
    if (!engineConfig().httpCache || request.httpMethod() != "GET"_s || !request.url().protocolIsInHTTPFamily())
        return false;
    if (request.cachePolicy() == ResourceRequestCachePolicy::DoNotUseAnyCache)
        return false;
    // Range requests (video) and WebCore's own conditional requests go straight to the network
    for (auto name : { HTTPHeaderName::Range, HTTPHeaderName::IfNoneMatch, HTTPHeaderName::IfModifiedSince, HTTPHeaderName::IfMatch, HTTPHeaderName::IfUnmodifiedSince, HTTPHeaderName::IfRange, HTTPHeaderName::Authorization }) {
        if (request.hasHTTPHeaderField(name))
            return false;
    }
    return true;
}

static bool hasValidators(const ResourceResponse& response)
{
    return !response.httpHeaderField(HTTPHeaderName::ETag).isEmpty() || !response.httpHeaderField(HTTPHeaderName::LastModified).isEmpty();
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

bool isStorable(const ResourceRequest& request, const ResourceResponse& response)
{
    if (!canUse(request) || (response.httpStatusCode() != 200 && response.httpStatusCode() != 203))
        return false;
    if (cacheKey(response.url()) != cacheKey(request.url()))
        return false;
    if (parseCacheControlDirectives(response.httpHeaderFields()).noStore || parseCacheControlDirectives(request.httpHeaderFields()).noStore)
        return false;
    if (response.httpHeaderField(HTTPHeaderName::Vary).contains('*') || !response.httpHeaderField(HTTPHeaderName::ContentRange).isEmpty())
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

void lookup(const ResourceRequest& request, Completion&& completion)
{
    static int nextId;
    int id = ++nextId;
    pendingLookups().add(id, PendingLookup { request.url(), WTF::move(completion) });
    struct Job {
        int id;
        CString url;
    };
    auto* job = new Job { id, cacheKey(request.url()).utf8() };
    emscripten_proxy_async(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(), [](void* argument) {
        std::unique_ptr<Job> job(static_cast<Job*>(argument));
        blJsHttpCacheLookup(job->id, job->url.data());
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
        response.setHTTPStatusText(statusText.isEmpty() ? String { "OK"_s } : WTF::move(statusText));
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

void store(const ResourceRequest& request, const ResourceResponse& response, WallTime responseTime, const FragmentedSharedBuffer& body)
{
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
    auto varying = collectVaryingRequestHeaders(&networkStorageSession(), request, response);
    if (!varying.isEmpty())
        headers.append(varyHeader, ": "_s, encodeVary(varying), '\n');

    struct Job {
        CString url;
        int status;
        CString headers;
        uint8_t* body;
        size_t length;
    };
    auto contiguous = body.makeContiguous();
    auto* data = static_cast<uint8_t*>(malloc(std::max<size_t>(contiguous->size(), 1)));
    if (!data)
        return;
    memcpySpan(std::span(data, contiguous->size()), contiguous->span());
    auto* job = new Job { cacheKey(request.url()).utf8(), response.httpStatusCode(), headers.toString().utf8(), data, contiguous->size() };
    emscripten_proxy_async(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(), [](void* argument) {
        std::unique_ptr<Job> job(static_cast<Job*>(argument));
        blJsHttpCacheStore(job->url.data(), job->status, job->headers.data(), job->body, job->length);
        free(job->body);
    }, job);
}

void lookupForLoad(ResourceRequest&& request, bool alwaysRevalidate, CompletionHandler<void(Lookup&&)>&& completion)
{
    if (!canUse(request) || request.cachePolicy() == ResourceRequestCachePolicy::ReloadIgnoringCacheData)
        return completion({ WTF::move(request) });
    ResourceRequest key { request };
    lookup(key, [request = WTF::move(request), alwaysRevalidate, completion = WTF::move(completion)](std::unique_ptr<Entry>&& entry) mutable {
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

void didRevalidate(const ResourceRequest& request, Entry& entry, const ResourceResponse& notModified)
{
    updateResponseHeadersAfterRevalidation(entry.response, notModified);
    entry.responseTime = WallTime::now();
    store(request, entry.response, entry.responseTime, entry.body.get());
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
