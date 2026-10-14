// Dauerhafter Bytecode-Cache fuer Skripte.
//
// Auf grossen Seiten geht ein guter Teil der JS-Zeit ins Parsen und ins
// Erzeugen von Bytecode (CNN: ueber 6 s beim ersten Laden). JavaScriptCore
// kann fertigen Bytecode speichern und wieder laden; WebCore haengt das fuer
// Wasm an CachedScriptSourceProvider (Patch, platform/wasm/BytecodeCacheWasm.cpp).
// Hier liegt der Speicher dazu: die Cache API des Host-Browsers
// (engine/js/bytecode-cache.js), wie beim HTTP-Cache.
//
// Ablauf: Beim Start des Ladens eines Skripts holen wir den gespeicherten
// Bytecode schon mal auf den Engine-Thread (prefetch), JSC nimmt ihn beim
// ersten Ausfuehren (take). Neuer Bytecode (ganzes Skript und jede Funktion,
// die laeuft) wird nach dem Laden der Seite im Leerlauf gespeichert, beim
// naechsten Besuch kommt dazu, was noch fehlt. JSC prueft selbst Build-ID und
// den ganzen Quelltext; hier kommt eine Pruefsumme gegen kaputte Eintraege dazu.

#include "config.h"
#include "BytecodeCache.h"

#include "Engine.h"

#include <WebCore/WasmPlatform.h>
#include <emscripten/emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>

// Laufen auf dem Haupt-Thread (engine/js/bytecode-cache.js)
// Build-ID aus der Custom Section von engine.wasm (tools/wasm-build-id.py)
EM_JS(char*, blJsBuildID, (), {
    try {
        var sections = WebAssembly.Module.customSections(wasmModule, 'bl_build_id');
        if (sections.length)
            return stringToNewUTF8(new TextDecoder().decode(sections[0]));
    } catch (e) { }
    return 0;
});
EM_JS(void, blJsBytecodeCacheOpen, (const char* buildID), {
    blBytecodeCache.open(UTF8ToString(buildID));
});
EM_JS(void, blJsBytecodeCacheLookup, (const char* url), {
    blBytecodeCache.lookup(UTF8ToString(url));
});
EM_JS(void, blJsBytecodeCacheStore, (const char* url, const uint8_t* data, int length), {
    blBytecodeCache.store(UTF8ToString(url), HEAPU8.slice(data, data + length));
});

namespace BrowserLite::BytecodeCache {

static bool enabled;
static bool commitScheduled;

// Eintrag: Kopf + Bytecode von JSC
struct Header {
    char magic[4];
    uint32_t version;
    uint64_t length;
    uint64_t checksum;
};
static constexpr char headerMagic[4] = { 'B', 'L', 'B', 'C' };
static constexpr uint32_t headerVersion = 1;
static constexpr size_t maximumEntrySize = 16 << 20;
// Geholter Bytecode, den JSC nicht abgeholt hat (Skript nie ausgefuehrt)
static constexpr Seconds prefetchLifetime = 60_s;

struct Prefetched {
    Vector<uint8_t> bytes;
    MonotonicTime time;
};

struct Stats {
    unsigned hits { 0 };
    unsigned late { 0 };
    unsigned misses { 0 };
    unsigned stores { 0 };
};

static HashMap<String, Prefetched>& prefetched()
{
    static NeverDestroyed<HashMap<String, Prefetched>> map;
    return map;
}

static HashSet<String>& pendingLookups()
{
    static NeverDestroyed<HashSet<String>> set;
    return set;
}

static Stats& stats()
{
    static Stats stats;
    return stats;
}

static String cacheKey(const URL& url)
{
    return url.viewWithoutFragmentIdentifier().toString();
}

// Schnelle Pruefsumme (8 Bytes pro Schritt), nur gegen kaputte Daten
static uint64_t checksum(std::span<const uint8_t> data)
{
    uint64_t hash = 0x9e3779b97f4a7c15ull ^ data.size();
    size_t i = 0;
    for (; i + 8 <= data.size(); i += 8) {
        uint64_t word;
        memcpy(&word, data.data() + i, 8);
        hash = (std::rotl(hash ^ (word * 0x87c37b91114253d5ull), 31) * 0x4cf5ad432745937full) + 0x52dce729;
    }
    for (; i < data.size(); ++i)
        hash = (hash ^ data[i]) * 0x100000001b3ull;
    hash ^= hash >> 33;
    hash *= 0xff51afd7ed558ccdull;
    hash ^= hash >> 33;
    return hash;
}

template<typename Function>
static void runOnMainThread(Function&& function)
{
    auto* job = new WTF::Function<void()>(std::forward<Function>(function));
    emscripten_proxy_async(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(), [](void* argument) {
        std::unique_ptr<WTF::Function<void()>> job(static_cast<WTF::Function<void()>*>(argument));
        (*job)();
    }, job);
}

static std::optional<Vector<uint8_t>> take(const String& url)
{
    auto key = cacheKey(URL { url });
    auto entry = prefetched().take(key);
    if (!entry.bytes.isEmpty()) {
        stats().hits++;
        debugLog("Bytecode-Cache: Treffer %s (%zu KB)", key.utf8().data(), entry.bytes.size() / 1024);
        return WTF::move(entry.bytes);
    }
    if (pendingLookups().contains(key)) {
        stats().late++;
        debugLog("Bytecode-Cache: zu spaet fuer %s", key.utf8().data());
    } else
        stats().misses++;
    return std::nullopt;
}

static void store(const String& url, Vector<uint8_t>&& bytecode)
{
    if (bytecode.isEmpty() || bytecode.size() > maximumEntrySize)
        return;
    auto size = sizeof(Header) + bytecode.size();
    auto* data = static_cast<uint8_t*>(malloc(size));
    if (!data)
        return;
    Header header;
    memcpy(header.magic, headerMagic, 4);
    header.version = headerVersion;
    header.length = bytecode.size();
    header.checksum = checksum(bytecode.span());
    memcpy(data, &header, sizeof(Header));
    memcpy(data + sizeof(Header), bytecode.span().data(), bytecode.size());
    stats().stores++;
    debugLog("Bytecode-Cache: speichere %s (%zu KB)", url.utf8().data(), bytecode.size() / 1024);
    runOnMainThread([url = cacheKey(URL { url }).utf8(), data, size] {
        blJsBytecodeCacheStore(url.data(), data, size);
        free(data);
    });
}

void initialize()
{
    const char* setting = getenv("BL_BYTECODE_CACHE");
    if (setting && !strcmp(setting, "0"))
        return;
    // JSC nimmt die ID als Version des Bytecode-Formats (Patch in
    // JSCBytecodeCacheVersion.cpp), darum vor dem ersten Skript setzen
    if (!getenv("BL_BUILD_ID")) {
        std::unique_ptr<char, decltype(&free)> id(blJsBuildID(), free);
        if (!id)
            return;
        setenv("BL_BUILD_ID", id.get(), 1);
    }
    const char* buildID = getenv("BL_BUILD_ID");
    if (!*buildID)
        return;
    enabled = true;
    runOnMainThread([buildID = CString(buildID)] {
        blJsBytecodeCacheOpen(buildID.data());
    });
    WebCore::WasmPlatform::setBytecodeCacheHandlers(take, store);
}

void prefetch(const URL& url)
{
    if (!enabled || !url.protocolIsInHTTPFamily())
        return;
    auto key = cacheKey(url);
    if (prefetched().contains(key) || !pendingLookups().add(key).isNewEntry)
        return;
    auto now = MonotonicTime::now();
    prefetched().removeIf([&](auto& entry) {
        return now - entry.value.time > prefetchLifetime;
    });
    runOnMainThread([url = key.utf8()] {
        blJsBytecodeCacheLookup(url.data());
    });
}

static void didLookup(const String& url, uint8_t* data, size_t length)
{
    pendingLookups().remove(url);
    std::unique_ptr<uint8_t, decltype(&free)> owner(data, free);
    if (!data || length < sizeof(Header))
        return;
    Header header;
    memcpy(&header, data, sizeof(Header));
    auto payload = std::span<const uint8_t>(data + sizeof(Header), length - sizeof(Header));
    if (memcmp(header.magic, headerMagic, 4) || header.version != headerVersion || header.length != payload.size() || header.checksum != checksum(payload)) {
        debugLog("Bytecode-Cache: kaputter Eintrag %s", url.utf8().data());
        return;
    }
    prefetched().set(url, Prefetched { Vector<uint8_t>(payload), MonotonicTime::now() });
}

void scheduleCommit()
{
    if (!enabled || commitScheduled)
        return;
    commitScheduled = true;
    // Nach dem Laden laufen meist noch Skripte an; dann im Leerlauf speichern
    RunLoop::mainSingleton().dispatchAfter(5_s, [] {
        commitScheduled = false;
        WebCore::WasmPlatform::commitPendingBytecode();
        auto& counts = stats();
        debugLog("Bytecode-Cache: %u Treffer, %u zu spaet, %u nicht da, %u gespeichert", counts.hits, counts.late, counts.misses, counts.stores);
    });
}

} // namespace BrowserLite::BytecodeCache

using namespace BrowserLite;

extern "C" {

// Vom Haupt-Thread (engine/js/bytecode-cache.js): data 0 = nicht im Cache.
// data gehoert danach uns (malloc).
EMSCRIPTEN_KEEPALIVE void bl_bytecode_cache_result(const char* url, uint8_t* data, int length)
{
    auto key = String::fromUTF8(url);
    runOnEngineThread([key = WTF::move(key).isolatedCopy(), data, length] {
        BytecodeCache::didLookup(key, data, length);
    });
}

} // extern "C"
