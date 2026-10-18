#include "config.h"
#include "ServiceWorkerWasm.h"

#include "CacheStorageWasm.h"
#include "DeviceClients.h"
#include "Engine.h"
#include "HttpCache.h"
#include "LoaderStrategy.h"
#include "Storage.h"
#include "Strategies.h"
#include "WasmSocketProvider.h"
#include "WebPlatformExtras.h"
#include "WebView.h"
#include <WebCore/BackgroundFetchInformation.h>
#include <WebCore/BackgroundFetchRecordInformation.h>
#include <WebCore/BackgroundFetchStore.h>
#include <WebCore/CacheStorageProvider.h>
#include <WebCore/ContentSecurityPolicyResponseHeaders.h>
#include <WebCore/CookieChangeSubscription.h>
#include <WebCore/CookieJar.h>
#include <WebCore/CrossOriginEmbedderPolicy.h>
#include <WebCore/CurlRequest.h>
#include <WebCore/CurlRequestClient.h>
#include <WebCore/CurlResponse.h>
#include <WebCore/DatabaseProvider.h>
#include <WebCore/Document.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/DocumentLoader.h>
#include <WebCore/Chrome.h>
#include <WebCore/DocumentPage.h>
#include <WebCore/EmptyClients.h>
#include <WebCore/ExceptionData.h>
#include <WebCore/FetchLoader.h>
#include <WebCore/FetchLoaderClient.h>
#include <WebCore/FormData.h>
#include <WebCore/FrameDestructionObserverInlines.h>
#include <WebCore/FrameInlines.h>
#include <WebCore/FrameLoadRequest.h>
#include <WebCore/FrameLoader.h>
#include <WebCore/HTTPHeaderNames.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/MessageWithMessagePorts.h>
#include <WebCore/NavigationPreloadState.h>
#include <WebCore/NavigationScheduler.h>
#include <WebCore/NetworkLoadMetrics.h>
#include <WebCore/NotificationData.h>
#include <WebCore/Page.h>
#include <WebCore/PageConfiguration.h>
#include <WebCore/PushPermissionState.h>
#include <WebCore/PushSubscriptionData.h>
#include <WebCore/ResourceLoader.h>
#include <WebCore/SWClientConnection.h>
#include <WebCore/SWContextManager.h>
#include <WebCore/SWOriginStore.h>
#include <WebCore/SWRegistrationDatabase.h>
#include <WebCore/SWRegistrationStore.h>
#include <WebCore/SWServer.h>
#include <WebCore/SWServerDelegate.h>
#include <WebCore/SWServerRegistration.h>
#include <WebCore/SWServerToContextConnection.h>
#include <WebCore/SWServerWorker.h>
#include <WebCore/ServiceWorkerClientData.h>
#include <WebCore/ServiceWorkerFetch.h>
#include <WebCore/ServiceWorkerJob.h>
#include <WebCore/ServiceWorkerJobData.h>
#include <WebCore/ServiceWorkerProvider.h>
#include <WebCore/ServiceWorkerRegistrationData.h>
#include <WebCore/SecurityOrigin.h>
#include <WebCore/ServiceWorkerTypes.h>
#include <WebCore/ServiceWorkerRoute.h>
#include <WebCore/ServiceWorkerThreadProxy.h>
#include <WebCore/SharedWorkerContextManager.h>
#include <WebCore/SharedWorkerKey.h>
#include <WebCore/SharedWorkerObjectConnection.h>
#include <WebCore/SharedWorkerProvider.h>
#include <WebCore/SharedWorkerThreadProxy.h>
#include <WebCore/TransferredMessagePort.h>
#include <WebCore/UserAgent.h>
#include <WebCore/WorkerInitializationData.h>
#include <WebCore/WorkerOptions.h>
#include <WebCore/Settings.h>
#include <WebCore/StorageNamespaceProvider.h>
#include <WebCore/StorageProvider.h>
#include <WebCore/StorageSessionProvider.h>
#include <WebCore/TextResourceDecoder.h>
#include <WebCore/UserContentProvider.h>
#include <WebCore/WorkerFetchResult.h>
#include <WebCore/WorkerScriptLoader.h>
#include <wtf/Deque.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>
#include <wtf/text/StringBuilder.h>

namespace BrowserLite::ServiceWorkers {

using namespace WebCore;

class ClientConnection;
class ServerConnection;
class ContextConnection;
class FetchTask;

static RefPtr<SWServer>& server()
{
    static NeverDestroyed<RefPtr<SWServer>> instance;
    return instance;
}

// Like IPC: later on the engine thread, never in the middle of the call
static void post(Function<void()>&& function)
{
    RunLoop::mainSingleton().dispatch(WTF::move(function));
}

static ExceptionData notSupported()
{
    return ExceptionData { ExceptionCode::NotSupportedError, "Not supported in browser-lite"_s };
}

// ------------------------------------------------------------ Page (client)

class ClientConnection final : public SWClientConnection {
public:
    static Ref<ClientConnection> create() { return adoptRef(*new ClientConnection); }

    // From the server (protected in SWClientConnection)
    using SWClientConnection::jobRejectedInServer;
    using SWClientConnection::registrationJobResolvedInServer;
    using SWClientConnection::startScriptFetchForServer;
    using SWClientConnection::postMessageToServiceWorkerClient;
    using SWClientConnection::updateRegistrationState;
    using SWClientConnection::updateWorkerState;
    using SWClientConnection::fireUpdateFoundEvent;
    using SWClientConnection::setRegistrationLastUpdateTime;
    using SWClientConnection::setRegistrationUpdateViaCache;
    using SWClientConnection::notifyClientsOfControllerChange;
    using SWClientConnection::updateBackgroundFetchRegistration;

    // Registrations per origin (for mayHaveServiceWorkerRegisteredForOrigin)
    HashCountedSet<SecurityOriginData> origins;

private:
    void matchRegistration(SecurityOriginData&&, const URL&, RegistrationCallback&&) final;
    void getRegistrations(SecurityOriginData&&, const URL&, GetRegistrationsCallback&&) final;
    void whenRegistrationReady(const SecurityOriginData&, const URL&, WhenRegistrationReadyCallback&&) final;
    void addServiceWorkerRegistrationInServer(ServiceWorkerRegistrationIdentifier) final;
    void removeServiceWorkerRegistrationInServer(ServiceWorkerRegistrationIdentifier) final;
    void scheduleUnregisterJobInServer(ServiceWorkerRegistrationIdentifier, ServiceWorkerOrClientIdentifier, CompletionHandler<void(ExceptionOr<bool>&&)>&&) final;
    void registerServiceWorkerInServer(ServiceWorkerIdentifier) final;
    void unregisterServiceWorkerInServer(ServiceWorkerIdentifier) final;
    void didResolveRegistrationPromise(const ServiceWorkerRegistrationKey&) final;
    void postMessageToServiceWorker(ServiceWorkerIdentifier, MessageWithMessagePorts&&, const ServiceWorkerOrClientIdentifier&) final;
    SWServerConnectionIdentifier serverConnectionIdentifier() const final { return Process::identifier(); }
    bool mayHaveServiceWorkerRegisteredForOrigin(const SecurityOriginData& origin) const final { return origins.contains(origin); }
    void registerServiceWorkerClient(const ClientOrigin&, ServiceWorkerClientData&&, const std::optional<ServiceWorkerRegistrationIdentifier>&, String&& userAgent) final;
    void unregisterServiceWorkerClient(ScriptExecutionContextIdentifier) final;
    void finishFetchingScriptInServer(const ServiceWorkerJobDataIdentifier&, ServiceWorkerRegistrationKey&&, WorkerFetchResult&&) final;
    void scheduleJobInServer(const ServiceWorkerJobData&) final;

    // Push, background fetch and cookie store for workers do not exist (yet)
    void subscribeToPushService(ServiceWorkerRegistrationIdentifier, const Vector<uint8_t>&, SubscribeToPushServiceCallback&& callback) final { callback(notSupported().toException()); }
    void unsubscribeFromPushService(ServiceWorkerRegistrationIdentifier, PushSubscriptionIdentifier, UnsubscribeFromPushServiceCallback&& callback) final { callback(false); }
    void getPushSubscription(ServiceWorkerRegistrationIdentifier, GetPushSubscriptionCallback&& callback) final { callback(std::optional<PushSubscriptionData> { }); }
    void getPushPermissionState(ServiceWorkerRegistrationIdentifier, GetPushPermissionStateCallback&& callback) final { callback(PushPermissionState::Denied); }
    // The still shown notifications of the registration
    void getNotifications(const URL& registrationURL, const String& tag, GetNotificationsCallback&& callback) final { callback(shownPersistentNotifications(registrationURL, tag)); }

    void enableNavigationPreload(ServiceWorkerRegistrationIdentifier, ExceptionOrVoidCallback&&) final;
    void disableNavigationPreload(ServiceWorkerRegistrationIdentifier, ExceptionOrVoidCallback&&) final;
    void setNavigationPreloadHeaderValue(ServiceWorkerRegistrationIdentifier, String&&, ExceptionOrVoidCallback&&) final;
    void getNavigationPreloadState(ServiceWorkerRegistrationIdentifier, ExceptionOrNavigationPreloadStateCallback&&) final;

    void startBackgroundFetch(ServiceWorkerRegistrationIdentifier, const String&, Vector<BackgroundFetchRequest>&&, BackgroundFetchOptions&&, ExceptionOrBackgroundFetchInformationCallback&& callback) final { callback(notSupported().toException()); }
    void backgroundFetchInformation(ServiceWorkerRegistrationIdentifier, const String&, ExceptionOrBackgroundFetchInformationCallback&& callback) final { callback(std::optional<BackgroundFetchInformation> { }); }
    void backgroundFetchIdentifiers(ServiceWorkerRegistrationIdentifier, BackgroundFetchIdentifiersCallback&& callback) final { callback({ }); }
    void abortBackgroundFetch(ServiceWorkerRegistrationIdentifier, const String&, AbortBackgroundFetchCallback&& callback) final { callback(false); }
    void matchBackgroundFetch(ServiceWorkerRegistrationIdentifier, const String&, RetrieveRecordsOptions&&, MatchBackgroundFetchCallback&& callback) final { callback({ }); }
    void retrieveRecordResponse(BackgroundFetchRecordIdentifier, RetrieveRecordResponseCallback&& callback) final { callback(notSupported().toException()); }
    void retrieveRecordResponseBody(BackgroundFetchRecordIdentifier, RetrieveRecordResponseBodyCallback&& callback) final { callback(makeUnexpected(ResourceError { ResourceError::Type::General })); }

    void addCookieChangeSubscriptions(ServiceWorkerRegistrationIdentifier, Vector<CookieChangeSubscription>&&, ExceptionOrVoidCallback&& callback) final { callback(notSupported().toException()); }
    void removeCookieChangeSubscriptions(ServiceWorkerRegistrationIdentifier, Vector<CookieChangeSubscription>&&, ExceptionOrVoidCallback&& callback) final { callback(notSupported().toException()); }
    void cookieChangeSubscriptions(ServiceWorkerRegistrationIdentifier, ExceptionOrCookieChangeSubscriptionsCallback&& callback) final { callback(notSupported().toException()); }

    Ref<AddRoutePromise> addRoutes(ServiceWorkerRegistrationIdentifier, Vector<ServiceWorkerRoute>&&) final;
};

static RefPtr<ClientConnection>& clientConnection()
{
    static NeverDestroyed<RefPtr<ClientConnection>> instance;
    return instance;
}

// ------------------------------------------------------------ Server

// The page from the server's point of view (WebSWServerConnection in WebKit2).
// There is only one process, so only this one connection.
class ServerConnection final : public SWServer::Connection {
public:
    static Ref<ServerConnection> create(SWServer& server) { return adoptRef(*new ServerConnection(server)); }

    void scheduleUnregisterJob(ServiceWorkerRegistrationIdentifier, ServiceWorkerOrClientIdentifier, CompletionHandler<void(ExceptionOr<bool>&&)>&&);
    void postMessageToServiceWorker(ServiceWorkerIdentifier, MessageWithMessagePorts&&, const ServiceWorkerOrClientIdentifier&);
    void registerClient(ClientOrigin&&, ServiceWorkerClientData&&, const std::optional<ServiceWorkerRegistrationIdentifier>&, String&& userAgent, SWServer::IsBeingCreatedClient);
    void unregisterClient(ScriptExecutionContextIdentifier);

    using SWServer::Connection::finishFetchingScriptInServer;
    using SWServer::Connection::addServiceWorkerRegistrationInServer;
    using SWServer::Connection::removeServiceWorkerRegistrationInServer;
    using SWServer::Connection::registerServiceWorkerInServer;
    using SWServer::Connection::unregisterServiceWorkerInServer;
    using SWServer::Connection::whenRegistrationReady;

private:
    explicit ServerConnection(SWServer& server)
        : SWServer::Connection(server, Process::identifier())
    {
    }

    URL clientURL(ServiceWorkerOrClientIdentifier);

    // SWServer::Connection (answers to the page)
    void rejectJobInClient(ServiceWorkerJobIdentifier, const ExceptionData&) final;
    void resolveRegistrationJobInClient(ServiceWorkerJobIdentifier, const ServiceWorkerRegistrationData&, ShouldNotifyWhenResolved) final;
    void resolveUnregistrationJobInClient(ServiceWorkerJobIdentifier, const ServiceWorkerRegistrationKey&, bool) final;
    void startScriptFetchInClient(ServiceWorkerJobIdentifier, const ServiceWorkerRegistrationKey&, FetchOptions::Cache) final;
    void updateRegistrationStateInClient(ServiceWorkerRegistrationIdentifier, ServiceWorkerRegistrationState, const std::optional<ServiceWorkerData>&) final;
    void updateWorkerStateInClient(ServiceWorkerIdentifier, ServiceWorkerState) final;
    void fireUpdateFoundEvent(ServiceWorkerRegistrationIdentifier) final;
    void setRegistrationLastUpdateTime(ServiceWorkerRegistrationIdentifier, WallTime) final;
    void setRegistrationUpdateViaCache(ServiceWorkerRegistrationIdentifier, ServiceWorkerUpdateViaCache) final;
    void notifyClientsOfControllerChange(const HashSet<ScriptExecutionContextIdentifier>&, const std::optional<ServiceWorkerData>&) final;
    void postMessageToServiceWorkerClient(ScriptExecutionContextIdentifier, const MessageWithMessagePorts&, ServiceWorkerIdentifier, const SecurityOriginData&) final;
    void focusServiceWorkerClient(ScriptExecutionContextIdentifier, CompletionHandler<void(std::optional<ServiceWorkerClientData>&&)>&&) final;
    void updateBackgroundFetchRegistration(const BackgroundFetchInformation&) final;
    void contextConnectionCreated(SWServerToContextConnection&) final { }

    HashMap<ScriptExecutionContextIdentifier, ClientOrigin> m_clientOrigins;
    HashMap<ServiceWorkerJobIdentifier, CompletionHandler<void(ExceptionOr<bool>&&)>> m_unregisterJobs;
};

static RefPtr<ServerConnection>& serverConnection()
{
    static NeverDestroyed<RefPtr<ServerConnection>> instance;
    return instance;
}

// ------------------------------------------------------------ Worker (context)

// One connection per site to the "process" of the workers, like
// WebSWServerToContextConnection. All workers run here.
class ContextConnection final : public SWServerToContextConnection {
public:
    static Ref<ContextConnection> create(SWServer& server, const Site& site, std::optional<ScriptExecutionContextIdentifier> pageIdentifier)
    {
        return adoptRef(*new ContextConnection(server, Site { site }, pageIdentifier));
    }

    void startFetch(FetchTask&);

private:
    ContextConnection(SWServer& server, Site&& site, std::optional<ScriptExecutionContextIdentifier> pageIdentifier)
        : SWServerToContextConnection(server, WTF::move(site), pageIdentifier)
    {
    }

    void installServiceWorkerContext(const ServiceWorkerContextData&, const ServiceWorkerData&, const String& userAgent, WorkerThreadMode, OptionSet<AdvancedPrivacyProtections>) final;
    void updateAppInitiatedValue(ServiceWorkerIdentifier, LastNavigationWasAppInitiated) final { }
    void fireInstallEvent(ServiceWorkerIdentifier) final;
    void fireActivateEvent(ServiceWorkerIdentifier) final;
    void terminateWorker(ServiceWorkerIdentifier) final;
    void didSaveScriptsToDisk(ServiceWorkerIdentifier, const ScriptBuffer&, const MemoryCompactRobinHoodHashMap<URL, ScriptBuffer>&) final { }
    void firePushEvent(ServiceWorkerIdentifier, const std::optional<Vector<uint8_t>>&, std::optional<NotificationPayload>&&, CompletionHandler<void(bool, std::optional<NotificationPayload>&&)>&& callback) final { callback(false, std::nullopt); }
    void fireNotificationEvent(ServiceWorkerIdentifier, const NotificationData&, NotificationEventType, CompletionHandler<void(bool)>&&) final;
    void fireBackgroundFetchEvent(ServiceWorkerIdentifier, const BackgroundFetchInformation&, CompletionHandler<void(bool)>&& callback) final { callback(false); }
    void fireBackgroundFetchClickEvent(ServiceWorkerIdentifier, const BackgroundFetchInformation&, CompletionHandler<void(bool)>&& callback) final { callback(false); }
    ProcessIdentifier webProcessIdentifier() const final { return Process::identifier(); }
    void openWindow(ServiceWorkerIdentifier, const URL&, OpenWindowCallback&& callback) final { callback(makeUnexpected(notSupported())); }
    void connectionIsNoLongerNeeded() final;
    void terminateDueToUnresponsiveness() final;
    void setInspectable(ServiceWorkerIsInspectable) final { }
#if ENABLE(CONTENT_EXTENSIONS)
    void reportNetworkUsageToWorkerClient(const ScriptExecutionContextIdentifier, uint64_t) final { }
#endif

    HashSet<ServiceWorkerIdentifier> m_workers;
};

// Which connection a worker belongs to (also shortly after it ended)
static HashMap<ServiceWorkerIdentifier, WeakPtr<SWServerToContextConnection>>& workerConnections()
{
    static NeverDestroyed<HashMap<ServiceWorkerIdentifier, WeakPtr<SWServerToContextConnection>>> map;
    return map;
}

static RefPtr<SWServerToContextConnection> contextConnectionFor(ServiceWorkerIdentifier identifier)
{
    return workerConnections().get(identifier);
}

// WindowClient.navigate() (WebPage::navigateServiceWorkerClient in WebKit2).
// Done when the new document in the frame registers as a client (on commit)
// or loading of the frame ends (frameLoadEnded).
struct PendingNavigation {
    ClientOrigin workerOrigin;
    SWContextManager::Connection::NavigateCallback callback;
};

static HashMap<FrameIdentifier, PendingNavigation>& pendingNavigations()
{
    static NeverDestroyed<HashMap<FrameIdentifier, PendingNavigation>> map;
    return map;
}

static void finishNavigation(FrameIdentifier frame, ExceptionOr<std::optional<ServiceWorkerClientData>>&& result)
{
    auto it = pendingNavigations().find(frame);
    if (it == pendingNavigations().end())
        return;
    auto callback = WTF::move(it->value.callback);
    pendingNavigations().remove(it);
    callback(WTF::move(result));
}

static Exception navigateFailed()
{
    return Exception { ExceptionCode::TypeError, "navigate failed"_s };
}

// Foreign origin: null instead of the client (specification)
static std::optional<ServiceWorkerClientData> clientIfSameOrigin(ServiceWorkerClientData&& data, const ClientOrigin& clientOrigin, const ClientOrigin& workerOrigin)
{
    if (clientOrigin != workerOrigin)
        return std::nullopt;
    return WTF::move(data);
}

static void navigateClient(ScriptExecutionContextIdentifier client, ServiceWorkerIdentifier worker, const URL& url, SWContextManager::Connection::NavigateCallback&& callback)
{
    RefPtr serverWorker = SWServerWorker::existingWorkerForIdentifier(worker);
    if (!serverWorker || !serverWorker->isClientActiveServiceWorker(client))
        return callback(Exception { ExceptionCode::TypeError, "service worker is not the client active service worker"_s });
    RefPtr document = Document::allDocumentsMap().get(client);
    RefPtr frame = document ? document->frame() : nullptr;
    if (!frame)
        return callback(Exception { ExceptionCode::TypeError, "cannot navigate service worker client"_s });
    document->navigateFromServiceWorker(url, [document, frame, url, workerOrigin = serverWorker->origin(), callback = WTF::move(callback)](ScheduleLocationChangeResult result) mutable {
        switch (result) {
        case ScheduleLocationChangeResult::Stopped:
            return callback(navigateFailed());
        case ScheduleLocationChangeResult::Completed: // only the anchor
            return callback(clientIfSameOrigin(ServiceWorkerClientData::from(*document), document->clientOrigin(), workerOrigin));
        case ScheduleLocationChangeResult::Started:
            break;
        }
        if (!frame->loader().provisionalDocumentLoader() && !frame->loader().policyDocumentLoader())
            return callback(navigateFailed());
        // Not HTTP (data: etc.): certainly a foreign origin
        if (!url.protocolIsInHTTPFamily())
            return callback(std::optional<ServiceWorkerClientData> { });
        auto frameID = frame->frameID();
        finishNavigation(frameID, navigateFailed());
        pendingNavigations().set(frameID, PendingNavigation { workerOrigin, WTF::move(callback) });
    });
}

// clients.openWindow() (WebCore only allows it shortly after
// notificationclick): a new view in the host. Done like navigate() when the
// document in the new view registers as a client or its loading ends. Only
// http(s) and with the worker as requester, not like input in the address
// bar: otherwise data: and file: (the file system under /data) would pass.
static void openClientWindow(ServiceWorkerIdentifier worker, const URL& url, SWContextManager::Connection::OpenWindowCallback&& callback)
{
    RefPtr serverWorker = SWServerWorker::existingWorkerForIdentifier(worker);
    if (!serverWorker)
        return callback(Exception { ExceptionCode::TypeError, "service worker is gone"_s });
    if (!url.protocolIsInHTTPFamily())
        return callback(Exception { ExceptionCode::TypeError, makeString("ServiceWorkerClients.openWindow() cannot be called with URL "_s, url.string()) });
    // The same size as the other views, the host adjusts it otherwise
    IntSize size { 800, 600 };
    float deviceScaleFactor = 1;
    WebView::forEach([&](WebView& view) {
        size = view.size();
        deviceScaleFactor = view.deviceScaleFactor();
    });
    auto& view = WebView::openFromEngine(0, size, deviceScaleFactor);
    RefPtr frame = view.mainFrame();
    RefPtr document = frame ? frame->document() : nullptr;
    if (!document)
        return callback(navigateFailed());
    pendingNavigations().set(frame->frameID(), PendingNavigation { serverWorker->origin(), WTF::move(callback) });
    Ref requester = serverWorker->origin().clientOrigin.securityOrigin();
    frame->loader().load(FrameLoadRequest { document.releaseNonNull(), requester, ResourceRequest { URL { url } }, { }, InitiatedByMainFrame::Unknown });
}

// WindowClient.focus() (WebCore only allows it shortly after
// notificationclick): the view of the document comes to the front like with window.focus()
static std::optional<ServiceWorkerClientData> focusClient(ScriptExecutionContextIdentifier identifier)
{
    RefPtr document = Document::allDocumentsMap().get(identifier);
    if (!document)
        return std::nullopt;
    if (RefPtr page = document->page())
        page->chrome().focus();
    return ServiceWorkerClientData::from(*document);
}

// What the workers report to "their process" (WebSWContextManagerConnection).
// Always arrives from WebCore on the engine thread.
class ContextManagerConnection final : public SWContextManager::Connection, public RefCounted<ContextManagerConnection> {
public:
    static Ref<ContextManagerConnection> create() { return adoptRef(*new ContextManagerConnection); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    void establishConnection(CompletionHandler<void()>&& callback) final { callback(); }
    void postMessageToServiceWorkerClient(const ScriptExecutionContextIdentifier& destination, const MessageWithMessagePorts& message, ServiceWorkerIdentifier source, const SecurityOriginData& sourceOrigin) final
    {
        post([destination, message = MessageWithMessagePorts { message }, source, sourceOrigin = SecurityOriginData { sourceOrigin }] {
            if (RefPtr server = ServiceWorkers::server()) {
                server->postMessageToServiceWorkerClient(destination, message, source, sourceOrigin, [](auto destination, auto& message, auto& sourceData, auto& sourceOrigin) {
                    if (RefPtr client = clientConnection())
                        client->postMessageToServiceWorkerClient(destination, MessageWithMessagePorts { message }, ServiceWorkerData { sourceData }, sourceOrigin);
                });
            }
        });
    }
    void serviceWorkerStarted(std::optional<ServiceWorkerJobDataIdentifier> job, ServiceWorkerIdentifier identifier, bool doesHandleFetch) final
    {
        if (RefPtr connection = contextConnectionFor(identifier))
            connection->scriptContextStarted(job, identifier, doesHandleFetch);
    }
    void serviceWorkerFailedToStart(std::optional<ServiceWorkerJobDataIdentifier> job, ServiceWorkerIdentifier identifier, const String& message) final
    {
        if (RefPtr connection = contextConnectionFor(identifier))
            connection->scriptContextFailedToStart(job, identifier, message);
    }
    void didFinishInstall(std::optional<ServiceWorkerJobDataIdentifier> job, ServiceWorkerIdentifier identifier, bool wasSuccessful) final
    {
        if (RefPtr connection = contextConnectionFor(identifier))
            connection->didFinishInstall(job, identifier, wasSuccessful);
    }
    void didFinishActivation(ServiceWorkerIdentifier identifier) final
    {
        if (RefPtr connection = contextConnectionFor(identifier))
            connection->didFinishActivation(identifier);
    }
    void setServiceWorkerHasPendingEvents(ServiceWorkerIdentifier identifier, bool hasPendingEvents) final
    {
        if (RefPtr connection = contextConnectionFor(identifier))
            connection->setServiceWorkerHasPendingEvents(identifier, hasPendingEvents);
    }
    void workerTerminated(ServiceWorkerIdentifier identifier) final
    {
        if (RefPtr connection = contextConnectionFor(identifier))
            connection->workerTerminated(identifier);
        workerConnections().remove(identifier);
    }
    void skipWaiting(ServiceWorkerIdentifier identifier, CompletionHandler<void()>&& callback) final
    {
        if (RefPtr server = ServiceWorkers::server()) {
            if (RefPtr worker = server->workerByID(identifier))
                worker->skipWaiting();
        }
        callback();
    }
    void setScriptResource(ServiceWorkerIdentifier identifier, const URL& url, const ServiceWorkerContextData::ImportedScript& script) final
    {
        if (RefPtr connection = contextConnectionFor(identifier))
            connection->setScriptResource(identifier, URL { url }, ServiceWorkerContextData::ImportedScript { script });
    }
    void findClientByVisibleIdentifier(ServiceWorkerIdentifier identifier, const String& clientIdentifier, FindClientByIdentifierCallback&& callback) final
    {
        if (RefPtr connection = contextConnectionFor(identifier))
            return connection->findClientByVisibleIdentifier(identifier, clientIdentifier, WTF::move(callback));
        callback({ });
    }
    void matchAll(ServiceWorkerIdentifier identifier, const ServiceWorkerClientQueryOptions& options, ServiceWorkerClientsMatchAllCallback&& callback) final
    {
        if (RefPtr connection = contextConnectionFor(identifier))
            return connection->matchAll(identifier, options, WTF::move(callback));
        callback({ });
    }
    void claim(ServiceWorkerIdentifier identifier, CompletionHandler<void(ExceptionOr<void>&&)>&& callback) final
    {
        RefPtr connection = contextConnectionFor(identifier);
        if (!connection)
            return callback({ });
        connection->claim(identifier, [callback = WTF::move(callback)](std::optional<ExceptionData>&& error) mutable {
            if (error)
                return callback(error->toException());
            callback({ });
        });
    }
    void focus(ScriptExecutionContextIdentifier identifier, CompletionHandler<void(std::optional<ServiceWorkerClientData>&&)>&& callback) final
    {
        callback(focusClient(identifier));
    }
    void openWindow(ServiceWorkerIdentifier worker, const URL& url, OpenWindowCallback&& callback) final
    {
        post([worker, url, callback = WTF::move(callback)]() mutable {
            openClientWindow(worker, url, WTF::move(callback));
        });
    }
    void navigate(ScriptExecutionContextIdentifier client, ServiceWorkerIdentifier worker, const URL& url, NavigateCallback&& callback) final
    {
        post([client, worker, url, callback = WTF::move(callback)]() mutable {
            navigateClient(client, worker, url, WTF::move(callback));
        });
    }
    void didFailHeartBeatCheck(ServiceWorkerIdentifier identifier) final
    {
        if (RefPtr connection = contextConnectionFor(identifier))
            connection->didFailHeartBeatCheck(identifier);
    }
    void setAsInspected(ServiceWorkerIdentifier, bool) final { }
    bool isThrottleable() const final { return false; }
    PageIdentifier pageIdentifier() const final { return m_pageIdentifier; }
    void stop() final { }
    void reportConsoleMessage(ServiceWorkerIdentifier, MessageSource, MessageLevel, const String& message, unsigned long) final
    {
        debugLog("Service Worker: %s", message.utf8().data());
    }
    void removeNavigationFetch(SWServerConnectionIdentifier, FetchIdentifier) final { }

    PageIdentifier m_pageIdentifier { PageIdentifier::generate() };
};

// ------------------------------------------------------------ Server delegate

// Empty storage for background fetch (not supported)
class NoBackgroundFetchStore final : public BackgroundFetchStore {
public:
    static Ref<NoBackgroundFetchStore> create() { return adoptRef(*new NoBackgroundFetchStore); }

private:
    void initializeFetches(const ServiceWorkerRegistrationKey&, CompletionHandler<void()>&& callback) final { callback(); }
    void clearFetch(const ServiceWorkerRegistrationKey&, const String&, CompletionHandler<void()>&& callback) final { callback(); }
    void clearAllFetches(const ServiceWorkerRegistrationKey&, CompletionHandler<void()>&& callback) final { callback(); }
    void storeFetch(const ServiceWorkerRegistrationKey&, const String&, uint64_t, uint64_t, std::optional<size_t>, Vector<uint8_t>&&, CompletionHandler<void(StoreResult)>&& callback) final { callback(StoreResult::InternalError); }
    void storeFetchResponseBodyChunk(const ServiceWorkerRegistrationKey&, const String&, size_t, const SharedBuffer&, CompletionHandler<void(StoreResult)>&& callback) final { callback(StoreResult::InternalError); }
    void retrieveResponseBody(const ServiceWorkerRegistrationKey&, const String&, size_t, RetrieveRecordResponseBodyCallback&& callback) final { callback(makeUnexpected(ResourceError { ResourceError::Type::General })); }
};

class OriginStore final : public SWOriginStore {
private:
    void importComplete() final { }
    void addToStore(const SecurityOriginData& origin) final
    {
        if (RefPtr client = clientConnection())
            client->origins.add(origin);
    }
    void removeFromStore(const SecurityOriginData& origin) final
    {
        if (RefPtr client = clientConnection())
            client->origins.remove(origin);
    }
    void clearStore() final
    {
        if (RefPtr client = clientConnection())
            client->origins.clear();
    }
};


// Registrations and scripts persistently under /data/serviceworkers (SQLite
// and files, WebCore's SWRegistrationDatabase). In WebKit2 the network process
// does that on its own queue; here directly on the engine thread, the database
// is small.
class RegistrationStore final : public SWRegistrationStore {
public:
    static Ref<RegistrationStore> create(SWServer& server) { return adoptRef(*new RegistrationStore(server)); }

private:
    explicit RegistrationStore(SWServer& server)
        : m_server(server)
        , m_database(makeUnique<SWRegistrationDatabase>("/data/serviceworkers"_s))
    {
    }

    void clearAll(CompletionHandler<void()>&& callback) final
    {
        m_updates.clear();
        m_database->deleteAllFiles();
        callback();
    }
    void flushChanges(CompletionHandler<void()>&& callback) final { write(); callback(); }
    void closeFiles(CompletionHandler<void()>&& callback) final { callback(); }
    void importRegistrationsForOrigin(const SecurityOriginData& topOrigin, CompletionHandler<void(std::optional<Vector<ServiceWorkerContextData>>&&)>&& callback) final
    {
        post([this, protectedThis = Ref { *this }, topOrigin, callback = WTF::move(callback)]() mutable {
            callback(m_database->importRegistrations(topOrigin));
        });
    }
    void importOriginList(CompletionHandler<void(std::optional<HashSet<ClientOrigin>>&&)>&& callback) final
    {
        post([this, protectedThis = Ref { *this }, callback = WTF::move(callback)]() mutable {
            callback(m_database->importOrigins());
        });
    }
    void updateRegistration(const ServiceWorkerContextData& data) final
    {
        m_updates.set(data.registration.key, data.copy());
        scheduleWrite();
    }
    void removeRegistration(const ServiceWorkerRegistrationKey& key) final
    {
        m_updates.set(key, std::nullopt);
        scheduleWrite();
    }
    void retrieveWorkerScripts(ServiceWorkerIdentifier identifier, const ServiceWorkerRegistrationKey& key, const URL& scriptURL, const Vector<URL>& importedScriptURLs, CompletionHandler<void(std::optional<ServiceWorkerScripts>&&)>&& callback) final
    {
        callback(m_database->retrieveWorkerScripts(identifier, key, scriptURL, importedScriptURLs));
    }

    void scheduleWrite()
    {
        if (std::exchange(m_writeScheduled, true))
            return;
        post([this, protectedThis = Ref { *this }] {
            m_writeScheduled = false;
            write();
        });
    }

    void write()
    {
        Vector<ServiceWorkerRegistrationKey> toDelete;
        Vector<ServiceWorkerContextData> toUpdate;
        for (auto& [key, data] : std::exchange(m_updates, { })) {
            if (data)
                toUpdate.append(WTF::move(*data));
            else
                toDelete.append(key);
        }
        if (toUpdate.isEmpty() && toDelete.isEmpty())
            return;
        auto scripts = m_database->updateRegistrations(toUpdate, toDelete);
        RefPtr server = m_server.get();
        if (!scripts || !server)
            return;
        for (auto& script : *scripts)
            server->didSaveWorkerScriptsToDisk(script.identifier, WTF::move(script.mainScript), WTF::move(script.importedScripts));
    }

    WeakPtr<SWServer> m_server;
    std::unique_ptr<SWRegistrationDatabase> m_database;
    HashMap<ServiceWorkerRegistrationKey, std::optional<ServiceWorkerContextData>> m_updates;
    bool m_writeScheduled { false };
};

// ------------------------------------------------------------ Background update

// Loads a worker script without a page (like ServiceWorkerSoftUpdateLoader in
// WebKit2): fresh from the HTTP cache, otherwise from the network (conditional
// with ETag/Last-Modified), no redirects. The server compares the result with
// the stored script and installs the new worker on a change.
class SoftUpdateLoad final : public RefCounted<SoftUpdateLoad>, public CurlRequestClient {
public:
    using Handler = CompletionHandler<void(WorkerFetchResult&&)>;

    static void start(ServiceWorkerJobData&& job, bool shouldRefreshCache, ResourceRequest&& request, Handler&& handler)
    {
        Ref load = adoptRef(*new SoftUpdateLoad(WTF::move(job), WTF::move(handler)));
        load->m_self = load.ptr();
        if (request.httpUserAgent().isEmpty())
            request.setHTTPUserAgent(standardUserAgent());
        HttpCache::lookupForLoad(WTF::move(request), shouldRefreshCache, [load](HttpCache::Lookup&& lookup) {
            if (lookup.fresh)
                return load->loadFromCache(*lookup.entry);
            load->m_cachedEntry = WTF::move(lookup.entry);
            load->loadFromNetwork(WTF::move(lookup.request));
        });
    }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    SoftUpdateLoad(ServiceWorkerJobData&& job, Handler&& handler)
        : m_job(WTF::move(job))
        , m_handler(WTF::move(handler))
    {
    }

    void loadFromNetwork(ResourceRequest&& request)
    {
        m_request = createCurlRequest(WTF::move(request), *this);
        m_request->resume();
    }

    void loadFromCache(HttpCache::Entry& entry)
    {
        if (!processResponse(entry.response))
            return;
        entry.body->forEachSegment([&](auto segment) {
            appendScript(segment);
        });
        succeed();
    }

    // https://w3c.github.io/ServiceWorker/#update-algorithm, steps 9.7 to 9.17
    bool processResponse(const ResourceResponse& response)
    {
        auto source = m_job.workerType == WorkerType::Module ? WorkerScriptLoader::Source::ModuleScript : WorkerScriptLoader::Source::ClassicWorkerScript;
        auto error = WorkerScriptLoader::validateWorkerResponse(response, source, FetchOptions::Destination::Serviceworker);
        if (error.isNull())
            error = ServiceWorkerJob::validateServiceWorkerResponse(m_job, response);
        if (!error.isNull()) {
            done(workerFetchError(error));
            return false;
        }
        m_contentSecurityPolicy = ContentSecurityPolicyResponseHeaders { response };
        m_crossOriginEmbedderPolicy = obtainCrossOriginEmbedderPolicy(response, nullptr);
        m_referrerPolicy = response.httpHeaderField(HTTPHeaderName::ReferrerPolicy);
        if (auto& certificateInfo = response.certificateInfo())
            m_certificateInfo = *certificateInfo;
        // Always UTF-8 like WorkerScriptLoader, otherwise the server would see a
        // changed script with another charset
        Ref decoder = TextResourceDecoder::create("text/javascript"_s, "UTF-8"_s);
        decoder->setAlwaysUseUTF8();
        m_decoder = WTF::move(decoder);
        return true;
    }

    void appendScript(std::span<const uint8_t> data)
    {
        if (m_decoder && !data.empty())
            m_script.append(m_decoder->decode(data));
    }

    void succeed()
    {
        if (m_decoder)
            m_script.append(m_decoder->flush());
        done({ ScriptBuffer { m_script.toString() }, m_job.scriptURL, m_certificateInfo, m_contentSecurityPolicy, m_crossOriginEmbedderPolicy, m_referrerPolicy, { } });
    }

    void done(WorkerFetchResult&& result)
    {
        if (auto request = std::exchange(m_request, nullptr)) {
            request->cancel();
            request->invalidateClient();
        }
        if (auto handler = std::exchange(m_handler, nullptr))
            handler(WTF::move(result));
        m_self = nullptr; // releases us
    }

    void curlDidSendData(CurlRequest&, unsigned long long, unsigned long long) final { }
    void curlDidReceiveResponse(CurlRequest& request, CurlResponse&& curlResponse) final
    {
        Ref protectedThis { *this };
        storeCookies(request.resourceRequest(), curlResponse);
        ResourceResponse response(curlResponse);
        if (response.httpStatusCode() == 304) {
            if (auto entry = std::exchange(m_cachedEntry, nullptr)) {
                HttpCache::didRevalidate(request.resourceRequest(), *entry, response);
                return loadFromCache(*entry);
            }
        }
        if (processResponse(response))
            request.completeDidReceiveResponse();
    }
    void curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&& buffer) final
    {
        appendScript(buffer->span());
    }
    void curlDidComplete(CurlRequest&, NetworkLoadMetrics&&) final
    {
        Ref protectedThis { *this };
        succeed();
    }
    void curlDidFailWithError(CurlRequest&, ResourceError&& error, CertificateInfo&&) final
    {
        Ref protectedThis { *this };
        done(workerFetchError(error));
    }

    ServiceWorkerJobData m_job;
    Handler m_handler;
    RefPtr<CurlRequest> m_request;
    std::unique_ptr<HttpCache::Entry> m_cachedEntry;
    RefPtr<TextResourceDecoder> m_decoder;
    StringBuilder m_script;
    CertificateInfo m_certificateInfo;
    ContentSecurityPolicyResponseHeaders m_contentSecurityPolicy;
    CrossOriginEmbedderPolicy m_crossOriginEmbedderPolicy;
    String m_referrerPolicy;
    RefPtr<SoftUpdateLoad> m_self;
};

class ServerDelegate final : public SWServerDelegate, public CanMakeCheckedPtr<ServerDelegate> {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(ServerDelegate);
    WTF_OVERRIDE_DELETE_FOR_CHECKED_PTR(ServerDelegate);
public:
    uint32_t checkedPtrCount() const final { return CanMakeCheckedPtr::checkedPtrCount(); }
    uint32_t checkedPtrCountWithoutThreadCheck() const final { return CanMakeCheckedPtr::checkedPtrCountWithoutThreadCheck(); }
    void incrementCheckedPtrCount() const final { CanMakeCheckedPtr::incrementCheckedPtrCount(); }
    void decrementCheckedPtrCount() const final { CanMakeCheckedPtr::decrementCheckedPtrCount(); }
    void setDidBeginCheckedPtrDeletion() final { CanMakeCheckedPtr::setDidBeginCheckedPtrDeletion(); }

private:
    // Scripts of a background update (SWServer::startScriptFetch and
    // refreshImportedScripts), in WebKit2 the network process loads them
    void softUpdate(ServiceWorkerJobData&& job, bool shouldRefreshCache, ResourceRequest&& request, CompletionHandler<void(WorkerFetchResult&&)>&& callback) final
    {
        SoftUpdateLoad::start(WTF::move(job), shouldRefreshCache, WTF::move(request), WTF::move(callback));
    }
    void createContextConnection(const Site& site, std::optional<ProcessIdentifier>, std::optional<ScriptExecutionContextIdentifier> pageIdentifier, CrossOriginEmbedderPolicyValue coep, CompletionHandler<void()>&& callback) final
    {
        if (RefPtr server = ServiceWorkers::server()) {
            Ref connection = ContextConnection::create(*server, site, pageIdentifier);
            connection->setCrossOriginEmbedderPolicyValue(coep);
            server->addContextConnection(connection.get());
            m_contextConnections.append(WTF::move(connection));
        }
        callback();
    }
    void appBoundDomains(CompletionHandler<void(HashSet<RegistrableDomain>&&)>&& callback) final { callback({ }); }
    void addAllowedFirstPartyForCookies(ProcessIdentifier, std::optional<ProcessIdentifier>, RegistrableDomain&&) final { }
    void requestBackgroundFetchPermission(const ClientOrigin&, CompletionHandler<void(bool)>&& callback) final { callback(false); }
    RefPtr<BackgroundFetchRecordLoader> createBackgroundFetchRecordLoader(BackgroundFetchRecordLoaderClient&, const BackgroundFetchRequest&, size_t, const ClientOrigin&) final { return nullptr; }
    Ref<BackgroundFetchStore> createBackgroundFetchStore() final { return NoBackgroundFetchStore::create(); }
    RefPtr<SWRegistrationStore> createRegistrationStore(SWServer& server) final { return RegistrationStore::create(server); }

public:
    void forget(SWServerToContextConnection& connection)
    {
        m_contextConnections.removeFirstMatching([&](auto& item) { return item.ptr() == &connection; });
    }

private:
    Vector<Ref<ContextConnection>> m_contextConnections;
};

static ServerDelegate& serverDelegate()
{
    static NeverDestroyed<ServerDelegate> delegate;
    return delegate;
}

class Provider final : public ServiceWorkerProvider {
public:
    SWClientConnection& serviceWorkerConnection() final { return *clientConnection(); }
    SWClientConnection* existingServiceWorkerConnection() final { return clientConnection().get(); }
    void terminateWorkerForTesting(ServiceWorkerIdentifier, CompletionHandler<void()>&& callback) final { callback(); }
};

// ------------------------------------------------------------ ClientConnection

void ClientConnection::matchRegistration(SecurityOriginData&& topOrigin, const URL& clientURL, RegistrationCallback&& callback)
{
    post([topOrigin = WTF::move(topOrigin), clientURL, callback = WTF::move(callback)]() mutable {
        serverConnection()->doRegistrationMatching(topOrigin, clientURL, WTF::move(callback));
    });
}

void ClientConnection::getRegistrations(SecurityOriginData&& topOrigin, const URL& clientURL, GetRegistrationsCallback&& callback)
{
    post([topOrigin = WTF::move(topOrigin), clientURL, callback = WTF::move(callback)]() mutable {
        server()->getRegistrations(topOrigin, clientURL, WTF::move(callback));
    });
}

void ClientConnection::whenRegistrationReady(const SecurityOriginData& topOrigin, const URL& clientURL, WhenRegistrationReadyCallback&& callback)
{
    post([topOrigin, clientURL, callback = WTF::move(callback)]() mutable {
        serverConnection()->whenRegistrationReady(topOrigin, clientURL, [callback = WTF::move(callback)](std::optional<ServiceWorkerRegistrationData>&& data) mutable {
            if (data)
                callback(WTF::move(*data));
        });
    });
}

void ClientConnection::addServiceWorkerRegistrationInServer(ServiceWorkerRegistrationIdentifier identifier)
{
    post([identifier] { serverConnection()->addServiceWorkerRegistrationInServer(identifier); });
}

void ClientConnection::removeServiceWorkerRegistrationInServer(ServiceWorkerRegistrationIdentifier identifier)
{
    post([identifier] { serverConnection()->removeServiceWorkerRegistrationInServer(identifier); });
}

void ClientConnection::scheduleUnregisterJobInServer(ServiceWorkerRegistrationIdentifier registration, ServiceWorkerOrClientIdentifier context, CompletionHandler<void(ExceptionOr<bool>&&)>&& callback)
{
    post([registration, context, callback = WTF::move(callback)]() mutable {
        serverConnection()->scheduleUnregisterJob(registration, context, WTF::move(callback));
    });
}

void ClientConnection::registerServiceWorkerInServer(ServiceWorkerIdentifier identifier)
{
    post([identifier] { serverConnection()->registerServiceWorkerInServer(identifier); });
}

void ClientConnection::unregisterServiceWorkerInServer(ServiceWorkerIdentifier identifier)
{
    post([identifier] { serverConnection()->unregisterServiceWorkerInServer(identifier); });
}

void ClientConnection::didResolveRegistrationPromise(const ServiceWorkerRegistrationKey& key)
{
    post([key] { serverConnection()->didResolveRegistrationPromise(key); });
}

void ClientConnection::postMessageToServiceWorker(ServiceWorkerIdentifier destination, MessageWithMessagePorts&& message, const ServiceWorkerOrClientIdentifier& source)
{
    post([destination, message = WTF::move(message), source]() mutable {
        serverConnection()->postMessageToServiceWorker(destination, WTF::move(message), source);
    });
}

void ClientConnection::registerServiceWorkerClient(const ClientOrigin& clientOrigin, ServiceWorkerClientData&& data, const std::optional<ServiceWorkerRegistrationIdentifier>& controllingRegistration, String&& userAgent)
{
    post([clientOrigin, data = WTF::move(data), controllingRegistration, userAgent = WTF::move(userAgent)]() mutable {
        serverConnection()->registerClient(ClientOrigin { clientOrigin }, WTF::move(data), controllingRegistration, WTF::move(userAgent), SWServer::IsBeingCreatedClient::No);
    });
}

void ClientConnection::unregisterServiceWorkerClient(ScriptExecutionContextIdentifier identifier)
{
    post([identifier] { serverConnection()->unregisterClient(identifier); });
}

void ClientConnection::finishFetchingScriptInServer(const ServiceWorkerJobDataIdentifier& job, ServiceWorkerRegistrationKey&& key, WorkerFetchResult&& result)
{
    post([job, key = WTF::move(key), result = WTF::move(result)]() mutable {
        serverConnection()->finishFetchingScriptInServer(job, key, WTF::move(result));
    });
}

void ClientConnection::scheduleJobInServer(const ServiceWorkerJobData& jobData)
{
    post([jobData = ServiceWorkerJobData { jobData }] () mutable {
        if (jobData.scopeURL.isNull()) {
            if (RefPtr client = clientConnection())
                client->jobRejectedInServer(jobData.identifier().jobIdentifier, ExceptionData { ExceptionCode::InvalidStateError, "Scope URL is empty"_s });
            return;
        }
        server()->scheduleJob(WTF::move(jobData));
    });
}

static RefPtr<SWServerRegistration> registrationFor(ServiceWorkerRegistrationIdentifier identifier)
{
    RefPtr server = ServiceWorkers::server();
    return server ? server->getRegistration(identifier) : nullptr;
}

void ClientConnection::enableNavigationPreload(ServiceWorkerRegistrationIdentifier identifier, ExceptionOrVoidCallback&& callback)
{
    RefPtr registration = registrationFor(identifier);
    if (!registration)
        return callback(Exception { ExceptionCode::InvalidStateError, "No registration"_s });
    auto result = registration->enableNavigationPreload();
    if (result)
        return callback(result->toException());
    callback({ });
}

void ClientConnection::disableNavigationPreload(ServiceWorkerRegistrationIdentifier identifier, ExceptionOrVoidCallback&& callback)
{
    RefPtr registration = registrationFor(identifier);
    if (!registration)
        return callback(Exception { ExceptionCode::InvalidStateError, "No registration"_s });
    auto result = registration->disableNavigationPreload();
    if (result)
        return callback(result->toException());
    callback({ });
}

void ClientConnection::setNavigationPreloadHeaderValue(ServiceWorkerRegistrationIdentifier identifier, String&& value, ExceptionOrVoidCallback&& callback)
{
    RefPtr registration = registrationFor(identifier);
    if (!registration)
        return callback(Exception { ExceptionCode::InvalidStateError, "No registration"_s });
    auto result = registration->setNavigationPreloadHeaderValue(WTF::move(value));
    if (result)
        return callback(result->toException());
    callback({ });
}

void ClientConnection::getNavigationPreloadState(ServiceWorkerRegistrationIdentifier identifier, ExceptionOrNavigationPreloadStateCallback&& callback)
{
    RefPtr registration = registrationFor(identifier);
    if (!registration)
        return callback(Exception { ExceptionCode::InvalidStateError, "No registration"_s });
    callback(NavigationPreloadState { registration->navigationPreloadState() });
}

Ref<SWClientConnection::AddRoutePromise> ClientConnection::addRoutes(ServiceWorkerRegistrationIdentifier identifier, Vector<ServiceWorkerRoute>&& routes)
{
    AddRoutePromise::Producer producer;
    Ref promise = producer.promise();
    server()->addRoutes(identifier, WTF::move(routes), [producer = WTF::move(producer)](Expected<void, ExceptionData>&& result) mutable {
        producer.settle(WTF::move(result));
    });
    return promise;
}

// ------------------------------------------------------------ ServerConnection

URL ServerConnection::clientURL(ServiceWorkerOrClientIdentifier context)
{
    RefPtr server = this->server();
    if (!server)
        return { };
    return WTF::switchOn(context, [&](ScriptExecutionContextIdentifier client) -> URL {
        auto it = m_clientOrigins.find(client);
        if (it == m_clientOrigins.end())
            return { };
        auto data = server->serviceWorkerClientWithOriginByID(it->value, client);
        return data ? data->url : URL { };
    }, [&](ServiceWorkerIdentifier worker) -> URL {
        RefPtr serverWorker = server->workerByID(worker);
        return serverWorker ? serverWorker->data().scriptURL : URL { };
    });
}

void ServerConnection::scheduleUnregisterJob(ServiceWorkerRegistrationIdentifier registrationIdentifier, ServiceWorkerOrClientIdentifier context, CompletionHandler<void(ExceptionOr<bool>&&)>&& callback)
{
    RefPtr server = this->server();
    RefPtr registration = server ? server->getRegistration(registrationIdentifier) : nullptr;
    if (!registration)
        return callback(false);
    auto url = clientURL(context);
    if (!url.isValid())
        return callback(Exception { ExceptionCode::InvalidStateError, "Client is unknown"_s });
    auto job = ServiceWorkerJobIdentifier::generate();
    m_unregisterJobs.add(job, WTF::move(callback));
    server->scheduleUnregisterJob(ServiceWorkerJobDataIdentifier { identifier(), job }, *registration, context, WTF::move(url));
}

void ServerConnection::postMessageToServiceWorker(ServiceWorkerIdentifier destination, MessageWithMessagePorts&& message, const ServiceWorkerOrClientIdentifier& source)
{
    RefPtr server = this->server();
    RefPtr worker = server ? server->workerByID(destination) : nullptr;
    if (!worker)
        return;

    std::optional<ServiceWorkerOrClientData> sourceData;
    WTF::switchOn(source, [&](ServiceWorkerIdentifier identifier) {
        if (RefPtr sourceWorker = server->workerByID(identifier))
            sourceData = ServiceWorkerOrClientData { sourceWorker->data() };
    }, [&](ScriptExecutionContextIdentifier identifier) {
        if (auto clientData = worker->findClientByIdentifier(identifier))
            sourceData = ServiceWorkerOrClientData { *clientData };
    });
    if (!sourceData)
        return;

    server->runServiceWorkerIfNecessary(destination, [destination, message = WTF::move(message), sourceData = WTF::move(*sourceData)](auto* contextConnection) mutable {
        if (!contextConnection)
            return;
        if (RefPtr proxy = SWContextManager::singleton().serviceWorkerThreadProxy(destination))
            proxy->fireMessageEvent(WTF::move(message), WTF::move(sourceData));
    });
}

void ServerConnection::registerClient(ClientOrigin&& clientOrigin, ServiceWorkerClientData&& data, const std::optional<ServiceWorkerRegistrationIdentifier>& controllingRegistration, String&& userAgent, SWServer::IsBeingCreatedClient isBeingCreated)
{
    if (isBeingCreated == SWServer::IsBeingCreatedClient::No && data.frameIdentifier) {
        if (auto it = pendingNavigations().find(*data.frameIdentifier); it != pendingNavigations().end())
            finishNavigation(*data.frameIdentifier, clientIfSameOrigin(ServiceWorkerClientData { data }, clientOrigin, it->value.workerOrigin));
    }
    auto& contextOrigin = clientOrigin.clientOrigin;
    // Like WebKit2: no sandboxed documents
    if (data.url.protocolIsInHTTPFamily() && contextOrigin != SecurityOriginData::fromURLWithoutStrictOpaqueness(data.url))
        return;
    if (contextOrigin.isNull())
        return;
    RefPtr server = this->server();
    if (!server)
        return;

    m_clientOrigins.add(data.identifier, clientOrigin);
    if (isBeingCreated == SWServer::IsBeingCreatedClient::No) {
        for (auto&& pending : server->releaseServiceWorkerClientPendingMessage(data.identifier)) {
            if (RefPtr client = clientConnection())
                client->postMessageToServiceWorkerClient(data.identifier, WTF::move(pending.message), WTF::move(pending.sourceData), pending.sourceOrigin);
        }
    }
    server->registerServiceWorkerClient(WTF::move(clientOrigin), WTF::move(data), controllingRegistration, WTF::move(userAgent), isBeingCreated);
}

void ServerConnection::unregisterClient(ScriptExecutionContextIdentifier identifier)
{
    auto it = m_clientOrigins.find(identifier);
    if (it == m_clientOrigins.end())
        return;
    auto clientOrigin = it->value;
    m_clientOrigins.remove(it);
    if (RefPtr server = this->server())
        server->unregisterServiceWorkerClient(clientOrigin, identifier);
}

void ServerConnection::rejectJobInClient(ServiceWorkerJobIdentifier job, const ExceptionData& error)
{
    if (auto callback = m_unregisterJobs.take(job))
        return callback(error.toException());
    post([job, error] {
        if (RefPtr client = clientConnection())
            client->jobRejectedInServer(job, ExceptionData { error });
    });
}

void ServerConnection::resolveRegistrationJobInClient(ServiceWorkerJobIdentifier job, const ServiceWorkerRegistrationData& data, ShouldNotifyWhenResolved notify)
{
    post([job, data = ServiceWorkerRegistrationData { data }, notify]() mutable {
        if (RefPtr client = clientConnection())
            client->registrationJobResolvedInServer(job, WTF::move(data), notify);
    });
}

void ServerConnection::resolveUnregistrationJobInClient(ServiceWorkerJobIdentifier job, const ServiceWorkerRegistrationKey&, bool result)
{
    if (auto callback = m_unregisterJobs.take(job))
        callback(result);
}

void ServerConnection::startScriptFetchInClient(ServiceWorkerJobIdentifier job, const ServiceWorkerRegistrationKey& key, FetchOptions::Cache cache)
{
    post([job, key = ServiceWorkerRegistrationKey { key }, cache]() mutable {
        if (RefPtr client = clientConnection())
            client->startScriptFetchForServer(job, WTF::move(key), cache);
    });
}

void ServerConnection::updateRegistrationStateInClient(ServiceWorkerRegistrationIdentifier identifier, ServiceWorkerRegistrationState state, const std::optional<ServiceWorkerData>& data)
{
    post([identifier, state, data] {
        if (RefPtr client = clientConnection())
            client->updateRegistrationState(identifier, state, data);
        SWContextManager::singleton().updateRegistrationState(identifier, state, data);
    });
}

void ServerConnection::updateWorkerStateInClient(ServiceWorkerIdentifier identifier, ServiceWorkerState state)
{
    post([identifier, state] {
        if (RefPtr client = clientConnection())
            client->updateWorkerState(identifier, state);
        SWContextManager::singleton().updateWorkerState(identifier, state);
    });
}

void ServerConnection::fireUpdateFoundEvent(ServiceWorkerRegistrationIdentifier identifier)
{
    post([identifier] {
        if (RefPtr client = clientConnection())
            client->fireUpdateFoundEvent(identifier);
        SWContextManager::singleton().fireUpdateFoundEvent(identifier);
    });
}

void ServerConnection::setRegistrationLastUpdateTime(ServiceWorkerRegistrationIdentifier identifier, WallTime time)
{
    post([identifier, time] {
        if (RefPtr client = clientConnection())
            client->setRegistrationLastUpdateTime(identifier, time);
        SWContextManager::singleton().setRegistrationLastUpdateTime(identifier, time);
    });
}

void ServerConnection::setRegistrationUpdateViaCache(ServiceWorkerRegistrationIdentifier identifier, ServiceWorkerUpdateViaCache value)
{
    post([identifier, value] {
        if (RefPtr client = clientConnection())
            client->setRegistrationUpdateViaCache(identifier, value);
        SWContextManager::singleton().setRegistrationUpdateViaCache(identifier, value);
    });
}

void ServerConnection::notifyClientsOfControllerChange(const HashSet<ScriptExecutionContextIdentifier>& contexts, const std::optional<ServiceWorkerData>& controller)
{
    post([contexts, controller = std::optional<ServiceWorkerData> { controller }]() mutable {
        if (RefPtr client = clientConnection())
            client->notifyClientsOfControllerChange(contexts, WTF::move(controller));
    });
}

void ServerConnection::postMessageToServiceWorkerClient(ScriptExecutionContextIdentifier destination, const MessageWithMessagePorts& message, ServiceWorkerIdentifier source, const SecurityOriginData& sourceOrigin)
{
    RefPtr server = this->server();
    if (!server)
        return;
    server->postMessageToServiceWorkerClient(destination, message, source, sourceOrigin, [](auto destination, auto& message, auto& sourceData, auto& sourceOrigin) {
        post([destination, message = MessageWithMessagePorts { message }, sourceData = ServiceWorkerData { sourceData }, sourceOrigin = SecurityOriginData { sourceOrigin }]() mutable {
            if (RefPtr client = clientConnection())
                client->postMessageToServiceWorkerClient(destination, WTF::move(message), WTF::move(sourceData), sourceOrigin);
        });
    });
}

void ServerConnection::focusServiceWorkerClient(ScriptExecutionContextIdentifier identifier, CompletionHandler<void(std::optional<ServiceWorkerClientData>&&)>&& callback)
{
    callback(focusClient(identifier));
}

void ServerConnection::updateBackgroundFetchRegistration(const BackgroundFetchInformation& information)
{
    post([information] {
        if (RefPtr client = clientConnection())
            client->updateBackgroundFetchRegistration(information);
    });
}

// ------------------------------------------------------------ ContextConnection

// Own page for the worker, like WebSWContextManagerConnection::installServiceWorker
class SessionProvider final : public StorageSessionProvider {
public:
    static Ref<SessionProvider> create() { return adoptRef(*new SessionProvider); }
    NetworkStorageSession* storageSession() const final { return &networkStorageSession(); }
};

static Ref<CacheStorageProvider>& cacheStorageProvider()
{
    static NeverDestroyed<Ref<CacheStorageProvider>> provider { createCacheStorageProvider() };
    return provider;
}

// Page in which a service worker or shared worker runs (without a window)
static Ref<Page> createWorkerPage()
{
    auto configuration = pageConfigurationWithEmptyClients(PageIdentifier::generate(), PAL::SessionID::defaultSessionID());
    configuration.cookieJar = CookieJar::create(SessionProvider::create());
    configuration.storageNamespaceProvider = &storageNamespaceProvider();
    configuration.databaseProvider = &databaseProvider();
    configuration.socketProvider = createSocketProvider();
    configuration.storageProvider = createStorageProvider();
    configuration.cacheStorageProvider = cacheStorageProvider().copyRef();
    configuration.userContentProvider = userContentProvider();
    Ref page = Page::create(WTF::move(configuration));
    auto& settings = page->settings();
    settings.setScriptEnabled(true);
    settings.setGlobalPrivacyControlEnabled(WebView::preferences().contains(WebView::Preference::GlobalPrivacyControl));
    enableIn(settings);
    return page;
}

void ContextConnection::installServiceWorkerContext(const ServiceWorkerContextData& contextData, const ServiceWorkerData& workerData, const String& userAgent, WorkerThreadMode mode, OptionSet<AdvancedPrivacyProtections> privacy)
{
    auto identifier = contextData.serviceWorkerIdentifier;
    m_workers.add(identifier);
    workerConnections().set(identifier, WeakPtr<SWServerToContextConnection> { *this });

    Ref page = createWorkerPage();
    page->setupForRemoteWorker(contextData.scriptURL, contextData.registration.key.topOrigin(), contextData.referrerPolicy, privacy);

    debugLog("Service worker %s: starting", contextData.scriptURL.string().utf8().data());
    auto proxy = ServiceWorkerThreadProxy::create(WTF::move(page), contextData.isolatedCopy(), workerData.isolatedCopy(), String { userAgent }, mode, cacheStorageProvider().get(), createServiceWorkerNotificationClient());
    SWContextManager::singleton().registerServiceWorkerThreadForInstall(WTF::move(proxy));
}

void ContextConnection::fireInstallEvent(ServiceWorkerIdentifier identifier)
{
    if (RefPtr proxy = SWContextManager::singleton().serviceWorkerThreadProxy(identifier))
        proxy->fireInstallEvent();
}

void ContextConnection::fireActivateEvent(ServiceWorkerIdentifier identifier)
{
    if (RefPtr proxy = SWContextManager::singleton().serviceWorkerThreadProxy(identifier))
        proxy->fireActivateEvent();
}

void ContextConnection::terminateWorker(ServiceWorkerIdentifier identifier)
{
    m_workers.remove(identifier);
    SWContextManager::singleton().terminateWorker(identifier, SWContextManager::workerTerminationTimeout, nullptr);
}

void ContextConnection::connectionIsNoLongerNeeded()
{
    // WebKit2 terminates the workers' process here
    for (auto identifier : std::exchange(m_workers, { }))
        SWContextManager::singleton().terminateWorker(identifier, SWContextManager::workerTerminationTimeout, nullptr);
    Ref protectedThis { *this };
    if (RefPtr server = this->server())
        server->removeContextConnection(*this);
    serverDelegate().forget(*this);
}

void ContextConnection::terminateDueToUnresponsiveness()
{
    for (auto identifier : m_workers)
        SWContextManager::singleton().terminateWorker(identifier, 0_s, nullptr);
}

void ContextConnection::fireNotificationEvent(ServiceWorkerIdentifier identifier, const NotificationData& data, NotificationEventType type, CompletionHandler<void(bool)>&& callback)
{
    post([identifier, data = NotificationData { data }, type, callback = WTF::move(callback)]() mutable {
        SWContextManager::singleton().fireNotificationEvent(identifier, WTF::move(data), type, WTF::move(callback));
    });
}

void notificationEvent(NotificationData&& data, NotificationEventType type)
{
    // Without JavaScript no service worker runs (applyPreferences in WebView.cpp)
    if (WebView::preferences().contains(WebView::Preference::NoJavaScript))
        return;
    if (RefPtr server = ServiceWorkers::server())
        server->processNotificationEvent(WTF::move(data), type, [](bool) { });
}

// ------------------------------------------------------------ Navigation Preload

// Loads a navigation while the worker starts (like
// ServiceWorkerNavigationPreloader in WebKit2), with the header
// Service-Worker-Navigation-Preload. The response goes to the worker as
// preloadResponse. Exactly one reads the body: the navigation itself
// (respondWith(preloadResponse)) or the loader in the worker that fetches the
// body of the preloadResponse (navigationPreloadIdentifier). Until then curl
// pauses. It does not follow redirects, the worker gets them as
// opaqueredirect. Like WebKit2 it asks the HTTP cache first: a fresh response
// comes from there, otherwise the request goes (conditionally) with the header
// to the network.
class NavigationPreloader final : public RefCounted<NavigationPreloader>, public CurlRequestClient {
public:
    class Reader {
    public:
        virtual ~Reader() = default;
        virtual void preloadData(const SharedBuffer&) = 0;
        virtual void preloadFinished(const NetworkLoadMetrics&) = 0;
        virtual void preloadFailed(const ResourceError&) = 0;
    };

    static Ref<NavigationPreloader> create(ResourceRequest request, const NavigationPreloadState& state)
    {
        Ref preloader = adoptRef(*new NavigationPreloader);
        HttpCache::lookupForLoad(WTF::move(request), false, [preloader, headerValue = state.headerValue](HttpCache::Lookup&& lookup) {
            if (preloader->m_cancelled)
                return;
            if (lookup.fresh)
                return preloader->useCacheEntry(*lookup.entry, ResourceResponse::Source::DiskCache);
            lookup.request.addHTTPHeaderField(HTTPHeaderName::ServiceWorkerNavigationPreload, headerValue);
            preloader->m_cachedEntry = WTF::move(lookup.entry);
            preloader->m_request = createCurlRequest(WTF::move(lookup.request), preloader.get());
            preloader->m_request->resume();
        });
        return preloader;
    }

    ~NavigationPreloader() { stop(); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    // Right away if the response (or the error) is already there
    void whenResponse(Function<void()>&& callback)
    {
        if (m_hasResponse || !m_error.isNull())
            return callback();
        m_responseCallback = WTF::move(callback);
    }
    const ResourceResponse& response() const { return m_response; }
    const ResourceError& error() const { return m_error; }

    // Only after whenResponse: the body goes to reader
    void readBody(Reader& reader)
    {
        if (!m_error.isNull())
            return reader.preloadFailed(m_error);
        if (RefPtr body = std::exchange(m_cachedBody, nullptr)) {
            Ref protectedThis { *this };
            if (body->size())
                reader.preloadData(*body);
            return reader.preloadFinished(m_metrics);
        }
        if (!m_request)
            return reader.preloadFinished(m_metrics);
        m_reader = &reader;
        m_request->completeDidReceiveResponse();
    }

    void cancel()
    {
        m_cancelled = true;
        m_reader = nullptr;
        m_responseCallback = nullptr;
        stop();
    }

private:
    NavigationPreloader() = default;

    // Response from the HTTP cache, the body is already there
    void useCacheEntry(HttpCache::Entry& entry, ResourceResponse::Source source)
    {
        m_response = entry.response;
        m_response.setSource(source);
        m_cachedBody = entry.body->makeContiguous();
        m_metrics.markComplete();
        responseIsReady();
    }

    void stop()
    {
        if (auto request = std::exchange(m_request, nullptr)) {
            request->cancel();
            request->invalidateClient();
        }
    }

    void responseIsReady()
    {
        m_hasResponse = true;
        if (auto callback = std::exchange(m_responseCallback, nullptr))
            callback();
    }

    void curlDidSendData(CurlRequest&, unsigned long long, unsigned long long) final { }
    void curlDidReceiveResponse(CurlRequest& request, CurlResponse&& curlResponse) final
    {
        Ref protectedThis { *this };
        storeCookies(request.resourceRequest(), curlResponse);
        m_response = networkResponse(curlResponse);
        if (auto entry = std::exchange(m_cachedEntry, nullptr); entry && m_response.httpStatusCode() == 304) {
            HttpCache::didRevalidate(request.resourceRequest(), *entry, m_response);
            stop();
            return useCacheEntry(*entry, ResourceResponse::Source::DiskCacheAfterValidation);
        }
        if (isRedirect(m_response)) {
            m_response.setTainting(ResourceResponse::Tainting::Opaqueredirect);
            stop();
        }
        responseIsReady();
    }
    void curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&& buffer) final
    {
        Ref protectedThis { *this };
        if (m_reader)
            m_reader->preloadData(buffer.get());
    }
    void curlDidComplete(CurlRequest&, NetworkLoadMetrics&& metrics) final
    {
        Ref protectedThis { *this };
        m_request = nullptr;
        m_metrics = WTF::move(metrics);
        if (auto* reader = std::exchange(m_reader, nullptr))
            reader->preloadFinished(m_metrics);
    }
    void curlDidFailWithError(CurlRequest&, ResourceError&& error, CertificateInfo&&) final
    {
        Ref protectedThis { *this };
        m_request = nullptr;
        m_error = WTF::move(error);
        if (auto* reader = std::exchange(m_reader, nullptr))
            reader->preloadFailed(m_error);
        if (auto callback = std::exchange(m_responseCallback, nullptr))
            callback();
    }

    RefPtr<CurlRequest> m_request;
    ResourceResponse m_response;
    ResourceError m_error;
    NetworkLoadMetrics m_metrics;
    bool m_hasResponse { false };
    bool m_cancelled { false };
    Function<void()> m_responseCallback;
    Reader* m_reader { nullptr };
    // HTTP cache: entry being revalidated, or body from the cache
    std::unique_ptr<HttpCache::Entry> m_cachedEntry;
    RefPtr<SharedBuffer> m_cachedBody;
};

// Preloads nobody has read yet, by the identifier of the worker fetch
static HashMap<FetchIdentifier, Ref<NavigationPreloader>>& unreadPreloaders()
{
    static NeverDestroyed<HashMap<FetchIdentifier, Ref<NavigationPreloader>>> map;
    return map;
}

// The loader in the worker that fetches the body of the preloadResponse
class PreloadLoad final : public RefCounted<PreloadLoad>, public NavigationPreloader::Reader {
public:
    static Ref<PreloadLoad> create(ResourceLoader& loader, NavigationPreloader& preloader) { return adoptRef(*new PreloadLoad(loader, preloader)); }

    void start();
    void cancel()
    {
        m_loader = nullptr;
        m_preloader->cancel();
    }

private:
    PreloadLoad(ResourceLoader& loader, NavigationPreloader& preloader)
        : m_loader(&loader)
        , m_preloader(preloader)
    {
    }

    void preloadData(const SharedBuffer& buffer) final
    {
        if (RefPtr loader = m_loader)
            loader->didReceiveBuffer(buffer, buffer.size(), DataPayloadBytes);
    }
    void preloadFinished(const NetworkLoadMetrics& metrics) final
    {
        if (RefPtr loader = end())
            loader->didFinishLoading(metrics);
    }
    void preloadFailed(const ResourceError& error) final
    {
        if (RefPtr loader = end())
            loader->didFail(error);
    }
    RefPtr<ResourceLoader> end();

    RefPtr<ResourceLoader> m_loader;
    Ref<NavigationPreloader> m_preloader;
};

static HashMap<const ResourceLoader*, Ref<PreloadLoad>>& preloadLoads()
{
    static NeverDestroyed<HashMap<const ResourceLoader*, Ref<PreloadLoad>>> map;
    return map;
}

void PreloadLoad::start()
{
    if (!m_loader)
        return;
    if (!m_preloader->error().isNull()) {
        preloadFailed(m_preloader->error());
        return;
    }
    m_loader->didReceiveResponse(ResourceResponse { m_preloader->response() }, [this, protectedThis = Ref { *this }] {
        if (m_loader)
            m_preloader->readBody(*this);
    });
}

RefPtr<ResourceLoader> PreloadLoad::end()
{
    Ref protectedThis { *this };
    RefPtr loader = std::exchange(m_loader, nullptr);
    if (loader)
        preloadLoads().remove(loader.get());
    return loader;
}

// ------------------------------------------------------------ Fetch interception

// A request the service worker answers (ServiceWorkerFetchTask and
// WebServiceWorkerFetchTaskClient in WebKit2 together). The worker's calls
// arrive on its thread and go to the engine thread, there to the page's
// ResourceLoader.
class FetchTask final : public ServiceWorkerFetch::Client, public NavigationPreloader::Reader {
public:
    static Ref<FetchTask> create(ResourceLoader& loader, Function<void()>&& networkLoad, SWServerRegistration& registration, ServiceWorkerIdentifier worker)
    {
        return adoptRef(*new FetchTask(loader, WTF::move(networkLoad), registration, worker));
    }

    ~FetchTask();

    FetchIdentifier identifier() const { return m_identifier; }
    ServiceWorkerIdentifier worker() const { return m_worker; }
    ResourceRequest request() const { return m_request; }
    FetchOptions options() const { return m_options; }

    // Engine thread
    void notHandled();
    void cancelFromLoader();
    void startPreload(const NavigationPreloadState&);
    bool hasPreload() const { return !!m_preloader; }
    // The worker has the fetch: now the preloadResponse may go to it
    void fetchStarted();

private:
    FetchTask(ResourceLoader& loader, Function<void()>&& networkLoad, SWServerRegistration& registration, ServiceWorkerIdentifier worker)
        : m_loader(&loader)
        , m_networkLoad(WTF::move(networkLoad))
        , m_registration(registration.identifier())
        , m_shouldSoftUpdate(registration.shouldSoftUpdate(loader.options()))
        , m_worker(worker)
        , m_request(loader.request())
        , m_options(loader.options())
    {
    }

    // ServiceWorkerFetch::Client (worker thread)
    void didReceiveRedirection(const ResourceResponse&) final;
    void didReceiveResponse(ResourceResponse&&) final;
    void didReceiveData(const SharedBuffer&) final;
    void didReceiveFormDataAndFinish(Ref<FormData>&&) final;
    void didFail(const ResourceError&) final;
    void didFinish(const NetworkLoadMetrics&) final;
    void didNotHandle() final;
    void setCancelledCallback(Function<void()>&& callback) final { m_cancelledCallback = WTF::move(callback); }
    void usePreload() final;
    void contextIsStopping() final;
    void doCancel() final
    {
        if (auto callback = std::exchange(m_cancelledCallback, nullptr))
            callback();
    }

    // NavigationPreloader::Reader (engine thread)
    void preloadData(const SharedBuffer&) final;
    void preloadFinished(const NetworkLoadMetrics&) final;
    void preloadFailed(const ResourceError&) final;

    // Engine thread: in order, data only after the yes to the response
    void enqueue(Function<void(FetchTask&)>&&);
    void runQueue();
    void receiveRedirect(ResourceResponse&&);
    void receiveResponse(ResourceResponse&&);
    void receiveData(const SharedBuffer&);
    bool markDone();
    void finish();
    void failWith(const ResourceError&);
    void readBlob(const URL&);
    void sendPreloadResponse();
    void loadFromPreload();
    void endPreload();

    class BlobReader;

    RefPtr<ResourceLoader> m_loader;
    Function<void()> m_networkLoad;
    ServiceWorkerRegistrationIdentifier m_registration;
    bool m_shouldSoftUpdate;
    ServiceWorkerIdentifier m_worker;
    FetchIdentifier m_identifier { FetchIdentifier::generate() };
    ResourceRequest m_request;
    FetchOptions m_options;
    Function<void()> m_cancelledCallback;
    Deque<Function<void(FetchTask&)>> m_queue;
    bool m_hasResponse { false };
    bool m_waitingForResponseCompletion { false };
    bool m_done { false };
    std::atomic<bool> m_sentResponse { false };
    std::atomic<bool> m_usesPreload { false };
    RefPtr<FetchLoader> m_blobLoader;
    RefPtr<BlobReader> m_blobReader;
    RefPtr<NavigationPreloader> m_preloader;
    bool m_readingPreload { false };
};

static HashMap<const ResourceLoader*, Ref<FetchTask>>& fetchTasks()
{
    static NeverDestroyed<HashMap<const ResourceLoader*, Ref<FetchTask>>> map;
    return map;
}

class FetchTask::BlobReader final : public FetchLoaderClient, public RefCounted<BlobReader> {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(BlobReader);
public:
    // Belongs to the FetchTask, so never lives longer than it
    static Ref<BlobReader> create(FetchTask& task) { return adoptRef(*new BlobReader(task)); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    explicit BlobReader(FetchTask& task)
        : m_task(task)
    {
    }

    void didReceiveData(const SharedBuffer& buffer) final
    {
        if (RefPtr loader = m_task.m_loader)
            loader->didReceiveBuffer(buffer, buffer.size(), DataPayloadBytes);
    }
    void didSucceed(const NetworkLoadMetrics&) final { m_task.finish(); }
    void didFail(const ResourceError& error) final
    {
        m_task.enqueue([error](FetchTask& task) {
            task.failWith(error);
        });
    }

    FetchTask& m_task;
};

FetchTask::~FetchTask() = default;

void FetchTask::enqueue(Function<void(FetchTask&)>&& step)
{
    m_queue.append(WTF::move(step));
    runQueue();
}

void FetchTask::runQueue()
{
    Ref protectedThis { *this };
    while (!m_queue.isEmpty() && !m_waitingForResponseCompletion && m_loader)
        m_queue.takeFirst()(*this);
    if (!m_loader)
        m_queue.clear();
}

void FetchTask::receiveRedirect(ResourceResponse&& response)
{
    RefPtr loader = m_loader;
    auto request = loader->request().redirectedRequest(response, false, ResourceRequest::ShouldSetHash::Yes);
    // The redirect target loads normally (like WebKit2)
    m_waitingForResponseCompletion = true;
    loader->willSendRequest(WTF::move(request), response, [task = Ref { *this }](ResourceRequest&& newRequest) mutable {
        task->m_waitingForResponseCompletion = false;
        if (newRequest.isNull() || !task->m_loader || !task->markDone())
            return;
        fetchTasks().remove(std::exchange(task->m_loader, nullptr).get());
        if (auto networkLoad = std::exchange(task->m_networkLoad, nullptr))
            networkLoad();
    });
}

void FetchTask::receiveResponse(ResourceResponse&& response)
{
    m_hasResponse = true;
    m_waitingForResponseCompletion = true;
    RefPtr loader = m_loader;
    loader->didReceiveResponse(WTF::move(response), [task = Ref { *this }] {
        task->m_waitingForResponseCompletion = false;
        task->runQueue();
    });
}

void FetchTask::receiveData(const SharedBuffer& buffer)
{
    m_loader->didReceiveBuffer(buffer, buffer.size(), DataPayloadBytes);
}

void FetchTask::didReceiveRedirection(const ResourceResponse& response)
{
    m_sentResponse = true;
    callOnMainThread([protectedThis = Ref { *this }, data = response.crossThreadData()]() mutable {
        auto response = ResourceResponse::fromCrossThreadData(WTF::move(data));
        response.setSource(ResourceResponse::Source::ServiceWorker);
        protectedThis->enqueue([response = WTF::move(response)](FetchTask& task) mutable {
            task.receiveRedirect(WTF::move(response));
        });
    });
}

void FetchTask::didReceiveResponse(ResourceResponse&& response)
{
    m_sentResponse = true;
    callOnMainThread([protectedThis = Ref { *this }, data = response.crossThreadData()]() mutable {
        auto response = ResourceResponse::fromCrossThreadData(WTF::move(data));
        response.setSource(ResourceResponse::Source::ServiceWorker);
        protectedThis->enqueue([response = WTF::move(response)](FetchTask& task) mutable {
            task.receiveResponse(WTF::move(response));
        });
    });
}

void FetchTask::didReceiveData(const SharedBuffer& buffer)
{
    callOnMainThread([protectedThis = Ref { *this }, buffer = Ref { buffer }] {
        protectedThis->enqueue([buffer](FetchTask& task) {
            task.receiveData(buffer.get());
        });
    });
}

// ------------------------------------------------------------ FetchTask: Preload

void FetchTask::startPreload(const NavigationPreloadState& state)
{
    m_preloader = NavigationPreloader::create(m_request, state);
    unreadPreloaders().set(m_identifier, Ref { *m_preloader });
}

void FetchTask::fetchStarted()
{
    if (RefPtr preloader = m_preloader) {
        preloader->whenResponse([task = Ref { *this }] {
            task->sendPreloadResponse();
        });
    }
}

void FetchTask::sendPreloadResponse()
{
    RefPtr proxy = SWContextManager::singleton().serviceWorkerThreadProxy(m_worker);
    if (!proxy || !m_preloader || m_done)
        return;
    if (!m_preloader->error().isNull())
        proxy->navigationPreloadFailed(Process::identifier(), m_identifier, ResourceError { m_preloader->error() });
    else
        proxy->navigationPreloadIsReady(Process::identifier(), m_identifier, ResourceResponse { m_preloader->response() });
}

// respondWith(preloadResponse): the navigation gets the response from the network
void FetchTask::usePreload()
{
    m_usesPreload = true;
    callOnMainThread([protectedThis = Ref { *this }] {
        protectedThis->enqueue([](FetchTask& task) {
            task.loadFromPreload();
        });
    });
}

void FetchTask::loadFromPreload()
{
    RefPtr preloader = m_preloader;
    if (!preloader || !unreadPreloaders().remove(m_identifier))
        return failWith(ResourceError { ResourceError::Type::General });
    if (!preloader->error().isNull())
        return failWith(preloader->error());
    auto response = preloader->response();
    if (isRedirect(response))
        return receiveRedirect(WTF::move(response));
    m_readingPreload = true;
    receiveResponse(WTF::move(response));
    enqueue([](FetchTask& task) {
        if (RefPtr preloader = task.m_preloader)
            preloader->readBody(task);
    });
}

void FetchTask::preloadData(const SharedBuffer& buffer)
{
    enqueue([buffer = Ref { buffer }](FetchTask& task) {
        task.receiveData(buffer.get());
    });
}

void FetchTask::preloadFinished(const NetworkLoadMetrics&)
{
    enqueue([](FetchTask& task) {
        task.finish();
    });
}

void FetchTask::preloadFailed(const ResourceError& error)
{
    enqueue([error](FetchTask& task) {
        task.failWith(error);
    });
}

// With the fetch its preload ends, unless the worker is reading it itself
void FetchTask::endPreload()
{
    RefPtr preloader = std::exchange(m_preloader, nullptr);
    if (preloader && (m_readingPreload || unreadPreloaders().remove(m_identifier)))
        preloader->cancel();
}

void FetchTask::didReceiveFormDataAndFinish(Ref<FormData>&& formData)
{
    callOnMainThread([protectedThis = Ref { *this }, formData = formData->isolatedCopy()] {
        protectedThis->enqueue([formData](FetchTask& task) {
            if (auto buffer = formData->asSharedBuffer()) {
                task.m_loader->didReceiveBuffer(*buffer, buffer->size(), DataPayloadBytes);
                task.finish();
                return;
            }
            auto blobURL = formData->asBlobURL();
            if (blobURL.isNull()) {
                task.failWith(ResourceError { ResourceError::Type::General });
                return;
            }
            task.readBlob(blobURL);
        });
    });
}

void FetchTask::readBlob(const URL& url)
{
    RefPtr proxy = SWContextManager::singleton().serviceWorkerThreadProxy(m_worker);
    m_blobReader = BlobReader::create(*this);
    m_blobLoader = proxy ? proxy->createBlobLoader(*m_blobReader, url) : nullptr;
    if (!m_blobLoader)
        failWith(ResourceError { ResourceError::Type::General });
}

// The worker is done with the request (like cleanup() in
// WebServiceWorkerFetchTaskClient). false: was already done
bool FetchTask::markDone()
{
    if (std::exchange(m_done, true))
        return false;
    SWContextManager::singleton().removeFetch(m_worker, Process::identifier(), m_identifier, false);
    endPreload();
    // After navigations check the worker's script (like ServiceWorkerFetchTask)
    if (m_shouldSoftUpdate) {
        if (RefPtr registration = registrationFor(m_registration))
            registration->scheduleSoftUpdate(IsAppInitiated::No);
    }
    return true;
}

void FetchTask::finish()
{
    Ref protectedThis { *this };
    RefPtr loader = std::exchange(m_loader, nullptr);
    if (!loader || !markDone())
        return;
    fetchTasks().remove(loader.get());
    NetworkLoadMetrics metrics;
    metrics.markComplete();
    loader->didFinishLoading(metrics);
}

void FetchTask::failWith(const ResourceError& error)
{
    Ref protectedThis { *this };
    RefPtr loader = std::exchange(m_loader, nullptr);
    if (!loader || !markDone())
        return;
    fetchTasks().remove(loader.get());
    loader->didFail(error);
}

void FetchTask::didFail(const ResourceError& error)
{
    callOnMainThread([protectedThis = Ref { *this }, error = error.isolatedCopy()] {
        protectedThis->enqueue([error](FetchTask& task) {
            task.failWith(error);
        });
    });
}

void FetchTask::didFinish(const NetworkLoadMetrics&)
{
    callOnMainThread([protectedThis = Ref { *this }] {
        protectedThis->enqueue([](FetchTask& task) {
            task.finish();
        });
    });
}

void FetchTask::didNotHandle()
{
    callOnMainThread([protectedThis = Ref { *this }] {
        protectedThis->notHandled();
    });
}

void FetchTask::contextIsStopping()
{
    // The response comes from the network, the worker is not needed for it
    if (m_usesPreload)
        return;
    if (!m_sentResponse) {
        didNotHandle();
        return;
    }
    didFail(ResourceError { ResourceError::Type::General });
}

void FetchTask::notHandled()
{
    Ref protectedThis { *this };
    if (!m_loader || m_hasResponse || !markDone())
        return;
    fetchTasks().remove(m_loader.get());
    m_loader = nullptr;
    if (auto networkLoad = std::exchange(m_networkLoad, nullptr))
        networkLoad();
}

void FetchTask::cancelFromLoader()
{
    m_loader = nullptr;
    m_queue.clear();
    endPreload();
    if (std::exchange(m_done, true))
        return;
    m_networkLoad = nullptr;
    if (RefPtr proxy = SWContextManager::singleton().serviceWorkerThreadProxy(m_worker))
        proxy->cancelFetch(Process::identifier(), m_identifier);
}

void ContextConnection::startFetch(FetchTask& task)
{
    RefPtr proxy = SWContextManager::singleton().serviceWorkerThreadProxy(task.worker());
    if (!proxy) {
        task.notHandled();
        return;
    }
    auto request = task.request();
    auto options = task.options();
    auto referrer = request.httpReferrer();
    String clientIdentifier;
    if (options.mode != FetchOptions::Mode::Navigate && options.clientIdentifier)
        clientIdentifier = options.clientIdentifier->toString();
    String resultingClientIdentifier;
    if (options.resultingClientIdentifier)
        resultingClientIdentifier = options.resultingClientIdentifier->toString();
    proxy->startFetch(Process::identifier(), task.identifier(), Ref { task }, WTF::move(request), WTF::move(referrer), WTF::move(options), task.hasPreload(), WTF::move(clientIdentifier), WTF::move(resultingClientIdentifier));
    task.fetchStarted();
}

// Navigation: the new page is controlled by the worker (controlClient in WebKit2)
static void controlClient(ResourceLoader& loader, SWServerRegistration& registration, ScriptExecutionContextIdentifier clientIdentifier)
{
    auto& request = loader.request();
    RefPtr documentLoader = DocumentLoader::fromScriptExecutionContextIdentifier(clientIdentifier);
    if (!documentLoader || !documentLoader->setControllingServiceWorkerRegistration(ServiceWorkerRegistrationData { registration.data() }))
        return;

    auto destination = loader.options().destination;
    auto type = destination == FetchOptions::Destination::Worker ? ServiceWorkerClientType::Worker
        : destination == FetchOptions::Destination::Sharedworker ? ServiceWorkerClientType::Sharedworker
        : ServiceWorkerClientType::Window;
    std::optional<PageIdentifier> pageIdentifier;
    std::optional<FrameIdentifier> frameIdentifier;
    if (RefPtr frame = loader.frame()) {
        frameIdentifier = frame->frameID();
        if (RefPtr page = frame->page())
            pageIdentifier = page->identifier();
    }
    ServiceWorkerClientData data { clientIdentifier, type, ServiceWorkerClientFrameType::None, request.url(), URL { }, pageIdentifier, frameIdentifier, LastNavigationWasAppInitiated::No, { }, false, false, 0, { } };
    serverConnection()->registerClient(ClientOrigin { registration.key().topOrigin(), SecurityOriginData::fromURLWithoutStrictOpaqueness(request.url()) }, WTF::move(data), registration.identifier(), request.httpUserAgent(), SWServer::IsBeingCreatedClient::Yes);
}

// Navigations waiting for the import of their registrations
static HashSet<const ResourceLoader*>& pendingImports()
{
    static NeverDestroyed<HashSet<const ResourceLoader*>> set;
    return set;
}

bool startFetch(ResourceLoader& loader, Function<void()>&& networkLoad)
{
    auto& options = loader.options();
    // The worker fetches the body of its preloadResponse
    if (auto identifier = options.navigationPreloadIdentifier) {
        if (auto preloader = unreadPreloaders().take(*identifier)) {
            Ref load = PreloadLoad::create(loader, *preloader);
            preloadLoads().set(&loader, load.copyRef());
            // Answer only after the loader was created, like from the network
            post([load] { load->start(); });
            return true;
        }
    }
    RefPtr server = ServiceWorkers::server();
    if (!server)
        return false;
    if (options.serviceWorkersMode == ServiceWorkersMode::None)
        return false;
    auto& url = loader.request().url();
    if (!server->canHandleScheme(url.protocol()))
        return false;

    std::optional<ServiceWorkerRegistrationIdentifier> registrationIdentifier;
    if (auto resultingClient = options.resultingClientIdentifier) {
        RefPtr frame = loader.frame();
        RefPtr document = frame && !frame->isMainFrame() ? frame->document() : nullptr;
        auto topOrigin = document ? document->topOrigin().data() : SecurityOriginData::fromURL(url);
        if (!clientConnection()->origins.contains(topOrigin))
            return false;
        // Fetch the origin's registrations from disk first (like
        // NetworkConnectionToWebProcess::scheduleResourceLoad)
        if (!server->isImportCompletedForOrigin(topOrigin)) {
            pendingImports().add(&loader);
            server->importRegistrationsForOrigin(topOrigin, [loader = Ref { loader }, networkLoad = WTF::move(networkLoad)]() mutable {
                if (!pendingImports().remove(loader.ptr()))
                    return;
                if (!startFetch(loader, [networkLoad = WTF::move(networkLoad)]() mutable { networkLoad(); }))
                    networkLoad();
            });
            return true;
        }
        RefPtr registration = server->doRegistrationMatchingSync(topOrigin, url);
        if (!registration)
            return false;
        registrationIdentifier = registration->identifier();
        controlClient(loader, *registration, ScriptExecutionContextIdentifier { *resultingClient, Process::identifier() });
    } else {
        if (!options.serviceWorkerRegistrationIdentifier || isPotentialNavigationOrSubresourceRequest(options.destination))
            return false;
        registrationIdentifier = *options.serviceWorkerRegistrationIdentifier;
    }

    RefPtr registration = server->getRegistration(*registrationIdentifier);
    RefPtr worker = registration ? registration->activeWorker() : nullptr;
    if (!worker)
        return false;
    // Without a fetch handler straight to the network (like WebKit2)
    auto source = worker->defaultRouterSource();
    if (auto* value = std::get_if<RouterSourceEnum>(&source); value && *value == RouterSourceEnum::Network) {
        if (registration->shouldSoftUpdate(options))
            registration->scheduleSoftUpdate(IsAppInitiated::No);
        return false;
    }

    Ref task = FetchTask::create(loader, WTF::move(networkLoad), *registration, worker->identifier());
    fetchTasks().set(&loader, task.copyRef());
    // Navigation preload: the network already loads while the worker starts
    if (options.mode == FetchOptions::Mode::Navigate && loader.request().httpMethod() == "GET"_s && registration->navigationPreloadState().enabled)
        task->startPreload(registration->navigationPreloadState());
    worker->whenActivated([task, workerIdentifier = worker->identifier()](bool success) mutable {
        RefPtr server = ServiceWorkers::server();
        RefPtr worker = server && success ? server->workerByID(workerIdentifier) : nullptr;
        if (!worker) {
            task->notHandled();
            return;
        }
        if (!worker->contextConnection())
            server->createContextConnection(worker->topSite(), worker->serviceWorkerPageIdentifier(), worker->crossOriginEmbedderPolicy().value);
        server->runServiceWorkerIfNecessary(workerIdentifier, [task = WTF::move(task)](auto* contextConnection) mutable {
            if (!contextConnection) {
                task->notHandled();
                return;
            }
            static_cast<ContextConnection&>(*contextConnection).startFetch(task);
        });
    });
    return true;
}

void frameLoadEnded(LocalFrame& localFrame, bool committed)
{
    auto frame = localFrame.frameID();
    if (!pendingNavigations().contains(frame))
        return;
    // The new document registers as a client through the RunLoop, so afterwards.
    // If it has not done that, it is none (specification: null)
    post([frame, committed] {
        if (committed)
            finishNavigation(frame, std::optional<ServiceWorkerClientData> { });
        else
            finishNavigation(frame, navigateFailed());
    });
}

bool cancelFetch(ResourceLoader& loader)
{
    if (pendingImports().remove(&loader))
        return true;
    if (auto load = preloadLoads().take(&loader)) {
        load->cancel();
        return true;
    }
    auto task = fetchTasks().take(&loader);
    if (!task)
        return false;
    task->cancelFromLoader();
    return true;
}

bool isFetching(const ResourceLoader& loader)
{
    return fetchTasks().contains(&loader) || pendingImports().contains(&loader) || preloadLoads().contains(&loader);
}


// ------------------------------------------------------------ SharedWorker

// Like WebSharedWorkerServer in WebKit2: one worker per key (origin, URL,
// name), as long as a SharedWorker object of a page needs it.
struct SharedWorkerEntry : RefCounted<SharedWorkerEntry> {
    static Ref<SharedWorkerEntry> create(const SharedWorkerKey& key, const WorkerOptions& options) { return adoptRef(*new SharedWorkerEntry(key, options)); }

    SharedWorkerKey key;
    WorkerOptions options;
    SharedWorkerIdentifier identifier { SharedWorkerIdentifier::generate() };
    // Port until the connect event (empty afterwards)
    HashMap<SharedWorkerObjectIdentifier, std::optional<TransferredMessagePort>> objects;
    bool fetched { false };
    bool running { false };

private:
    SharedWorkerEntry(const SharedWorkerKey& key, const WorkerOptions& options)
        : key(key)
        , options(options)
    {
    }
};

static HashMap<SharedWorkerKey, Ref<SharedWorkerEntry>>& sharedWorkers()
{
    static NeverDestroyed<HashMap<SharedWorkerKey, Ref<SharedWorkerEntry>>> map;
    return map;
}

static RefPtr<SharedWorkerEntry> sharedWorkerByID(SharedWorkerIdentifier identifier)
{
    for (auto& entry : sharedWorkers().values()) {
        if (entry->identifier == identifier)
            return entry.ptr();
    }
    return nullptr;
}

class SharedWorkerContext final : public SharedWorkerContextManager::Connection, public RefCounted<SharedWorkerContext> {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(SharedWorkerContext);
public:
    static Ref<SharedWorkerContext> create() { return adoptRef(*new SharedWorkerContext); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    using SharedWorkerContextManager::Connection::postConnectEvent;
    using SharedWorkerContextManager::Connection::terminateSharedWorker;

private:
    void establishConnection(CompletionHandler<void()>&& callback) final { callback(); }
    void postErrorToWorkerObject(SharedWorkerIdentifier, const String&, int, int, const String&, bool) final;
    void sharedWorkerTerminated(SharedWorkerIdentifier identifier) final
    {
        if (RefPtr entry = sharedWorkerByID(identifier))
            sharedWorkers().remove(entry->key);
    }
};

static SharedWorkerContext& sharedWorkerContext()
{
    static NeverDestroyed<Ref<SharedWorkerContext>> context { SharedWorkerContext::create() };
    return context.get();
}

class SharedWorkerConnection final : public SharedWorkerObjectConnection {
public:
    static Ref<SharedWorkerConnection> create() { return adoptRef(*new SharedWorkerConnection); }

    using SharedWorkerObjectConnection::postErrorToWorkerObject;

private:
    void requestSharedWorker(const SharedWorkerKey&, SharedWorkerObjectIdentifier, TransferredMessagePort&&, const WorkerOptions&) final;
    void sharedWorkerObjectIsGoingAway(const SharedWorkerKey&, SharedWorkerObjectIdentifier) final;
    void suspendForBackForwardCache(const SharedWorkerKey&, SharedWorkerObjectIdentifier) final { }
    void resumeForBackForwardCache(const SharedWorkerKey&, SharedWorkerObjectIdentifier) final { }

    void didFetchScript(SharedWorkerEntry&, WorkerFetchResult&&, WorkerInitializationData&&);
    void connect(SharedWorkerEntry&, SharedWorkerObjectIdentifier);
};

static SharedWorkerConnection& sharedWorkerConnection()
{
    static NeverDestroyed<Ref<SharedWorkerConnection>> connection { SharedWorkerConnection::create() };
    return connection.get();
}

void SharedWorkerContext::postErrorToWorkerObject(SharedWorkerIdentifier identifier, const String& message, int line, int column, const String& sourceURL, bool isErrorEvent)
{
    RefPtr entry = sharedWorkerByID(identifier);
    if (!entry)
        return;
    for (auto object : entry->objects.keys())
        sharedWorkerConnection().postErrorToWorkerObject(object, message, line, column, sourceURL, isErrorEvent);
}

void SharedWorkerConnection::requestSharedWorker(const SharedWorkerKey& key, SharedWorkerObjectIdentifier object, TransferredMessagePort&& port, const WorkerOptions& options)
{
    post([this, protectedThis = Ref { *this }, key, object, port = WTF::move(port), options]() mutable {
        Ref entry = sharedWorkers().ensure(key, [&] {
            return SharedWorkerEntry::create(key, options);
        }).iterator->value;
        if (entry->options.type != options.type || entry->options.credentials != options.credentials) {
            notifyWorkerObjectOfLoadCompletion(object, ResourceError { ResourceError::Type::AccessControl });
            return;
        }
        entry->objects.set(object, WTF::move(port));
        if (entry->objects.size() > 1) {
            if (entry->fetched)
                notifyWorkerObjectOfLoadCompletion(object, { });
            if (entry->running)
                connect(entry, object);
            return;
        }
        // The page that wants the worker first loads the script (like WebKit2)
        fetchScriptInClient(URL { key.url }, object, WorkerOptions { options }, [this, protectedThis = Ref { *this }, entry](WorkerFetchResult&& result, WorkerInitializationData&& data) mutable {
            didFetchScript(entry, WTF::move(result), WTF::move(data));
        });
    });
}

void SharedWorkerConnection::didFetchScript(SharedWorkerEntry& entry, WorkerFetchResult&& result, WorkerInitializationData&& data)
{
    Ref protectedEntry { entry };
    for (auto object : entry.objects.keys())
        notifyWorkerObjectOfLoadCompletion(object, result.error);
    if (!result.error.isNull()) {
        sharedWorkers().remove(entry.key);
        return;
    }
    entry.fetched = true;
    if (entry.objects.isEmpty()) {
        sharedWorkers().remove(entry.key);
        return;
    }

    if (data.userAgent.isEmpty())
        data.userAgent = standardUserAgent();
    if (!data.clientIdentifier)
        data.clientIdentifier = ScriptExecutionContextIdentifier::generate();
    Ref page = createWorkerPage();
    page->setupForRemoteWorker(result.responseURL, entry.key.origin.topOrigin, result.referrerPolicy, data.advancedPrivacyProtections);
    debugLog("SharedWorker %s: starting", entry.key.url.string().utf8().data());
    auto proxy = SharedWorkerThreadProxy::create(WTF::move(page), entry.identifier, entry.key.origin, WTF::move(result), WorkerOptions { entry.options }, WTF::move(data), cacheStorageProvider().get());
    SharedWorkerContextManager::singleton().registerSharedWorkerThread(WTF::move(proxy));
    entry.running = true;

    for (auto object : copyToVector(entry.objects.keys()))
        connect(entry, object);
}

void SharedWorkerConnection::connect(SharedWorkerEntry& entry, SharedWorkerObjectIdentifier object)
{
    auto it = entry.objects.find(object);
    if (it == entry.objects.end() || !it->value)
        return;
    auto port = std::exchange(it->value, std::nullopt);
    sharedWorkerContext().postConnectEvent(entry.identifier, WTF::move(*port), entry.key.origin.clientOrigin, [](bool) { });
}

void SharedWorkerConnection::sharedWorkerObjectIsGoingAway(const SharedWorkerKey& key, SharedWorkerObjectIdentifier object)
{
    post([key, object] {
        auto it = sharedWorkers().find(key);
        if (it == sharedWorkers().end())
            return;
        Ref entry = it->value;
        entry->objects.remove(object);
        if (!entry->objects.isEmpty())
            return;
        sharedWorkers().remove(it);
        if (entry->running)
            sharedWorkerContext().terminateSharedWorker(entry->identifier);
    });
}

class SharedProvider final : public SharedWorkerProvider {
public:
    SharedWorkerObjectConnection* sharedWorkerConnection() final { return &ServiceWorkers::sharedWorkerConnection(); }
};

// ------------------------------------------------------------ Start

void initialize()
{
    clientConnection() = ClientConnection::create();
    server() = SWServer::create(serverDelegate(), makeUniqueRef<OriginStore>(), false, String { }, PAL::SessionID::defaultSessionID(), false, true, std::nullopt, ServiceWorkerIsInspectable::No);
    serverConnection() = ServerConnection::create(*server());
    server()->addConnection(*serverConnection());
    SWContextManager::singleton().setConnection(ContextManagerConnection::create());
    static NeverDestroyed<Provider> provider;
    ServiceWorkerProvider::setSharedProvider(provider.get());

    SharedWorkerContextManager::singleton().setConnection(&sharedWorkerContext());
    static NeverDestroyed<SharedProvider> sharedProvider;
    SharedWorkerProvider::setSharedProvider(sharedProvider.get());
}

void enableIn(Settings& settings)
{
    settings.setServiceWorkersEnabled(true);
    settings.setServiceWorkerNavigationPreloadEnabled(true);
    settings.setNotificationEventEnabled(true);
    settings.setCacheAPIEnabled(true);
    settings.setSharedWorkerEnabled(true);
}

} // namespace BrowserLite::ServiceWorkers
