#pragma once

#include <optional>
#include <wtf/CompletionHandler.h>
#include <wtf/Forward.h>
#include <wtf/text/ASCIILiteral.h>

namespace WebCore {
class CurlRequest;
class CurlRequestClient;
class CurlResponse;
class LoaderStrategy;
class ResourceError;
class ResourceLoader;
class ResourceRequest;
class ResourceResponse;
}

namespace BrowserLite {

WebCore::LoaderStrategy& loaderStrategy();

// Load errors of the engine itself (not from curl); the error page knows these codes
constexpr auto loadErrorDomain = "BrowserLite"_s;
enum class LoadErrorCode : int {
    Other,
    CannotShowURL, // an address WebCore does not load, like about:foo
    FileNotFound, // a file: address that is no file in the engine file system
    Blocked, // blockedError for any other reason, like a redirect to data:
    UnsafePort, // blockedError: a port no browser connects to (portAllowed)
    AddressInvalid, // blockedError: an address of only zeros (isIPAddressDisallowed)
    TooManyRedirects, // more than 20 redirects, like in Chrome
    UnsafeRedirect, // a redirect to a file: address
    HttpErrorWithoutBody, // a navigation answered with status 400 or more and no body
};

// Why WebCore never loads an address: a restricted port (UnsafePort) or an address
// of only zeros (AddressInvalid). The engine's own requests (icons, preconnect, the
// redirects they follow) skip it the same way.
std::optional<LoadErrorCode> refusedReason(const URL&);
// A load refused for refusedReason. FrameLoader::blockedError marks it as
// cancelled, but like in Chrome a navigation gets an error and the error page.
bool isRefusedAddress(const WebCore::ResourceError&);

// Downloads the file and hands it to the host (events download-start /
// download-done, data through Module.onEngineDownloadData). data: and blob:
// come from the engine itself, otherwise an own request.
void startDownload(int viewId, const WebCore::ResourceRequest&, const String& suggestedFilename);
// A navigation whose response became a download: its running load continues
// as the download, nothing is requested again. False if the engine has no such
// load (WebCore memory cache, answered by a service worker).
bool continueAsDownload(int viewId, WebCore::ResourceLoader&, const WebCore::ResourceResponse&);
// Stops a running download, which ends with download-done (error "Cancelled")
void cancelDownload(int id);
// Loads the source of an address (like a download, flagged viewSource)
void startViewSource(int viewId, const URL&);

// Stores Set-Cookie of the response if the request may have cookies
void storeCookies(const WebCore::ResourceRequest&, const WebCore::CurlResponse&);

// Every CurlRequest of the engine: user agent, Sec-GPC and Save-Data (when enabled), plus
// cookies if the request may have them (allowCookies)
Ref<WebCore::CurlRequest> createCurlRequest(WebCore::ResourceRequest&&, WebCore::CurlRequestClient&);
// Response from curl like for a ResourceLoader: without Content-Type guess the
// MIME type like other browsers (by extension, otherwise HTML)
WebCore::ResourceResponse networkResponse(WebCore::CurlResponse&);
// curl does not follow redirects itself: 3xx with Location
bool isRedirect(const WebCore::ResourceResponse&);
// For loaders without a ResourceLoader: the running request ends, the next one
// starts from current, the request that got the redirect (like Chrome, at most
// 20). An error means it does not continue.
WebCore::ResourceError followRedirect(RefPtr<WebCore::CurlRequest>&, WebCore::CurlRequestClient&, const WebCore::ResourceRequest& current, const WebCore::ResourceResponse&, unsigned& redirectCount);

// Loads a favicon (small, entirely in memory). Empty data when there is none
void loadIcon(const URL&, CompletionHandler<void(const String& mimeType, Vector<uint8_t>&&)>&&);

} // namespace BrowserLite
