// WebAssembly der Seiten, siehe WasmBridge.h
//
// Werte gehen als "Slots" zu 16 Bytes zur Host-Seite (Format in
// engine/js/wasm-host.js). Auf der Seite von JSC sind es Paare [tag, wert].
#include "config.h"
#include "WasmBridge.h"

#include <JavaScriptCore/ArrayBuffer.h>
#include <JavaScriptCore/CallData.h>
#include <JavaScriptCore/Completion.h>
#include <JavaScriptCore/GetterSetter.h>
#include <JavaScriptCore/JSArray.h>
#include <JavaScriptCore/JSArrayBuffer.h>
#include <JavaScriptCore/JSArrayBufferView.h>
#include <JavaScriptCore/JSBigInt.h>
#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/JSLock.h>
#include <JavaScriptCore/ObjectConstructor.h>
#include <JavaScriptCore/SourceCode.h>
#include <JavaScriptCore/StrongInlines.h>
#include <JavaScriptCore/TopExceptionScope.h>
#include <WebCore/WorkerOrWorkletGlobalScope.h>
#include <WebCore/WorkerOrWorkletScriptController.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <emscripten/emscripten.h>
#include <memory>
#include <mutex>
#include <wtf/HashMap.h>
#include <wtf/text/WTFString.h>

using namespace JSC;

namespace BrowserLite {

namespace {

constexpr size_t pageSize = 65536;
constexpr int slotCapacity = 1024;

struct Slot {
    uint32_t tag;
    uint32_t a;
    union {
        double number;
        struct {
            uint32_t lo;
            uint32_t hi;
        } word;
    };
};
static_assert(sizeof(Slot) == 16);

enum Tag : uint32_t {
    Undefined = 0,
    Null = 1,
    Number = 2,
    BigInt = 3,
    Boolean = 4,
    Guest = 5,
    HostObject = 6,
    GuestOnce = 7,
    HostFunction = 8,
    Bytes = 9,
    Text = 10,
};

struct MemoryRecord {
    VM* vm { nullptr };
    uint8_t* base { nullptr };
    uint32_t pages { 0 };
    uint32_t maxPages { 0 };
    uint32_t capacityPages { 0 };
    int references { 1 };
    RefPtr<ArrayBuffer> buffer;
    Strong<JSArrayBuffer> wrapper;
};

struct BridgeState {
    HashMap<uint32_t, Strong<Unknown>> guests;
    uint32_t nextGuest { 1 };
    HashMap<int, std::unique_ptr<MemoryRecord>> memories;
    int nextMemory { 1 };
    Slot args[slotCapacity];
    Slot out[slotCapacity];
};

thread_local BridgeState* bridgeState;

BridgeState& state()
{
    if (!bridgeState)
        bridgeState = new BridgeState;
    return *bridgeState;
}

uint32_t registerGuest(VM& vm, JSValue value)
{
    auto& s = state();
    uint32_t id = s.nextGuest++;
    s.guests.add(id, Strong<Unknown>(vm, value));
    return id;
}

JSValue guestValue(uint32_t id, bool release)
{
    auto& s = state();
    auto it = s.guests.find(id);
    if (it == s.guests.end())
        return jsUndefined();
    JSValue value = it->value.get();
    if (release)
        s.guests.remove(it);
    return value;
}

// Paare [tag, wert, ...] aus JSC in Slots. Texte werden mit malloc kopiert,
// "texts" sammelt sie zum Freigeben nach dem Aufruf.
int writePairs(JSGlobalObject* globalObject, JSValue pairsValue, Slot* slots, Vector<char*>& texts)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto* pairs = dynamicDowncast<JSArray>(pairsValue);
    if (!pairs) {
        throwTypeError(globalObject, scope, "browser-lite: Paare erwartet"_s);
        return -1;
    }
    unsigned length = pairs->length();
    int count = length / 2;
    if (count > slotCapacity) {
        throwRangeError(globalObject, scope, "browser-lite: zu viele Werte"_s);
        return -1;
    }
    for (int i = 0; i < count; i++) {
        uint32_t tag = pairs->getIndex(globalObject, 2 * i).toUInt32(globalObject);
        RETURN_IF_EXCEPTION(scope, -1);
        JSValue value = pairs->getIndex(globalObject, 2 * i + 1);
        RETURN_IF_EXCEPTION(scope, -1);
        Slot& slot = slots[i];
        slot = { };
        slot.tag = tag;
        switch (tag) {
        case Undefined:
        case Null:
            break;
        case Number:
            slot.number = value.toNumber(globalObject);
            break;
        case BigInt: {
            uint64_t bits = static_cast<uint64_t>(value.toBigInt64(globalObject));
            slot.word.lo = static_cast<uint32_t>(bits);
            slot.word.hi = static_cast<uint32_t>(bits >> 32);
            break;
        }
        case Boolean:
            slot.word.lo = value.toBoolean(globalObject) ? 1 : 0;
            break;
        case Guest:
            slot.word.lo = registerGuest(vm, value);
            break;
        case HostObject:
        case HostFunction:
            slot.word.lo = value.toUInt32(globalObject);
            break;
        case Bytes: {
            auto* view = dynamicDowncast<JSArrayBufferView>(value);
            if (!view) {
                throwTypeError(globalObject, scope, "browser-lite: Bytes erwartet"_s);
                return -1;
            }
            slot.word.lo = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(view->vector()));
            slot.a = static_cast<uint32_t>(view->byteLength());
            break;
        }
        case Text: {
            auto utf8 = value.toWTFString(globalObject).utf8();
            RETURN_IF_EXCEPTION(scope, -1);
            char* copy = static_cast<char*>(malloc(utf8.length() + 1));
            memcpy(copy, utf8.data(), utf8.length());
            copy[utf8.length()] = 0;
            texts.append(copy);
            slot.word.lo = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(copy));
            slot.a = static_cast<uint32_t>(utf8.length());
            break;
        }
        default:
            throwTypeError(globalObject, scope, "browser-lite: unbekannter Wert"_s);
            return -1;
        }
        RETURN_IF_EXCEPTION(scope, -1);
    }
    return count;
}

// Slots in Paare fuer JSC. Texte von der Host-Seite werden freigegeben.
JSArray* readPairs(JSGlobalObject* globalObject, const Slot* slots, int count)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    JSArray* pairs = constructEmptyArray(globalObject, nullptr, 2 * count);
    RETURN_IF_EXCEPTION(scope, nullptr);
    for (int i = 0; i < count; i++) {
        const Slot& slot = slots[i];
        uint32_t tag = slot.tag;
        JSValue value = jsUndefined();
        switch (tag) {
        case Undefined:
            break;
        case Null:
            value = jsNull();
            break;
        case Number:
            value = jsNumber(slot.number);
            break;
        case BigInt: {
            int64_t bits = static_cast<int64_t>((static_cast<uint64_t>(slot.word.hi) << 32) | slot.word.lo);
            value = JSBigInt::makeHeapBigIntOrBigInt32(globalObject, bits);
            RETURN_IF_EXCEPTION(scope, nullptr);
            break;
        }
        case Boolean:
            value = jsBoolean(slot.word.lo);
            break;
        case Guest:
        case GuestOnce:
            value = guestValue(slot.word.lo, tag == GuestOnce);
            tag = Guest;
            break;
        case HostObject:
        case HostFunction:
            value = jsNumber(slot.word.lo);
            break;
        case Text: {
            auto* text = reinterpret_cast<const char8_t*>(static_cast<uintptr_t>(slot.word.lo));
            value = jsString(vm, String::fromUTF8(std::span { text, slot.a }));
            free(const_cast<char8_t*>(text));
            break;
        }
        default:
            break;
        }
        pairs->putDirectIndex(globalObject, 2 * i, jsNumber(tag));
        RETURN_IF_EXCEPTION(scope, nullptr);
        pairs->putDirectIndex(globalObject, 2 * i + 1, value);
        RETURN_IF_EXCEPTION(scope, nullptr);
    }
    return pairs;
}

// ------------------------------------------------------------ Speicher

MemoryRecord* memoryRecord(int id)
{
    auto& memories = state().memories;
    auto it = memories.find(id);
    return it == memories.end() ? nullptr : it->value.get();
}

uint8_t* allocatePages(uint32_t pages)
{
    size_t bytes = std::max<size_t>(pages, 1) * pageSize;
    auto* base = static_cast<uint8_t*>(aligned_alloc(pageSize, bytes));
    if (base)
        memset(base, 0, bytes);
    return base;
}

void updateHost(int id, uint8_t* base, int pages)
{
    EM_ASM({ blWasmHost.memoryUpdate($0, $1, $2); }, id, reinterpret_cast<uintptr_t>(base), pages);
}

// Alter ArrayBuffer ist nach grow nicht mehr gueltig (wie im Standard)
void detachBuffer(MemoryRecord& memory)
{
    if (memory.buffer)
        memory.buffer->detach(*memory.vm);
    memory.buffer = nullptr;
    memory.wrapper.clear();
}

int growMemory(int id, uint32_t delta)
{
    auto* memory = memoryRecord(id);
    if (!memory)
        return -1;
    uint64_t pages = static_cast<uint64_t>(memory->pages) + delta;
    if (pages > memory->maxPages)
        return -1;
    uint32_t old = memory->pages;
    if (pages > memory->capacityPages) {
        // Umziehen, mit Reserve, damit nicht jedes grow kopiert
        uint32_t capacity = static_cast<uint32_t>(std::min<uint64_t>(memory->maxPages, std::max<uint64_t>(pages, static_cast<uint64_t>(old) * 2)));
        auto* base = allocatePages(capacity);
        if (!base && capacity > pages) {
            capacity = static_cast<uint32_t>(pages);
            base = allocatePages(capacity);
        }
        if (!base)
            return -1;
        memcpy(base, memory->base, static_cast<size_t>(old) * pageSize);
        free(memory->base);
        memory->base = base;
        memory->capacityPages = capacity;
    }
    memory->pages = static_cast<uint32_t>(pages);
    detachBuffer(*memory);
    updateHost(id, memory->base, memory->pages);
    return old;
}

void releaseMemory(int id)
{
    auto* memory = memoryRecord(id);
    if (!memory || --memory->references > 0)
        return;
    detachBuffer(*memory);
    // Ab jetzt faengt jeder Zugriff (Groesse 0), falls noch ein Modul lebt
    updateHost(id, nullptr, -1);
    free(memory->base);
    state().memories.remove(id);
}

// ------------------------------------------------------------ Funktionen fuer die API

JSC_DEFINE_HOST_FUNCTION(bridgeHost, (JSGlobalObject* globalObject, CallFrame* callFrame))
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    int op = callFrame->argument(0).toInt32(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    auto& s = state();
    Vector<char*> texts;
    int count = writePairs(globalObject, callFrame->argument(1), s.args, texts);
    if (count < 0 || scope.exception()) {
        for (auto* text : texts)
            free(text);
        return { };
    }
    int results = EM_ASM_INT({ return blWasmHost.dispatch($0, $1, $2, $3, $4); }, op, s.args, count, s.out, slotCapacity);
    for (auto* text : texts)
        free(text);
    RELEASE_AND_RETURN(scope, JSValue::encode(readPairs(globalObject, s.out, results)));
}

JSC_DEFINE_HOST_FUNCTION(bridgeMemoryCreate, (JSGlobalObject* globalObject, CallFrame* callFrame))
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    uint32_t initial = callFrame->argument(0).toUInt32(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    int32_t maximum = callFrame->argument(1).toInt32(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    auto memory = std::make_unique<MemoryRecord>();
    memory->vm = &vm;
    memory->pages = initial;
    memory->maxPages = maximum < 0 ? 65536 : static_cast<uint32_t>(maximum);
    memory->capacityPages = std::max<uint32_t>(initial, 1);
    memory->base = allocatePages(memory->capacityPages);
    if (!memory->base)
        return throwVMRangeError(globalObject, scope, "WebAssembly.Memory(): could not allocate memory"_s);
    auto& s = state();
    int id = s.nextMemory++;
    uint8_t* base = memory->base;
    s.memories.add(id, WTF::move(memory));
    EM_ASM({ blWasmHost.memoryCreate($0, $1, $2); }, id, reinterpret_cast<uintptr_t>(base), initial);
    return JSValue::encode(jsNumber(id));
}

JSC_DEFINE_HOST_FUNCTION(bridgeMemoryBuffer, (JSGlobalObject* globalObject, CallFrame* callFrame))
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto* memory = memoryRecord(callFrame->argument(0).toInt32(globalObject));
    RETURN_IF_EXCEPTION(scope, { });
    if (!memory)
        return throwVMTypeError(globalObject, scope, "WebAssembly.Memory: freigegeben"_s);
    if (!memory->wrapper) {
        // Direkt auf den Speicher, gehoert weiter dem Speicher-Objekt
        memory->buffer = ArrayBuffer::createFromBytes(std::span<const uint8_t> { memory->base, static_cast<size_t>(memory->pages) * pageSize }, nullptr);
        auto* wrapper = JSArrayBuffer::create(vm, globalObject->arrayBufferStructure(ArrayBufferSharingMode::Default), RefPtr { memory->buffer });
        memory->wrapper = Strong<JSArrayBuffer>(vm, wrapper);
    }
    return JSValue::encode(memory->wrapper.get());
}

JSC_DEFINE_HOST_FUNCTION(bridgeMemoryGrow, (JSGlobalObject* globalObject, CallFrame* callFrame))
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    int id = callFrame->argument(0).toInt32(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    uint32_t delta = callFrame->argument(1).toUInt32(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    return JSValue::encode(jsNumber(growMemory(id, delta)));
}

JSC_DEFINE_HOST_FUNCTION(bridgeMemoryRetain, (JSGlobalObject* globalObject, CallFrame* callFrame))
{
    if (auto* memory = memoryRecord(callFrame->argument(0).toInt32(globalObject)))
        memory->references++;
    return JSValue::encode(jsUndefined());
}

JSC_DEFINE_HOST_FUNCTION(bridgeMemoryRelease, (JSGlobalObject* globalObject, CallFrame* callFrame))
{
    releaseMemory(callFrame->argument(0).toInt32(globalObject));
    return JSValue::encode(jsUndefined());
}

// ------------------------------------------------------------ "WebAssembly" anlegen

// Quelltext der API: die Bytes einmal lesen, den String pro Thread anlegen
// (WTF::String darf nicht zwischen Threads geteilt werden)
const String& guestSource()
{
    static std::once_flag once;
    static Vector<char8_t>* bytes;
    std::call_once(once, [] {
        bytes = new Vector<char8_t>;
        FILE* file = fopen("/usr/share/browser-lite/wasm-guest.js", "rb");
        if (!file)
            return;
        char8_t buffer[16384];
        size_t read;
        while ((read = fread(buffer, 1, sizeof(buffer), file)) > 0)
            bytes->append(std::span { buffer, read });
        fclose(file);
    });
    thread_local String source;
    if (source.isNull() && !bytes->isEmpty())
        source = String::fromUTF8(bytes->span());
    return source;
}

JSObject* createBridge(JSGlobalObject* globalObject)
{
    VM& vm = globalObject->vm();
    JSObject* bridge = constructEmptyObject(globalObject);
    auto add = [&](ASCIILiteral name, unsigned length, NativeFunction function) {
        bridge->putDirectNativeFunction(vm, globalObject, Identifier::fromString(vm, name), length, function, ImplementationVisibility::Private, NoIntrinsic, 0);
    };
    add("host"_s, 2, bridgeHost);
    add("memoryCreate"_s, 2, bridgeMemoryCreate);
    add("memoryBuffer"_s, 1, bridgeMemoryBuffer);
    add("memoryGrow"_s, 2, bridgeMemoryGrow);
    add("memoryRetain"_s, 1, bridgeMemoryRetain);
    add("memoryRelease"_s, 1, bridgeMemoryRelease);
    return bridge;
}

void replaceWithValue(JSGlobalObject* globalObject, JSValue value)
{
    VM& vm = globalObject->vm();
    auto name = Identifier::fromString(vm, "WebAssembly"_s);
    globalObject->JSObject::deleteProperty(globalObject, name);
    globalObject->putDirect(vm, name, value, static_cast<unsigned>(PropertyAttribute::DontEnum));
}

JSC_DEFINE_HOST_FUNCTION(webAssemblyGetter, (JSGlobalObject* callerGlobalObject, CallFrame* callFrame))
{
    auto* globalObject = callFrame->jsCallee()->realm();
    VM& vm = callerGlobalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    const String& source = guestSource();
    if (source.isNull())
        return JSValue::encode(jsUndefined());
    NakedPtr<JSC::Exception> exception;
    JSValue factory = JSC::evaluate(globalObject, makeSource(source, SourceOrigin(), SourceTaintedOrigin::Untainted, "browser-lite-wasm.js"_s), JSValue(), exception);
    if (exception) {
        throwException(globalObject, scope, exception.get());
        return { };
    }
    auto callData = JSC::getCallData(factory);
    MarkedArgumentBuffer args;
    args.append(createBridge(globalObject));
    JSValue webAssembly = JSC::call(globalObject, factory, callData, jsUndefined(), args);
    RETURN_IF_EXCEPTION(scope, { });
    replaceWithValue(globalObject, webAssembly);
    return JSValue::encode(webAssembly);
}

JSC_DEFINE_HOST_FUNCTION(webAssemblySetter, (JSGlobalObject*, CallFrame* callFrame))
{
    replaceWithValue(callFrame->jsCallee()->realm(), callFrame->argument(0));
    return JSValue::encode(jsUndefined());
}

} // namespace

void initializeWebAssembly()
{
    WebCore::WorkerOrWorkletScriptController::workerGlobalObjectCreatedHook = [](JSGlobalObject& globalObject) {
        installWebAssembly(globalObject);
    };
}

void installWebAssembly(JSGlobalObject& globalObject)
{
    VM& vm = globalObject.vm();
    JSLockHolder lock(vm);
    auto* getter = JSFunction::create(vm, &globalObject, 0, "get WebAssembly"_s, webAssemblyGetter, ImplementationVisibility::Public);
    auto* setter = JSFunction::create(vm, &globalObject, 1, "set WebAssembly"_s, webAssemblySetter, ImplementationVisibility::Public);
    globalObject.putDirectAccessor(&globalObject, Identifier::fromString(vm, "WebAssembly"_s), GetterSetter::create(vm, &globalObject, getter, setter),
        PropertyAttribute::DontEnum | PropertyAttribute::Accessor);
}

} // namespace BrowserLite

// ------------------------------------------------------------ Aufrufe von der Host-Seite

using namespace BrowserLite;

// WebAssembly ruft eine Funktion aus JS auf (Import). Die Funktion ist ein
// Thunk aus wasm-guest.js, der Paare bekommt und Paare zurueckgibt.
extern "C" EMSCRIPTEN_KEEPALIVE int bl_wasm_call_guest(uint32_t id, const Slot* args, int count, Slot* out, int capacity)
{
    JSValue function = guestValue(id, false);
    auto* object = function.getObject();
    if (!object || capacity < 2)
        return 0;
    JSGlobalObject* globalObject = object->realm();
    VM& vm = globalObject->vm();
    JSLockHolder lock(vm);
    auto scope = DECLARE_TOP_EXCEPTION_SCOPE(vm);
    JSArray* pairs = readPairs(globalObject, args, count);
    JSValue result;
    if (pairs && !scope.exception()) {
        MarkedArgumentBuffer arguments;
        arguments.append(pairs);
        auto callData = JSC::getCallData(function);
        result = JSC::call(globalObject, function, callData, jsUndefined(), arguments);
    }
    Vector<char*> texts;
    int written = -1;
    if (!scope.exception())
        written = writePairs(globalObject, result, out, texts);
    if (JSC::Exception* exception = scope.exception()) {
        scope.clearException();
        // Ausnahme weiterreichen: Status 1 und der Wert
        out[0] = { };
        out[0].tag = Number;
        out[0].number = 1;
        out[1] = { };
        out[1].tag = Guest;
        out[1].word.lo = registerGuest(vm, exception->value());
        written = 2;
    }
    for (auto* text : texts)
        free(text);
    return written;
}

extern "C" EMSCRIPTEN_KEEPALIVE void bl_wasm_release_guest(uint32_t id)
{
    guestValue(id, true);
}

extern "C" EMSCRIPTEN_KEEPALIVE int bl_wasm_memory_grow(int id, int delta)
{
    if (delta < 0)
        return -1;
    return growMemory(id, static_cast<uint32_t>(delta));
}
