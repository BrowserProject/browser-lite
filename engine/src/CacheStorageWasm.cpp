// Cache API (caches.open, cache.put/match ...) fuer Seiten und Worker.
//
// In WebKit2 steckt die Umsetzung im Netzwerk-Prozess (CacheStorageManager).
// Hier eine kleine eigene im Speicher der Engine, fuer alle Tabs gemeinsam,
// nach Ursprung getrennt. Sie lebt so lange wie die Sitzung; dauerhaft
// gespeichert wird (noch) nicht.
#include "config.h"
#include "CacheStorageWasm.h"

#include <WebCore/DOMCacheEngine.h>

// NativePromise kopiert Werte fuer andere Threads; das Ergebnis von open() ist
// nur eine Kennung und ein bool, eine flache Kopie reicht
namespace WTF {
template<> struct CrossThreadCopierBase<false, false, WebCore::DOMCacheEngine::CacheIdentifierOperationResult> {
    using Type = WebCore::DOMCacheEngine::CacheIdentifierOperationResult;
    static constexpr bool IsNeeded = false;
    static Type copy(const Type& value) { return value; }
};
}

#include <WebCore/CacheQueryOptions.h>
#include <WebCore/CacheStorageConnection.h>
#include <WebCore/CacheStorageProvider.h>
#include <WebCore/ClientOrigin.h>
#include <WebCore/DOMCacheEngine.h>
#include <WebCore/RetrieveRecordsOptions.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>

namespace BrowserLite {

using namespace WebCore;
using namespace WebCore::DOMCacheEngine;

static CrossThreadRecord copyRecord(const CrossThreadRecord& record, bool withBody)
{
    return CrossThreadRecord { record.identifier, record.updateResponseCounter, record.requestHeadersGuard, ResourceRequest { record.request },
        record.options, String { record.referrer }, record.responseHeadersGuard, record.response.isolatedCopy(),
        withBody ? copyResponseBody(record.responseBody) : ResponseBody { nullptr }, record.responseBodySize };
}

static bool matches(const ResourceRequest& request, const CrossThreadRecord& record, const CacheQueryOptions& options)
{
    auto response = ResourceResponse::fromCrossThreadData(record.response.isolatedCopy());
    return queryCacheMatch(request, record.request, response, options);
}

class CacheStorageConnectionWasm final : public CacheStorageConnection {
public:
    static CacheStorageConnectionWasm& singleton()
    {
        static NeverDestroyed<Ref<CacheStorageConnectionWasm>> connection = adoptRef(*new CacheStorageConnectionWasm);
        return connection.get();
    }

private:
    struct Cache {
        String name;
        ClientOrigin origin;
        Vector<CrossThreadRecord> records;
    };

    Ref<OpenPromise> open(const ClientOrigin& origin, const String& name) final
    {
        for (auto& [identifier, cache] : m_caches) {
            if (cache.origin == origin && cache.name == name)
                return OpenPromise::createAndResolve(CacheIdentifierOperationResult { identifier, false });
        }
        auto identifier = DOMCacheIdentifier::generate();
        m_caches.add(identifier, Cache { name, origin, { } });
        m_order.append(identifier);
        ++m_updateCounter;
        return OpenPromise::createAndResolve(CacheIdentifierOperationResult { identifier, false });
    }

    Ref<RemovePromise> remove(DOMCacheIdentifier identifier) final
    {
        bool removed = m_caches.remove(identifier);
        m_order.removeFirst(identifier);
        if (removed)
            ++m_updateCounter;
        return RemovePromise::createAndResolve(removed);
    }

    Ref<RetrieveCachesPromise> retrieveCaches(const ClientOrigin& origin, uint64_t) final
    {
        CacheInfos result { { }, m_updateCounter };
        for (auto identifier : m_order) {
            auto it = m_caches.find(identifier);
            if (it != m_caches.end() && it->value.origin == origin)
                result.infos.append(CacheInfo { identifier, it->value.name });
        }
        return RetrieveCachesPromise::createAndResolve(WTF::move(result));
    }

    Ref<RetrieveRecordsPromise> retrieveRecords(DOMCacheIdentifier identifier, RetrieveRecordsOptions&& options) final
    {
        auto it = m_caches.find(identifier);
        if (it == m_caches.end())
            return RetrieveRecordsPromise::createAndReject(Error::Internal);
        CacheQueryOptions query { options.ignoreSearch, options.ignoreMethod, options.ignoreVary };
        Vector<CrossThreadRecord> result;
        for (auto& record : it->value.records) {
            if (options.request.url().isNull() || matches(options.request, record, query))
                result.append(copyRecord(record, options.shouldProvideResponse));
        }
        return RetrieveRecordsPromise::createAndResolve(WTF::move(result));
    }

    Ref<BatchPromise> batchDeleteOperation(DOMCacheIdentifier identifier, const ResourceRequest& request, CacheQueryOptions&& options) final
    {
        auto it = m_caches.find(identifier);
        if (it == m_caches.end())
            return BatchPromise::createAndReject(Error::Internal);
        Vector<uint64_t> removed;
        it->value.records.removeAllMatching([&](auto& record) {
            if (!matches(request, record, options))
                return false;
            removed.append(record.identifier);
            return true;
        });
        return BatchPromise::createAndResolve(WTF::move(removed));
    }

    Ref<BatchPromise> batchPutOperation(DOMCacheIdentifier identifier, Vector<CrossThreadRecord>&& records) final
    {
        auto it = m_caches.find(identifier);
        if (it == m_caches.end())
            return BatchPromise::createAndReject(Error::Internal);
        auto& stored = it->value.records;
        Vector<uint64_t> identifiers;
        for (auto& record : records) {
            // Gleiche Anfrage ersetzt den alten Eintrag (Cache.put)
            stored.removeAllMatching([&](auto& existing) {
                return matches(record.request, existing, { });
            });
            record.identifier = ++m_nextRecordIdentifier;
            record.updateResponseCounter = 0;
            identifiers.append(record.identifier);
            stored.append(WTF::move(record));
        }
        return BatchPromise::createAndResolve(WTF::move(identifiers));
    }

    void reference(DOMCacheIdentifier) final { }
    void dereference(DOMCacheIdentifier) final { }
    void lockStorage(const ClientOrigin&) final { }
    void unlockStorage(const ClientOrigin&) final { }

    HashMap<DOMCacheIdentifier, Cache> m_caches;
    Vector<DOMCacheIdentifier> m_order;
    uint64_t m_updateCounter { 0 };
    uint64_t m_nextRecordIdentifier { 0 };
};

class CacheStorageProviderWasm final : public CacheStorageProvider {
public:
    static Ref<CacheStorageProviderWasm> create() { return adoptRef(*new CacheStorageProviderWasm); }
    Ref<CacheStorageConnection> createCacheStorageConnection() final { return CacheStorageConnectionWasm::singleton(); }
};

Ref<CacheStorageProvider> createCacheStorageProvider()
{
    return CacheStorageProviderWasm::create();
}

} // namespace BrowserLite
