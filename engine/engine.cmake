# browser-lite Engine (Embedder) als Teil des WebKit-Builds mit PORT=Wasm.
#
# Wird aus Source/WebCore/PlatformWasm.cmake per cmake_language(DEFER ...)
# eingebunden, wenn BROWSER_LITE_ENGINE_DIR gesetzt ist. So laeuft diese Datei
# NACH dem ganzen WebCore/CMakeLists.txt und sieht die fertigen Include-Listen.
# (Gleiches Muster wie WebCoreTestSupport unten in WebCore/CMakeLists.txt.)

set(BL_ENGINE_SRC "${BROWSER_LITE_ENGINE_DIR}/src")

add_executable(BrowserLiteEngine
    ${BL_ENGINE_SRC}/BackForwardList.cpp
    ${BL_ENGINE_SRC}/Clients.cpp
    ${BL_ENGINE_SRC}/EditorClient.cpp
    ${BL_ENGINE_SRC}/EngineLoop.cpp
    ${BL_ENGINE_SRC}/Exports.cpp
    ${BL_ENGINE_SRC}/Host.cpp
    ${BL_ENGINE_SRC}/LoaderStrategy.cpp
    ${BL_ENGINE_SRC}/PlatformStrategies.cpp
    ${BL_ENGINE_SRC}/WebView.cpp
    ${BL_ENGINE_SRC}/main.cpp
)
set_target_properties(BrowserLiteEngine PROPERTIES OUTPUT_NAME engine)

target_include_directories(BrowserLiteEngine PRIVATE
    ${BL_ENGINE_SRC}
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
target_link_libraries(BrowserLiteEngine PRIVATE ${BL_WOFF2COMMON_LIBRARY} ${BL_EXPAT_LIBRARY})

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
    "SHELL:-sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,ccall,cwrap,stringToUTF8,stringToNewUTF8,lengthBytesUTF8,UTF8ToString"
    "SHELL:-sEXPORTED_FUNCTIONS=_main,_malloc,_free"
    "SHELL:-lEGL"
    "SHELL:-lGL"
    "SHELL:-Wl,--error-limit=0"
    # WebKit baut mit -fno-exceptions, einige Deps (C++) koennen aber werfen.
    # Werfen erlauben (ohne Fangen fuehrt ein throw zu abort).
    "SHELL:-sDISABLE_EXCEPTION_THROWING=0"
    # GC-Wurzeln in WASM-Locals sichtbar machen (siehe docs/architektur.md).
    # --profiling-funcs, damit der Pass den Stack-Pointer nach der Optimierung findet.
    "SHELL:-sBINARYEN_EXTRA_PASSES=--spill-pointers"
    "SHELL:--profiling-funcs"
    "SHELL:--pre-js ${BROWSER_LITE_ENGINE_DIR}/js/engine-pre.js"
)

# Laufzeit-Dateien (fontconfig-Konfig, Fonts, CA-Zertifikate) als Datenpaket.
if (BROWSER_LITE_RUNTIME_DIR)
    target_link_options(BrowserLiteEngine PRIVATE
        "SHELL:--preload-file ${BROWSER_LITE_RUNTIME_DIR}@/"
    )
endif ()
