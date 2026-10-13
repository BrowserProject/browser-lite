// Cache API (caches.open, cache.put/match ...) fuer Seiten und Worker.
//
// In WebKit2 steckt die Umsetzung im Netzwerk-Prozess (CacheStorageManager).
// Hier eine kleine eigene im Speicher der Engine, fuer alle Tabs gemeinsam,
// nach Ursprung getrennt. Dauerhaft: pro Ursprung eine Datei unter
// /data/cachestorage (wie alles unter /data im IndexedDB des Host), beim
// ersten Zugriff gelesen und nach Aenderungen gebuendelt neu geschrieben.
// Das Format der Eintraege ist das von WebKits CacheStorageDiskStore.
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
#include <WebCore/FetchHeaders.h>
#include <WebCore/FormData.h>
#include <WebCore/RetrieveRecordsOptions.h>
#include <WebCore/SharedBuffer.h>
#include <WebCore/WebCorePersistentCoders.h>
#include <wtf/FileSystem.h>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>
#include <wtf/persistence/PersistentDecoder.h>
#include <wtf/persistence/PersistentEncoder.h>
#include <wtf/text/MakeString.h>

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

static constexpr uint32_t fileVersion = 1;
static constexpr auto storageDirectory = "/data/cachestorage"_s;

static String fileForOrigin(const ClientOrigin& origin)
{
    return FileSystem::pathByAppendingComponent(storageDirectory, FileSystem::encodeForFileName(makeString(origin.topOrigin.toString(), ' ', origin.clientOrigin.toString())));
}

static void encodeRecord(WTF::Persistence::Encoder& encoder, const CrossThreadRecord& record)
{
    encoder << static_cast<uint8_t>(record.requestHeadersGuard);
    encoder << record.request;
    record.options.encodePersistent(encoder);
    encoder << record.referrer;
    encoder << static_cast<uint8_t>(record.responseHeadersGuard);
    encoder << record.response;
    // Formulardaten mit Dateien/Blobs speichert auch WebKit nicht
    Vector<uint8_t> body = WTF::switchOn(record.responseBody, [](const Ref<FormData>& formData) {
        return formData->flatten();
    }, [](const Ref<SharedBuffer>& buffer) {
        return Vector<uint8_t> { buffer->span() };
    }, [](const std::nullptr_t&) {
        return Vector<uint8_t> { };
    });
    bool hasBody = !std::holds_alternative<std::nullptr_t>(record.responseBody);
    encoder << hasBody;
    encoder << body;
    encoder << record.responseBodySize;
}

static std::optional<CrossThreadRecord> decodeRecord(WTF::Persistence::Decoder& decoder)
{
    std::optional<uint8_t> requestGuard;
    decoder >> requestGuard;
    std::optional<ResourceRequest> request;
    decoder >> request;
    FetchOptions options;
    if (!requestGuard || !request || !FetchOptions::decodePersistent(decoder, options))
        return std::nullopt;
    std::optional<String> referrer;
    decoder >> referrer;
    std::optional<uint8_t> responseGuard;
    decoder >> responseGuard;
    std::optional<ResourceResponse::CrossThreadData> response;
    decoder >> response;
    std::optional<bool> hasBody;
    decoder >> hasBody;
    std::optional<Vector<uint8_t>> body;
    decoder >> body;
    std::optional<uint64_t> bodySize;
    decoder >> bodySize;
    if (!referrer || !responseGuard || !response || !hasBody || !body || !bodySize)
        return std::nullopt;
    ResponseBody responseBody = nullptr;
    if (*hasBody)
        responseBody = SharedBuffer::create(WTF::move(*body));
    return CrossThreadRecord { 0, 0, static_cast<FetchHeaders::Guard>(*requestGuard), WTF::move(*request), WTF::move(options), WTF::move(*referrer),
        static_cast<FetchHeaders::Guard>(*responseGuard), WTF::move(*response), WTF::move(responseBody), *bodySize };
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

    // Gespeicherte Caches des Ursprungs beim ersten Zugriff lesen
    void ensureLoaded(const ClientOrigin& origin)
    {
        if (!m_loadedOrigins.add(origin).isNewEntry)
            return;
        auto data = FileSystem::readEntireFile(fileForOrigin(origin));
        if (!data)
            return;
        WTF::Persistence::Decoder decoder(data->span());
        std::optional<uint32_t> version;
        decoder >> version;
        std::optional<uint64_t> cacheCount;
        decoder >> cacheCount;
        if (version != fileVersion || !cacheCount)
            return;
        for (uint64_t i = 0; i < *cacheCount; ++i) {
            std::optional<String> name;
            decoder >> name;
            std::optional<uint64_t> recordCount;
            decoder >> recordCount;
            if (!name || !recordCount)
                return;
            Cache cache { *name, origin, { } };
            for (uint64_t j = 0; j < *recordCount; ++j) {
                auto record = decodeRecord(decoder);
                if (!record)
                    return;
                record->identifier = ++m_nextRecordIdentifier;
                cache.records.append(WTF::move(*record));
            }
            auto identifier = DOMCacheIdentifier::generate();
            m_caches.add(identifier, WTF::move(cache));
            m_order.append(identifier);
            // Die Seiten merken sich die Liste der Caches bis zur naechsten Aenderung
            ++m_updateCounter;
        }
    }

    // Nach einer Aenderung: kurz sammeln, dann die Datei des Ursprungs schreiben
    void markChanged(const ClientOrigin& origin)
    {
        m_changedOrigins.add(origin);
        if (std::exchange(m_writeScheduled, true))
            return;
        RunLoop::mainSingleton().dispatchAfter(500_ms, [this] {
            m_writeScheduled = false;
            for (auto& origin : std::exchange(m_changedOrigins, { }))
                write(origin);
        });
    }

    void write(const ClientOrigin& origin)
    {
        Vector<const Cache*> caches;
        for (auto identifier : m_order) {
            auto it = m_caches.find(identifier);
            if (it != m_caches.end() && it->value.origin == origin)
                caches.append(&it->value);
        }
        auto file = fileForOrigin(origin);
        if (caches.isEmpty()) {
            FileSystem::deleteFile(file);
            return;
        }
        WTF::Persistence::Encoder encoder;
        encoder << fileVersion;
        encoder << static_cast<uint64_t>(caches.size());
        for (auto* cache : caches) {
            encoder << cache->name;
            encoder << static_cast<uint64_t>(cache->records.size());
            for (auto& record : cache->records)
                encodeRecord(encoder, record);
        }
        FileSystem::makeAllDirectories(storageDirectory);
        FileSystem::overwriteEntireFile(file, encoder.span());
    }

    Ref<OpenPromise> open(const ClientOrigin& origin, const String& name) final
    {
        ensureLoaded(origin);
        for (auto& [identifier, cache] : m_caches) {
            if (cache.origin == origin && cache.name == name)
                return OpenPromise::createAndResolve(CacheIdentifierOperationResult { identifier, false });
        }
        auto identifier = DOMCacheIdentifier::generate();
        m_caches.add(identifier, Cache { name, origin, { } });
        m_order.append(identifier);
        ++m_updateCounter;
        markChanged(origin);
        return OpenPromise::createAndResolve(CacheIdentifierOperationResult { identifier, false });
    }

    Ref<RemovePromise> remove(DOMCacheIdentifier identifier) final
    {
        auto it = m_caches.find(identifier);
        bool removed = it != m_caches.end();
        if (removed) {
            auto origin = it->value.origin;
            m_caches.remove(it);
            ++m_updateCounter;
            markChanged(origin);
        }
        m_order.removeFirst(identifier);
        return RemovePromise::createAndResolve(removed);
    }

    Ref<RetrieveCachesPromise> retrieveCaches(const ClientOrigin& origin, uint64_t) final
    {
        ensureLoaded(origin);
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
        if (!removed.isEmpty())
            markChanged(it->value.origin);
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
        markChanged(it->value.origin);
        return BatchPromise::createAndResolve(WTF::move(identifiers));
    }

    void reference(DOMCacheIdentifier) final { }
    void dereference(DOMCacheIdentifier) final { }
    void lockStorage(const ClientOrigin&) final { }
    void unlockStorage(const ClientOrigin&) final { }

    HashMap<DOMCacheIdentifier, Cache> m_caches;
    Vector<DOMCacheIdentifier> m_order;
    HashSet<ClientOrigin> m_loadedOrigins;
    HashSet<ClientOrigin> m_changedOrigins;
    bool m_writeScheduled { false };
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
