# browser-lite engine (embedder) as part of the WebKit build with PORT=Wasm.
#
# Included from Source/WebCore/PlatformWasm.cmake via cmake_language(DEFER ...)
# when BROWSER_LITE_ENGINE_DIR is set. So this file runs AFTER the whole
# WebCore/CMakeLists.txt and sees the finished include lists.
# (Same pattern as WebCoreTestSupport at the bottom of WebCore/CMakeLists.txt.)

set(BL_ENGINE_SRC "${BROWSER_LITE_ENGINE_DIR}/src")
set(BL_LEGACY_STORAGE "${CMAKE_SOURCE_DIR}/Source/WebKitLegacy/Storage")

# localStorage + IndexedDB from WebKitLegacy (without the rest of WebKitLegacy)
set(BL_LEGACY_STORAGE_SOURCES
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

add_executable(BrowserLiteEngine
    ${BL_ENGINE_SRC}/BackForwardList.cpp
    ${BL_ENGINE_SRC}/Choosers.cpp
    ${BL_ENGINE_SRC}/Clients.cpp
    ${BL_ENGINE_SRC}/Compositor.cpp
    ${BL_ENGINE_SRC}/DeviceClients.cpp
    ${BL_ENGINE_SRC}/EditorClient.cpp
    ${BL_ENGINE_SRC}/EngineConfig.cpp
    ${BL_ENGINE_SRC}/EngineLoop.cpp
    ${BL_ENGINE_SRC}/Exports.cpp
    ${BL_ENGINE_SRC}/FileAccessCache.cpp
    ${BL_ENGINE_SRC}/FileSystemStorageWasm.cpp
    ${BL_ENGINE_SRC}/CacheStorageWasm.cpp
    ${BL_ENGINE_SRC}/GpuRaster.cpp
    ${BL_ENGINE_SRC}/LayerTreeHostWasm.cpp
    ${BL_ENGINE_SRC}/ScrollingWasm.cpp
    ${BL_ENGINE_SRC}/ServiceWorkerWasm.cpp
    ${BL_ENGINE_SRC}/WebPlatformExtras.cpp
    ${BL_ENGINE_SRC}/WebRTCPolyfill.cpp
    ${BL_ENGINE_SRC}/ErrorPage.cpp
    ${BL_ENGINE_SRC}/Gamepad.cpp
    ${BL_ENGINE_SRC}/Host.cpp
    ${BL_ENGINE_SRC}/LoaderStrategy.cpp
    ${BL_ENGINE_SRC}/Permissions.cpp
    ${BL_ENGINE_SRC}/PlatformResources.cpp
    ${BL_ENGINE_SRC}/Preconnect.cpp
    ${BL_ENGINE_SRC}/Prewarm.cpp
    ${BL_ENGINE_SRC}/Printing.cpp
    ${BL_ENGINE_SRC}/PlatformStrategies.cpp
    ${BL_ENGINE_SRC}/HttpAuth.cpp
    ${BL_ENGINE_SRC}/HttpCache.cpp
    ${BL_ENGINE_SRC}/LazyFiles.cpp
    ${BL_ENGINE_SRC}/FontPrefetch.cpp
    ${BL_ENGINE_SRC}/MemoryVFS.cpp
    ${BL_ENGINE_SRC}/MemoryWatch.cpp
    ${BL_ENGINE_SRC}/Sockets.cpp
    ${BL_ENGINE_SRC}/Speech.cpp
    ${BL_ENGINE_SRC}/Storage.cpp
    ${BL_ENGINE_SRC}/WebView.cpp
    ${BL_ENGINE_SRC}/main.cpp
    ${BL_ENGINE_SRC}/media/ContainerParser.cpp
    ${BL_ENGINE_SRC}/media/MediaFetch.cpp
    ${BL_ENGINE_SRC}/media/MediaSourceWasm.cpp
    ${BL_ENGINE_SRC}/media/MediaPlayerPrivateWasm.cpp
    ${BL_ENGINE_SRC}/media/VideoOverlay.cpp
    ${BL_ENGINE_SRC}/media/VideoFrameWasm.cpp
    ${BL_ENGINE_SRC}/media/WebCodecsWasm.cpp
    ${BL_ENGINE_SRC}/media/MediaStreamWasm.cpp
    ${BL_ENGINE_SRC}/media/MediaRecorderWasm.cpp
    ${BL_ENGINE_SRC}/wasm/WasmBridge.cpp
    ${BL_ENGINE_SRC}/websocket/WasmSocketProvider.cpp
    ${BL_ENGINE_SRC}/websocket/SocketStreamHandle.cpp
    ${BL_ENGINE_SRC}/websocket/SocketStreamHandleCurl.cpp
    ${BL_ENGINE_SRC}/websocket/WebSocketChannel.cpp

    ${BL_LEGACY_STORAGE_SOURCES}
)
set_target_properties(BrowserLiteEngine PROPERTIES OUTPUT_NAME engine)

# The WebKitLegacy files have no #include "config.h" (a prefix header does that
# there), so it comes through -include
set_source_files_properties(${BL_LEGACY_STORAGE_SOURCES}
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

# LazyFiles.cpp is a WasmFS backend: its base classes are in Emscripten's system/lib/wasmfs
set_source_files_properties(${BL_ENGINE_SRC}/LazyFiles.cpp
    PROPERTIES INCLUDE_DIRECTORIES "${EMSCRIPTEN_ROOT_PATH}/system/lib/wasmfs"
)

# ICU data: the items of icu-core.txt are linked (icudata.c, before libicudata.a in the link
# order, so the full data of the sysroot is not taken), the others become files under lazy/icu
# next to the engine that load on first use (tools/icu-data.mjs, LazyFiles.cpp)
if (BROWSER_LITE_ICU_DATA)
    set(BL_ICU_OUT "${CMAKE_CURRENT_BINARY_DIR}/browser-lite-icu")
    add_custom_command(
        OUTPUT ${BL_ICU_OUT}/icudata.c
        COMMAND node ${BROWSER_LITE_ENGINE_DIR}/../tools/icu-data.mjs ${BROWSER_LITE_ICU_DATA}
            ${BROWSER_LITE_ENGINE_DIR}/icu-core.txt ${BL_ICU_OUT} ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/lazy/icu
        DEPENDS ${BROWSER_LITE_ICU_DATA} ${BROWSER_LITE_ENGINE_DIR}/icu-core.txt
            ${BROWSER_LITE_ENGINE_DIR}/../tools/icu-data.mjs
        VERBATIM
    )
    target_sources(BrowserLiteEngine PRIVATE ${BL_ICU_OUT}/icudata.c)
    set_source_files_properties(${BL_ICU_OUT}/icudata.c PROPERTIES COMPILE_OPTIONS "-std=c23")
endif ()

# Fonts that load on demand (deps/recipes/lazyfonts.sh, LazyFiles.cpp): copied to lazy/fonts
# whenever their index in the data package changes
if (BROWSER_LITE_LAZY_FONTS)
    set(BL_LAZY_FONTS_STAMP "${CMAKE_CURRENT_BINARY_DIR}/browser-lite-lazy-fonts.stamp")
    add_custom_command(
        OUTPUT ${BL_LAZY_FONTS_STAMP}
        COMMAND ${CMAKE_COMMAND} -E rm -rf ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/lazy/fonts
        COMMAND ${CMAKE_COMMAND} -E copy_directory ${BROWSER_LITE_LAZY_FONTS} ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/lazy/fonts
        COMMAND ${CMAKE_COMMAND} -E touch ${BL_LAZY_FONTS_STAMP}
        DEPENDS ${BROWSER_LITE_RUNTIME_DIR}/usr/share/browser-lite/lazy-fonts.txt
        VERBATIM
    )
    target_sources(BrowserLiteEngine PRIVATE ${BL_LAZY_FONTS_STAMP})
endif ()

# WebCore is static, its private dependencies (JSC, WTF, PAL, curl, ICU, ...)
# come along as LINK_ONLY. Skia directly for the include paths.
target_link_libraries(BrowserLiteEngine PRIVATE WebCore Skia::Skia)

# Private dependencies of the static libs CMake does not know (they are only
# listed as Requires.private in the .pc files).
find_library(BL_WOFF2COMMON_LIBRARY woff2common REQUIRED)
find_library(BL_EXPAT_LIBRARY expat REQUIRED)
# libwebp (encoder for toDataURL/toBlob) needs libsharpyuv
find_library(BL_SHARPYUV_LIBRARY sharpyuv REQUIRED)
target_link_libraries(BrowserLiteEngine PRIVATE ${BL_WOFF2COMMON_LIBRARY} ${BL_EXPAT_LIBRARY} ${BL_SHARPYUV_LIBRARY})

target_link_options(BrowserLiteEngine PRIVATE
    # main() runs in its own worker (pthread). The main thread of the page
    # stays free for the UI.
    "SHELL:-pthread"
    "SHELL:-sPROXY_TO_PTHREAD"
    "SHELL:-sPTHREAD_POOL_SIZE=8"
    "SHELL:-sSTACK_SIZE=8MB"
    "SHELL:-sDEFAULT_PTHREAD_STACK_SIZE=4MB"
    "SHELL:-sINITIAL_MEMORY=256MB"
    "SHELL:-sALLOW_MEMORY_GROWTH=1"
    "SHELL:-sMAXIMUM_MEMORY=4GB"
    # The engine runs "forever", main() returns with a live runtime
    "SHELL:-sEXIT_RUNTIME=0"
    "SHELL:-sENVIRONMENT=web,worker,node"
    "SHELL:-sMODULARIZE=1"
    "SHELL:-sEXPORT_NAME=createBrowserLiteEngine"
    "SHELL:-sEXPORTED_RUNTIME_METHODS=FS,ENV,HEAPU8,HEAPF32,addRunDependency,removeRunDependency,ccall,cwrap,stringToUTF8,stringToNewUTF8,lengthBytesUTF8,UTF8ToString"
    "SHELL:-sEXPORTED_FUNCTIONS=_main,_malloc,_free"
    "SHELL:-lEGL"
    # WebGL of the pages (platform/wasm/angle): WebGL 1 and 2. Without FULL_ES3,
    # WebGL does not need the emulation of client arrays and it costs on every draw.
    "SHELL:-sMAX_WEBGL_VERSION=2"
    "SHELL:-lGL"
    "SHELL:-Wl,--error-limit=0"
    # WebKit builds with -fno-exceptions, but some deps (C++) can throw. Allow
    # throwing (without catching a throw leads to abort).
    "SHELL:-sDISABLE_EXCEPTION_THROWING=0"
    # Keep function names (profiles, stack traces; tools/package-engine.sh
    # removes them for delivery)
    "SHELL:--profiling-funcs"
    # Sockets in WASM instead of SOCKFS (engine/src/Sockets.cpp): intercept the
    # functions at link time
    "SHELL:-Wl,--wrap=socket,--wrap=connect,--wrap=bind,--wrap=send,--wrap=recv,--wrap=read,--wrap=write,--wrap=close"
    "SHELL:-Wl,--wrap=poll,--wrap=select,--wrap=fcntl,--wrap=getsockopt,--wrap=setsockopt,--wrap=getpeername,--wrap=getsockname"
    "SHELL:-Wl,--wrap=pipe2,--wrap=getaddrinfo,--wrap=freeaddrinfo"
    # access() on fixed files remembered (engine/src/FileAccessCache.cpp)
    "SHELL:-Wl,--wrap=access"
    # Growth of the memory under one lock (engine/src/MemoryWatch.cpp)
    "SHELL:-Wl,--wrap=sbrk"
)

# JS parts of the engine (--pre-js) in this order. If one changes, the engine
# is linked again.
set(BL_PRE_JS
    engine-pre.js
    # Deferred engine code of a split engine.wasm (tools/split-engine.mjs)
    deferred.js
    # Web workers for new threads (engine/src/main.cpp)
    workers.js
    # WebAssembly of the pages (engine/src/wasm/WasmBridge.cpp)
    wasm-rewrite.js
    wasm-host.js
    # Connections through the host's transport (engine/src/Sockets.cpp)
    sockets.js
    # HTTP cache in the host's Cache API (engine/src/HttpCache.cpp)
    http-cache.js
    # WebCodecs of the pages through the WebCodecs of the host (engine/src/media/WebCodecsWasm.cpp)
    webcodecs-host.js
    # MediaRecorder: encoders of the host + WebM (engine/src/media/MediaRecorderWasm.cpp)
    mediarecorder-host.js
)
foreach (pre_js IN LISTS BL_PRE_JS)
    target_link_options(BrowserLiteEngine PRIVATE "SHELL:--pre-js ${BROWSER_LITE_ENGINE_DIR}/js/${pre_js}")
    set_property(TARGET BrowserLiteEngine APPEND PROPERTY LINK_DEPENDS ${BROWSER_LITE_ENGINE_DIR}/js/${pre_js})
endforeach ()

# File system: WasmFS (in WASM, file syscalls without a detour through the UI thread)
target_link_options(BrowserLiteEngine PRIVATE "SHELL:-sWASMFS")
# OPFS root of /data (storage namespace) and more precise errors when writing to the host's OPFS (engine/js/wasmfs-opfs.js)
target_link_options(BrowserLiteEngine PRIVATE "SHELL:--js-library ${BROWSER_LITE_ENGINE_DIR}/js/wasmfs-opfs.js")
set_property(TARGET BrowserLiteEngine APPEND PROPERTY LINK_DEPENDS ${BROWSER_LITE_ENGINE_DIR}/js/wasmfs-opfs.js)

# GC roots in WASM locals: the engine only runs the GC on an empty stack
# (engine/src/EngineLoop.cpp, patch 0012), so the pass is not needed. It makes
# everything about 10x slower, but stays for comparison (needs
# --profiling-funcs, see above).
option(BROWSER_LITE_SPILL_POINTERS "Binaryen --spill-pointers for the conservative GC" OFF)
if (BROWSER_LITE_SPILL_POINTERS)
    target_link_options(BrowserLiteEngine PRIVATE "SHELL:-sBINARYEN_EXTRA_PASSES=--spill-pointers")
endif ()

# Runtime files (fontconfig configuration, fonts, CA certificates) as a data package.
if (BROWSER_LITE_RUNTIME_DIR)
    target_link_options(BrowserLiteEngine PRIVATE
        "SHELL:--preload-file ${BROWSER_LITE_RUNTIME_DIR}@/"
        # HRTF data for PannerNode (AudioBus::loadPlatformResource)
        "SHELL:--preload-file ${WEBCORE_DIR}/platform/audio/resources/Composite.wav@/usr/share/webkit/audio/Composite.wav"
        # Broken image icon and resize corner of text areas (engine/src/PlatformResources.cpp),
        # "@@" is an "@" of the file name
        "SHELL:--preload-file ${WEBCORE_DIR}/Resources/missingImage.png@/usr/share/webkit/images/missingImage.png"
        "SHELL:--preload-file ${WEBCORE_DIR}/Resources/missingImage@@2x.png@/usr/share/webkit/images/missingImage@@2x.png"
        "SHELL:--preload-file ${WEBCORE_DIR}/Resources/missingImage@@3x.png@/usr/share/webkit/images/missingImage@@3x.png"
        "SHELL:--preload-file ${WEBCORE_DIR}/Resources/textAreaResizeCorner.png@/usr/share/webkit/images/textAreaResizeCorner.png"
        "SHELL:--preload-file ${WEBCORE_DIR}/Resources/textAreaResizeCorner@@2x.png@/usr/share/webkit/images/textAreaResizeCorner@@2x.png"
        # WebAssembly API for the pages, evaluated in JSC
        "SHELL:--preload-file ${BROWSER_LITE_ENGINE_DIR}/js/wasm-guest.js@/usr/share/browser-lite/wasm-guest.js"
        # Files of lazy/ fetched in the background at the start (main.cpp)
        "SHELL:--preload-file ${BROWSER_LITE_ENGINE_DIR}/lazy-prefetch.txt@/usr/share/browser-lite/lazy-prefetch.txt"
    )
endif ()

# engine.wasm becomes the code the start and common pages run, chunks engine.deferred-<n>.wasm
# the rest, loaded after the start; the linked module stays as engine.full.wasm
# (tools/split-engine.mjs)
option(BROWSER_LITE_SPLIT_ENGINE "Split engine.wasm into engine.wasm and engine.deferred-<n>.wasm" ON)
if (BROWSER_LITE_SPLIT_ENGINE)
    add_custom_command(TARGET BrowserLiteEngine POST_BUILD
        COMMAND node ${BROWSER_LITE_ENGINE_DIR}/../tools/split-engine.mjs
            $<TARGET_FILE_DIR:BrowserLiteEngine>/engine.wasm ${BROWSER_LITE_ENGINE_DIR}/hot-functions.txt
        VERBATIM
    )
    set_property(TARGET BrowserLiteEngine APPEND PROPERTY LINK_DEPENDS
        ${BROWSER_LITE_ENGINE_DIR}/hot-functions.txt
        ${BROWSER_LITE_ENGINE_DIR}/../tools/split-engine.mjs
        ${BROWSER_LITE_ENGINE_DIR}/../tools/hot-functions-file.mjs
        ${BROWSER_LITE_ENGINE_DIR}/../tools/wasm-binary.mjs
    )
endif ()

# Data package: link again when the WebAssembly API changes
set_property(TARGET BrowserLiteEngine APPEND PROPERTY LINK_DEPENDS
    ${BROWSER_LITE_ENGINE_DIR}/js/wasm-guest.js
    ${BROWSER_LITE_ENGINE_DIR}/lazy-prefetch.txt
)

# Native tests of the WTF fixes in engine/patches (tests/engine/wtf-tests.cpp), run in
# node by tests/engine/wtf-test.mjs: bin/wtf-tests.js and wtf-tests.wasm
add_executable(BrowserLiteWTFTests ${BROWSER_LITE_ENGINE_DIR}/../tests/engine/wtf-tests.cpp)
set_target_properties(BrowserLiteWTFTests PROPERTIES OUTPUT_NAME wtf-tests)
target_include_directories(BrowserLiteWTFTests PRIVATE
    ${WebCore_INCLUDE_DIRECTORIES}
    ${WebCore_PRIVATE_INCLUDE_DIRECTORIES}
)
target_include_directories(BrowserLiteWTFTests SYSTEM PRIVATE
    ${WebCore_SYSTEM_INCLUDE_DIRECTORIES}
)
target_link_libraries(BrowserLiteWTFTests PRIVATE WebKit::WTF)
target_link_options(BrowserLiteWTFTests PRIVATE
    "SHELL:-pthread"
    "SHELL:-sPTHREAD_POOL_SIZE=2"
    "SHELL:-sALLOW_MEMORY_GROWTH=1"
    "SHELL:-sENVIRONMENT=node"
    "SHELL:--profiling-funcs"
)
# Built with the engine (tools/build-webcore.sh builds BrowserLiteEngine)
add_dependencies(BrowserLiteEngine BrowserLiteWTFTests)
