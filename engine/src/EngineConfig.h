// Configuration of the engine from its environment (BL_*). Read once at the
// start of main() before other threads start, immutable afterwards. The only
// place in engine/src that calls getenv (engine/abi.json lists every value).
#pragma once

#include <wtf/OptionSet.h>
#include <wtf/Vector.h>
#include <wtf/text/CString.h>
#include <wtf/text/WTFString.h>

namespace BrowserLite {

// Optional parts of the web platform that need a service of the host
// (BL_FEATURES). A disabled feature looks to the page like a browser without it.
enum class Feature : uint32_t {
    Audio = 1 << 0,
    Media = 1 << 1,
    PictureInPicture = 1 << 2,
    Capture = 1 << 3,
    WebRTC = 1 << 4,
    FileSystemAccess = 1 << 5,
    ImageDecoder = 1 << 6,
    EyeDropper = 1 << 7,
    Battery = 1 << 8,
    Keyboard = 1 << 9,
    NetworkInfo = 1 << 10,
    Geolocation = 1 << 11,
    Sensors = 1 << 12,
    Gamepad = 1 << 13,
    Speech = 1 << 14,
    Notifications = 1 << 15,
    Clipboard = 1 << 16,
};

struct EngineConfig {
    bool debug { false }; // BL_DEBUG
    bool testHooks { false }; // BL_TEST_HOOKS
    OptionSet<Feature> features; // BL_FEATURES, unset = all
    bool opfs { true }; // BL_OPFS
    CString storageNamespace; // BL_STORAGE_NAMESPACE
    String errorPage; // BL_ERROR_PAGE, null = built-in template
    bool gpu { true }; // BL_GPU
    bool compositing { true }; // BL_COMPOSITING
    bool asyncScrolling { true }; // BL_ASYNC_SCROLLING
    // BL_DAMAGE, 0 only with test hooks: every frame composited and shown, the
    // reference of tests/core/damage-test.mjs (#220)
    bool skipUnchangedFrames { true };
    // BL_VIDEO_OVERLAY: the host shows its <video> behind the view canvas (#232); 0 copies the
    // frames into the engine (#217)
    bool videoOverlay { true };
    bool httpCache { true }; // BL_HTTP_CACHE
    double scriptTimeoutSeconds { 30 }; // BL_SCRIPT_TIMEOUT
    size_t memoryReleaseMB { 192 }; // BL_MEMORY_RELEASE_MB
    size_t memoryPressureMB { 3072 }; // BL_MEMORY_PRESSURE_MB
    uint64_t indexedDBQuotaMB { 256 }; // BL_INDEXEDDB_QUOTA_MB
    uint64_t databaseMaxMB { 512 }; // BL_DATABASE_MAX_MB
    bool fontconfigEarly { true }; // BL_FONTCONFIG_EARLY
    int spareWorkers { 4 }; // BL_SPARE_WORKERS
};

// Reads the environment and writes BL_EXTRA_CA to a file (then removes it from
// the environment). Only at the start of main().
void loadEngineConfig();
const EngineConfig& engineConfig();
bool featureEnabled(Feature);
// Names of the enabled features as in BL_FEATURES (for the polyfills)
Vector<String> enabledFeatureNames();

} // namespace BrowserLite
