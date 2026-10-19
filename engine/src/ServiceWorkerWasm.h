// Service workers and shared workers in the same process.
//
// In WebKit2 this is spread over three processes: the page
// (SWClientConnection), the network process (SWServer, fetch interception)
// and a process the worker runs in (SWContextManager). Here everything is on
// the engine thread, only the worker's JS runs in its own pthread like web
// workers. The parts talk to each other directly, but always through the
// RunLoop (like IPC), so WebCore sees the same order as in WebKit2.
//
// Registrations and scripts stay under /data/serviceworkers (SQLite).
//
// SharedWorker: one worker per origin/URL/name for all views (like
// WebSharedWorkerServer), with its own page like the service workers.
#pragma once

#include <WebCore/NotificationEventType.h>
#include <wtf/Function.h>

namespace WebCore {
class LocalFrame;
class ResourceLoader;
class Settings;
struct NotificationData;
}

namespace BrowserLite::ServiceWorkers {

// At engine start (engine thread), before the first page
void initialize();

// Settings for pages and the pages of the workers
void enableIn(WebCore::Settings&);

// LoaderStrategy: hand a request to a service worker if one is responsible.
// false = load normally, networkLoad is left untouched for the caller. Otherwise
// it is taken and the worker (or the answer "not handled") later calls it to
// load normally after all.
bool startFetch(WebCore::ResourceLoader&, Function<void()>&& networkLoad);
// The loader is gone (cancelled or finished): true = it was a worker fetch
bool cancelFetch(WebCore::ResourceLoader&);
bool isFetching(const WebCore::ResourceLoader&);

// FrameLoaderClient: loading of a frame ended, committed = with a new document
// (for WindowClient.navigate())
void frameLoadEnded(WebCore::LocalFrame&, bool committed);

// Click or close of a notification from showNotification():
// notificationclick/notificationclose in the worker of the registration
void notificationEvent(WebCore::NotificationData&&, WebCore::NotificationEventType);

} // namespace BrowserLite::ServiceWorkers
