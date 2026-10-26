#pragma once

#include <wtf/Forward.h>

namespace WebCore {
class CurlRequest;
class CurlRequestClient;
class CurlResponse;
class LoaderStrategy;
class ResourceError;
class ResourceRequest;
class ResourceResponse;
}

namespace BrowserLite {

WebCore::LoaderStrategy& loaderStrategy();

// Downloads the file and hands it to the host (events download-start /
// download-done, data through Module.onEngineDownloadData). data: and blob:
// come from the engine itself, otherwise an own request.
void startDownload(int viewId, const WebCore::ResourceRequest&, const String& suggestedFilename);
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

// Loads a favicon and hands it to the host (Module.onEngineIcon)
void loadIcon(int viewId, const URL&);

} // namespace BrowserLite
