#include "config.h"
#include "ServiceWorkerWasm.h"

#include "CacheStorageWasm.h"
#include "Engine.h"
#include "Storage.h"
#include "Strategies.h"
#include "WasmSocketProvider.h"
#include "WebPlatformExtras.h"
#include <WebCore/BackgroundFetchInformation.h>
#include <WebCore/BackgroundFetchRecordInformation.h>
#include <WebCore/BackgroundFetchStore.h>
#include <WebCore/CacheStorageProvider.h>
#include <WebCore/CookieChangeSubscription.h>
#include <WebCore/CookieJar.h>
#include <WebCore/DatabaseProvider.h>
#include <WebCore/Document.h>
#include <WebCore/DocumentLoader.h>
#include <WebCore/DocumentPage.h>
#include <WebCore/EmptyClients.h>
#include <WebCore/ExceptionData.h>
#include <WebCore/FetchLoader.h>
#include <WebCore/FetchLoaderClient.h>
#include <WebCore/FormData.h>
#include <WebCore/FrameInlines.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/MessageWithMessagePorts.h>
#include <WebCore/NavigationPreloadState.h>
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
#include <WebCore/SWServer.h>
#include <WebCore/SWServerDelegate.h>
#include <WebCore/SWServerRegistration.h>
#include <WebCore/SWServerToContextConnection.h>
#include <WebCore/SWServerWorker.h>
#include <WebCore/ServiceWorkerClientData.h>
#include <WebCore/ServiceWorkerFetch.h>
#include <WebCore/ServiceWorkerJobData.h>
#include <WebCore/ServiceWorkerProvider.h>
#include <WebCore/ServiceWorkerRegistrationData.h>
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
#include <WebCore/UserContentProvider.h>
#include <WebCore/WorkerFetchResult.h>
#include <wtf/Deque.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>

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

// Wie IPC: spaeter im Engine-Thread, nie mitten im Aufruf
static void post(Function<void()>&& function)
{
    RunLoop::mainSingleton().dispatch(WTF::move(function));
}

static ExceptionData notSupported()
{
    return ExceptionData { ExceptionCode::NotSupportedError, "Not supported in browser-lite"_s };
}

// ------------------------------------------------------------ Seite (Client)

class ClientConnection final : public SWClientConnection {
public:
    static Ref<ClientConnection> create() { return adoptRef(*new ClientConnection); }

    // Vom Server (protected in SWClientConnection)
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

    // Registrierungen pro Ursprung (fuer mayHaveServiceWorkerRegisteredForOrigin)
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

    // Push, Benachrichtigungen aus dem Worker, Background Fetch und Cookie
    // Store fuer Worker gibt es (noch) nicht
    void subscribeToPushService(ServiceWorkerRegistrationIdentifier, const Vector<uint8_t>&, SubscribeToPushServiceCallback&& callback) final { callback(notSupported().toException()); }
    void unsubscribeFromPushService(ServiceWorkerRegistrationIdentifier, PushSubscriptionIdentifier, UnsubscribeFromPushServiceCallback&& callback) final { callback(false); }
    void getPushSubscription(ServiceWorkerRegistrationIdentifier, GetPushSubscriptionCallback&& callback) final { callback(std::optional<PushSubscriptionData> { }); }
    void getPushPermissionState(ServiceWorkerRegistrationIdentifier, GetPushPermissionStateCallback&& callback) final { callback(PushPermissionState::Denied); }
#if ENABLE(NOTIFICATION_EVENT)
    void getNotifications(const URL&, const String&, GetNotificationsCallback&& callback) final { callback(Vector<NotificationData> { }); }
#endif

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

// Die Seite aus Sicht des Servers (WebSWServerConnection in WebKit2). Es gibt
// nur einen Prozess, also nur diese eine Verbindung.
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

    // SWServer::Connection (Antworten an die Seite)
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

// ------------------------------------------------------------ Worker (Kontext)

// Pro Seite (Site) eine Verbindung zum "Prozess" der Worker, wie
// WebSWServerToContextConnection. Die Worker laufen alle hier.
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
    void fireNotificationEvent(ServiceWorkerIdentifier, const NotificationData&, NotificationEventType, CompletionHandler<void(bool)>&& callback) final { callback(false); }
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

// Zu welcher Verbindung gehoert ein Worker (auch kurz nach seinem Ende noch)
static HashMap<ServiceWorkerIdentifier, WeakPtr<SWServerToContextConnection>>& workerConnections()
{
    static NeverDestroyed<HashMap<ServiceWorkerIdentifier, WeakPtr<SWServerToContextConnection>>> map;
    return map;
}

static RefPtr<SWServerToContextConnection> contextConnectionFor(ServiceWorkerIdentifier identifier)
{
    return workerConnections().get(identifier);
}

// Was die Worker an "ihren Prozess" melden (WebSWContextManagerConnection).
// Kommt von WebCore immer im Engine-Thread an.
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
        RefPtr document = Document::allDocumentsMap().get(identifier);
        if (!document)
            return callback({ });
        callback(ServiceWorkerClientData::from(*document));
    }
    void openWindow(ServiceWorkerIdentifier, const URL&, OpenWindowCallback&& callback) final { callback(notSupported().toException()); }
    void navigate(ScriptExecutionContextIdentifier, ServiceWorkerIdentifier, const URL&, NavigateCallback&& callback) final { callback(notSupported().toException()); }
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

// ------------------------------------------------------------ Server-Delegate

// Leerer Speicher fuer Background Fetch (wird nicht unterstuetzt)
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
    // Hintergrund-Aktualisierung des Worker-Skripts: noch nicht, der Worker
    // bleibt bis zur naechsten Registrierung durch die Seite
    void softUpdate(ServiceWorkerJobData&&, bool, ResourceRequest&& request, CompletionHandler<void(WorkerFetchResult&&)>&& callback) final
    {
        callback(workerFetchError(ResourceError { ResourceError::Type::Cancellation }));
        UNUSED_PARAM(request);
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
    // Ohne Speicher auf der Platte: Registrierungen nur im Speicher
    RefPtr<SWRegistrationStore> createRegistrationStore(SWServer&) final { return nullptr; }

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
    auto& contextOrigin = clientOrigin.clientOrigin;
    // Wie WebKit2: keine Sandbox-Dokumente
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
    // Auch Hintergrund-Aktualisierungen des Servers kommen hier an (gleiche
    // Prozess-Kennung); die kennt die Seite nicht und meldet einen Fehler
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
    RefPtr document = Document::allDocumentsMap().get(identifier);
    if (!document)
        return callback({ });
    callback(ServiceWorkerClientData::from(*document));
}

void ServerConnection::updateBackgroundFetchRegistration(const BackgroundFetchInformation& information)
{
    post([information] {
        if (RefPtr client = clientConnection())
            client->updateBackgroundFetchRegistration(information);
    });
}

// ------------------------------------------------------------ ContextConnection

// Eigene Page fuer den Worker, wie WebSWContextManagerConnection::installServiceWorker
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

// Page, in der ein Service Worker oder SharedWorker laeuft (ohne Fenster)
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

    debugLog("Service Worker %s: starten", contextData.scriptURL.string().utf8().data());
    auto proxy = ServiceWorkerThreadProxy::create(WTF::move(page), contextData.isolatedCopy(), workerData.isolatedCopy(), String { userAgent }, mode, cacheStorageProvider().get(), nullptr);
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
    // WebKit2 beendet hier den Prozess der Worker
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

// ------------------------------------------------------------ Fetch-Abfang

// Eine Anfrage, die der Service Worker beantwortet (ServiceWorkerFetchTask und
// WebServiceWorkerFetchTaskClient in WebKit2 zusammen). Die Aufrufe des
// Workers kommen in seinem Thread an und gehen in den Engine-Thread, dort an
// den ResourceLoader der Seite.
class FetchTask final : public ServiceWorkerFetch::Client {
public:
    static Ref<FetchTask> create(ResourceLoader& loader, Function<void()>&& networkLoad, ServiceWorkerIdentifier worker)
    {
        return adoptRef(*new FetchTask(loader, WTF::move(networkLoad), worker));
    }

    ~FetchTask();

    FetchIdentifier identifier() const { return m_identifier; }
    ServiceWorkerIdentifier worker() const { return m_worker; }
    ResourceRequest request() const { return m_request; }
    FetchOptions options() const { return m_options; }

    // Engine-Thread
    void notHandled();
    void cancelFromLoader();

private:
    FetchTask(ResourceLoader& loader, Function<void()>&& networkLoad, ServiceWorkerIdentifier worker)
        : m_loader(&loader)
        , m_networkLoad(WTF::move(networkLoad))
        , m_worker(worker)
        , m_request(loader.request())
        , m_options(loader.options())
    {
    }

    // ServiceWorkerFetch::Client (Worker-Thread)
    void didReceiveRedirection(const ResourceResponse&) final;
    void didReceiveResponse(ResourceResponse&&) final;
    void didReceiveData(const SharedBuffer&) final;
    void didReceiveFormDataAndFinish(Ref<FormData>&&) final;
    void didFail(const ResourceError&) final;
    void didFinish(const NetworkLoadMetrics&) final;
    void didNotHandle() final;
    void setCancelledCallback(Function<void()>&& callback) final { m_cancelledCallback = WTF::move(callback); }
    void usePreload() final { didNotHandle(); }
    void contextIsStopping() final;
    void doCancel() final
    {
        if (auto callback = std::exchange(m_cancelledCallback, nullptr))
            callback();
    }

    // Engine-Thread: der Reihe nach, Daten erst nach dem Ja zur Antwort
    void enqueue(Function<void(FetchTask&)>&&);
    void runQueue();
    void finish();
    void readBlob(const URL&);

    class BlobReader;

    RefPtr<ResourceLoader> m_loader;
    Function<void()> m_networkLoad;
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
    RefPtr<FetchLoader> m_blobLoader;
    RefPtr<BlobReader> m_blobReader;
};

static HashMap<const ResourceLoader*, Ref<FetchTask>>& fetchTasks()
{
    static NeverDestroyed<HashMap<const ResourceLoader*, Ref<FetchTask>>> map;
    return map;
}

class FetchTask::BlobReader final : public FetchLoaderClient, public RefCounted<BlobReader> {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(BlobReader);
public:
    // Gehoert dem FetchTask, lebt also nie laenger als er
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
            RefPtr loader = std::exchange(task.m_loader, nullptr);
            task.m_done = true;
            if (loader)
                loader->didFail(error);
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

void FetchTask::didReceiveRedirection(const ResourceResponse& response)
{
    m_sentResponse = true;
    callOnMainThread([protectedThis = Ref { *this }, data = response.crossThreadData()]() mutable {
        protectedThis->enqueue([response = ResourceResponse::fromCrossThreadData(WTF::move(data))](FetchTask& task) mutable {
            RefPtr loader = task.m_loader;
            response.setSource(ResourceResponse::Source::ServiceWorker);
            auto request = loader->request().redirectedRequest(response, false, ResourceRequest::ShouldSetHash::Yes);
            // Das Ziel der Weiterleitung laedt normal (wie WebKit2)
            task.m_waitingForResponseCompletion = true;
            loader->willSendRequest(WTF::move(request), response, [task = Ref { task }](ResourceRequest&& newRequest) mutable {
                task->m_waitingForResponseCompletion = false;
                if (newRequest.isNull() || !task->m_loader)
                    return;
                task->m_done = true;
                fetchTasks().remove(std::exchange(task->m_loader, nullptr).get());
                if (auto networkLoad = std::exchange(task->m_networkLoad, nullptr))
                    networkLoad();
            });
        });
    });
}

void FetchTask::didReceiveResponse(ResourceResponse&& response)
{
    m_sentResponse = true;
    callOnMainThread([protectedThis = Ref { *this }, data = response.crossThreadData()]() mutable {
        protectedThis->enqueue([response = ResourceResponse::fromCrossThreadData(WTF::move(data))](FetchTask& task) mutable {
            response.setSource(ResourceResponse::Source::ServiceWorker);
            task.m_hasResponse = true;
            task.m_waitingForResponseCompletion = true;
            RefPtr loader = task.m_loader;
            loader->didReceiveResponse(WTF::move(response), [task = Ref { task }] {
                task->m_waitingForResponseCompletion = false;
                task->runQueue();
            });
        });
    });
}

void FetchTask::didReceiveData(const SharedBuffer& buffer)
{
    callOnMainThread([protectedThis = Ref { *this }, buffer = Ref { buffer }] {
        protectedThis->enqueue([buffer](FetchTask& task) {
            task.m_loader->didReceiveBuffer(buffer.get(), buffer->size(), DataPayloadBytes);
        });
    });
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
                RefPtr loader = std::exchange(task.m_loader, nullptr);
                task.m_done = true;
                loader->didFail(ResourceError { ResourceError::Type::General });
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
    if (!m_blobLoader) {
        RefPtr loader = std::exchange(m_loader, nullptr);
        m_done = true;
        loader->didFail(ResourceError { ResourceError::Type::General });
    }
}

void FetchTask::finish()
{
    RefPtr loader = std::exchange(m_loader, nullptr);
    if (!loader || m_done)
        return;
    m_done = true;
    fetchTasks().remove(loader.get());
    SWContextManager::singleton().removeFetch(m_worker, Process::identifier(), m_identifier, false);
    NetworkLoadMetrics metrics;
    metrics.markComplete();
    loader->didFinishLoading(metrics);
}

void FetchTask::didFail(const ResourceError& error)
{
    callOnMainThread([protectedThis = Ref { *this }, error = error.isolatedCopy()] {
        protectedThis->enqueue([error](FetchTask& task) {
            RefPtr loader = std::exchange(task.m_loader, nullptr);
            task.m_done = true;
            fetchTasks().remove(loader.get());
            SWContextManager::singleton().removeFetch(task.m_worker, Process::identifier(), task.m_identifier, false);
            loader->didFail(error);
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
    if (!m_sentResponse) {
        didNotHandle();
        return;
    }
    didFail(ResourceError { ResourceError::Type::General });
}

void FetchTask::notHandled()
{
    if (m_done || !m_loader || m_hasResponse)
        return;
    m_done = true;
    fetchTasks().remove(m_loader.get());
    m_loader = nullptr;
    if (auto networkLoad = std::exchange(m_networkLoad, nullptr))
        networkLoad();
}

void FetchTask::cancelFromLoader()
{
    m_loader = nullptr;
    m_queue.clear();
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
    proxy->startFetch(Process::identifier(), task.identifier(), Ref { task }, WTF::move(request), WTF::move(referrer), WTF::move(options), false, WTF::move(clientIdentifier), WTF::move(resultingClientIdentifier));
}

// Navigation: die neue Seite wird vom Worker kontrolliert (controlClient in WebKit2)
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

bool startFetch(ResourceLoader& loader, Function<void()>&& networkLoad)
{
    RefPtr server = ServiceWorkers::server();
    if (!server)
        return false;
    auto& options = loader.options();
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
    // Ohne fetch-Handler gleich ins Netz (wie WebKit2)
    auto source = worker->defaultRouterSource();
    if (auto* value = std::get_if<RouterSourceEnum>(&source); value && *value == RouterSourceEnum::Network)
        return false;

    Ref task = FetchTask::create(loader, WTF::move(networkLoad), worker->identifier());
    fetchTasks().set(&loader, task.copyRef());
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

bool cancelFetch(ResourceLoader& loader)
{
    auto task = fetchTasks().take(&loader);
    if (!task)
        return false;
    task->cancelFromLoader();
    return true;
}

bool isFetching(const ResourceLoader& loader)
{
    return fetchTasks().contains(&loader);
}


// ------------------------------------------------------------ SharedWorker

// Wie WebSharedWorkerServer in WebKit2: ein Worker pro Schluessel (Ursprung,
// URL, Name), so lange ein SharedWorker-Objekt einer Seite ihn braucht.
struct SharedWorkerEntry : RefCounted<SharedWorkerEntry> {
    static Ref<SharedWorkerEntry> create(const SharedWorkerKey& key, const WorkerOptions& options) { return adoptRef(*new SharedWorkerEntry(key, options)); }

    SharedWorkerKey key;
    WorkerOptions options;
    SharedWorkerIdentifier identifier { SharedWorkerIdentifier::generate() };
    // Port bis zum connect-Event (danach leer)
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
        // Das Skript laedt die Seite, die den Worker zuerst will (wie WebKit2)
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
    debugLog("SharedWorker %s: starten", entry.key.url.string().utf8().data());
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
    // Navigation Preload braucht den Netzwerk-Teil von WebKit2
    settings.setServiceWorkerNavigationPreloadEnabled(false);
    settings.setCacheAPIEnabled(true);
    settings.setSharedWorkerEnabled(true);
}

} // namespace BrowserLite::ServiceWorkers
