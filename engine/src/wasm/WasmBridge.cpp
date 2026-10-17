// WebAssembly der Seiten, siehe WasmBridge.h
//
// Werte gehen als "Slots" zu 16 Bytes zur Host-Seite (Format in
// engine/js/wasm-host.js). Auf der Seite von JSC sind es Paare [tag, wert].
//
// Alles gehoert einer Realm (einem globalen Objekt in JSC). Werte aus JSC, die
// die Host-Seite haelt, haengen am globalen Objekt und sind keine GC-Wurzeln.
// Stirbt es (Navigation, Ende eines Workers), gibt die Bruecke den Speicher der
// Realm frei und die Host-Seite ihre Objekte. Zyklen ueber beide Seiten (Import
// ruft Exporte der eigenen Instanz, wie im Glue von Emscripten) leben so
// hoechstens so lange wie die Seite bzw. der Worker.
#include "config.h"
#include "WasmBridge.h"

#include <JavaScriptCore/ArrayBuffer.h>
#include <JavaScriptCore/CallData.h>
#include <JavaScriptCore/Completion.h>
#include <JavaScriptCore/ExceptionHelpers.h>
#include <JavaScriptCore/GetterSetter.h>
#include <JavaScriptCore/JSArray.h>
#include <JavaScriptCore/JSArrayBuffer.h>
#include <JavaScriptCore/JSArrayBufferView.h>
#include <JavaScriptCore/JSBigInt.h>
#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/JSLock.h>
#include <JavaScriptCore/JSMapInlines.h>
#include <JavaScriptCore/JSNativeStdFunction.h>
#include <JavaScriptCore/ObjectConstructor.h>
#include <JavaScriptCore/PrivateName.h>
#include <JavaScriptCore/SourceCode.h>
#include <JavaScriptCore/TopExceptionScope.h>
#include <JavaScriptCore/TypedArrayController.h>
#include <JavaScriptCore/WeakHandleOwner.h>
#include <JavaScriptCore/WeakInlines.h>
#include <WebCore/WorkerOrWorkletGlobalScope.h>
#include <WebCore/WorkerOrWorkletScriptController.h>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <emscripten/emscripten.h>
#include <memory>
#include <mutex>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/SharedTask.h>
#include <wtf/ThreadSafeRefCounted.h>
#include <wtf/text/WTFString.h>

using namespace JSC;

namespace BrowserLite {

namespace {

constexpr size_t pageSize = 65536;
// Hoechstens 2 GB pro Speicher: die Engine selber liegt im gleichen 4-GB-Speicher
constexpr uint32_t maxMemoryPages = 32768;
// Verschachtelte Aufrufe JS -> WebAssembly -> JS. Jede Ebene braucht Stack des
// Browsers in Frames der Engine (ca. 8 KB), den JSC nicht sieht. Ohne Grenze lief
// er in Chrome nach ca. 125 Ebenen ueber, mitten in der Engine (JSC bleibt dann
// halb abgebaut zurueck, die Engine haengt).
constexpr unsigned maxCallDepth = 64;
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

// Eindeutig ueber alle Threads: ein Worker der Engine bekommt nach dem Ende
// eines Threads einen neuen, die Host-Seite darin bleibt dieselbe
std::atomic<uint32_t> nextId { 1 };

// Bereich im Engine-Speicher. Ihn halten der Speicher und der ArrayBuffer der
// Seite darauf, der den Speicher ueberleben kann (wie im Standard).
struct Region : ThreadSafeRefCounted<Region> {
    explicit Region(uint8_t* base)
        : base(base)
    {
    }
    ~Region() { free(base); }
    uint8_t* const base;
    // Setzt sich zurueck, wenn der ArrayBuffer abgehaengt oder abgebaut wird
    ArrayBuffer* buffer { nullptr };
};

struct MemoryRecord {
    uint32_t realm { 0 };
    VM* vm { nullptr };
    RefPtr<Region> region;
    uint32_t pages { 0 };
    uint32_t maxPages { 0 };
    uint32_t capacityPages { 0 };
    // Das Memory-Objekt der Seite und jede Instanz auf der Host-Seite
    int references { 1 };
};

class RealmOwner final : public WeakHandleOwner {
    void finalize(Handle<Unknown>, void* context) final;
};

struct Realm {
    // Werte aus JSC nach id, als unsichtbare Eigenschaft am globalen Objekt
    Weak<JSMap> guests;
    uint32_t nextGuest { 1 };
    // Freigaben von der Host-Seite kommen ausserhalb von JSC an (aus ihrer
    // FinalizationRegistry), erledigt beim naechsten Aufruf der Bruecke
    Vector<uint32_t> released;
};

RealmOwner& realmOwner()
{
    static NeverDestroyed<RealmOwner> owner;
    return owner;
}

// Pro Thread (jeder Worker hat einen eigenen), lebt bis zum Ende des Threads.
// Nie frueher freigeben: releaseRealm laeuft im GC, auch mitten in einer
// Allokation, waehrend weiter oben im Stack noch eine Referenz darauf liegt.
struct BridgeState {
    HashMap<uint32_t, std::unique_ptr<Realm>> realms;
    HashMap<int, std::unique_ptr<MemoryRecord>> memories;
    Slot args[slotCapacity];
    Slot out[slotCapacity];
};

thread_local std::unique_ptr<BridgeState> bridgeState;
thread_local unsigned callDepth;

BridgeState& state()
{
    if (!bridgeState)
        bridgeState = std::make_unique<BridgeState>();
    return *bridgeState;
}

Realm* findRealm(uint32_t id)
{
    if (!bridgeState)
        return nullptr;
    auto& realms = bridgeState->realms;
    if (!realms.isValidKey(id))
        return nullptr;
    auto it = realms.find(id);
    return it == realms.end() ? nullptr : it->value.get();
}

uint32_t registerGuest(JSGlobalObject* globalObject, Realm& realm, JSValue value)
{
    uint32_t id = realm.nextGuest++;
    realm.guests->set(globalObject, jsNumber(id), value);
    return id;
}

JSValue guestValue(JSGlobalObject* globalObject, uint32_t realmId, uint32_t id, bool release)
{
    auto* realm = findRealm(realmId);
    auto* guests = realm ? realm->guests.get() : nullptr;
    if (!guests)
        return jsUndefined();
    JSValue key = jsNumber(id);
    JSValue value = guests->get(globalObject, key);
    if (release)
        guests->remove(globalObject, key);
    return value;
}

void dropReleased(JSGlobalObject* globalObject, Realm& realm)
{
    auto* guests = realm.guests.get();
    if (!guests)
        return;
    for (uint32_t id : realm.released)
        guests->remove(globalObject, jsNumber(id));
    realm.released.clear();
}

// Paare [tag, wert, ...] aus JSC in Slots. Texte werden mit malloc kopiert,
// "texts" sammelt sie zum Freigeben nach dem Aufruf.
int writePairs(JSGlobalObject* globalObject, uint32_t realmId, JSValue pairsValue, Slot* slots, Vector<char*>& texts)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto* pairs = dynamicDowncast<JSArray>(pairsValue);
    auto* realm = findRealm(realmId);
    if (!pairs || !realm) {
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
            slot.a = realmId;
            slot.word.lo = registerGuest(globalObject, *realm, value);
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
            value = guestValue(globalObject, slot.a, slot.word.lo, tag == GuestOnce);
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
    if (!bridgeState)
        return nullptr;
    auto& memories = bridgeState->memories;
    if (!memories.isValidKey(id))
        return nullptr;
    auto it = memories.find(id);
    return it == memories.end() ? nullptr : it->value.get();
}

// Speicher fuer Aufrufe aus JSC: nur der eigenen Realm. Die ids sind leicht zu
// raten und wasm-guest.js laeuft mit den Built-ins der Seite.
MemoryRecord* ownedMemory(int id, uint32_t realm)
{
    auto* memory = memoryRecord(id);
    return memory && memory->realm == realm ? memory : nullptr;
}

// Neuer Bereich: die ersten "copied" Seiten aus "from", der Rest null. JSC
// erfaehrt die Groesse (wie V8 im Browser), sonst sammelt es kaum: die
// Memory-Objekte sind klein, alte findet erst ein voller GC.
RefPtr<Region> allocateRegion(VM& vm, uint32_t pages, const uint8_t* from = nullptr, uint32_t copied = 0)
{
    if (pages > maxMemoryPages)
        return nullptr;
    size_t bytes = static_cast<size_t>(std::max<uint32_t>(pages, 1)) * pageSize;
    auto* base = static_cast<uint8_t*>(aligned_alloc(pageSize, bytes));
    if (!base)
        return nullptr;
    size_t copiedBytes = static_cast<size_t>(copied) * pageSize;
    if (copiedBytes)
        memcpy(base, from, copiedBytes);
    memset(base + copiedBytes, 0, bytes - copiedBytes);
    vm.heap.deprecatedReportExtraMemory(bytes);
    return adoptRef(*new Region(base));
}

// Reserve beim Umziehen, damit nicht jedes grow kopiert: ein Viertel, hoechstens
// 96 MB (wie Emscripten selber waechst). Beim Umziehen liegen alter und neuer
// Bereich zugleich im Speicher, darum bleibt die Reserve klein.
uint32_t capacityFor(uint64_t pages, uint32_t maxPages)
{
    constexpr uint64_t maxReserve = (96 << 20) / pageSize;
    return static_cast<uint32_t>(std::min<uint64_t>(maxPages, pages + std::min(pages / 4, maxReserve)));
}

void updateHost(int id, uint8_t* base, int pages)
{
    EM_ASM({ blWasmHost.memoryUpdate($0, $1, $2); }, id, reinterpret_cast<uintptr_t>(base), pages);
}

// Alter ArrayBuffer ist nach grow nicht mehr gueltig (wie im Standard)
void detachBuffer(MemoryRecord& memory)
{
    if (auto* buffer = memory.region->buffer)
        buffer->detach(*memory.vm);
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
    RefPtr<Region> region = memory->region;
    if (pages > memory->capacityPages) {
        uint32_t capacity = capacityFor(pages, memory->maxPages);
        region = allocateRegion(*memory->vm, capacity, memory->region->base, old);
        if (!region && capacity > pages) {
            capacity = static_cast<uint32_t>(pages);
            region = allocateRegion(*memory->vm, capacity, memory->region->base, old);
        }
        if (!region)
            return -1;
        memory->capacityPages = capacity;
    }
    detachBuffer(*memory);
    memory->region = WTF::move(region);
    memory->pages = static_cast<uint32_t>(pages);
    updateHost(id, memory->region->base, memory->pages);
    return old;
}

// Ab jetzt faengt jeder Zugriff (Groesse 0). Den Bereich gibt der letzte frei,
// der ihn haelt (evtl. ein ArrayBuffer der Seite).
void dropMemory(int id)
{
    updateHost(id, nullptr, -1);
    state().memories.remove(id);
}

void releaseMemory(int id)
{
    auto* memory = memoryRecord(id);
    if (memory && --memory->references <= 0)
        dropMemory(id);
}

// Laeuft, wenn der GC das globale Objekt abbaut (auch beim Ende der VM eines
// Workers). Darf JSC nicht benutzen.
void releaseRealm(uint32_t id)
{
    auto& s = state();
    Vector<int> owned;
    for (auto& entry : s.memories) {
        if (entry.value->realm == id)
            owned.append(entry.key);
    }
    for (int memoryId : owned)
        dropMemory(memoryId);
    s.realms.remove(id);
    EM_ASM({ blWasmHost.releaseRealm($0); }, id);
}

void RealmOwner::finalize(Handle<Unknown>, void* context)
{
    releaseRealm(static_cast<uint32_t>(reinterpret_cast<uintptr_t>(context)));
}

// ------------------------------------------------------------ Funktionen fuer die API

EncodedJSValue bridgeHost(JSGlobalObject* globalObject, CallFrame* callFrame, uint32_t realmId)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto& s = state();
    if (auto* realm = findRealm(realmId))
        dropReleased(globalObject, *realm);
    int op = callFrame->argument(0).toInt32(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    Vector<char*> texts;
    int count = writePairs(globalObject, realmId, callFrame->argument(1), s.args, texts);
    if (count < 0 || scope.exception()) {
        for (auto* text : texts)
            free(text);
        return { };
    }
    int results = EM_ASM_INT({ return blWasmHost.dispatch($0, $1, $2, $3, $4, $5); }, realmId, op, s.args, count, s.out, slotCapacity);
    for (auto* text : texts)
        free(text);
    RELEASE_AND_RETURN(scope, JSValue::encode(readPairs(globalObject, s.out, results)));
}

EncodedJSValue bridgeMemoryCreate(JSGlobalObject* globalObject, CallFrame* callFrame, uint32_t realmId)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    uint32_t initial = callFrame->argument(0).toUInt32(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    int32_t maximum = callFrame->argument(1).toInt32(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    auto memory = std::make_unique<MemoryRecord>();
    memory->realm = realmId;
    memory->vm = &vm;
    memory->pages = initial;
    memory->maxPages = maximum < 0 ? maxMemoryPages : std::min(static_cast<uint32_t>(maximum), maxMemoryPages);
    memory->capacityPages = std::max<uint32_t>(initial, 1);
    memory->region = allocateRegion(vm, memory->capacityPages);
    if (!memory->region)
        return throwVMRangeError(globalObject, scope, "WebAssembly.Memory(): could not allocate memory"_s);
    int id = static_cast<int>(nextId++);
    uint8_t* base = memory->region->base;
    state().memories.add(id, WTF::move(memory));
    EM_ASM({ blWasmHost.memoryCreate($0, $1, $2, $3); }, id, realmId, reinterpret_cast<uintptr_t>(base), initial);
    return JSValue::encode(jsNumber(id));
}

EncodedJSValue bridgeMemoryBuffer(JSGlobalObject* globalObject, CallFrame* callFrame, uint32_t realmId)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    int id = callFrame->argument(0).toInt32(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    auto* memory = ownedMemory(id, realmId);
    if (!memory)
        return throwVMTypeError(globalObject, scope, "WebAssembly.Memory: freigegeben"_s);
    auto& region = *memory->region;
    if (region.buffer) {
        // WebCore cacht einen Wrapper pro ArrayBuffer, nicht pro Realm
        auto* wrapper = vm.m_typedArrayController->toJS(globalObject, globalObject, *region.buffer);
        if (wrapper->realm() != globalObject)
            return throwVMTypeError(globalObject, scope, "WebAssembly.Memory: Buffer einer anderen Realm"_s);
        return JSValue::encode(wrapper);
    }
    // Direkt auf den Speicher. Nicht abloesbar wie im Standard: transfer() wirft,
    // postMessage kopiert (sonst zeigte ein uebertragener Buffer auf freien Speicher)
    auto buffer = ArrayBuffer::createFromBytes(std::span<const uint8_t> { region.base, static_cast<size_t>(memory->pages) * pageSize },
        createSharedTask<void(void*)>([region = Ref { region }](void*) { region->buffer = nullptr; }));
    buffer->makeWasmMemory();
    region.buffer = buffer.ptr();
    return JSValue::encode(JSArrayBuffer::create(vm, globalObject->arrayBufferStructure(ArrayBufferSharingMode::Default), WTF::move(buffer)));
}

EncodedJSValue bridgeMemoryGrow(JSGlobalObject* globalObject, CallFrame* callFrame, uint32_t realmId)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    int id = callFrame->argument(0).toInt32(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    uint32_t delta = callFrame->argument(1).toUInt32(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    if (!ownedMemory(id, realmId))
        return throwVMTypeError(globalObject, scope, "WebAssembly.Memory: freigegeben"_s);
    return JSValue::encode(jsNumber(growMemory(id, delta)));
}

EncodedJSValue bridgeMemoryRelease(JSGlobalObject* globalObject, CallFrame* callFrame, uint32_t realmId)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    int id = callFrame->argument(0).toInt32(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    if (ownedMemory(id, realmId))
        releaseMemory(id);
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

// Neue Realm fuer das globale Objekt, ihre Werte haengen daran
uint32_t createRealm(JSGlobalObject* globalObject)
{
    VM& vm = globalObject->vm();
    uint32_t id = nextId++;
    auto* guests = JSMap::create(vm, globalObject->mapStructure());
    globalObject->putDirect(vm, Identifier::fromUid(PrivateName(PrivateName::PrivateSymbol, "browser-lite wasm"_s)), guests,
        static_cast<unsigned>(PropertyAttribute::DontEnum | PropertyAttribute::DontDelete | PropertyAttribute::ReadOnly));
    auto realm = std::make_unique<Realm>();
    realm->guests = Weak<JSMap>(guests, &realmOwner(), reinterpret_cast<void*>(static_cast<uintptr_t>(id)));
    state().realms.add(id, WTF::move(realm));
    return id;
}

JSObject* createBridge(JSGlobalObject* globalObject)
{
    VM& vm = globalObject->vm();
    uint32_t realm = createRealm(globalObject);
    JSObject* bridge = constructEmptyObject(globalObject);
    auto put = [&](ASCIILiteral name, JSObject* function) {
        bridge->putDirect(vm, Identifier::fromString(vm, name), function);
    };
    auto withRealm = [&](ASCIILiteral name, unsigned length, EncodedJSValue (*function)(JSGlobalObject*, CallFrame*, uint32_t)) {
        put(name, JSNativeStdFunction::create(vm, globalObject, length, String(name), [function, realm](JSGlobalObject* globalObject, CallFrame* callFrame) {
            return function(globalObject, callFrame, realm);
        }));
    };
    withRealm("host"_s, 2, bridgeHost);
    withRealm("memoryCreate"_s, 2, bridgeMemoryCreate);
    withRealm("memoryBuffer"_s, 1, bridgeMemoryBuffer);
    withRealm("memoryGrow"_s, 2, bridgeMemoryGrow);
    withRealm("memoryRelease"_s, 1, bridgeMemoryRelease);
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
extern "C" EMSCRIPTEN_KEEPALIVE int bl_wasm_call_guest(uint32_t realmId, uint32_t id, const Slot* args, int count, Slot* out, int capacity)
{
    auto* realm = findRealm(realmId);
    auto* guests = realm ? realm->guests.get() : nullptr;
    if (!guests || capacity < 2)
        return 0;
    VM& vm = guests->vm();
    JSLockHolder lock(vm);
    JSValue function = guestValue(guests->realm(), realmId, id, false);
    auto* object = function.getObject();
    if (!object)
        return 0;
    JSGlobalObject* globalObject = object->realm();
    auto scope = DECLARE_TOP_EXCEPTION_SCOPE(vm);
    JSArray* pairs = readPairs(globalObject, args, count);
    JSValue result;
    if (callDepth >= maxCallDepth) {
        auto throwScope = DECLARE_THROW_SCOPE(vm);
        throwStackOverflowError(globalObject, throwScope);
    } else if (pairs && !scope.exception()) {
        MarkedArgumentBuffer arguments;
        arguments.append(pairs);
        auto callData = JSC::getCallData(function);
        callDepth++;
        result = JSC::call(globalObject, function, callData, jsUndefined(), arguments);
        callDepth--;
    }
    Vector<char*> texts;
    int written = -1;
    if (!scope.exception())
        written = writePairs(globalObject, realmId, result, out, texts);
    if (JSC::Exception* exception = scope.exception()) {
        scope.clearException();
        // Ausnahme weiterreichen: Status 1 und der Wert. Die Realm kann
        // waehrend des Aufrufs abgebaut worden sein.
        written = 0;
        if (auto* current = findRealm(realmId)) {
            out[0] = { };
            out[0].tag = Number;
            out[0].number = 1;
            out[1] = { };
            out[1].tag = Guest;
            out[1].a = realmId;
            out[1].word.lo = registerGuest(globalObject, *current, exception->value());
            written = 2;
        }
    }
    for (auto* text : texts)
        free(text);
    return written;
}

extern "C" EMSCRIPTEN_KEEPALIVE void bl_wasm_release_guest(uint32_t realmId, uint32_t id)
{
    if (auto* realm = findRealm(realmId))
        realm->released.append(id);
}

extern "C" EMSCRIPTEN_KEEPALIVE int bl_wasm_memory_grow(int id, int delta)
{
    if (delta < 0)
        return -1;
    return growMemory(id, static_cast<uint32_t>(delta));
}

// Eine Instanz auf der Host-Seite benutzt den Speicher, bis sie abgebaut wird
// (ihre FinalizationRegistry). Freigeben braucht JSC nicht.
extern "C" EMSCRIPTEN_KEEPALIVE void bl_wasm_memory_retain(int id)
{
    if (auto* memory = memoryRecord(id))
        memory->references++;
}

extern "C" EMSCRIPTEN_KEEPALIVE void bl_wasm_memory_release(int id)
{
    releaseMemory(id);
}
