# browser-lite Engine (Embedder) als Teil des WebKit-Builds mit PORT=Wasm.
#
# Wird aus Source/WebCore/PlatformWasm.cmake per cmake_language(DEFER ...)
# eingebunden, wenn BROWSER_LITE_ENGINE_DIR gesetzt ist. So laeuft diese Datei
# NACH dem ganzen WebCore/CMakeLists.txt und sieht die fertigen Include-Listen.
# (Gleiches Muster wie WebCoreTestSupport unten in WebCore/CMakeLists.txt.)

set(BL_ENGINE_SRC "${BROWSER_LITE_ENGINE_DIR}/src")
set(BL_LEGACY_STORAGE "${CMAKE_SOURCE_DIR}/Source/WebKitLegacy/Storage")

add_executable(BrowserLiteEngine
    ${BL_ENGINE_SRC}/BackForwardList.cpp
    ${BL_ENGINE_SRC}/Choosers.cpp
    ${BL_ENGINE_SRC}/Clients.cpp
    ${BL_ENGINE_SRC}/DeviceClients.cpp
    ${BL_ENGINE_SRC}/EditorClient.cpp
    ${BL_ENGINE_SRC}/EngineLoop.cpp
    ${BL_ENGINE_SRC}/Exports.cpp
    ${BL_ENGINE_SRC}/FileAccessCache.cpp
    ${BL_ENGINE_SRC}/Gamepad.cpp
    ${BL_ENGINE_SRC}/Host.cpp
    ${BL_ENGINE_SRC}/LoaderStrategy.cpp
    ${BL_ENGINE_SRC}/Permissions.cpp
    ${BL_ENGINE_SRC}/PlatformStrategies.cpp
    ${BL_ENGINE_SRC}/HttpCache.cpp
    ${BL_ENGINE_SRC}/MemoryVFS.cpp
    ${BL_ENGINE_SRC}/Sockets.cpp
    ${BL_ENGINE_SRC}/Speech.cpp
    ${BL_ENGINE_SRC}/Storage.cpp
    ${BL_ENGINE_SRC}/WebView.cpp
    ${BL_ENGINE_SRC}/main.cpp
    ${BL_ENGINE_SRC}/media/ContainerParser.cpp
    ${BL_ENGINE_SRC}/media/MediaFetch.cpp
    ${BL_ENGINE_SRC}/media/MediaSourceWasm.cpp
    ${BL_ENGINE_SRC}/media/MediaPlayerPrivateWasm.cpp
    ${BL_ENGINE_SRC}/wasm/WasmBridge.cpp
    ${BL_ENGINE_SRC}/websocket/WasmSocketProvider.cpp
    ${BL_ENGINE_SRC}/websocket/SocketStreamHandle.cpp
    ${BL_ENGINE_SRC}/websocket/SocketStreamHandleCurl.cpp
    ${BL_ENGINE_SRC}/websocket/WebSocketChannel.cpp

    # localStorage + IndexedDB aus WebKitLegacy (ohne den Rest von WebKitLegacy)
    ${BL_LEGACY_STORAGE}/InProcessIDBServer.cpp
    ${BL_LEGACY_STORAGE}/StorageAreaImpl.cpp
    ${BL_LEGACY_STORAGE}/StorageAreaSync.cpp
    ${BL_LEGACY_STORAGE}/StorageNamespaceImpl.cpp
    ${BL_LEGACY_STORAGE}/StorageSyncManager.cpp
    ${BL_LEGACY_STORAGE}/StorageThread.cpp
    ${BL_LEGACY_STORAGE}/StorageTracker.cpp
    ${BL_LEGACY_STORAGE}/WebDatabaseProvider.cpp
    ${BL_LEGACY_STORAGE}/WebStorageNamespaceProvider.cpp
)
set_target_properties(BrowserLiteEngine PROPERTIES OUTPUT_NAME engine)

# Die WebKitLegacy-Dateien haben kein #include "config.h" (dort macht das ein
# Prefix-Header), darum hier per -include
set_source_files_properties(
    ${BL_LEGACY_STORAGE}/InProcessIDBServer.cpp
    ${BL_LEGACY_STORAGE}/StorageAreaImpl.cpp
    ${BL_LEGACY_STORAGE}/StorageAreaSync.cpp
    ${BL_LEGACY_STORAGE}/StorageNamespaceImpl.cpp
    ${BL_LEGACY_STORAGE}/StorageSyncManager.cpp
    ${BL_LEGACY_STORAGE}/StorageThread.cpp
    ${BL_LEGACY_STORAGE}/StorageTracker.cpp
    ${BL_LEGACY_STORAGE}/WebDatabaseProvider.cpp
    ${BL_LEGACY_STORAGE}/WebStorageNamespaceProvider.cpp
    PROPERTIES COMPILE_OPTIONS "-includeconfig.h"
)

target_include_directories(BrowserLiteEngine PRIVATE
    ${BL_ENGINE_SRC}
    ${BL_ENGINE_SRC}/media
    ${BL_ENGINE_SRC}/websocket
    ${BL_LEGACY_STORAGE}
    ${WebCore_INCLUDE_DIRECTORIES}
    ${WebCore_PRIVATE_INCLUDE_DIRECTORIES}
)
target_include_directories(BrowserLiteEngine SYSTEM PRIVATE
    ${WebCore_SYSTEM_INCLUDE_DIRECTORIES}
)

# WebCore ist statisch, seine privaten Abhaengigkeiten (JSC, WTF, PAL, curl,
# ICU, ...) kommen als LINK_ONLY mit. Skia direkt fuer die Include-Pfade.
target_link_libraries(BrowserLiteEngine PRIVATE WebCore Skia::Skia)

# Private Abhaengigkeiten der statischen Libs, die CMake nicht kennt
# (stehen nur als Requires.private in den .pc-Dateien).
find_library(BL_WOFF2COMMON_LIBRARY woff2common REQUIRED)
find_library(BL_EXPAT_LIBRARY expat REQUIRED)
# libwebp (Encoder fuer toDataURL/toBlob) braucht libsharpyuv
find_library(BL_SHARPYUV_LIBRARY sharpyuv REQUIRED)
target_link_libraries(BrowserLiteEngine PRIVATE ${BL_WOFF2COMMON_LIBRARY} ${BL_EXPAT_LIBRARY} ${BL_SHARPYUV_LIBRARY})

target_link_options(BrowserLiteEngine PRIVATE
    # main() laeuft in einem eigenen Worker (pthread). Der Haupt-Thread der
    # Seite bleibt frei fuer die UI.
    "SHELL:-pthread"
    "SHELL:-sPROXY_TO_PTHREAD"
    "SHELL:-sPTHREAD_POOL_SIZE=8"
    "SHELL:-sSTACK_SIZE=8MB"
    "SHELL:-sDEFAULT_PTHREAD_STACK_SIZE=4MB"
    "SHELL:-sINITIAL_MEMORY=256MB"
    "SHELL:-sALLOW_MEMORY_GROWTH=1"
    "SHELL:-sMAXIMUM_MEMORY=4GB"
    # Die Engine laeuft "ewig", main() kehrt mit lebender Runtime zurueck
    "SHELL:-sEXIT_RUNTIME=0"
    "SHELL:-sENVIRONMENT=web,worker,node"
    "SHELL:-sMODULARIZE=1"
    "SHELL:-sEXPORT_NAME=createBrowserLiteEngine"
    "SHELL:-sEXPORTED_RUNTIME_METHODS=FS,ENV,HEAPU8,HEAPF32,addRunDependency,removeRunDependency,ccall,cwrap,stringToUTF8,stringToNewUTF8,lengthBytesUTF8,UTF8ToString"
    "SHELL:-sEXPORTED_FUNCTIONS=_main,_malloc,_free"
    "SHELL:-lEGL"
    # WebGL der Seiten (platform/wasm/angle): WebGL 1 und 2. Ohne FULL_ES3, die
    # Emulation von Client-Arrays braucht WebGL nicht und kostet bei jedem Draw.
    "SHELL:-sMAX_WEBGL_VERSION=2"
    "SHELL:-lGL"
    # Dauerhafter Speicher (/data) ueber IndexedDB des Host-Browsers, siehe web/app.js
    "SHELL:-lidbfs.js"
    "SHELL:-Wl,--error-limit=0"
    # WebKit baut mit -fno-exceptions, einige Deps (C++) koennen aber werfen.
    # Werfen erlauben (ohne Fangen fuehrt ein throw zu abort).
    "SHELL:-sDISABLE_EXCEPTION_THROWING=0"
    # Funktionsnamen behalten (Profile, Stacktraces; tools/optimize-site.mjs
    # entfernt sie fuer die Auslieferung)
    "SHELL:--profiling-funcs"
    "SHELL:--pre-js ${BROWSER_LITE_ENGINE_DIR}/js/engine-pre.js"
    # WebAssembly der Seiten (engine/src/wasm/WasmBridge.cpp)
    "SHELL:--pre-js ${BROWSER_LITE_ENGINE_DIR}/js/wasm-rewrite.js"
    "SHELL:--pre-js ${BROWSER_LITE_ENGINE_DIR}/js/wasm-host.js"
    # Sockets im WASM statt SOCKFS (engine/src/Sockets.cpp): die Funktionen
    # beim Linken abfangen, Verbindungen ueber den Transport der Oberflaeche
    "SHELL:--pre-js ${BROWSER_LITE_ENGINE_DIR}/js/sockets.js"
    # HTTP-Cache in der Cache API des Host (engine/src/HttpCache.cpp)
    "SHELL:--pre-js ${BROWSER_LITE_ENGINE_DIR}/js/http-cache.js"
    "SHELL:-Wl,--wrap=socket,--wrap=connect,--wrap=bind,--wrap=send,--wrap=recv,--wrap=read,--wrap=write,--wrap=close"
    "SHELL:-Wl,--wrap=poll,--wrap=select,--wrap=fcntl,--wrap=getsockopt,--wrap=setsockopt,--wrap=getpeername,--wrap=getsockname"
    "SHELL:-Wl,--wrap=pipe2,--wrap=getaddrinfo,--wrap=freeaddrinfo"
    # access() auf feste Dateien gemerkt (engine/src/FileAccessCache.cpp)
    "SHELL:-Wl,--wrap=access"
)

# GC-Wurzeln in WASM-Locals: Die Engine laesst den GC nur auf leerem Stack
# laufen (engine/src/EngineLoop.cpp, Patch 0012), darum braucht es den Pass
# nicht. Er macht alles etwa 10x langsamer, bleibt aber zum Vergleichen da
# (braucht --profiling-funcs, siehe oben).
option(BROWSER_LITE_SPILL_POINTERS "Binaryen --spill-pointers fuer den konservativen GC" OFF)
if (BROWSER_LITE_SPILL_POINTERS)
    target_link_options(BrowserLiteEngine PRIVATE "SHELL:-sBINARYEN_EXTRA_PASSES=--spill-pointers")
endif ()

# Laufzeit-Dateien (fontconfig-Konfig, Fonts, CA-Zertifikate) als Datenpaket.
if (BROWSER_LITE_RUNTIME_DIR)
    target_link_options(BrowserLiteEngine PRIVATE
        "SHELL:--preload-file ${BROWSER_LITE_RUNTIME_DIR}@/"
        # HRTF-Daten fuer PannerNode (AudioBus::loadPlatformResource)
        "SHELL:--preload-file ${WEBCORE_DIR}/platform/audio/resources/Composite.wav@/usr/share/webkit/audio/Composite.wav"
        # WebAssembly-API fuer die Seiten, wird in JSC ausgewertet
        "SHELL:--preload-file ${BROWSER_LITE_ENGINE_DIR}/js/wasm-guest.js@/usr/share/browser-lite/wasm-guest.js"
    )
endif ()

# JS-Teile und Datenpaket: bei Aenderung neu linken
set_property(TARGET BrowserLiteEngine APPEND PROPERTY LINK_DEPENDS
    ${BROWSER_LITE_ENGINE_DIR}/js/engine-pre.js
    ${BROWSER_LITE_ENGINE_DIR}/js/wasm-rewrite.js
    ${BROWSER_LITE_ENGINE_DIR}/js/wasm-host.js
    ${BROWSER_LITE_ENGINE_DIR}/js/sockets.js
    ${BROWSER_LITE_ENGINE_DIR}/js/http-cache.js
    ${BROWSER_LITE_ENGINE_DIR}/js/wasm-guest.js
)
