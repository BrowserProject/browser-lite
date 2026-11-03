# The JIT to WebAssembly (docs/jit.md) and the checks of the machine stack, built into
# JavaScriptCore of the engine and of the jsc shell: included from
# Source/JavaScriptCore/CMakeLists.txt (patch 0067).
list(APPEND JavaScriptCore_SOURCES
    ${CMAKE_CURRENT_LIST_DIR}/MachineStack.cpp
    ${CMAKE_CURRENT_LIST_DIR}/WasmJIT.cpp
    ${CMAKE_CURRENT_LIST_DIR}/WasmModule.cpp
)
list(APPEND JavaScriptCore_PRIVATE_INCLUDE_DIRECTORIES ${CMAKE_CURRENT_LIST_DIR})
