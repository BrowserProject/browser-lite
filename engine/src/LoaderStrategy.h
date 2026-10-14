#pragma once

#include <wtf/Forward.h>

namespace WebCore {
class LoaderStrategy;
class ResourceRequest;
}

namespace BrowserLite {

WebCore::LoaderStrategy& loaderStrategy();

// Laedt die Datei herunter und gibt sie an die Oberflaeche (Events
// download-start / download-done, Daten ueber Module.onEngineDownloadData).
void startDownload(int viewId, const WebCore::ResourceRequest&, const String& suggestedFilename);
// Quelltext einer Adresse laden (wie ein Download, mit viewSource-Merker)
void startViewSource(int viewId, const URL&);
// PDF im Tab anzeigen (Viewer des Host-Browsers) statt herunterladen
void startPDFView(int viewId, const WebCore::ResourceRequest&);

// Cookies aus dem Cookie-Speicher der Engine an die Anfrage haengen
void addCookieHeader(WebCore::ResourceRequest&);

// Laedt ein Favicon und gibt es an die Oberflaeche (Module.onEngineIcon)
void loadIcon(int viewId, const URL&);

} // namespace BrowserLite
