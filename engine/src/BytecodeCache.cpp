// Persistent bytecode cache for scripts.
//
// On big pages a good part of the JS time goes into parsing and generating
// bytecode (CNN: over 6 s on the first load). JavaScriptCore can store finished
// bytecode and load it again; WebCore hooks that up for Wasm in
// CachedScriptSourceProvider (patch, platform/wasm/BytecodeCacheWasm.cpp). This
// file provides the storage: the Cache API of the host browser
// (engine/js/bytecode-cache.js), like the HTTP cache.
//
// Flow: when a script resource starts loading, its key is remembered and the
// stored bytecode is fetched to the engine thread ahead of time (prefetch), JSC
// takes it on the first execution (take). New bytecode (whole script and every
// function that runs) is stored when idle after the page loaded, the next visit
// adds what is still missing. JSC checks the build ID and the whole source
// itself; a checksum against broken entries is added here.
//
// The key is the URL the page requested (without fragment), so a script behind
// a redirect or answered by a service worker with another URL still hits.

#include "config.h"
#include "BytecodeCache.h"

#include "Engine.h"
#include "EngineConfig.h"

#include <WebCore/CachedResource.h>
#include <WebCore/WasmPlatform.h>
#include <emscripten/emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/MallocSpan.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>
#include <wtf/SHA1.h>
#include <wtf/WeakHashMap.h>
#include <wtf/text/MakeString.h>

// Run on the main thread (engine/js/bytecode-cache.js)
// Build ID from the custom section of engine.wasm (tools/wasm-build-id.mjs)
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
EM_JS(void, blJsBytecodeCacheLookup, (const char* key), {
    blBytecodeCache.lookup(UTF8ToString(key));
});
// Copies the bytecode into a new entry before it returns
EM_JS(void, blJsBytecodeCacheStore, (const char* key, const uint8_t* bytecode, size_t length, uint64_t checksum), {
    blBytecodeCache.store(UTF8ToString(key), HEAPU8.subarray(bytecode, bytecode + length), checksum);
});

namespace BrowserLite::BytecodeCache {

static bool enabled;
static bool commitScheduled;

static constexpr size_t maximumEntrySize = 16 << 20;
// Fetched bytecode JSC did not pick up (script never ran)
static constexpr Seconds prefetchLifetime = 60_s;

// The block JS allocated with malloc, taken over by JSC as it is: FastMalloc is
// the system malloc on this platform (USE_SYSTEM_MALLOC; the small block cache of
// patch 0015 keeps every block a malloc block), and JSC::VMMalloc is FastMalloc.
using Bytecode = MallocSpan<uint8_t, FastMalloc>;

struct Prefetched {
    Bytecode bytes;
    MonotonicTime time;
};

struct Stats {
    unsigned hits { 0 };
    unsigned late { 0 };
    unsigned misses { 0 };
    unsigned stores { 0 };
};

// Key of every script resource that loaded from the network, remembered at the
// start of the load. Weak: a new resource at the address of a dead one has no key.
static WeakHashMap<WebCore::CachedResource, String>& resourceKeys()
{
    static NeverDestroyed<WeakHashMap<WebCore::CachedResource, String>> map;
    return map;
}

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

// Fast checksum (8 bytes per step), only against broken data
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

// nullopt: this script is not cached (it did not load from the network)
static std::optional<Bytecode> take(const WebCore::CachedResource& resource)
{
    auto key = resourceKeys().get(resource);
    if (key.isNull())
        return std::nullopt;
    if (auto entry = prefetched().takeOptional(key)) {
        stats().hits++;
        debugLog("Bytecode cache: hit %s (%zu KB)", key.utf8().data(), entry->bytes.span().size() / 1024);
        return WTF::move(entry->bytes);
    }
    if (pendingLookups().contains(key)) {
        stats().late++;
        debugLog("Bytecode cache: too late for %s", key.utf8().data());
    } else
        stats().misses++;
    return Bytecode { };
}

static void store(const WebCore::CachedResource& resource, Vector<uint8_t>&& bytecode)
{
    auto key = resourceKeys().get(resource);
    if (key.isNull() || bytecode.isEmpty() || bytecode.size() > maximumEntrySize)
        return;
    auto sum = checksum(bytecode.span());
    stats().stores++;
    debugLog("Bytecode cache: storing %s (%zu KB)", key.utf8().data(), bytecode.size() / 1024);
    runOnMainThread([key = key.utf8(), bytecode = WTF::move(bytecode), sum] {
        blJsBytecodeCacheStore(key.data(), bytecode.span().data(), bytecode.size(), sum);
    });
}

// JSC options change the bytecode: with JSC_* variables the ID gets their hash,
// so JSC (format version) and the cache name reject bytecode of other options
static CString withJSCOptions(const CString& buildID)
{
    auto& options = engineConfig().jscOptions;
    if (options.isEmpty())
        return buildID;
    static constexpr uint8_t separator[] = { '\n' };
    SHA1 sha1;
    for (auto& option : options) {
        sha1.addBytes(option);
        sha1.addBytes(std::span<const uint8_t> { separator });
    }
    SHA1::Digest digest;
    sha1.computeHash(digest);
    return makeString(String::fromUTF8(buildID.span()), "-jsc-"_s, String::fromLatin1(SHA1::hexDigest(digest).data()).left(16).convertToASCIILowercase()).utf8();
}

void initialize()
{
    auto& config = engineConfig();
    if (!config.bytecodeCache)
        return;
    CString buildID = config.buildID;
    if (buildID.isNull()) {
        std::unique_ptr<char, decltype(&free)> id(blJsBuildID(), free);
        if (!id)
            return;
        buildID = id.get();
    }
    if (!buildID.length())
        return;
    // JSC takes the ID as the version of the bytecode format (patch 0029,
    // JSCBytecodeCacheVersion.cpp), so it is set before the first script
    buildID = withJSCOptions(buildID);
    setenv("BL_BUILD_ID", buildID.data(), 1);
    enabled = true;
    runOnMainThread([buildID] {
        blJsBytecodeCacheOpen(buildID.data());
    });
    WebCore::WasmPlatform::setBytecodeCacheHandlers(take, store);
}

void prefetch(const WebCore::CachedResource& resource, const URL& requestURL)
{
    if (!enabled || !requestURL.protocolIsInHTTPFamily())
        return;
    auto key = cacheKey(requestURL);
    resourceKeys().set(resource, key);
    if (prefetched().contains(key) || !pendingLookups().add(key).isNewEntry)
        return;
    auto now = MonotonicTime::now();
    prefetched().removeIf([&](auto& entry) {
        return now - entry.value.time > prefetchLifetime;
    });
    runOnMainThread([key = key.utf8()] {
        blJsBytecodeCacheLookup(key.data());
    });
}

static void didLookup(const String& key, Bytecode&& bytes, uint64_t length, uint64_t storedChecksum)
{
    pendingLookups().remove(key);
    if (bytes.span().empty())
        return;
    if (length != bytes.span().size() || length > maximumEntrySize || storedChecksum != checksum(bytes.span())) {
        debugLog("Bytecode cache: broken entry %s", key.utf8().data());
        return;
    }
    prefetched().set(key, Prefetched { WTF::move(bytes), MonotonicTime::now() });
}

void scheduleCommit()
{
    if (!enabled || commitScheduled)
        return;
    commitScheduled = true;
    // After loading, scripts usually still start up; store when idle afterwards
    RunLoop::mainSingleton().dispatchAfter(5_s, [] {
        commitScheduled = false;
        WebCore::WasmPlatform::commitPendingBytecode();
        auto& counts = stats();
        debugLog("Bytecode cache: %u hits, %u too late, %u missing, %u stored", counts.hits, counts.late, counts.misses, counts.stores);
    });
}

} // namespace BrowserLite::BytecodeCache

using namespace BrowserLite;

extern "C" {

// From the main thread (engine/js/bytecode-cache.js): the bytecode of an entry
// (malloc, belongs to us afterwards; 0 = no entry) with the length and checksum
// of its header.
EMSCRIPTEN_KEEPALIVE void bl__bytecode_cache_result(const char* key, uint8_t* bytecode, size_t size, uint64_t length, uint64_t checksum)
{
    auto bytes = bytecode ? adoptMallocSpan<uint8_t, FastMalloc>(std::span { bytecode, size }) : BytecodeCache::Bytecode { };
    runOnEngineThread([key = String::fromUTF8(key).isolatedCopy(), bytes = WTF::move(bytes), length, checksum]() mutable {
        BytecodeCache::didLookup(key, WTF::move(bytes), length, checksum);
    });
}

} // extern "C"
