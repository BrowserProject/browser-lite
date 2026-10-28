#include "config.h"
#include "EngineConfig.h"

#include "Engine.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <emscripten/emscripten.h>
#include <sys/stat.h>
#include <wtf/NeverDestroyed.h>

namespace BrowserLite {

static constexpr auto defaultStorageNamespace = "browserlite";

static EngineConfig& mutableConfig()
{
    static NeverDestroyed<EngineConfig> config;
    return config;
}

const EngineConfig& engineConfig()
{
    return mutableConfig();
}

bool featureEnabled(Feature feature)
{
    return engineConfig().features.contains(feature);
}

static const char* value(const char* name)
{
    const char* text = getenv(name);
    return text && *text ? text : nullptr;
}

static bool flag(const char* name, bool fallback)
{
    const char* text = value(name);
    return text ? strcmp(text, "0") : fallback;
}

static uint64_t number(const char* name, uint64_t fallback)
{
    const char* text = value(name);
    return text ? strtoull(text, nullptr, 10) : fallback;
}

static constexpr std::pair<const char*, Feature> featureNames[] = {
    { "audio", Feature::Audio },
    { "media", Feature::Media },
    { "pip", Feature::PictureInPicture },
    { "capture", Feature::Capture },
    { "webrtc", Feature::WebRTC },
    { "fs-access", Feature::FileSystemAccess },
    { "image-decoder", Feature::ImageDecoder },
    { "eyedropper", Feature::EyeDropper },
    { "battery", Feature::Battery },
    { "keyboard", Feature::Keyboard },
    { "network-info", Feature::NetworkInfo },
    { "geolocation", Feature::Geolocation },
    { "sensors", Feature::Sensors },
    { "gamepad", Feature::Gamepad },
    { "speech", Feature::Speech },
    { "notifications", Feature::Notifications },
    { "clipboard", Feature::Clipboard },
};

// Unset means all features (standalone engine tests), an empty list none
static OptionSet<Feature> parseFeatures(const char* list)
{
    OptionSet<Feature> features;
    if (!list) {
        for (auto& [name, feature] : featureNames)
            features.add(feature);
        return features;
    }
    for (auto& entry : String::fromUTF8(list).split(',')) {
        auto name = entry.trim(isASCIIWhitespace<char16_t>).utf8();
        bool known = false;
        for (auto& [featureName, feature] : featureNames) {
            if (!strcmp(name.data(), featureName)) {
                features.add(feature);
                known = true;
            }
        }
        if (!known)
            log("BL_FEATURES: unknown feature %s", name.data());
    }
    return features;
}

Vector<String> enabledFeatureNames()
{
    Vector<String> names;
    for (auto& [name, feature] : featureNames) {
        if (featureEnabled(feature))
            names.append(String::fromLatin1(name));
    }
    return names;
}

static bool isValidNamespace(const char* name)
{
    size_t length = strlen(name);
    if (!length || length > 32)
        return false;
    for (size_t i = 0; i < length; ++i) {
        char c = name[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_'))
            return false;
    }
    return true;
}

// Extra CA certificates (PEM) become a file for CurlSSLHandleWasm.cpp. They are
// neither kept in the configuration nor left in the environment.
static void installExtraCertificates()
{
    const char* pem = value("BL_EXTRA_CA");
    if (pem) {
        mkdir("/etc/ssl", 0755);
        mkdir("/etc/ssl/certs", 0755);
        if (FILE* file = fopen("/etc/ssl/certs/extra-ca.crt", "w")) {
            fputs(pem, file);
            fclose(file);
        }
    }
    unsetenv("BL_EXTRA_CA");
}

void loadEngineConfig()
{
    auto& config = mutableConfig();
    config.debug = flag("BL_DEBUG", false);
    config.testHooks = flag("BL_TEST_HOOKS", false);
    config.features = parseFeatures(getenv("BL_FEATURES"));
    config.opfs = flag("BL_OPFS", true);
    config.httpCache = flag("BL_HTTP_CACHE", true);
    config.storageNamespace = defaultStorageNamespace;
    if (const char* name = value("BL_STORAGE_NAMESPACE")) {
        if (isValidNamespace(name))
            config.storageNamespace = name;
        else {
            // Nothing persistent, so the default namespace is never touched
            log("BL_STORAGE_NAMESPACE: invalid name, storage stays in memory");
            config.opfs = false;
            config.httpCache = false;
        }
    }
    if (const char* page = value("BL_ERROR_PAGE"))
        config.errorPage = String::fromUTF8(page);
    config.gpu = flag("BL_GPU", true);
    config.compositing = flag("BL_COMPOSITING", true);
    config.asyncScrolling = flag("BL_ASYNC_SCROLLING", true);
    config.skipUnchangedFrames = !config.testHooks || flag("BL_DAMAGE", true);
    config.videoOverlay = flag("BL_VIDEO_OVERLAY", true);
    config.asyncImageDecoding = flag("BL_ASYNC_IMAGE_DECODING", true);
    config.imageSubsampling = flag("BL_IMAGE_SUBSAMPLING", true);
    config.firstPaintEarly = flag("BL_FIRST_PAINT_EARLY", true);
    if (const char* wait = value("BL_FALLBACK_FONT_WAIT"))
        config.fallbackFontWaitMs = atof(wait);
    if (const char* timeout = value("BL_SCRIPT_TIMEOUT"))
        config.scriptTimeoutSeconds = atof(timeout);
    config.memoryReleaseMB = static_cast<size_t>(number("BL_MEMORY_RELEASE_MB", config.memoryReleaseMB));
    config.memoryPressureMB = static_cast<size_t>(number("BL_MEMORY_PRESSURE_MB", config.memoryPressureMB));
    config.indexedDBQuotaMB = number("BL_INDEXEDDB_QUOTA_MB", config.indexedDBQuotaMB);
    config.databaseMaxMB = number("BL_DATABASE_MAX_MB", config.databaseMaxMB);
    config.httpCacheMB = number("BL_HTTP_CACHE_MB", config.httpCacheMB);
    config.fontconfigEarly = flag("BL_FONTCONFIG_EARLY", true);
    config.spareWorkers = static_cast<int>(number("BL_SPARE_WORKERS", config.spareWorkers));
    installExtraCertificates();
}

} // namespace BrowserLite

// The WasmFS OPFS backend runs on its own worker that does not see the host's
// Module fields: it reads the namespace of /data here (engine/js/wasmfs-opfs.js).
extern "C" EMSCRIPTEN_KEEPALIVE const char* bl__storage_namespace()
{
    return BrowserLite::engineConfig().storageNamespace.data();
}

// Limit of the HTTP cache in the host's Cache API (engine/js/http-cache.js)
extern "C" EMSCRIPTEN_KEEPALIVE double bl__http_cache_limit_mb()
{
    return static_cast<double>(BrowserLite::engineConfig().httpCacheMB);
}
