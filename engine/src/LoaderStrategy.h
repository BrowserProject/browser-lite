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

// Laedt die Datei herunter und gibt sie an die Oberflaeche (Events
// download-start / download-done, Daten ueber Module.onEngineDownloadData).
// data: und blob: kommen aus der Engine selber, sonst ein eigener Request.
void startDownload(int viewId, const WebCore::ResourceRequest&, const String& suggestedFilename);
// Quelltext einer Adresse laden (wie ein Download, mit viewSource-Merker)
void startViewSource(int viewId, const URL&);

// Set-Cookie der Antwort speichern, wenn die Anfrage Cookies haben darf
void storeCookies(const WebCore::ResourceRequest&, const WebCore::CurlResponse&);

// Jeder CurlRequest der Engine: User-Agent, Sec-GPC (wenn eingeschaltet),
// dazu Cookies, wenn die Anfrage welche haben darf (allowCookies)
Ref<WebCore::CurlRequest> createCurlRequest(WebCore::ResourceRequest&&, WebCore::CurlRequestClient&);
// Antwort von curl wie fuer einen ResourceLoader: ohne Content-Type den
// MIME-Typ raten wie andere Browser (nach der Endung, sonst HTML)
WebCore::ResourceResponse networkResponse(WebCore::CurlResponse&);
// curl folgt Redirects nicht selber: 3xx mit Location
bool isRedirect(const WebCore::ResourceResponse&);
// Fuer Lader ohne ResourceLoader: die laufende Anfrage endet, die naechste
// startet (wie Chrome, hoechstens 20). Ein Fehler heisst, es geht nicht weiter.
WebCore::ResourceError followRedirect(RefPtr<WebCore::CurlRequest>&, WebCore::CurlRequestClient&, const WebCore::ResourceResponse&, unsigned& redirectCount);

// Laedt ein Favicon und gibt es an die Oberflaeche (Module.onEngineIcon)
void loadIcon(int viewId, const URL&);

} // namespace BrowserLite
