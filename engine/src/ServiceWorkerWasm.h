// Service Worker und SharedWorker im selben Prozess.
//
// In WebKit2 verteilt sich das auf drei Prozesse: die Seite (SWClientConnection),
// den Netzwerk-Prozess (SWServer, Fetch-Abfang) und einen Prozess, in dem der
// Worker laeuft (SWContextManager). Hier ist alles im Engine-Thread, nur das JS
// des Workers laeuft wie bei Web Workern in einem eigenen pthread. Die Teile
// reden direkt miteinander, aber immer ueber den RunLoop (wie bei IPC), damit
// WebCore die gleiche Reihenfolge sieht wie in WebKit2.
//
// Registrierungen und Skripte bleiben unter /data/serviceworkers (SQLite).
//
// SharedWorker: ein Worker pro Ursprung/URL/Name fuer alle Tabs (wie
// WebSharedWorkerServer), mit eigener Page wie die Service Worker.
#pragma once

#include <wtf/Function.h>

namespace WebCore {
class ResourceLoader;
class Settings;
}

namespace BrowserLite::ServiceWorkers {

// Beim Start der Engine (Engine-Thread), vor der ersten Page
void initialize();

// Einstellungen fuer Seiten und die Pages der Worker
void enableIn(WebCore::Settings&);

// LoaderStrategy: Anfrage an einen Service Worker geben, wenn einer zustaendig
// ist. false = normal laden. Sonst ruft der Worker (oder die Antwort "nicht
// behandelt") spaeter networkLoad() auf, um doch normal zu laden.
bool startFetch(WebCore::ResourceLoader&, Function<void()>&& networkLoad);
// Der Loader ist weg (abgebrochen oder fertig): true = es war ein Worker-Fetch
bool cancelFetch(WebCore::ResourceLoader&);
bool isFetching(const WebCore::ResourceLoader&);

} // namespace BrowserLite::ServiceWorkers
