// The JIT to WebAssembly (docs/jit.md): hooks of the C loop (LLIntWasmJIT.h, patch 0067) and the
// compiler of a CodeBlock's bytecode into one WASM function.
//
// The function runs the CodeBlock from one of its basic blocks: (cfr, block) -> status, block 0
// after op_enter or the one after a loop hint, status 0 when it returned (the value in the
// frame's `this` slot, an op_ret of the C loop takes it from there), 1 on an exception (the C loop
// unwinds), 2 plus a block to be called again from there (runCompiled), -1 at a tail call, which
// the interpreter or the compiled caller makes in its place (finishTailCall). Virtual registers stay in
// the frame, as tag and payload in linear memory, so a safepoint inside sees every value like in
// the interpreter.
#include "config.h"
#include "LLIntWasmJIT.h"
#include "MachineStack.h"

#include "ArrayAllocationProfile.h"
#include "ArrayProfile.h"
#include "ArrayStorage.h"
#include "ButterflyInlines.h"
#include "BuiltinExecutables.h"
#include "BytecodeGenerator.h"
#include "BytecodeStructs.h"
#include "CallData.h"
#include "CellState.h"
#include "ConstructData.h"
#include "CodeBlock.h"
#include "CodeSpecializationKind.h"
#include "CommonSlowPaths.h"
#include "DeferGC.h"
#include "DirectArguments.h"
#include "Fits.h"
#include "FrameTracers.h"
#include "FunctionExecutable.h"
#include "FunctionRareData.h"
#include "GetterSetter.h"
#include "HeapObserver.h"
#include "IndexingHeader.h"
#include "IndexingType.h"
#include "Interpreter.h"
#include "InterpreterInlines.h"
#include "JSArrayBufferView.h"
#include "JSBoundFunction.h"
#include "JSCJSValueInlines.h"
#include "JSCellButterfly.h"
#include "JSFunction.h"
#include "JSFunctionInlines.h"
#include "JSGlobalLexicalEnvironment.h"
#include "JSInternalFieldObjectImpl.h"
#include "JSLexicalEnvironment.h"
#include "JSObject.h"
#include "JSObjectInlines.h"
#include "JSString.h"
#include "LLIntData.h"
#include "LLIntSlowPaths.h"
#include "LocalAllocator.h"
#include "MathObjectInlines.h"
#include "MegamorphicCache.h"
#include "NativeExecutable.h"
#include "Options.h"
#include "SlowPathCall.h"
#include "StackAlignment.h"
#include "StructureChain.h"
#include "Symbol.h"
#include "TypedArrayType.h"
#include "VMTraps.h"
#include "Watchpoint.h"
#include "WasmModule.h"
#include <emscripten.h>
#include <optional>
#include <tuple>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/Lock.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>

namespace JSC::LLInt {

using namespace WasmJIT;

namespace {

// On by default: BL_JIT=0 turns it off, 2 also logs what it compiles, 3 also writes the modules
// to files (node)
EM_JS(int, wasmJITSwitch, (), {
    const value = typeof process === 'object' && process.env ? process.env.BL_JIT : undefined;
    return value === undefined || value === '' ? 1 : Number(value) || 0;
});

int level()
{
    static const int value = [] {
        // The engine's environment (engine.env); node's for the jsc shell, whose getenv does not see it
        if (const char* value = getenv("BL_JIT"))
            return atoi(value);
        return wasmJITSwitch();
    }();
    return value;
}

bool enabled()
{
    return level() > 0;
}

using OffsetMap = HashMap<unsigned, unsigned, WTF::IntHash<unsigned>, WTF::UnsignedWithZeroKeyHashTraits<unsigned>>;

// What a call from compiled code needs of a compiled or host callee, so it neither reads the
// executable and its CodeBlock nor looks up the map. Valid within one GC epoch (a collection may
// throw the code away, and a new executable may take the address of one that went away).
struct CallTarget {
    // The executable, with 1 added for a construct (executables are cells, aligned); 0: empty
    uintptr_t key { 0 };
    uint32_t epoch { 0 };
    CodeBlock* codeBlock { nullptr };
    // The compiled function, 0 for a host function
    uint32_t function { 0 };
    unsigned numParameters { 0 };
    unsigned numCalleeLocals { 0 };
    unsigned numVars { 0 };
    VirtualRegister scopeRegister;
    // A host function (`function` is 0), called without the generic path
    TaggedNativeFunction hostFunction { };
};

// The callees of a VM's compiled code, direct mapped by key. One table for all call sites: an
// obfuscated VM's dispatch (handlers[op](state)) calls dozens of functions from one site, which a
// cache per site missed on every call (2.5 times the time of a call that hit). The epoch moves at
// the start and the end of every collection, which empties the table at once. Compiled code
// reads it at fixed addresses (emitCompiledCall), so it lives as long as the VM has compiled code.
struct CallTargets final : HeapObserver {
    WTF_DEPRECATED_MAKE_STRUCT_FAST_ALLOCATED(CallTargets);
    static constexpr unsigned count = 2048;

    explicit CallTargets(VM& vm)
        : vm(vm)
    {
        vm.heap.addObserver(this);
    }
    ~CallTargets() { vm.heap.removeObserver(this); }
    void willGarbageCollect() final { ++epoch; }
    void didGarbageCollect(CollectionScope) final { ++epoch; }

    static uintptr_t key(ExecutableBase* executable, bool isConstruct)
    {
        return reinterpret_cast<uintptr_t>(executable) + isConstruct;
    }
    static unsigned index(uintptr_t key) { return ((key >> 4) ^ (key >> 15)) & (count - 1); }
    CallTarget& slot(uintptr_t key) { return targets[index(key)]; }

    VM& vm;
    // Starts above 0, the epoch of empty entries
    uint32_t epoch { 1 };
    // CodeBlocks with compiled code: the table goes with the last one (at the latest when the VM
    // ends, which finalizes every CodeBlock)
    unsigned compiledCodeBlocks { 0 };
    CallTarget targets[count];
};

// Compiled code runs on the thread of its VM (WASM tables are per thread), one VM per thread
// (wasmJITTierUp). A pooled thread may run another VM after the last one ended.
std::unique_ptr<CallTargets>& threadCallTargets()
{
    static thread_local std::unique_ptr<CallTargets> table;
    return table;
}

// The table of a VM that has compiled code on this thread, or null
CallTargets* existingCallTargets(VM& vm)
{
    auto* table = threadCallTargets().get();
    return table && &table->vm == &vm ? table : nullptr;
}

// The table of the VM of the compiled code that runs or compiles
CallTargets& callTargets(VM& vm)
{
    auto* table = existingCallTargets(vm);
    RELEASE_ASSERT(table);
    return *table;
}

// The entry of a callee from this epoch, or null
CallTarget* cachedCallTarget(VM& vm, ExecutableBase* executable, bool isConstruct)
{
    auto& table = callTargets(vm);
    uintptr_t key = CallTargets::key(executable, isConstruct);
    auto& target = table.slot(key);
    if (target.key != key || target.epoch != table.epoch)
        return nullptr;
    return &target;
}

// More own properties of a get_by_id than the interpreter's cache holds (two structures, patch 0179):
// the structures and offsets it had before, valid until the next GC. And how often the misses of
// a get_by_id or get_length looked for a getter and found none (getByIdFromCompiledCode).
struct PropertyCache {
    WTF_DEPRECATED_MAKE_STRUCT_FAST_ALLOCATED(PropertyCache);
    static constexpr unsigned size = 4;
    static constexpr uint8_t getterMissesBeforeGivingUp = 4;
    HeapVersion markingVersion { 0 };
    HeapVersion edenVersion { 0 };
    StructureID structures[size] { };
    int32_t offsets[size] { };
    unsigned next { 0 };
    uint8_t getterMisses { 0 };
};

// A CodeBlock the compiler saw: the table index of its function (0 when it cannot be compiled),
// by bytecode offset the blocks that start after its loop hints, the caches of its property reads
struct Compiled {
    uint32_t function { 0 };
    OffsetMap loops;
    Vector<std::unique_ptr<PropertyCache>> propertyCaches;
};

// CodeBlocks of this thread's VM. Tables are per thread, so are the indexes.
HashMap<CodeBlock*, Compiled>& compiledCode()
{
    static thread_local HashMap<CodeBlock*, Compiled> map;
    return map;
}

// CodeBlocks with compiled code of every thread's VM, for the GC's markers on other threads
// (wasmJITHasCompiledCode)
Lock compiledCodeBlocksLock;
HashSet<const CodeBlock*>& compiledCodeBlocks() WTF_REQUIRES_LOCK(compiledCodeBlocksLock)
{
    static NeverDestroyed<HashSet<const CodeBlock*>> set;
    return set;
}

// How often the interpreter's counter must fire (about 50 calls or 500 loop iterations each)
// before a CodeBlock compiles. A compile costs in proportion to the code: V8 compiles the module on
// the engine thread at its first call (Liftoff, about 4 ms for 25 KB in the engine), while code
// fresh from Liftoff runs little faster than the interpreter. So a function warms up the longer the
// larger it is, and compiles only once it ran long enough to pay that back (#566): 64 fires plus
// one per 6 bytes, at most 512 (about 25000 calls or 250000 loop iterations). The module was 25
// to 40 times the bytecode then, one fire per 2 bytes and at most 2048; with the fast paths of
// scope, element and property access in functions of the module it is 8 to 20 times, and the
// large functions of an obfuscated VM (Turnstile's challenge, 4 to 12 KB) ran interpreted for most
// of a minute at a fire every 30 to 50 ms (#630).
constexpr unsigned maximumWarmUpFires = 512;

unsigned warmUpFires(CodeBlock* codeBlock)
{
    size_t size = codeBlock->instructions().size();
    return static_cast<unsigned>(std::min<size_t>(64 + size / 6, maximumWarmUpFires));
}

// The fires count calls and loop iterations, not the time they take. An obfuscated VM's large
// functions (Turnstile's challenge: 19 to 78 KB of bytecode) fire every 100 to 150 ms, as one of
// their iterations runs a whole instruction of the VM: their 512 fires took 35 to 45 s, most of a
// step of 38 s in which the interpreter was 35 to 55 % of the engine thread. So for the functions
// whose warm-up is at its maximum (from about 2.7 KB of bytecode) the time they run in the
// interpreter counts too, sampled at the safepoints of the running script (bl_jsc_jit_sample):
// such a function compiles once that time is 30 times the estimated cost of its compile (Liftoff
// compiles about 30 MB of WASM per second on a desktop, the module is about 8 times the bytecode:
// some 0.3 us per byte; a phone is slower at both alike), and at least 100 ms. Like the fires,
// by UnlinkedCodeBlock.
bool warmsUpByTime(CodeBlock* codeBlock)
{
    return warmUpFires(codeBlock) == maximumWarmUpFires;
}

Seconds interpretedTimeBeforeCompile(CodeBlock* codeBlock)
{
    return std::max(100_ms, Seconds::fromMicroseconds(9) * static_cast<double>(codeBlock->instructions().size()));
}

// The interval of the samples while such a function warms up. A sample is a safepoint the
// embedder brings the script to (an atomic flag that the interpreter and compiled code check at
// loops and function entries), so this costs a few safepoints per 10 ms of interpreted code that
// warms up, nothing otherwise.
constexpr Seconds sampleInterval = 5_ms;

// How often the counter fired for the code of CodeBlocks not compiled yet. By UnlinkedCodeBlock,
// like the counter: a full GC throws away a CodeBlock that is not compiled and older than 5 s, and
// the next call makes a new one of the same code. Counted per CodeBlock, the large functions of an
// obfuscated VM (Turnstile's challenge) started their warm-up again at every GC and ran interpreted
// for a minute (#630). The entry stays after a compile, so the next CodeBlock of hot code (another
// frame's, a builtin's in another realm) compiles at its first fire.
struct WarmUp {
    unsigned fires { 0 };
    // The thread's fire count at this entry's last fire
    uint64_t lastFire { 0 };
    // The time its code ran in the interpreter, by samples (interpretedTimeBeforeCompile)
    Seconds interpreted;
};

// The entries of this thread's VM. Their age counts in fires of the whole thread, not in time: a
// clock read at every fire (the host's performance.now(), about 0.7 us in a worker of Chromium)
// took over 1 % of the engine thread while a news site rendered a route (#632).
struct WarmUps {
    HashMap<UnlinkedCodeBlock*, WarmUp> map;
    uint64_t fires { 0 };
    size_t pruneAt { 0 };
    // The sample asked for (bl_jsc_jit_sample), when it was asked for
    MonotonicTime sampleRequested;
    bool samplePending { false };
    unsigned sampleChecks { 0 };
};
WarmUps& warmUps()
{
    static thread_local WarmUps state;
    return state;
}

// The code of entries not fired among the thread's last fires went away or cooled down: dropped
// once the map is large, so a page that runs for hours does not keep one for every function it
// ever warmed up (an UnlinkedCodeBlock that went away may leave its entry to another one at its
// address, which then compiles sooner). A busy page fires a few thousand times per second, a
// React render's largest functions about twice per second. The next pruning waits until the map
// doubled, so a map of live entries is not scanned at every fire.
constexpr size_t warmUpEntriesBeforePruning = 4096;
constexpr uint64_t warmUpEntryLifetime = 65536;

WarmUp& warmUpOf(CodeBlock* codeBlock)
{
    auto& state = warmUps();
    uint64_t now = ++state.fires;
    if (state.map.size() >= std::max(state.pruneAt, warmUpEntriesBeforePruning)) {
        state.map.removeIf([&](auto& entry) {
            return now - entry.value.lastFire > warmUpEntryLifetime;
        });
        state.pruneAt = state.map.size() * 2;
    }
    auto& entry = state.map.add(codeBlock->unlinkedCodeBlock(), WarmUp { }).iterator->value;
    entry.lastFire = now;
    return entry;
}

// Set by the embedder (engine/src/EngineLoop.cpp): brings the running script of the VM to a
// safepoint after the delay, where the embedder calls bl_jsc_jit_sample. Without one (the jsc
// shell) only the fires count.
void (*sampleRequester)(VM&, double seconds);

void requestSample(VM& vm, WarmUps& state)
{
    if (!sampleRequester)
        return;
    // A request whose safepoint never came (the script had ended) is renewed; the clock only at
    // every 8th fire while one waits
    if (state.samplePending && (++state.sampleChecks & 7))
        return;
    auto now = MonotonicTime::now();
    if (state.samplePending && now - state.sampleRequested < sampleInterval * 10)
        return;
    state.samplePending = true;
    state.sampleRequested = now;
    sampleRequester(vm, sampleInterval.seconds());
}

uint32_t compiledFunction(CodeBlock* codeBlock)
{
    auto it = compiledCode().find(codeBlock);
    return it == compiledCode().end() ? 0 : it->value.function;
}

bool isFunctionPrototypeCall(VM& vm, FunctionExecutable* executable)
{
    return executable->isBuiltinFunction() && executable->unlinkedExecutable() == vm.builtinExecutables()->functionPrototypeCallCodeExecutable();
}

// The entry of a callee's CodeBlock with its compiled function, filled now. Not for
// Function.prototype.call, whose calls give way to the call it makes (callInFrame).
CallTarget* fillCallTarget(VM& vm, FunctionExecutable* executable, CodeBlock* codeBlock, uint32_t function, bool isConstruct)
{
    if (isFunctionPrototypeCall(vm, executable))
        return nullptr;
    auto& table = callTargets(vm);
    uintptr_t key = CallTargets::key(executable, isConstruct);
    auto& target = table.slot(key);
    target = { key, table.epoch, codeBlock, function, codeBlock->numParameters(), codeBlock->numCalleeLocals(), codeBlock->numVars(), codeBlock->scopeRegister() };
    return &target;
}

EM_JS(uint32_t, wasmJITInstall, (const uint8_t* bytes, uint32_t size, int dump), {
    bytes >>>= 0;
    try {
        const code = HEAPU8.slice(bytes, bytes + size);
        // BL_JIT=3 in node: every module into the working directory, for wasm-dis
        if (dump && typeof require === 'function')
            require('fs').writeFileSync('jit-' + wasmTable.length + '.wasm', code);
        const module = new WebAssembly.Module(code);
        const instance = new WebAssembly.Instance(module, { env: { memory: wasmMemory, table: wasmTable } });
        // Slots of functions that went away first (tables are per thread, so is this list)
        const free = globalThis.blJitFreeSlots;
        const index = free && free.length ? free.pop() : wasmTable.grow(1);
        wasmTable.set(index, instance.exports.f);
        return index;
    } catch (e) {
        err('[jit] ' + e);
        return 0;
    }
});

// The function's CodeBlock went away: its table slot no longer holds the module, which V8 then
// collects, and serves the next function
EM_JS(void, wasmJITRelease, (uint32_t index), {
    wasmTable.set(index, null);
    (globalThis.blJitFreeSlots ||= []).push(index);
});

using CompiledFunction = int32_t (*)(CallFrame*, uint32_t block);
using SlowPath = UGPRPair (*)(CallFrame*, const JSInstruction*);

// op_ret of the `this` slot, where compiled code leaves the return value
const JSInstruction* returnInstruction()
{
    static const uint8_t* instruction = [] {
        auto* bytes = new uint8_t[16] { };
        bytes[0] = static_cast<uint8_t>(op_ret);
        bytes[1] = Fits<VirtualRegister, OpcodeSize::Narrow>::convert(virtualRegisterForArgumentIncludingThis(0));
        return bytes;
    }();
    return reinterpret_cast<const JSInstruction*>(instruction);
}

const JSInstruction* instructionAt(const JSInstruction* pc, int offset)
{
    return reinterpret_cast<const JSInstruction*>(reinterpret_cast<const uint8_t*>(pc) + offset);
}

// Instructions the interpreter runs only as a slow path (slowPathOp, llintSlowPathOp in its
// assembly, and some more): compiled code calls the same one
#define BL_JIT_COMMON_SLOW_PATH_OPS(v) \
    v(create_async_generator) v(create_generator) v(create_promise) v(create_rest) v(create_this) \
    v(define_accessor_property) v(define_data_property) v(enumerator_has_own_property) v(enumerator_next) \
    v(get_by_val_with_this) v(get_property_enumerator) v(is_callable) v(is_constructor) \
    v(new_array_with_species) v(new_array_with_spread) v(new_async_function_generator) v(new_generator) \
    v(new_promise) v(push_with_scope) v(put_by_id_with_this) v(put_by_val_with_this) v(spread) v(strcat) \
    v(throw_static_error) v(typeof_is_function) v(typeof_is_object) v(get_prototype_of) v(pow) \
    v(enumerator_get_by_val) v(enumerator_in_by_val) v(enumerator_put_by_val)
#define BL_JIT_LLINT_SLOW_PATH_OPS(v) \
    v(create_cloned_arguments) v(create_direct_arguments) v(create_lexical_environment) \
    v(create_scoped_arguments) v(del_by_id) v(del_by_val) v(get_by_id_with_this) v(has_private_brand) \
    v(has_private_name) v(has_structure_with_flags) v(new_array_with_size) v(new_async_func) \
    v(new_async_func_exp) v(new_async_generator_func) v(new_async_generator_func_exp) v(new_func) \
    v(new_func_exp) v(new_generator_func) v(new_generator_func_exp) v(new_reg_exp) v(put_getter_by_id) \
    v(put_getter_by_val) v(put_getter_setter_by_id) v(put_setter_by_id) v(put_setter_by_val) \
    v(set_function_name) v(throw) v(instanceof) v(in_by_id) v(in_by_val) v(put_by_val_direct) \
    v(get_private_name) v(put_private_name) v(check_private_brand) v(set_private_brand)

// Compiled code nests on the host's machine stack (every JS call is a WASM call), which is much
// smaller than the JS stack of the C loop and which JSC does not see; V8 stopping it halfway
// leaves the engine broken. Beyond this depth, or with little room left, the interpreter takes
// the calls, which nest only in the JS stack, until JSC's own limit throws a RangeError.
constexpr unsigned maximumDepth = 1000;
thread_local unsigned depth;

// Within one outermost run of compiled code (a script, an event handler): the deepest depth found
// with room and the depth found without (0: none)
thread_local unsigned roomyDepth;
thread_local unsigned crampedDepth;

// Room for one more level of compiled code: shallow nesting cannot run out; deeper, within one
// outermost run, depths up to the deepest one with room are trusted and every 8 levels beyond it
// probed, so code that recurses around one depth does not probe on every call
bool roomForCompiledCode()
{
    if (!depth)
        roomyDepth = crampedDepth = 0;
    if (depth >= maximumDepth)
        return false;
    if (depth < 64 || depth < roomyDepth + 8)
        return true;
    if (crampedDepth && depth >= crampedDepth)
        return false;
    if (!machineStackHasRoom()) {
        crampedDepth = depth;
        return false;
    }
    roomyDepth = depth;
    return true;
}

// VM entries that compiled code has open through JSC's generic call or construct of a JS function,
// and those of bound functions calling their target (wasmJITGenericEntries, GenericEntry)
thread_local unsigned genericEntries;

// A compiled function returns 0, 1 after an exception, or reenterStatus plus a block: its loops
// return every loopIterationsPerCall iterations and are called again from that block. V8 has no
// on-stack replacement for WebAssembly, a function runs the code it was called with to its end:
// a loop entered once (an obfuscated VM's dispatch, a proof of work) ran in Liftoff, V8's first
// tier, about 2.5x slower than the optimized code that V8 compiles meanwhile in the background
// and that the next call takes.
constexpr int32_t reenterStatus = 2;
constexpr int32_t loopIterationsPerCall = 10000;

// A compiled function returns this at a tail call (op_tail_call, op_tail_call_varargs), the frame's
// bytecode offset at it. The call is made in place of the function's frame, like the interpreter's
// tail calls: the interpreter goes on at that instruction, a compiled caller finishes it with
// finishTailCall. The frame of a strict function that ends in `return f()` is gone before f runs:
// JSC's Function.prototype.call and apply and Reflect.apply (`return this.@apply(...)`) leave no
// frame that a stack walk sees (the incumbent realm of postMessage, Error.stack).
constexpr int32_t tailCallStatus = -1;

// The call of an op_tail_call that a compiled function returned at, for emitCompiledCallFunction,
// which makes it in WASM for a compiled callee; argc 0 at an op_tail_call_varargs
struct PendingTailCall {
    uint32_t calleeTag { 0 };
    uint32_t callee { 0 };
    uint32_t argvBytes { 0 };
    uint32_t argc { 0 };
};
thread_local PendingTailCall pendingTailCall;

int32_t runCompiled(uint32_t function, CallFrame* callFrame, uint32_t block)
{
    ++depth;
    auto compiled = reinterpret_cast<CompiledFunction>(static_cast<uintptr_t>(function));
    auto status = compiled(callFrame, block);
    while (status >= reenterStatus)
        status = compiled(callFrame, status - reenterStatus);
    --depth;
    return status;
}

// Math.imul's host function, which compiled code computes inline: static in JSC, so taken once
// from a Math object of the JIT's own (pages may replace the global one)
uintptr_t imulHostFunction(JSGlobalObject* globalObject)
{
    static const uintptr_t function = [globalObject] {
        VM& vm = globalObject->vm();
        // The compiler runs without collections
        DeferGC deferGC(vm);
        auto* math = MathObject::create(vm, globalObject, MathObject::createStructure(vm, globalObject, globalObject->objectPrototype()));
        auto* imul = dynamicDowncast<JSFunction>(math->getDirect(vm, Identifier::fromString(vm, "imul"_s)));
        if (!imul || !imul->isHostFunction())
            return uintptr_t { 0 };
        return reinterpret_cast<uintptr_t>(uncheckedDowncast<NativeExecutable>(imul->executable())->function().taggedPtr());
    }();
    return function;
}

// What compiled calls move and check of the C loop's stack (patch 0096)
void* cloopStackPointerAddress(VM& vm)
{
    return reinterpret_cast<char*>(&vm.cloopStack()) + CLoopStack::offsetOfCurrentStackPointer();
}

void* cloopStackLimitAddress(VM& vm)
{
    return reinterpret_cast<char*>(&vm.traps()) + VMTraps::offsetOfStackManager() + StackManager::offsetOfCLoopStackLimit();
}

// A host function's entry, so its next calls skip the generic path. Not for bound functions: all
// of a kind share their executable, and those without arguments of their own give way to the call
// they make (callInFrame).
void cacheHostFunction(VM& vm, JSFunction* function)
{
    if (function->inherits<JSBoundFunction>())
        return;
    auto* executable = uncheckedDowncast<NativeExecutable>(function->executable());
    auto& table = callTargets(vm);
    uintptr_t key = CallTargets::key(executable, false);
    auto& target = table.slot(key);
    target = { };
    target.key = key;
    target.epoch = table.epoch;
    target.hostFunction = executable->function();
}

// The builtin Function.prototype.call (FunctionPrototype.js), which calls its `this` through
// Function.prototype.apply
bool isFunctionPrototypeCall(VM& vm, JSFunction* function)
{
    return !function->isHostFunction() && isFunctionPrototypeCall(vm, function->jsExecutable());
}

// The call that Function.prototype.call (fn.call(thisArgument, a, b), which obfuscated code also
// reaches as fn["call"](...)) and bound functions without arguments of their own make, in place
// of theirs: what each of them leaves to a VM entry of the generic call. Moves `this` and the
// arguments in the frame and returns the callee to call instead; unchanged for everything else.
JSValue unwrapForwardingCall(VM& vm, CallFrame* calleeFrame, JSValue callee, unsigned& argumentCount)
{
    auto argument = [&](unsigned index) -> Register& {
        return calleeFrame->uncheckedR(virtualRegisterForArgumentIncludingThis(index));
    };
    // fn.call.call(...) and bound functions of bound functions, a few levels
    for (unsigned level = 0; level < 4 && callee.isCell() && callee.asCell()->type() == JSFunctionType; ++level) {
        auto* function = uncheckedDowncast<JSFunction>(callee.asCell());
        if (auto* bound = dynamicDowncast<JSBoundFunction>(function)) {
            if (bound->boundArgsLength())
                break;
            argument(0) = bound->boundThis();
            callee = bound->targetFunction();
            continue;
        }
        if (!isFunctionPrototypeCall(vm, function))
            break;
        // Its `this.@apply(thisArgument, argumentValues)` calls `this` directly (a varargs call);
        // other callees than functions stay with it
        JSValue target = argument(0).jsValue();
        if (!target.isCell() || target.asCell()->type() != JSFunctionType)
            break;
        for (unsigned i = 1; i < argumentCount; ++i)
            argument(i - 1) = argument(i);
        if (argumentCount > 1)
            --argumentCount;
        else
            argument(0) = jsUndefined();
        callee = target;
    }
    return callee;
}

int32_t finishTailCall(CallFrame*);

// Calls the callee in its frame below callFrame, where `this` (new.target for a construct) and
// the arguments already are: a compiled callee directly in that frame, a host function like the
// interpreter calls it, everything else through JSC's generic call or construct (bound functions
// with arguments, proxies, interpreted functions, stack overflow). Function.prototype.call and
// bound functions without arguments of their own give way to the call they make. Returns the
// result, empty after an exception.
template<bool isConstruct>
JSValue callInFrame(VM& vm, JSGlobalObject* globalObject, ThrowScope& scope, CallFrame* callFrame, CallFrame* calleeFrame, JSValue callee, unsigned argumentCount)
{
    if constexpr (!isConstruct)
        callee = unwrapForwardingCall(vm, calleeFrame, callee, argumentCount);
    auto setUpFrame = [&](CodeBlock* calleeCodeBlock) {
        calleeFrame->setCallerFrame(callFrame);
        calleeFrame->setReturnPC(nullptr);
        calleeFrame->setCodeBlock(calleeCodeBlock);
        calleeFrame->uncheckedR(VirtualRegister(CallFrameSlot::callee)) = callee;
        calleeFrame->setArgumentCountIncludingThis(argumentCount);
    };

    if (callee.isCell() && callee.asCell()->type() == JSFunctionType && vm.isSafeToRecurseSoft() && roomForCompiledCode()) {
        auto* function = uncheckedDowncast<JSFunction>(callee.asCell());
        auto* executable = function->executable();
        auto* cache = cachedCallTarget(vm, executable, isConstruct);
        if (!cache && !function->isHostFunction()) {
            CodeBlock* calleeCodeBlock = function->jsExecutable()->codeBlockFor(isConstruct ? CodeSpecializationKind::CodeForConstruct : CodeSpecializationKind::CodeForCall);
            if (uint32_t compiled = calleeCodeBlock && !calleeCodeBlock->couldBeTainted() ? compiledFunction(calleeCodeBlock) : 0)
                cache = fillCallTarget(vm, function->jsExecutable(), calleeCodeBlock, compiled, isConstruct);
        }
        if (cache && cache->function) {
            // Too few arguments: like the interpreter's arity fixup, the frame moves down (by a
            // multiple of the stack alignment) and the missing parameters are undefined
            unsigned padding = argumentCount < cache->numParameters ? WTF::roundUpToMultipleOf(stackAlignmentRegisters(), cache->numParameters - argumentCount) : 0;
            auto* shiftedFrame = calleeFrame - padding;
            auto* top = reinterpret_cast<Register*>(shiftedFrame) - cache->numCalleeLocals;
            if (vm.cloopStack().ensureCapacityFor(top)) {
                if (padding) {
                    auto* from = reinterpret_cast<Register*>(calleeFrame);
                    auto* to = reinterpret_cast<Register*>(shiftedFrame);
                    for (unsigned i = 0; i < CallFrame::headerSizeInRegisters + argumentCount; ++i)
                        to[i] = from[i];
                    for (unsigned i = argumentCount; i < cache->numParameters; ++i)
                        shiftedFrame->uncheckedR(virtualRegisterForArgumentIncludingThis(i)) = jsUndefined();
                    calleeFrame = shiftedFrame;
                }
                setUpFrame(cache->codeBlock);
                // What op_enter and slow_path_enter do
                for (int local = CodeBlock::llintBaselineCalleeSaveSpaceAsVirtualRegisters(); local < static_cast<int>(cache->numVars); ++local)
                    calleeFrame->uncheckedR(virtualRegisterForLocal(local)) = jsUndefined();
                vm.writeBarrier(cache->codeBlock);
                calleeFrame->uncheckedR(cache->scopeRegister) = function->scope();
                auto* previous = vm.cloopStack().currentStackPointer();
                vm.cloopStack().setCurrentStackPointer(top);
                auto status = runCompiled(cache->function, calleeFrame, 0);
                if (status == tailCallStatus)
                    status = finishTailCall(calleeFrame);
                vm.cloopStack().setCurrentStackPointer(previous);
                vm.topCallFrame = callFrame;
                if (status)
                    return JSValue();
                return calleeFrame->uncheckedR(virtualRegisterForArgumentIncludingThis(0)).jsValue();
            }
        }
    }

    MarkedArgumentBuffer arguments;
    auto collectArguments = [&] {
        for (unsigned i = 1; i < argumentCount; ++i)
            arguments.append(calleeFrame->uncheckedR(virtualRegisterForArgumentIncludingThis(i)).jsValue());
        if (arguments.hasOverflowed()) [[unlikely]] {
            throwOutOfMemoryError(globalObject, scope);
            return false;
        }
        return true;
    };
    JSValue thisValue = calleeFrame->uncheckedR(virtualRegisterForArgumentIncludingThis(0)).jsValue();
    if constexpr (isConstruct) {
        auto constructData = JSC::getConstructData(callee);
        if (constructData.type == CallData::Type::None) {
            throwException(globalObject, scope, createNotAConstructorError(globalObject, callee));
            return JSValue();
        }
        if (!collectArguments())
            return JSValue();
        if (constructData.type != CallData::Type::JS)
            return JSC::construct(globalObject, callee, constructData, arguments, thisValue);
        GenericEntry entry;
        return JSC::construct(globalObject, callee, constructData, arguments, thisValue);
    } else {
        auto callData = JSC::getCallData(callee);
        if (callData.type == CallData::Type::Native && vm.isSafeToRecurseSoft()) {
            // A host function runs in its realm, like the interpreter calls it
            JSGlobalObject* calleeGlobalObject = globalObject;
            if (callee.asCell()->type() == JSFunctionType) {
                auto* function = uncheckedDowncast<JSFunction>(callee.asCell());
                cacheHostFunction(vm, function);
                calleeGlobalObject = function->realm();
            }
            setUpFrame(nullptr);
            // The whole frame is in use, its caller and return pc too: a host function that enters
            // the VM again puts its entry frame below
            auto* previous = vm.cloopStack().currentStackPointer();
            vm.cloopStack().setCurrentStackPointer(reinterpret_cast<Register*>(calleeFrame));
            vm.topCallFrame = calleeFrame;
            JSValue result = JSValue::decode(callData.native.function(calleeGlobalObject, calleeFrame));
            vm.cloopStack().setCurrentStackPointer(previous);
            vm.topCallFrame = callFrame;
            return result;
        }
        if (callData.type == CallData::Type::None) {
            throwException(globalObject, scope, createNotAFunctionError(globalObject, callee));
            return JSValue();
        }
        if (!collectArguments())
            return JSValue();
        if (callData.type != CallData::Type::JS)
            return JSC::call(globalObject, callee, callData, thisValue, arguments);
        GenericEntry entry;
        return JSC::call(globalObject, callee, callData, thisValue, arguments);
    }
}

// A call from compiled code (op_call, op_call_ignore_result, op_construct, op_super_construct),
// with the signature of a slow path: in the frame the bytecode prepared (argv slots below
// callFrame).
template<typename Bytecode>
UGPRPair callFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc)
{
    constexpr bool isConstruct = std::is_same_v<Bytecode, OpConstruct> || std::is_same_v<Bytecode, OpSuperConstruct>;
    auto bytecode = pc->as<Bytecode>();

    // The common case first, without the tracer and scope of the general path: a compiled or host
    // callee in the table (also the one Function.prototype.call or a bound function calls), enough
    // arguments, shallow nesting
    VM& vm = callFrame->codeBlock()->vm();
    CallFrame* calleeFrame = callFrame - bytecode.m_argv;
    JSValue callee = callFrame->r(bytecode.m_callee).jsValue();
    unsigned argumentCount = bytecode.m_argc;
    if constexpr (!isConstruct)
        callee = unwrapForwardingCall(vm, calleeFrame, callee, argumentCount);
    if (callee.isCell() && callee.asCell()->type() == JSFunctionType && (depth < 64 || depth < roomyDepth + 8)) {
        auto* function = uncheckedDowncast<JSFunction>(callee.asCell());
        auto* cache = cachedCallTarget(vm, function->executable(), isConstruct);
        auto* top = cache ? reinterpret_cast<Register*>(calleeFrame) - cache->numCalleeLocals : nullptr;
        bool cached = cache && argumentCount >= cache->numParameters && top >= vm.cloopStackLimit();
        // The stack check reads the top frame: the one a call or slow path left there may be a
        // frame a tail call replaced, whose header the new frame covers
        vm.topCallFrame = callFrame;
        if (cached && !cache->function && vm.isSafeToRecurseSoft()) {
            // A host function, like the interpreter calls it
            callFrame->setCurrentVPC(pc);
            calleeFrame->setCallerFrame(callFrame);
            calleeFrame->setReturnPC(nullptr);
            calleeFrame->setCodeBlock(nullptr);
            calleeFrame->uncheckedR(VirtualRegister(CallFrameSlot::callee)) = callee;
            calleeFrame->setArgumentCountIncludingThis(argumentCount);
            auto scope = DECLARE_THROW_SCOPE(vm);
            auto* previous = vm.cloopStack().currentStackPointer();
            vm.cloopStack().setCurrentStackPointer(reinterpret_cast<Register*>(calleeFrame));
            vm.topCallFrame = calleeFrame;
            JSValue result = JSValue::decode(cache->hostFunction(function->realm(), calleeFrame));
            vm.cloopStack().setCurrentStackPointer(previous);
            vm.topCallFrame = callFrame;
            if (scope.exception()) [[unlikely]]
                return encodeResult(exceptionInstructions(), callFrame);
            if constexpr (requires { bytecode.m_dst; })
                callFrame->uncheckedR(bytecode.m_dst) = result;
            return encodeResult(pc, callFrame);
        }
        if (cached && cache->function) {
            callFrame->setCurrentVPC(pc);
            calleeFrame->setCallerFrame(callFrame);
            calleeFrame->setReturnPC(nullptr);
            calleeFrame->setCodeBlock(cache->codeBlock);
            calleeFrame->uncheckedR(VirtualRegister(CallFrameSlot::callee)) = callee;
            calleeFrame->setArgumentCountIncludingThis(argumentCount);
            for (int local = CodeBlock::llintBaselineCalleeSaveSpaceAsVirtualRegisters(); local < static_cast<int>(cache->numVars); ++local)
                calleeFrame->uncheckedR(virtualRegisterForLocal(local)) = jsUndefined();
            vm.writeBarrier(cache->codeBlock);
            calleeFrame->uncheckedR(cache->scopeRegister) = function->scope();
            auto* previous = vm.cloopStack().currentStackPointer();
            vm.cloopStack().setCurrentStackPointer(top);
            auto status = runCompiled(cache->function, calleeFrame, 0);
            if (status == tailCallStatus)
                status = finishTailCall(calleeFrame);
            vm.cloopStack().setCurrentStackPointer(previous);
            vm.topCallFrame = callFrame;
            if (status)
                return encodeResult(exceptionInstructions(), callFrame);
            if constexpr (requires { bytecode.m_dst; })
                callFrame->uncheckedR(bytecode.m_dst) = calleeFrame->uncheckedR(virtualRegisterForArgumentIncludingThis(0)).jsValue();
            return encodeResult(pc, callFrame);
        }
    }

    SlowPathFrameTracer tracer(vm, callFrame);
    callFrame->setCurrentVPC(pc);
    auto scope = DECLARE_THROW_SCOPE(vm);
    JSValue result = callInFrame<isConstruct>(vm, callFrame->codeBlock()->globalObject(), scope, callFrame, calleeFrame, callee, argumentCount);
    if (scope.exception()) [[unlikely]]
        return encodeResult(exceptionInstructions(), callFrame);
    if constexpr (requires { bytecode.m_dst; })
        callFrame->uncheckedR(bytecode.m_dst) = result;
    return encodeResult(pc, callFrame);
}

// The tail call a compiled function returned at (tailCallStatus), for its compiled caller, like the
// interpreter's op_tail_call and op_tail_call_varargs: the callee and its arguments in a frame
// below the function's registers, checked to be callable while the function is still on the stack,
// then the frame moves into the function's place (prepareForTailCall: it ends where the function's
// arguments ended) and the callee is called from the function's caller, which finds the result in
// the `this` slot of the function's frame. Runs with the stack pointer below the function's
// registers; counts as a level of nesting, so a chain of tail calls stays within the depth of
// compiled code (beyond it the interpreter makes them). Returns 0, or 1 after an exception.
int32_t finishTailCall(CallFrame* frame)
{
    CodeBlock* codeBlock = frame->codeBlock();
    VM& vm = codeBlock->vm();
    JSGlobalObject* globalObject = codeBlock->globalObject();
    CallFrame* caller = frame->callerFrame();
    const JSInstruction* pc = frame->currentVPC();
    SlowPathFrameTracer tracer(vm, frame);
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto* previous = vm.cloopStack().currentStackPointer();
    auto exception = [&] {
        vm.cloopStack().setCurrentStackPointer(previous);
        return 1;
    };

    CallFrame* calleeFrame;
    unsigned argumentCount;
    VirtualRegister calleeRegister;
    if (pc->is<OpTailCall>()) {
        auto bytecode = pc->as<OpTailCall>();
        calleeFrame = frame - bytecode.m_argv;
        argumentCount = bytecode.m_argc;
        calleeRegister = bytecode.m_callee;
    } else {
        auto bytecode = pc->as<OpTailCallVarargs>();
        JSValue source = frame->r(bytecode.m_arguments).jsValue();
        unsigned usedSlots = -bytecode.m_firstFree.offset();
        unsigned length = sizeFrameForVarargs(globalObject, frame, vm, source, usedSlots, bytecode.m_firstVarArg);
        if (scope.exception())
            return exception();
        calleeFrame = calleeFrameForVarargs(frame, usedSlots, length + 1);
        vm.cloopStack().setCurrentStackPointer(reinterpret_cast<Register*>(calleeFrame));
        setupVarargsFrameAndSetThis(globalObject, frame, calleeFrame, frame->r(bytecode.m_thisValue).jsValue(), source, bytecode.m_firstVarArg, length);
        if (scope.exception())
            return exception();
        argumentCount = length + 1;
        calleeRegister = bytecode.m_callee;
    }
    JSValue callee = frame->r(calleeRegister).jsValue();
    if (!callee.isCell() || callee.asCell()->type() != JSFunctionType) {
        if (JSC::getCallData(callee).type == CallData::Type::None) {
            throwException(globalObject, scope, createNotAFunctionError(globalObject, callee));
            return exception();
        }
    }

    unsigned alignment = stackAlignmentRegisters();
    unsigned frameSize = WTF::roundUpToMultipleOf(alignment, CallFrame::headerSizeInRegisters + std::max<unsigned>(frame->argumentCountIncludingThis(), codeBlock->numParameters()));
    unsigned calleeFrameSize = WTF::roundUpToMultipleOf(alignment, CallFrame::headerSizeInRegisters + argumentCount);
    auto* tailFrame = reinterpret_cast<CallFrame*>(reinterpret_cast<Register*>(frame) + frameSize - calleeFrameSize);
    memmove(&tailFrame->uncheckedR(virtualRegisterForArgumentIncludingThis(0)), &calleeFrame->uncheckedR(virtualRegisterForArgumentIncludingThis(0)), argumentCount * sizeof(Register));

    vm.topCallFrame = caller;
    ++depth;
    JSValue result = callInFrame<false>(vm, globalObject, scope, caller, tailFrame, callee, argumentCount);
    --depth;
    vm.cloopStack().setCurrentStackPointer(previous);
    vm.topCallFrame = caller;
    if (scope.exception())
        return 1;
    frame->uncheckedR(virtualRegisterForArgumentIncludingThis(0)) = result;
    return 0;
}

// finishTailCall for the function of emitCompiledCall, with the signature of a slow path
UGPRPair tailCallFromCompiledCode(CallFrame* frame, const JSInstruction*)
{
    return encodeResult(finishTailCall(frame) ? exceptionInstructions() : returnInstruction(), frame);
}

// A host function in the frame that a tail call moved into place (emitCompiledCallFunction), called
// like callFromCompiledCode calls one; the result in the frame's `this` slot
UGPRPair hostTailCallFromCompiledCode(CallFrame* frame, const JSInstruction*)
{
    auto* function = uncheckedDowncast<JSFunction>(frame->jsCallee());
    VM& vm = function->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    CallFrame* caller = frame->callerFrame();
    // The stack check reads the top frame: the tail call's frame, the caller's frame it replaced
    // may be overwritten (its code block slot by this frame's header)
    vm.topCallFrame = frame;
    if (!vm.isSafeToRecurseSoft()) [[unlikely]] {
        // Through JSC's generic call, which throws the RangeError
        JSValue result = callInFrame<false>(vm, caller->codeBlock()->globalObject(), scope, caller, frame, function, frame->argumentCountIncludingThis());
        if (scope.exception())
            return encodeResult(exceptionInstructions(), frame);
        frame->uncheckedR(virtualRegisterForArgumentIncludingThis(0)) = result;
        return encodeResult(returnInstruction(), frame);
    }
    auto* previous = vm.cloopStack().currentStackPointer();
    vm.cloopStack().setCurrentStackPointer(reinterpret_cast<Register*>(frame));
    vm.topCallFrame = frame;
    auto hostFunction = uncheckedDowncast<NativeExecutable>(function->executable())->function();
    JSValue result = JSValue::decode(hostFunction(function->realm(), frame));
    vm.cloopStack().setCurrentStackPointer(previous);
    vm.topCallFrame = caller;
    if (scope.exception()) [[unlikely]]
        return encodeResult(exceptionInstructions(), frame);
    frame->uncheckedR(virtualRegisterForArgumentIncludingThis(0)) = result;
    return encodeResult(returnInstruction(), frame);
}

// op_call_varargs, op_construct_varargs, op_super_construct_varargs
// (f.apply(this, arguments), new F(...args)): like the interpreter, a frame below the caller's
// registers in use with the arguments of the array-like (the stack pointer covers it while they
// load), then the call in that frame
template<typename Bytecode>
UGPRPair callVarargsFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc)
{
    constexpr bool isConstruct = std::is_same_v<Bytecode, OpConstructVarargs> || std::is_same_v<Bytecode, OpSuperConstructVarargs>;
    auto bytecode = pc->as<Bytecode>();
    CodeBlock* codeBlock = callFrame->codeBlock();
    VM& vm = codeBlock->vm();
    JSGlobalObject* globalObject = codeBlock->globalObject();
    SlowPathFrameTracer tracer(vm, callFrame);
    callFrame->setCurrentVPC(pc);
    auto scope = DECLARE_THROW_SCOPE(vm);

    JSValue source = callFrame->r(bytecode.m_arguments).jsValue();
    unsigned usedSlots = -bytecode.m_firstFree.offset();
    unsigned length = sizeFrameForVarargs(globalObject, callFrame, vm, source, usedSlots, bytecode.m_firstVarArg);
    if (scope.exception())
        return encodeResult(exceptionInstructions(), callFrame);
    CallFrame* calleeFrame = calleeFrameForVarargs(callFrame, usedSlots, length + 1);
    auto* previous = vm.cloopStack().currentStackPointer();
    vm.cloopStack().setCurrentStackPointer(reinterpret_cast<Register*>(calleeFrame));
    setupVarargsFrameAndSetThis(globalObject, callFrame, calleeFrame, callFrame->r(bytecode.m_thisValue).jsValue(), source, bytecode.m_firstVarArg, length);
    JSValue result;
    if (!scope.exception())
        result = callInFrame<isConstruct>(vm, globalObject, scope, callFrame, calleeFrame, callFrame->r(bytecode.m_callee).jsValue(), length + 1);
    vm.cloopStack().setCurrentStackPointer(previous);
    if (scope.exception())
        return encodeResult(exceptionInstructions(), callFrame);
    callFrame->uncheckedR(bytecode.m_dst) = result;
    return encodeResult(pc, callFrame);
}

// op_iterator_open, op_iterator_next (for of): the interpreter's fast modes (arrays, maps, sets,
// strings) through its slow paths, else the iteration protocol through JSC's generic call
using IteratorFastPath = UGPRPair (*)(CallFrame*, const JSInstruction*);

IteratorFastPath byWidth(const JSInstruction* pc, IteratorFastPath narrow, IteratorFastPath wide16, IteratorFastPath wide32)
{
    switch (pc->width()) {
    case OpcodeSize::Narrow: return narrow;
    case OpcodeSize::Wide16: return wide16;
    case OpcodeSize::Wide32: return wide32;
    }
    RELEASE_ASSERT_NOT_REACHED();
}

// The iteration mode of an iterator fast path's result, or nullopt after an exception
std::optional<IterationMode> iterationMode(UGPRPair result)
{
    const void* next;
    const void* mode;
    decodeResult(result, next, mode);
    if (!next || next == exceptionInstructions())
        return std::nullopt;
    return static_cast<IterationMode>(reinterpret_cast<uintptr_t>(mode));
}

UGPRPair iteratorOpenFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc)
{
    auto bytecode = pc->as<OpIteratorOpen>();
    CodeBlock* codeBlock = callFrame->codeBlock();
    VM& vm = codeBlock->vm();
    JSGlobalObject* globalObject = codeBlock->globalObject();
    auto exception = [&] { return encodeResult(exceptionInstructions(), callFrame); };
    auto mode = iterationMode(byWidth(pc, iterator_open_try_fast_narrow, iterator_open_try_fast_wide16, iterator_open_try_fast_wide32)(callFrame, pc));
    if (!mode)
        return exception();
    if (*mode != IterationMode::Generic)
        return encodeResult(pc, callFrame);

    SlowPathFrameTracer tracer(vm, callFrame);
    callFrame->setCurrentVPC(pc);
    auto scope = DECLARE_THROW_SCOPE(vm);
    JSValue symbolIterator = callFrame->r(bytecode.m_symbolIterator).jsValue();
    JSValue iterable = callFrame->r(bytecode.m_iterable).jsValue();
    auto callData = JSC::getCallData(symbolIterator);
    if (callData.type == CallData::Type::None) {
        throwException(globalObject, scope, createNotAFunctionError(globalObject, symbolIterator));
        return exception();
    }
    JSValue iterator = JSC::call(globalObject, symbolIterator, callData, iterable, ArgList());
    if (scope.exception())
        return exception();
    if (!iterator.isObject()) {
        throwException(globalObject, scope, createTypeError(globalObject, "Iterator result interface is not an object."_s));
        return exception();
    }
    callFrame->uncheckedR(bytecode.m_iterator) = iterator;
    JSValue next = iterator.get(globalObject, vm.propertyNames->next);
    if (scope.exception())
        return exception();
    callFrame->uncheckedR(bytecode.m_next) = next;
    return encodeResult(pc, callFrame);
}

UGPRPair iteratorNextFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc)
{
    auto bytecode = pc->as<OpIteratorNext>();
    CodeBlock* codeBlock = callFrame->codeBlock();
    VM& vm = codeBlock->vm();
    JSGlobalObject* globalObject = codeBlock->globalObject();
    auto exception = [&] { return encodeResult(exceptionInstructions(), callFrame); };
    JSValue next = callFrame->r(bytecode.m_next).jsValue();
    if (next.isCell() && next.asCell()->type() == SentinelType) {
        if (!iterationMode(byWidth(pc, iterator_next_try_fast_narrow, iterator_next_try_fast_wide16, iterator_next_try_fast_wide32)(callFrame, pc)))
            return exception();
        return encodeResult(pc, callFrame);
    }

    SlowPathFrameTracer tracer(vm, callFrame);
    callFrame->setCurrentVPC(pc);
    auto scope = DECLARE_THROW_SCOPE(vm);
    JSValue iterator = callFrame->r(bytecode.m_iterator).jsValue();
    auto callData = JSC::getCallData(next);
    if (callData.type == CallData::Type::None) {
        throwException(globalObject, scope, createNotAFunctionError(globalObject, next));
        return exception();
    }
    JSValue result = JSC::call(globalObject, next, callData, iterator, ArgList());
    if (scope.exception())
        return exception();
    if (!result.isObject()) {
        throwException(globalObject, scope, createTypeError(globalObject, "Iterator result interface is not an object."_s));
        return exception();
    }
    JSValue done = result.get(globalObject, vm.propertyNames->done);
    if (scope.exception())
        return exception();
    callFrame->uncheckedR(bytecode.m_done) = done;
    if (!done.toBoolean(globalObject)) {
        JSValue value = result.get(globalObject, vm.propertyNames->value);
        if (scope.exception())
            return exception();
        callFrame->uncheckedR(bytecode.m_value) = value;
    }
    return encodeResult(pc, callFrame);
}

// Reads and writes with a string or symbol key (o[key], an obfuscated VM's handlers for every
// property access of its program) go through JSC's megamorphic cache of the VM, like in JSC's own
// JITs: entries by structure and key, for an own or prototype data property, its absence, a
// replacement and a transition without a new butterfly. Its epoch moves at every GC and every
// change of a prototype chain (VM::invalidateStructureChainIntegrity), which empties it. Compiled
// code looks it up in WASM (emitKeyedLoadFunction, emitKeyedStoreFunction), these fill it.

// Names JSC's megamorphic caches take (canUseMegamorphicGetById and canUseMegamorphicPutById of
// InlineCacheCompiler.h, which needs ENABLE(JIT)): no index, and for reads none of the names that
// functions, arrays and strings answer themselves; a typed array's `length` is its prototype's
// getter like any other
bool keyedReadIsCacheable(VM& vm, JSObject* base, UniquedStringImpl* uid)
{
    if (uid == vm.propertyNames->length.impl())
        return isTypedView(base->type());
    return !parseIndex(PropertyName(uid)) && uid != vm.propertyNames->name.impl()
        && uid != vm.propertyNames->prototype.impl() && uid != vm.propertyNames->underscoreProto.impl();
}

bool keyedWriteIsCacheable(VM& vm, UniquedStringImpl* uid)
{
    return !parseIndex(PropertyName(uid)) && uid != vm.propertyNames->underscoreProto.impl();
}

template<typename Entry>
Entry* megamorphicEntry(MegamorphicCache& cache, ptrdiff_t entriesOffset, uint32_t index)
{
    return reinterpret_cast<Entry*>(reinterpret_cast<uint8_t*>(&cache) + entriesOffset) + index;
}

uint16_t megamorphicEpoch(MegamorphicCache& cache)
{
    return *reinterpret_cast<uint16_t*>(reinterpret_cast<uint8_t*>(&cache) + MegamorphicCache::offsetOfEpoch());
}

// The current load entry of the structure and key, or null (the lookup of JSC's JITs, which
// read the cache at its offsets too)
MegamorphicCache::LoadEntry* findLoadEntry(MegamorphicCache& cache, StructureID structureID, UniquedStringImpl* uid)
{
    using Entry = MegamorphicCache::LoadEntry;
    uint16_t epoch = megamorphicEpoch(cache);
    auto* entry = megamorphicEntry<Entry>(cache, MegamorphicCache::offsetOfLoadCachePrimaryEntries(), MegamorphicCache::primaryHash(structureID, uid) & MegamorphicCache::loadCachePrimaryMask);
    if (entry->m_structureID == structureID && entry->m_uid.get() == uid)
        return entry->m_epoch == epoch ? entry : nullptr;
    entry = megamorphicEntry<Entry>(cache, MegamorphicCache::offsetOfLoadCacheSecondaryEntries(), MegamorphicCache::secondaryHash(structureID, uid) & MegamorphicCache::loadCacheSecondaryMask);
    if (entry->m_structureID == structureID && entry->m_uid.get() == uid && entry->m_epoch == epoch)
        return entry;
    return nullptr;
}

GetterSetter* asGetterSetter(JSValue value)
{
    return value.isCell() && value.asCell()->type() == GetterSetterType ? uncheckedDowncast<GetterSetter>(value.asCell()) : nullptr;
}

// A getter's call from compiled code, `this` its only argument: in a frame above the caller's
// registers, so a compiled getter runs directly and a host getter (a typed array's `length`) like
// the interpreter calls host functions (callInFrame). GetterSetter::callGetter made a VM entry of
// JSC's generic call for each, about 200 ns in the jsc shell.
JSValue callGetterFromCompiledCode(VM& vm, JSGlobalObject* globalObject, ThrowScope& scope, CallFrame* callFrame, GetterSetter* getterSetter, JSValue thisValue)
{
    unsigned frameSize = callFrame->codeBlock()->frameRegisterCount() + WTF::roundUpToMultipleOf(stackAlignmentRegisters(), static_cast<unsigned>(CallFrame::headerSizeInRegisters) + 1);
    CallFrame* calleeFrame = callFrame - frameSize;
    if (!vm.cloopStack().ensureCapacityFor(reinterpret_cast<Register*>(calleeFrame))) [[unlikely]]
        RELEASE_AND_RETURN(scope, getterSetter->callGetter(globalObject, thisValue));
    calleeFrame->uncheckedR(virtualRegisterForArgumentIncludingThis(0)) = thisValue;
    RELEASE_AND_RETURN(scope, callInFrame<false>(vm, globalObject, scope, callFrame, calleeFrame, getterSetter->getter(), 1));
}

// A read through a current entry of the megamorphic cache: the property's value, its getter's
// result, or undefined for an absent one; nullopt without an entry. Empty after an exception.
std::optional<JSValue> readMegamorphicEntry(VM& vm, JSGlobalObject* globalObject, ThrowScope& scope, CallFrame* callFrame, JSObject* object, UniquedStringImpl* uid)
{
    auto* entry = findLoadEntry(vm.ensureMegamorphicCache(), object->structureID(), uid);
    if (!entry)
        return std::nullopt;
    JSCell* holder = entry->m_holder;
    if (!holder)
        return jsUndefined();
    JSValue value = asObject(holder == JSCell::seenMultipleCalleeObjects() ? object : holder)->getDirect(entry->m_offset);
    if (auto* getterSetter = asGetterSetter(value))
        return callGetterFromCompiledCode(vm, globalObject, scope, callFrame, getterSetter, object);
    return value;
}

enum class MegamorphicWalk : uint8_t { Get, CacheGetters };

// JSC's megamorphic read (getByValMegamorphic of JITOperations.cpp, which needs ENABLE(JIT)): the
// prototype chain walked like a get, and an own or prototype data property, a getter or the
// property's absence cached; a getter runs in a frame of compiled code. CacheGetters only caches
// a getter and reads nothing (an object that answers by its own lookup ends the walk); returns
// whether it did.
JSValue getMegamorphic(VM& vm, JSGlobalObject* globalObject, CallFrame* callFrame, JSObject* baseObject, UniquedStringImpl* uid, MegamorphicWalk walk = MegamorphicWalk::Get)
{
    auto scope = DECLARE_THROW_SCOPE(vm);
    PropertySlot slot(baseObject, PropertySlot::InternalMethodType::Get);
    JSObject* object = baseObject;
    bool cacheable = true;
    bool getOnly = walk == MegamorphicWalk::Get;
    while (true) {
        // Typed arrays look up indexes and numeric strings themselves, other names like objects
        bool ownLookup = TypeInfo::overridesGetOwnPropertySlot(object->inlineTypeFlags()) && object->type() != ArrayType && object->type() != JSFunctionType && object != globalObject->arrayPrototype()
            && (!isTypedView(object->type()) || isCanonicalNumericIndexString(uid));
        if (ownLookup) [[unlikely]] {
            if (!getOnly)
                return jsBoolean(false);
            bool found = object->getNonIndexPropertySlot(globalObject, uid, slot);
            RETURN_IF_EXCEPTION(scope, { });
            if (found)
                RELEASE_AND_RETURN(scope, slot.getValue(globalObject, uid));
            return jsUndefined();
        }
        Structure* structure = object->structure();
        bool found = object->getOwnNonIndexPropertySlot(vm, structure, uid, slot);
        // Static property tables may have transitioned it
        structure = object->structure();
        if (!structure->propertyAccessesAreCacheable())
            cacheable = false;
        if (found) {
            bool getter = slot.isCacheableGetter();
            bool cached = cacheable && (getter || (getOnly && slot.isCacheableValue())) && slot.cachedOffset() <= MegamorphicCache::maxOffset && (slot.slotBase() == baseObject || !baseObject->structure()->isDictionary());
            if (cached)
                vm.ensureMegamorphicCache().initAsHit(baseObject->structureID(), uid, slot.slotBase(), slot.cachedOffset(), slot.slotBase() == baseObject);
            if (!getOnly)
                return jsBoolean(cached && getter);
            if (getter)
                RELEASE_AND_RETURN(scope, callGetterFromCompiledCode(vm, globalObject, scope, callFrame, slot.getterSetter(), baseObject));
            RELEASE_AND_RETURN(scope, slot.getValue(globalObject, uid));
        }
        if (!structure->propertyAccessesAreCacheableForAbsence())
            cacheable = false;
        cacheable &= structure->hasMonoProto();
        JSValue prototype = object->getPrototypeDirect();
        if (!prototype.isObject()) {
            if (!getOnly)
                return jsBoolean(false);
            if (cacheable && !baseObject->structure()->isDictionary())
                vm.ensureMegamorphicCache().initAsMiss(baseObject->structureID(), uid);
            return jsUndefined();
        }
        object = asObject(prototype);
    }
}

// op_get_by_val after the fast paths missed: a string or symbol key of an object through the
// megamorphic cache (a string not an atom yet becomes the atom of its text, so the next read with
// it finds the entry in WASM), everything else the interpreter's slow path
UGPRPair getByValFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc)
{
    auto bytecode = pc->as<OpGetByVal>();
    JSValue base = callFrame->r(bytecode.m_base).jsValue();
    JSValue subscript = callFrame->r(bytecode.m_property).jsValue();
    if (!base.isObject() || !(subscript.isString() || subscript.isSymbol()))
        return llint_slow_path_get_by_val(callFrame, pc);
    CodeBlock* codeBlock = callFrame->codeBlock();
    VM& vm = codeBlock->vm();
    JSGlobalObject* globalObject = codeBlock->globalObject();
    SlowPathFrameTracer tracer(vm, callFrame);
    callFrame->setCurrentVPC(pc);
    {
        auto scope = DECLARE_THROW_SCOPE(vm);
        // A rope keeps no reference to the atom of its text, and a getter may run
        RefPtr<UniquedStringImpl> key;
        if (subscript.isSymbol())
            key = &asSymbol(subscript)->uid();
        else {
            key = asString(subscript)->toExistingAtomString(globalObject).data;
            if (scope.exception()) [[unlikely]]
                return encodeResult(exceptionInstructions(), callFrame);
        }
        UniquedStringImpl* uid = key.get();
        JSObject* object = asObject(base);
        if (uid && keyedReadIsCacheable(vm, object, uid)) {
            JSValue result;
            if (auto value = readMegamorphicEntry(vm, globalObject, scope, callFrame, object, uid))
                result = *value;
            else
                result = getMegamorphic(vm, globalObject, callFrame, object, uid);
            if (scope.exception()) [[unlikely]]
                return encodeResult(exceptionInstructions(), callFrame);
            callFrame->uncheckedR(bytecode.m_dst) = result;
            return encodeResult(pc, callFrame);
        }
    }
    return llint_slow_path_get_by_val(callFrame, pc);
}

// Whether the interpreter's cache of a get_by_id (or get_length) took the structure
bool interpreterCacheHas(const GetByIdModeMetadata& metadata, StructureID structureID)
{
    switch (metadata.mode) {
    case GetByIdMode::Default: return metadata.defaultMode.structureID == structureID || metadata.defaultMode.secondStructureID == structureID;
    case GetByIdMode::ProtoLoad: return metadata.protoLoadMode.structureID == structureID;
    case GetByIdMode::Unset: return metadata.unsetMode.structureID == structureID;
    case GetByIdMode::ArrayLength: return true;
    }
    return false;
}

// op_get_by_id and op_get_length after the inline caches missed. The interpreter's caches take
// only data properties: a getter (a class's accessor, a typed array's `length`) is cached in the
// megamorphic cache after the interpreter's slow path read it, and called from there in a frame
// of compiled code. A site whose misses found no getter several times stops looking for one.
// Then the interpreter's slow path, and the structure it cached also into the property cache of
// a get_by_id (more own properties than the interpreter's cache holds).
template<typename Bytecode>
UGPRPair getByIdFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc, PropertyCache* cache)
{
    constexpr bool isGetLength = std::is_same_v<Bytecode, OpGetLength>;
    constexpr SlowPath slowPath = isGetLength ? llint_slow_path_get_length : llint_slow_path_get_by_id;
    auto bytecode = pc->as<Bytecode>();
    JSValue base = callFrame->r(bytecode.m_base).jsValue();
    if (!base.isObject())
        return slowPath(callFrame, pc);
    CodeBlock* codeBlock = callFrame->codeBlock();
    VM& vm = codeBlock->vm();
    auto* object = asObject(base);
    auto& space = vm.heap.objectSpace();
    if constexpr (!isGetLength) {
        if (cache->markingVersion == space.markingVersion() && cache->edenVersion == space.edenVersion()) {
            for (unsigned i = 0; i < PropertyCache::size; ++i) {
                if (cache->structures[i] == object->structureID()) {
                    callFrame->uncheckedR(bytecode.m_dst) = object->getDirect(cache->offsets[i]);
                    return encodeResult(pc, callFrame);
                }
            }
        }
    }
    UniquedStringImpl* uid = vm.propertyNames->length.impl();
    if constexpr (!isGetLength)
        uid = codeBlock->identifier(bytecode.m_property).impl();
    bool getters = keyedReadIsCacheable(vm, object, uid) && cache->getterMisses < PropertyCache::getterMissesBeforeGivingUp;
    if (getters) {
        auto* entry = findLoadEntry(vm.ensureMegamorphicCache(), object->structureID(), uid);
        JSCell* holder = entry ? entry->m_holder : nullptr;
        if (auto* getterSetter = holder ? asGetterSetter(asObject(holder == JSCell::seenMultipleCalleeObjects() ? object : holder)->getDirect(entry->m_offset)) : nullptr) {
            JSGlobalObject* globalObject = codeBlock->globalObject();
            SlowPathFrameTracer tracer(vm, callFrame);
            callFrame->setCurrentVPC(pc);
            auto scope = DECLARE_THROW_SCOPE(vm);
            JSValue result = callGetterFromCompiledCode(vm, globalObject, scope, callFrame, getterSetter, object);
            if (scope.exception()) [[unlikely]]
                return encodeResult(exceptionInstructions(), callFrame);
            callFrame->uncheckedR(bytecode.m_dst) = result;
            return encodeResult(pc, callFrame);
        }
    }
    StructureID structureID = object->structureID();
    auto result = slowPath(callFrame, pc);
    auto& metadata = pc->as<Bytecode>().metadata(codeBlock).m_modeMetadata;
    if (getters && !interpreterCacheHas(metadata, structureID) && !vm.exceptionForInspection()) {
        if (!getMegamorphic(vm, codeBlock->globalObject(), callFrame, object, uid, MegamorphicWalk::CacheGetters).asBoolean())
            ++cache->getterMisses;
    }
    if constexpr (!isGetLength) {
        if (metadata.mode != GetByIdMode::Default || !metadata.defaultMode.structureID)
            return result;
        if (cache->markingVersion != space.markingVersion() || cache->edenVersion != space.edenVersion()) {
            uint8_t getterMisses = cache->getterMisses;
            *cache = { };
            cache->markingVersion = space.markingVersion();
            cache->edenVersion = space.edenVersion();
            cache->getterMisses = getterMisses;
        }
        for (auto structure : cache->structures) {
            if (structure == metadata.defaultMode.structureID)
                return result;
        }
        unsigned entry = cache->next++ % PropertyCache::size;
        cache->structures[entry] = metadata.defaultMode.structureID;
        cache->offsets[entry] = metadata.defaultMode.cachedOffset;
    }
    return result;
}

// op_put_by_val after the fast paths missed: a string or symbol key of an object like JSC's
// megamorphic write (putByValMegamorphic of JITOperations.cpp), which caches a replacement or a
// transition; everything else the interpreter's slow path
UGPRPair putByValFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc)
{
    auto bytecode = pc->as<OpPutByVal>();
    JSValue base = callFrame->r(bytecode.m_base).jsValue();
    JSValue subscript = callFrame->r(bytecode.m_property).jsValue();
    if (!base.isObject() || !(subscript.isString() || subscript.isSymbol()))
        return llint_slow_path_put_by_val(callFrame, pc);
    CodeBlock* codeBlock = callFrame->codeBlock();
    VM& vm = codeBlock->vm();
    JSGlobalObject* globalObject = codeBlock->globalObject();
    SlowPathFrameTracer tracer(vm, callFrame);
    callFrame->setCurrentVPC(pc);
    {
        auto scope = DECLARE_THROW_SCOPE(vm);
        Identifier name = subscript.toPropertyKey(globalObject);
        if (scope.exception()) [[unlikely]]
            return encodeResult(exceptionInstructions(), callFrame);
        UniquedStringImpl* uid = name.impl();
        JSObject* baseObject = asObject(base);
        Structure* structure = baseObject->structure();
        if (keyedWriteIsCacheable(vm, uid) && !structure->typeInfo().overridesPut()) {
            JSValue value = callFrame->r(bytecode.m_value).jsValue();
            PutPropertySlot slot(base, bytecode.m_ecmaMode.isStrict());
            auto done = [&] {
                return encodeResult(scope.exception() ? exceptionInstructions() : pc, callFrame);
            };
            for (JSObject* object = baseObject;;) {
                if (structure->hasReadOnlyOrGetterSetterPropertiesExcludingProto() || structure->typeInfo().overridesGetPrototype() || structure->typeInfo().overridesPut() || structure->hasPolyProto()) [[unlikely]] {
                    baseObject->putInlineSlow(globalObject, uid, value, slot);
                    return done();
                }
                JSValue prototype = object->getPrototypeDirect();
                if (prototype.isNull())
                    break;
                object = asObject(prototype);
                structure = object->structure();
            }
            Structure* oldStructure = baseObject->structure();
            baseObject->putInlineFast(globalObject, uid, value, slot);
            if (scope.exception() || !slot.isCacheablePut() || !oldStructure->propertyAccessesAreCacheable() || slot.cachedOffset() > MegamorphicCache::maxOffset)
                return done();
            Structure* newStructure = baseObject->structure();
            if (slot.type() == PutPropertySlot::ExistingProperty) {
                if (oldStructure == newStructure) {
                    oldStructure->didCachePropertyReplacement(vm, slot.cachedOffset());
                    vm.ensureMegamorphicCache().initAsReplace(StructureID::encode(oldStructure), uid, slot.cachedOffset());
                }
                return done();
            }
            // A new property: a dictionary's transition happens once per object
            if (oldStructure->isDictionary() || newStructure->isDictionary() || oldStructure->mayBePrototype() || newStructure->previousID() != oldStructure || !newStructure->propertyAccessesAreCacheable())
                return done();
            bool reallocating = newStructure->outOfLineCapacity() != oldStructure->outOfLineCapacity();
            vm.ensureMegamorphicCache().initAsTransition(StructureID::encode(oldStructure), StructureID::encode(newStructure), uid, slot.cachedOffset(), reallocating);
            return done();
        }
    }
    return llint_slow_path_put_by_val(callFrame, pc);
}

bool equalsNull(CodeBlock* codeBlock, JSValue value)
{
    return value.isUndefinedOrNull() || (value.isCell() && value.asCell()->structure()->masqueradesAsUndefined(codeBlock->globalObject()));
}

// op_eq_null, op_neq_null: == null, also for objects that masquerade as undefined
template<typename Bytecode>
UGPRPair equalsNullFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc)
{
    auto bytecode = pc->as<Bytecode>();
    bool isNull = equalsNull(callFrame->codeBlock(), callFrame->r(bytecode.m_operand).jsValue());
    callFrame->uncheckedR(bytecode.m_dst) = jsBoolean(std::is_same_v<Bytecode, OpEqNull> ? isNull : !isNull);
    return encodeResult(pc, callFrame);
}

// op_jeq_null, op_jneq_null of a cell that masquerades as undefined: the target or the next
// instruction
template<typename Bytecode>
UGPRPair jumpIfNullFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc)
{
    auto bytecode = pc->as<Bytecode>();
    CodeBlock* codeBlock = callFrame->codeBlock();
    bool isNull = equalsNull(codeBlock, callFrame->r(bytecode.m_value).jsValue());
    if (isNull != std::is_same_v<Bytecode, OpJeqNull>)
        return encodeResult(instructionAt(pc, pc->size()), callFrame);
    int label = bytecode.m_targetLabel.target();
    return encodeResult(label ? instructionAt(pc, label) : codeBlock->outOfLineJumpTarget(pc), callFrame);
}

// op_typeof_is_undefined of a cell that masquerades as undefined
UGPRPair typeofIsUndefinedFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc)
{
    auto bytecode = pc->as<OpTypeofIsUndefined>();
    JSValue value = callFrame->r(bytecode.m_operand).jsValue();
    callFrame->uncheckedR(bytecode.m_dst) = jsBoolean(value.isUndefined() || (value.isCell() && equalsNull(callFrame->codeBlock(), value)));
    return encodeResult(pc, callFrame);
}

// op_switch_imm, op_switch_char, op_switch_string: the target, through the interpreter's slow
// path for scrutinees it takes, else the default
template<typename Bytecode>
UGPRPair switchFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc)
{
    auto bytecode = pc->as<Bytecode>();
    JSValue scrutinee = callFrame->r(bytecode.m_scrutinee).jsValue();
    if constexpr (std::is_same_v<Bytecode, OpSwitchString>)
        return llint_slow_path_switch_string(callFrame, pc);
    else {
        if constexpr (std::is_same_v<Bytecode, OpSwitchImm>) {
            if (scrutinee.isNumber())
                return llint_slow_path_switch_imm(callFrame, pc);
        } else {
            if (scrutinee.isString() && asString(scrutinee)->length() == 1)
                return llint_slow_path_switch_char(callFrame, pc);
        }
        auto& table = callFrame->codeBlock()->unlinkedSwitchJumpTable(bytecode.m_tableIndex);
        return encodeResult(instructionAt(pc, table.defaultOffset()), callFrame);
    }
}

// put_by_id's cached transition: the prototypes still have the structures of the cache's chain,
// what the interpreter checks
int32_t structureChainMatches(Structure* structure, StructureChain* chain)
{
    StructureID* expected = chain->head();
    for (JSValue prototype = structure->storedPrototype(); prototype.isCell(); ++expected) {
        if (prototype.asCell()->structureID() != *expected)
            return 0;
        prototype = expected->decode()->storedPrototype();
    }
    return 1;
}

// An exception in a try of compiled code: whether its handler may take it (not a termination)
int32_t exceptionIsCatchable(CallFrame* callFrame, const JSInstruction*)
{
    VM& vm = callFrame->codeBlock()->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    Exception* exception = scope.exception();
    return exception && !vm.isTerminationException(exception);
}

// op_catch: the exception and its value into their registers, like the interpreter
UGPRPair catchFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc)
{
    auto bytecode = pc->as<OpCatch>();
    VM& vm = callFrame->codeBlock()->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    Exception* exception = scope.exception();
    if (!scope.tryClearException())
        return encodeResult(exceptionInstructions(), callFrame);
    callFrame->uncheckedR(bytecode.m_exception) = exception;
    callFrame->uncheckedR(bytecode.m_thrownValue) = exception->value();
    return encodeResult(pc, callFrame);
}

// What the out-of-line function of an instruction returns (Compiler::emitOutOfLineFunction): it was
// done, it jumped (a conditional jump), or an exception is pending
constexpr int32_t outOfLineDone = 0;
constexpr int32_t outOfLineJumped = 1;
constexpr int32_t outOfLineException = 2;

// The interpreter's slow path for an out-of-line function: its status instead of the next
// instruction (a value's slow path returns its own instruction, a jump's the target or the next one)
template<SlowPath slowPath, bool isJump>
UGPRPair outOfLineSlowPath(CallFrame* callFrame, const JSInstruction* pc)
{
    const void* next;
    const void* unused;
    decodeResult(slowPath(callFrame, pc), next, unused);
    int32_t status = outOfLineDone;
    if (next == exceptionInstructions())
        status = outOfLineException;
    else if (isJump && next != instructionAt(pc, pc->size()))
        status = outOfLineJumped;
    return makeUGPRPair(status, 0);
}

// The out-of-line slow path of an opcode that has an out-of-line function
SlowPath outOfLineSlowPathOf(OpcodeID opcode)
{
    switch (opcode) {
#define BL_JIT_VALUE(name, slowPath) case op_##name: return outOfLineSlowPath<slowPath, false>;
#define BL_JIT_JUMP(name) case op_##name: return outOfLineSlowPath<llint_slow_path_##name, true>;
    BL_JIT_VALUE(add, slow_path_add)
    BL_JIT_VALUE(sub, slow_path_sub)
    BL_JIT_VALUE(mul, slow_path_mul)
    BL_JIT_VALUE(div, slow_path_div)
    BL_JIT_VALUE(bitand, slow_path_bitand)
    BL_JIT_VALUE(bitor, slow_path_bitor)
    BL_JIT_VALUE(bitxor, slow_path_bitxor)
    BL_JIT_VALUE(lshift, slow_path_lshift)
    BL_JIT_VALUE(rshift, slow_path_rshift)
    BL_JIT_VALUE(urshift, slow_path_urshift)
    BL_JIT_VALUE(less, llint_slow_path_less)
    BL_JIT_VALUE(lesseq, llint_slow_path_lesseq)
    BL_JIT_VALUE(greater, llint_slow_path_greater)
    BL_JIT_VALUE(greatereq, llint_slow_path_greatereq)
    BL_JIT_VALUE(eq, slow_path_eq)
    BL_JIT_VALUE(neq, slow_path_neq)
    BL_JIT_VALUE(stricteq, slow_path_stricteq)
    BL_JIT_VALUE(nstricteq, slow_path_nstricteq)
    BL_JIT_JUMP(jless)
    BL_JIT_JUMP(jlesseq)
    BL_JIT_JUMP(jgreater)
    BL_JIT_JUMP(jgreatereq)
    BL_JIT_JUMP(jnless)
    BL_JIT_JUMP(jnlesseq)
    BL_JIT_JUMP(jngreater)
    BL_JIT_JUMP(jngreatereq)
    BL_JIT_JUMP(jeq)
    BL_JIT_JUMP(jneq)
    BL_JIT_JUMP(jstricteq)
    BL_JIT_JUMP(jnstricteq)
#undef BL_JIT_VALUE
#undef BL_JIT_JUMP
    default:
        RELEASE_ASSERT_NOT_REACHED();
    }
}

// ToBoolean of a value that compiled code does not decide itself (BigInts, objects that masquerade
// as undefined), which never throws
int32_t toBooleanFromCompiledCode(JSGlobalObject* globalObject, int32_t tag, int32_t payload)
{
    auto bits = static_cast<uint64_t>(static_cast<uint32_t>(tag)) << 32 | static_cast<uint32_t>(payload);
    return JSValue::decode(static_cast<EncodedJSValue>(bits)).toBoolean(globalObject);
}

// Larger CodeBlocks (whole bundles run once as one function) stay interpreted: their module would
// be about 20 times their bytecode, past V8's limit of a function and much memory to build
constexpr unsigned maximumBytecodeSize = 100000;
// Entries of a switch table that compiled code takes through a br_table
constexpr unsigned maximumInlineSwitchSize = 4096;

constexpr int32_t int32Tag = static_cast<int32_t>(JSValue::Int32Tag);
constexpr int32_t booleanTag = static_cast<int32_t>(JSValue::BooleanTag);
constexpr int32_t cellTag = static_cast<int32_t>(JSValue::CellTag);
constexpr int32_t emptyTag = static_cast<int32_t>(JSValue::EmptyValueTag);
constexpr int32_t lowestTag = static_cast<int32_t>(JSValue::LowestTag);

class Compiler {
public:
    explicit Compiler(CodeBlock* codeBlock)
        : m_codeBlock(codeBlock)
    {
    }

    std::optional<std::vector<uint8_t>> compile();
    OpcodeID unsupported() const { return m_unsupported; }
    bool tooLarge() const { return m_tooLarge; }
    size_t branchHints() const { return m_module.hintCount(); }
    // Blocks after loop hints, by bytecode offset
    OffsetMap takeLoops() { return WTF::move(m_loops); }
    Vector<std::unique_ptr<PropertyCache>> takePropertyCaches() { return WTF::move(m_propertyCaches); }

private:
    bool scan();
    // The first instruction it does not take, for the log
    OpcodeID m_unsupported { op_enter };
    bool m_tooLarge { false };
    void emitInstruction(const JSInstructionStream::Ref&, unsigned block);
    void emitTrapCheck(const JSInstructionStream::Ref&);

    unsigned targetOf(const JSInstructionStream::Ref& instruction, int label)
    {
        return instruction.offset() + (label ? label : m_codeBlock->outOfLineJumpOffset(instruction));
    }
    const JSInstruction* instructionPointer(unsigned offset) { return m_codeBlock->instructions().at(offset).ptr(); }
    // Bytecode offsets a switch can go to, its default first
    Vector<unsigned> switchTargets(const JSInstructionStream::Ref&);

    static constexpr uint32_t noLocal = UINT32_MAX;
    // An operand of an instruction as its fast paths see it: a register of the frame or a
    // constant, or in a function of the module that does the fast paths of all instructions of a
    // kind (emitFastPathFunction) locals with its tag and payload (an input) or with the address
    // of its register (the destination)
    struct Operand {
        Operand(VirtualRegister reg)
            : reg(reg)
        {
        }
        static Operand value(uint32_t tagLocal, uint32_t payloadLocal)
        {
            Operand operand { VirtualRegister() };
            operand.tag = tagLocal;
            operand.payload = payloadLocal;
            return operand;
        }
        static Operand at(uint32_t addressLocal)
        {
            Operand operand { VirtualRegister() };
            operand.address = addressLocal;
            return operand;
        }
        bool inLocals() const { return tag != noLocal; }
        bool isConstant() const { return !inLocals() && address == noLocal && reg.isConstant(); }
        VirtualRegister reg;
        uint32_t tag { noLocal };
        uint32_t payload { noLocal };
        uint32_t address { noLocal };
    };

    // Value of an operand: tag or payload, from the frame, the constant pool or locals
    void loadTag(const Operand&);
    void loadPayload(const Operand&);
    // Tag and payload into the locals
    void load(const Operand&, uint32_t tagLocal, uint32_t payloadLocal);
    void storeTagAndPayload(const Operand&, uint32_t tagLocal, uint32_t payloadLocal);
    void storeTag(const Operand&, int32_t tag, uint32_t payloadLocal);
    void storeInt32(const Operand& operand, uint32_t payloadLocal) { storeTag(operand, int32Tag, payloadLocal); }
    void storeBoolean(const Operand& operand, uint32_t payloadLocal) { storeTag(operand, booleanTag, payloadLocal); }
    void storeCell(const Operand& operand, uint32_t payloadLocal) { storeTag(operand, cellTag, payloadLocal); }
    void storeDouble(const Operand&, uint32_t doubleLocal);
    // The tag and the payload that `payload` pushes
    template<typename Payload> void storeTagWithPayload(const Operand& operand, int32_t tag, const Payload& payload)
    {
        address(operand);
        payload();
        m_body->i32Store(slot(operand) + PayloadOffset);
        address(operand);
        m_body->i32Const(tag);
        m_body->i32Store(slot(operand) + TagOffset);
    }
    void address(const Operand&);
    // Offset of a register from the base (0 for an address in a local)
    uint32_t slot(const Operand&) const;
    // Pushes the address of a register (the destination a fast path function writes)
    void registerAddress(VirtualRegister);
    // Pushes whether the tag in the local is a number's (int32 or double)
    void isNumberTag(uint32_t tagLocal);
    // Pushes a number operand as f64, its tag in the local
    void loadNumber(const Operand&, uint32_t tagLocal);
    // Pushes the JSType of the cell in the local
    void cellType(uint32_t cellLocal);
    // The write barrier of the cell in the local, like the interpreter's
    void writeBarrier(uint32_t cellLocal);
    // The interpreter's barrier on a store of `value` into `base`: when both are cells
    void writeBarrierOnOperands(const Operand& base, const Operand& value);
    // The same into a cell known now (the global object)
    void writeBarrierOnConstant(JSCell*, const Operand& value);

    // Calls a slow path of the interpreter for the instruction; leaves the returned instruction
    // pointer in m_next, and on an exception goes to the instruction's handler (a try around it)
    // or returns 1
    void callSlowPath(SlowPath, const JSInstructionStream::Ref&);
    // The same for a call: compiled callees in WASM (emitCompiledCall), the rest through
    // callFromCompiledCode or callVarargsFromCompiledCode; a tail call leaves the function
    // (emitTailCallExit)
    template<typename Bytecode> void emitCall(const JSInstructionStream::Ref&);
    void emitInlineHostCall(VirtualRegister callee, unsigned argv, VirtualRegister dst);
    void emitInlineHostCallFunction();
    void emitCompiledCall(const JSInstructionStream::Ref&, VirtualRegister callee, unsigned argc, unsigned argv, VirtualRegister dst, bool isConstruct);
    void emitCompiledCallFunction();
    void emitTailCallExit(const JSInstructionStream::Ref&);
    static constexpr int32_t compiledCallNotDone = 2;
    // Lookups of the VM's megamorphic cache for string keys (keyed reads and writes)
    void emitKeyedLoadFunction();
    void emitKeyedStoreFunction();
    // Functions of the module beside the compiled one: index of each, numbered in the order the
    // sites first need them (the module emits them in that order)
    enum class Helper : uint8_t { CompiledCall, KeyedLoad, KeyedStore, SlowPathCall, GetById, GetByVal, PutByVal, ResolveScope, GetFromScope, PutToScope, InlineHostCall, OutOfLine, ToBoolean, NewArray, NewArrayBuffer };
    // OutOfLine is one function per opcode
    uint32_t helper(Helper, OpcodeID = op_nop);
    void emitHelpers();
    Vector<std::pair<Helper, OpcodeID>> m_helpers;
    // A function of the module that does the fast paths of all instructions of a kind, emitted by
    // `emit` with the scratch locals of its own: returns m_next (1 when a fast path did it). One
    // copy for all sites instead of one per site keeps the compiled code small, which large
    // functions need: their code no longer fit the processor's instruction caches (#630).
    template<typename Emit> void emitFastPathFunction(std::span<const ValueType> parameters, const Emit&);
    void addScratchLocals();
    // (frame, instruction, slow path) -> the slow path's result: the call through the table once
    void emitSlowPathCallFunction();
    void emitGetByIdFunction();
    void emitGetByValFunction();
    void getByValFastPaths(const Operand& dst, const Operand& base, const Operand& property);
    void emitPutByValFunction();
    void putByValFastPaths(const Operand& base, const Operand& property, const Operand& value);
    void emitResolveScopeFunction();
    void emitGetFromScopeFunction();
    // The fast path of one resolve type: the scope's payload and the metadata's address in the
    // locals, fastPathDone() when it stored the destination. A global property's offset is inline
    // or out of line as `outOfLine` says, both when it has no value.
    void resolveScopeFastPath(ResolveType, uint32_t scopeLocal, uint32_t metadataLocal, const Operand& dst);
    void getFromScopeFastPath(ResolveType, uint32_t scopeLocal, uint32_t metadataLocal, const Operand& dst, std::optional<bool> outOfLine = std::nullopt);
    // Whether a site of the global resolve type gets its fast path inline
    static bool inlinesGlobalAccess(ResolveType);
    void emitPutToScopeFunction();
    void closureVariableAddress(const Operand& scope, const void* operand);
    // Pushes the address of the cache entry for the base's structure ID in `structureLocal` and
    // the key in `uidLocal`, or returns 0 from the helper function when neither table has a current
    // one (JSC's lookup: the primary table, then the secondary one)
    void findMegamorphicEntry(uint32_t structureLocal, uint32_t uidLocal, uint32_t hashShift, uint32_t primaryMask, ptrdiff_t primaryOffset, uint32_t secondaryShift, uint32_t secondaryMask, ptrdiff_t secondaryOffset, size_t entrySize, ptrdiff_t structureOffset, ptrdiff_t uidOffset, ptrdiff_t epochOffset);
    // The uid of a string key that is no rope into the local, else returns 0 from the helper
    void stringKeyUid(uint32_t keyLocal, uint32_t uidLocal);
    // After a helper's call: its result into m_next, an exception to the handler or out
    void checkException(const JSInstructionStream::Ref&);
    // There is an exception: to the instruction's handler or out
    void exceptionExit(const JSInstructionStream::Ref&);
    // Fast paths mark m_next when they did the instruction; the slow path does it otherwise
    void beginFastPaths();
    void fastPathDone();
    void endFastPaths(SlowPath, const JSInstructionStream::Ref&);
    // To the block of the bytecode offset, from any depth within the block's code
    void jumpTo(unsigned targetOffset, unsigned fromBlock);
    // Jumps when the slow path (just called) returned the target
    void jumpIfSlowPathReturned(unsigned targetOffset, unsigned fromBlock);

    // Out-of-line functions: what arithmetic, comparisons and equality do beyond two int32 (doubles,
    // ToInt32, cells) and their slow path, one function of the module per opcode for all its sites,
    // (frame, instruction, tag and payload of both operands[, destination address]) -> status
    // (outOfLineDone, outOfLineJumped, outOfLineException). The sites keep the int32 path inline:
    // with everything inline such an instruction was 200 to 270 bytes of WASM.
    void emitOutOfLineFunction(OpcodeID);
    // Calls the opcode's out-of-line function with the operands (their tags already in the locals)
    // and handles an exception; a jump's status (whether it jumps) stays on the stack
    void callOutOfLine(const JSInstructionStream::Ref&, VirtualRegister lhs, uint32_t lhsTag, VirtualRegister rhs, uint32_t rhsTag, std::optional<VirtualRegister> dst);
    // The tag of an operand into the local (nothing for a constant, whose tag is known), and back
    void tagInto(VirtualRegister, uint32_t tagLocal);
    void pushTag(VirtualRegister, uint32_t tagLocal);
    // Pushes whether both operands are int32, their tags in the locals of tagInto
    void bothInt32(VirtualRegister lhs, uint32_t lhsTag, VirtualRegister rhs, uint32_t rhsTag);
    // Jumps to the target when the value on the stack is not 0
    void jumpIf(unsigned targetOffset, unsigned fromBlock);
    template<typename Bytecode> void emitArithmetic(const JSInstructionStream::Ref&, uint8_t i64Op);
    void emitDivide(const JSInstructionStream::Ref&);
    // ToInt32 of a number register inline: pushes whether it converts, the int32 in `resultLocal`
    void toInt32(const Operand&, uint32_t tagLocal, uint32_t resultLocal, uint32_t doubleLocal);
    template<typename Bytecode> void emitBitOp(const JSInstructionStream::Ref&, uint8_t i32Op);
    template<typename Bytecode> void emitCompare(const JSInstructionStream::Ref&, unsigned block, uint8_t i32Op);
    template<typename Bytecode> void emitEquality(const JSInstructionStream::Ref&, unsigned block, bool negate);
    template<typename Bytecode> void emitConditionJump(const JSInstructionStream::Ref&, unsigned block, bool jumpIfTrue);
    template<typename Bytecode> void emitIncrement(const JSInstructionStream::Ref&, int32_t delta, SlowPath);
    void emitMod(const JSInstructionStream::Ref&);
    void emitNot(const JSInstructionStream::Ref&);
    // ToBoolean into m_c, and m_e whether it is known: booleans, int32, doubles, undefined, null,
    // strings and objects (not those that masquerade as undefined)
    void emitToBoolean(const Operand&);
    // (tag, payload) -> ToBoolean, what emitToBoolean does not know through C++
    void emitToBooleanFunction();
    // Pushes ToBoolean of the register (0 or not): booleans and int32 inline, the rest through the
    // module's function
    void toBoolean(VirtualRegister);
    // The characters of the string in the local, which is no rope or the substring of another
    // string, into the locals: address, length and the 8-bit flag (StringImpl::flagIs8Bit() or 0);
    // for another rope out of the innermost block. Uses m_g.
    void stringCharacters(uint32_t stringLocal, uint32_t dataLocal, uint32_t lengthLocal, uint32_t is8BitLocal);
    void emitNegate(const JSInstructionStream::Ref&);
    // dst = src when it is a number (`numbers`), any other non-cell (`immediates`) or a cell the
    // condition (pushing a boolean, the cell in m_a) takes; else the slow path
    template<typename CellCondition> void emitCopyIf(const JSInstructionStream::Ref&, VirtualRegister dst, VirtualRegister src, bool numbers, bool immediates, const CellCondition&, SlowPath);
    // dst = a boolean of the operand: `condition` pushes it from the tag in m_t1 and payload in m_a
    template<typename Condition> void emitIs(VirtualRegister dst, VirtualRegister operand, const Condition&);
    void emitToThis(const JSInstructionStream::Ref&);
    template<typename Bytecode> void emitGetById(const JSInstructionStream::Ref&);
    void emitGetByIdDirect(const JSInstructionStream::Ref&);
    void emitPutById(const JSInstructionStream::Ref&);
    void emitGetByVal(const JSInstructionStream::Ref&);
    // Whether the site's array profile saw only int32 and contiguous butterflies within bounds (for
    // writes none that is copy-on-write)
    bool profiledContiguousElements(ArrayProfile&, bool writes);
    void emitPutByVal(const JSInstructionStream::Ref&);
    template<typename Access> void typedArrayElement(uint32_t viewLocal, uint32_t indexLocal, const Access&);
    // Array literals without a call into C++ (emitNewArrayFunction, emitNewArrayBufferFunction)
    void emitNewArray(const JSInstructionStream::Ref&);
    void emitNewArrayFunction();
    void emitNewArrayBuffer(const JSInstructionStream::Ref&);
    void emitNewArrayBufferFunction();
    // Pushes the structure of the global object's arrays of the indexing type in the local (0
    // for other types), those of `types`; returns 0 from the helper while it has a bad time
    void arrayStructure(uint32_t typeLocal, std::span<const IndexingType> types);
    // Pushes the indexing type the profile at the address in the local selects, or 0 when its last
    // array changed its type (selectIndexingType then updates the profile, in C++)
    void profiledIndexingType(uint32_t profileLocal);
    // Allocates a cell of the allocator's size from its free list into the local without a call
    // into C++, else returns 0 from the helper; checkFreeCell only checks that there is one
    void checkFreeCell(LocalAllocator*, uint32_t allocatorLocal);
    void allocateCell(LocalAllocator*, uint32_t allocatorLocal, uint32_t cellLocal);
    // The header of a new array of the structure in the local, its butterfly in the local
    void initializeArray(uint32_t arrayLocal, uint32_t structureLocal, uint32_t butterflyLocal);
    void emitResolveScope(const JSInstructionStream::Ref&);
    void emitGetFromScope(const JSInstructionStream::Ref&);
    void emitPutToScope(const JSInstructionStream::Ref&);
    template<typename Bytecode> void emitJumpIfNull(const JSInstructionStream::Ref&, unsigned block);
    template<typename Bytecode> void emitSwitchSlowPath(const JSInstructionStream::Ref&, unsigned block);
    template<typename Bytecode> void emitSwitch(const JSInstructionStream::Ref&, unsigned block);
    template<typename Bytecode> void emitGenericJump(const JSInstructionStream::Ref&, unsigned block, SlowPath);
    // Address of a property at the offset in the local, of the object in the local: inline storage
    // or the butterfly's (through the address local, m_c by default)
    void propertyAddress(uint32_t objectLocal, uint32_t offsetLocal) { propertyAddress(objectLocal, offsetLocal, m_c); }
    void propertyAddress(uint32_t objectLocal, uint32_t offsetLocal, uint32_t addressLocal);
    // Loads the property into m_a (tag) and m_b (payload)
    void loadProperty(uint32_t objectLocal, uint32_t offsetLocal);

    CodeBlock* m_codeBlock;
    Module m_module;
    FunctionBody* m_body { nullptr };
    uint32_t m_slowPathType { 0 };
    uint32_t m_barrierType { 0 };
    uint32_t m_checkType { 0 };
    uint32_t m_callType { 0 };
    uint32_t m_toBooleanType { 0 };
    Vector<std::unique_ptr<PropertyCache>> m_propertyCaches;
    // Parameters: the frame and the block to start with
    static constexpr uint32_t cfr = 0;
    static constexpr uint32_t entry = 1;
    // cfr minus m_baseBias, below every local
    uint32_t m_base { 0 };
    uint32_t m_baseBias { 0 };
    uint32_t m_block { 0 }, m_a { 0 }, m_b { 0 }, m_c { 0 }, m_d { 0 }, m_e { 0 }, m_g { 0 }, m_t1 { 0 }, m_t2 { 0 }, m_next { 0 }, m_wide { 0 }, m_x { 0 }, m_y { 0 };
    // Loop iterations left before the function returns to be called again (runCompiled)
    uint32_t m_iterations { 0 };
    // Basic blocks: bytecode offset of each start, and the block of an offset
    Vector<unsigned> m_starts;
    OffsetMap m_blockAt;
    OffsetMap m_loops;
    unsigned m_blockCount { 0 };
    // The block being compiled and the depth of its code, for branches out of nested blocks
    unsigned m_currentBlock { 0 };
    uint32_t m_blockDepth { 0 };
};

// Registers are at negative offsets from the frame down to its locals: addressed from a base below
// them, so every access is one load or store with the register's offset as its immediate
void Compiler::address(const Operand& operand)
{
    m_body->localGet(operand.address != noLocal ? operand.address : m_base);
}

uint32_t Compiler::slot(const Operand& operand) const
{
    if (operand.address != noLocal)
        return 0;
    int offset = operand.reg.offset() * static_cast<int>(sizeof(Register)) + static_cast<int>(m_baseBias);
    RELEASE_ASSERT(offset >= 0);
    return offset;
}

void Compiler::registerAddress(VirtualRegister reg)
{
    m_body->localGet(m_base);
    m_body->i32Const(slot(reg));
    m_body->op(Op::I32Add);
}

void Compiler::loadTag(const Operand& operand)
{
    if (operand.inLocals()) {
        m_body->localGet(operand.tag);
        return;
    }
    if (operand.isConstant()) {
        m_body->i32Const(static_cast<int32_t>(m_codeBlock->getConstant(operand.reg).tag()));
        return;
    }
    address(operand);
    m_body->i32Load(slot(operand) + TagOffset);
}

void Compiler::loadPayload(const Operand& operand)
{
    if (operand.inLocals()) {
        m_body->localGet(operand.payload);
        return;
    }
    if (operand.isConstant()) {
        m_body->i32Const(m_codeBlock->getConstant(operand.reg).payload());
        return;
    }
    address(operand);
    m_body->i32Load(slot(operand) + PayloadOffset);
}

void Compiler::load(const Operand& operand, uint32_t tagLocal, uint32_t payloadLocal)
{
    loadTag(operand);
    m_body->localSet(tagLocal);
    loadPayload(operand);
    m_body->localSet(payloadLocal);
}

void Compiler::storeTagAndPayload(const Operand& operand, uint32_t tagLocal, uint32_t payloadLocal)
{
    address(operand);
    m_body->localGet(tagLocal);
    m_body->i32Store(slot(operand) + TagOffset);
    address(operand);
    m_body->localGet(payloadLocal);
    m_body->i32Store(slot(operand) + PayloadOffset);
}

void Compiler::storeTag(const Operand& operand, int32_t tag, uint32_t payloadLocal)
{
    address(operand);
    m_body->i32Const(tag);
    m_body->i32Store(slot(operand) + TagOffset);
    address(operand);
    m_body->localGet(payloadLocal);
    m_body->i32Store(slot(operand) + PayloadOffset);
}

// A double in the register's 8 bytes, as the interpreter stores them (not made int32)
void Compiler::storeDouble(const Operand& operand, uint32_t doubleLocal)
{
    address(operand);
    m_body->localGet(doubleLocal);
    m_body->f64Store(slot(operand));
}

void Compiler::isNumberTag(uint32_t tagLocal)
{
    m_body->localGet(tagLocal);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    m_body->localGet(tagLocal);
    m_body->i32Const(lowestTag);
    m_body->op(Op::I32LtU);
    m_body->op(Op::I32Or);
}

void Compiler::loadNumber(const Operand& operand, uint32_t tagLocal)
{
    if (operand.isConstant()) {
        JSValue value = m_codeBlock->getConstant(operand.reg);
        m_body->f64Const(value.isNumber() ? value.asNumber() : 0);
        return;
    }
    loadPayload(operand);
    m_body->op(Op::F64ConvertI32S);
    if (operand.inLocals()) {
        // The bits of a double: the tag is its high word
        m_body->localGet(operand.tag);
        m_body->op(Op::I64ExtendI32U);
        m_body->i64Const(32);
        m_body->op(Op::I64Shl);
        m_body->localGet(operand.payload);
        m_body->op(Op::I64ExtendI32U);
        m_body->op(Op::I64Or);
        m_body->op(Op::F64ReinterpretI64);
    } else {
        address(operand);
        m_body->f64Load(slot(operand));
    }
    m_body->localGet(tagLocal);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    m_body->select();
}

void Compiler::cellType(uint32_t cellLocal)
{
    m_body->localGet(cellLocal);
    m_body->i32Load8U(JSCell::typeInfoTypeOffset());
}

void Compiler::writeBarrier(uint32_t cellLocal)
{
    m_body->localGet(cellLocal);
    m_body->i32Load8U(JSCell::cellStateOffset());
    m_body->i32Const(blackThreshold);
    m_body->op(Op::I32LeU);
    m_body->ifThen();
    m_body->localGet(cfr);
    m_body->localGet(cellLocal);
    m_body->i32Const(reinterpret_cast<uintptr_t>(&llint_write_barrier_slow));
    m_body->callIndirect(m_barrierType);
    m_body->end();
}

void Compiler::writeBarrierOnOperands(const Operand& base, const Operand& value)
{
    loadTag(value);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    loadTag(base);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32And);
    m_body->ifThen();
    loadPayload(base);
    m_body->localSet(m_e);
    writeBarrier(m_e);
    m_body->end();
}

void Compiler::writeBarrierOnConstant(JSCell* cell, const Operand& value)
{
    loadTag(value);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    m_body->i32Const(reinterpret_cast<uintptr_t>(cell));
    m_body->localSet(m_e);
    writeBarrier(m_e);
    m_body->end();
}

void Compiler::callSlowPath(SlowPath slowPath, const JSInstructionStream::Ref& instruction)
{
    m_body->localGet(cfr);
    m_body->i32Const(reinterpret_cast<uintptr_t>(instruction.ptr()));
    m_body->i32Const(reinterpret_cast<uintptr_t>(slowPath));
    m_body->call(helper(Helper::SlowPathCall));
    checkException(instruction);
}

template<typename Bytecode>
void Compiler::emitCall(const JSInstructionStream::Ref& instruction)
{
    constexpr bool isVarargs = requires(Bytecode bytecode) { bytecode.m_firstVarArg; };
    constexpr bool isTailCall = std::is_same_v<Bytecode, OpTailCall> || std::is_same_v<Bytecode, OpTailCallVarargs>;
    // Math.imul has two arguments and `this`
    bool inlineHostCall = false;
    if constexpr (std::is_same_v<Bytecode, OpCall> || std::is_same_v<Bytecode, OpCallIgnoreResult> || std::is_same_v<Bytecode, OpTailCall>) {
        auto bytecode = instruction->as<Bytecode>();
        inlineHostCall = bytecode.m_argc == 3 && imulHostFunction(m_codeBlock->globalObject());
        if (inlineHostCall) {
            emitInlineHostCall(bytecode.m_callee, bytecode.m_argv, [&] {
                if constexpr (requires { bytecode.m_dst; })
                    return bytecode.m_dst;
                return VirtualRegister();
            }());
            m_body->localGet(m_next);
            m_body->op(Op::I32Eqz);
            m_body->ifThen();
        }
    }
    if constexpr (isTailCall)
        emitTailCallExit(instruction);
    else if constexpr (isVarargs)
        callSlowPath(callVarargsFromCompiledCode<Bytecode>, instruction);
    else {
        constexpr bool isConstruct = std::is_same_v<Bytecode, OpConstruct> || std::is_same_v<Bytecode, OpSuperConstruct>;
        auto bytecode = instruction->as<Bytecode>();
        VirtualRegister dst;
        if constexpr (requires { bytecode.m_dst; })
            dst = bytecode.m_dst;
        emitCompiledCall(instruction, bytecode.m_callee, bytecode.m_argc, bytecode.m_argv, dst, isConstruct);
        endFastPaths(callFromCompiledCode<Bytecode>, instruction);
    }
    if (inlineHostCall)
        m_body->end();
}

// Out of the function at a tail call, with the frame's bytecode offset at it: the interpreter or
// the compiled caller makes the call in place of this frame (tailCallStatus), an op_tail_call's
// call also in pendingTailCall
void Compiler::emitTailCallExit(const JSInstructionStream::Ref& instruction)
{
    auto store = [&](uint32_t* address) {
        m_body->i32Const(reinterpret_cast<uintptr_t>(address));
        m_body->localGet(m_a);
        m_body->i32Store(0);
    };
    if (instruction->is<OpTailCall>()) {
        auto bytecode = instruction->as<OpTailCall>();
        loadTag(bytecode.m_callee);
        m_body->localSet(m_a);
        store(&pendingTailCall.calleeTag);
        loadPayload(bytecode.m_callee);
        m_body->localSet(m_a);
        store(&pendingTailCall.callee);
        m_body->i32Const(bytecode.m_argv * sizeof(Register));
        m_body->localSet(m_a);
        store(&pendingTailCall.argvBytes);
        m_body->i32Const(bytecode.m_argc);
    } else
        m_body->i32Const(0);
    m_body->localSet(m_a);
    store(&pendingTailCall.argc);
    m_body->localGet(cfr);
    m_body->i32Const(CallSiteIndex(BytecodeIndex(instruction.offset())).bits());
    m_body->i32Store(static_cast<uint32_t>(static_cast<int>(CallFrameSlot::argumentCountIncludingThis) * sizeof(Register) + TagOffset));
    m_body->i32Const(tailCallStatus);
    m_body->returnValue();
}

// A call of a compiled callee in the callee table, in WASM: what callFromCompiledCode does for it
// without the call into C++, which took about a third of the time of a call. The work is in a
// function of the module (emitCompiledCallFunction), so a site costs a few instructions: with the
// work at every site, compiled code grew by 20 to 40 % and a large VM function ran slower, also
// once V8 had optimized it. Sets m_next when it did the call; everything else (host functions,
// other callees, too few arguments, deep nesting, a full stack) is left to callFromCompiledCode.
void Compiler::emitCompiledCall(const JSInstructionStream::Ref& instruction, VirtualRegister callee, unsigned argc, unsigned argv, VirtualRegister dst, bool isConstruct)
{
    uint32_t compiledCallFunction = helper(Helper::CompiledCall);
    beginFastPaths();
    m_body->localGet(cfr);
    loadTag(callee);
    loadPayload(callee);
    m_body->i32Const(argv * sizeof(Register));
    m_body->i32Const(argc);
    m_body->i32Const(CallSiteIndex(BytecodeIndex(instruction.offset())).bits());
    m_body->i32Const(isConstruct);
    m_body->call(compiledCallFunction);
    m_body->localTee(m_g);
    m_body->i32Const(compiledCallNotDone);
    m_body->op(Op::I32Ne);
    m_body->ifThen();
    m_body->localGet(m_g);
    m_body->ifThen();
    exceptionExit(instruction);
    m_body->end();
    if (dst.isValid()) {
        // The result in the `this` slot of the callee's frame
        m_body->localGet(cfr);
        m_body->i32Const(argv * sizeof(Register));
        m_body->op(Op::I32Sub);
        m_body->localTee(m_b);
        m_body->i32Load(static_cast<uint32_t>(static_cast<int>(CallFrameSlot::thisArgument) * sizeof(Register) + TagOffset));
        m_body->localSet(m_t1);
        m_body->localGet(m_b);
        m_body->i32Load(static_cast<uint32_t>(static_cast<int>(CallFrameSlot::thisArgument) * sizeof(Register) + PayloadOffset));
        m_body->localSet(m_t2);
        storeTagAndPayload(dst, m_t1, m_t2);
    }
    fastPathDone();
    m_body->end();
}

// The function of emitCompiledCall: (cfr, callee tag, callee payload, argv in bytes, argc, the
// call site's bits, construct) -> 0 when it called (the result in the `this` slot of the callee's
// frame), 1 after an exception, compiledCallNotDone when the callee is not a compiled one in the
// table or the call needs C++
void Compiler::emitCompiledCallFunction()
{
    VM& vm = m_codeBlock->vm();
    auto& table = callTargets(vm);
    const ValueType parameters[] = { ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32 };
    const ValueType status[] = { ValueType::I32 };
    auto* main = m_body;
    m_body = &m_module.addFunction(m_module.addType(parameters, status), std::size(parameters));
    constexpr uint32_t calleeTag = 1, callee = 2, argvBytes = 3, argc = 4, callSite = 5, isConstruct = 6;
    uint32_t key = m_body->addLocal(ValueType::I32);
    uint32_t entry = m_body->addLocal(ValueType::I32);
    uint32_t function = m_body->addLocal(ValueType::I32);
    uint32_t frame = m_body->addLocal(ValueType::I32);
    uint32_t top = m_body->addLocal(ValueType::I32);
    uint32_t saved = m_body->addLocal(ValueType::I32);
    uint32_t result = m_body->addLocal(ValueType::I32);
    uint32_t temporary = m_body->addLocal(ValueType::I32);
    uint32_t end = m_body->addLocal(ValueType::I32);
    uint32_t first = m_body->addLocal(ValueType::I32);
    uint32_t moved = m_body->addLocal(ValueType::I32);
    auto field = [](ptrdiff_t offset) { return static_cast<uint32_t>(offset); };
    auto header = [](CallFrameSlot slot, int32_t part) { return static_cast<uint32_t>(static_cast<int>(slot) * sizeof(Register) + part); };
    auto loadAddress = [&](const void* address) {
        m_body->i32Const(reinterpret_cast<uintptr_t>(address));
        m_body->i32Load(0);
    };
    auto storeAddress = [&](const void* address, uint32_t local) {
        m_body->i32Const(reinterpret_cast<uintptr_t>(address));
        m_body->localGet(local);
        m_body->i32Store(0);
    };
    auto notDoneIf = [&] {
        m_body->ifThen();
        m_body->i32Const(compiledCallNotDone);
        m_body->returnValue();
        m_body->end();
    };

    // The callee: a JSFunction (its executable also through its rare data), its entry in the table
    // (CallTargets::index) from this epoch with a compiled function and enough arguments, or with
    // a host function (function 0) when hosts are taken. failIf leaves when the value on the stack
    // is true.
    auto lookUp = [&](const auto& failIf, bool hosts) {
        m_body->localGet(calleeTag);
        m_body->i32Const(cellTag);
        m_body->op(Op::I32Ne);
        failIf();
        m_body->localGet(callee);
        m_body->i32Load8U(JSCell::typeInfoTypeOffset());
        m_body->i32Const(JSFunctionType);
        m_body->op(Op::I32Ne);
        failIf();
        m_body->localGet(callee);
        m_body->i32Load(JSFunction::offsetOfExecutableOrRareData());
        m_body->localTee(key);
        m_body->i32Const(JSFunction::rareDataTag);
        m_body->op(Op::I32And);
        m_body->ifThen();
        m_body->localGet(key);
        m_body->i32Load(FunctionRareData::offsetOfExecutable() - JSFunction::rareDataTag);
        m_body->localSet(key);
        m_body->end();
        m_body->localGet(key);
        m_body->localGet(isConstruct);
        m_body->op(Op::I32Add);
        m_body->localSet(key);
        m_body->localGet(key);
        m_body->i32Const(4);
        m_body->op(Op::I32ShrU);
        m_body->localGet(key);
        m_body->i32Const(15);
        m_body->op(Op::I32ShrU);
        m_body->op(Op::I32Xor);
        m_body->i32Const(CallTargets::count - 1);
        m_body->op(Op::I32And);
        m_body->i32Const(sizeof(CallTarget));
        m_body->op(Op::I32Mul);
        m_body->i32Const(reinterpret_cast<uintptr_t>(&table.targets[0]));
        m_body->op(Op::I32Add);
        m_body->localTee(entry);
        m_body->i32Load(field(OBJECT_OFFSETOF(CallTarget, key)));
        m_body->localGet(key);
        m_body->op(Op::I32Ne);
        failIf();
        m_body->localGet(entry);
        m_body->i32Load(field(OBJECT_OFFSETOF(CallTarget, epoch)));
        loadAddress(&table.epoch);
        m_body->op(Op::I32Ne);
        failIf();
        m_body->localGet(entry);
        m_body->i32Load(field(OBJECT_OFFSETOF(CallTarget, function)));
        m_body->localTee(function);
        if (hosts)
            m_body->ifThen();
        else {
            m_body->op(Op::I32Eqz);
            failIf();
        }
        m_body->localGet(entry);
        m_body->i32Load(field(OBJECT_OFFSETOF(CallTarget, numParameters)));
        m_body->localGet(argc);
        m_body->op(Op::I32GtU);
        failIf();
        if (hosts)
            m_body->end();
    };
    // Room in the JS stack below the frame in the local for the callee's locals: their end into top
    auto roomIf = [&](uint32_t frameLocal, const auto& failIf) {
        m_body->localGet(frameLocal);
        m_body->localGet(entry);
        m_body->i32Load(field(OBJECT_OFFSETOF(CallTarget, numCalleeLocals)));
        m_body->i32Const(3);
        m_body->op(Op::I32Shl);
        m_body->op(Op::I32Sub);
        m_body->localTee(top);
        loadAddress(cloopStackLimitAddress(vm));
        m_body->op(Op::I32LtU);
        failIf();
    };
    // The call in the frame: the callee's frame like op_enter and slow_path_enter, runCompiled with
    // the stack pointer below it, the status into result
    auto runInFrame = [&] {
        m_body->localGet(frame);
        m_body->localGet(cfr);
        m_body->i32Store(field(CallFrame::callerFrameOffset()));
        m_body->localGet(frame);
        m_body->i32Const(0);
        m_body->i32Store(field(CallFrame::returnPCOffset()));
        m_body->localGet(frame);
        m_body->localGet(entry);
        m_body->i32Load(field(OBJECT_OFFSETOF(CallTarget, codeBlock)));
        m_body->localTee(temporary);
        m_body->i32Store(header(CallFrameSlot::codeBlock, 0));
        m_body->localGet(frame);
        m_body->i32Const(cellTag);
        m_body->i32Store(header(CallFrameSlot::callee, TagOffset));
        m_body->localGet(frame);
        m_body->localGet(callee);
        m_body->i32Store(header(CallFrameSlot::callee, PayloadOffset));
        m_body->localGet(frame);
        m_body->localGet(argc);
        m_body->i32Store(header(CallFrameSlot::argumentCountIncludingThis, PayloadOffset));
        writeBarrier(temporary);
        // Its variables undefined: locals from the callee save space up to numVars, downwards
        m_body->localGet(frame);
        m_body->localGet(entry);
        m_body->i32Load(field(OBJECT_OFFSETOF(CallTarget, numVars)));
        m_body->i32Const(3);
        m_body->op(Op::I32Shl);
        m_body->op(Op::I32Sub);
        m_body->localSet(end);
        m_body->localGet(frame);
        m_body->i32Const((CodeBlock::llintBaselineCalleeSaveSpaceAsVirtualRegisters() + 1) * sizeof(Register));
        m_body->op(Op::I32Sub);
        m_body->localSet(temporary);
        m_body->block();
        m_body->loop();
        m_body->localGet(temporary);
        m_body->localGet(end);
        m_body->op(Op::I32LtU);
        m_body->brIf(1);
        m_body->localGet(temporary);
        m_body->i32Const(static_cast<int32_t>(JSValue::UndefinedTag));
        m_body->i32Store(TagOffset);
        m_body->localGet(temporary);
        m_body->i32Const(0);
        m_body->i32Store(PayloadOffset);
        m_body->localGet(temporary);
        m_body->i32Const(sizeof(Register));
        m_body->op(Op::I32Sub);
        m_body->localSet(temporary);
        m_body->br(0);
        m_body->end();
        m_body->end();
        // Its scope register
        m_body->localGet(entry);
        m_body->i32Load(field(OBJECT_OFFSETOF(CallTarget, scopeRegister)));
        m_body->i32Const(3);
        m_body->op(Op::I32Shl);
        m_body->localGet(frame);
        m_body->op(Op::I32Add);
        m_body->localTee(temporary);
        m_body->i32Const(cellTag);
        m_body->i32Store(TagOffset);
        m_body->localGet(temporary);
        m_body->localGet(callee);
        m_body->i32Load(JSCallee::offsetOfScopeChain());
        m_body->i32Store(PayloadOffset);
        storeAddress(cloopStackPointerAddress(vm), top);
        loadAddress(&depth);
        m_body->i32Const(1);
        m_body->op(Op::I32Add);
        m_body->localSet(temporary);
        storeAddress(&depth, temporary);
        m_body->localGet(frame);
        m_body->i32Const(0);
        m_body->localGet(function);
        m_body->callIndirect(0);
        m_body->localSet(result);
        m_body->block();
        m_body->loop();
        m_body->localGet(result);
        m_body->i32Const(reenterStatus);
        m_body->op(Op::I32LtS);
        m_body->brIf(1);
        m_body->localGet(frame);
        m_body->localGet(result);
        m_body->i32Const(reenterStatus);
        m_body->op(Op::I32Sub);
        m_body->localGet(function);
        m_body->callIndirect(0);
        m_body->localSet(result);
        m_body->br(0);
        m_body->end();
        m_body->end();
        loadAddress(&depth);
        m_body->i32Const(1);
        m_body->op(Op::I32Sub);
        m_body->localSet(temporary);
        storeAddress(&depth, temporary);
    };
    // The end of the frame's arguments, aligned: where the frame of its tail call ends (the
    // interpreter's prepareForTailCall), for a frame with argc arguments
    auto alignedFrameSize = [&] {
        const int32_t alignment = stackAlignmentRegisters();
        m_body->localGet(argc);
        m_body->i32Const(CallFrame::headerSizeInRegisters + alignment - 1);
        m_body->op(Op::I32Add);
        m_body->i32Const(-alignment);
        m_body->op(Op::I32And);
        m_body->i32Const(3);
        m_body->op(Op::I32Shl);
    };

    lookUp(notDoneIf, false);
    // Shallow nesting (roomForCompiledCode without a probe)
    loadAddress(&depth);
    m_body->localTee(temporary);
    m_body->i32Const(64);
    m_body->op(Op::I32GeU);
    m_body->localGet(temporary);
    loadAddress(&roomyDepth);
    m_body->i32Const(8);
    m_body->op(Op::I32Add);
    m_body->op(Op::I32GeU);
    m_body->op(Op::I32And);
    notDoneIf();
    m_body->localGet(cfr);
    m_body->localGet(argvBytes);
    m_body->op(Op::I32Sub);
    m_body->localTee(frame);
    m_body->localSet(first);
    roomIf(frame, notDoneIf);

    // The caller's bytecode offset, the call
    m_body->localGet(cfr);
    m_body->localGet(callSite);
    m_body->i32Store(header(CallFrameSlot::argumentCountIncludingThis, TagOffset));
    loadAddress(cloopStackPointerAddress(vm));
    m_body->localSet(saved);
    runInFrame();

    // Its tail calls (tailCallStatus, the call in pendingTailCall): the frame of the call takes the
    // place of the callee's, like the interpreter's prepareForTailCall, and a compiled callee in the
    // table is called here again (a chain of them neither nests nor grows the JS stack); else
    // finishTailCall makes the call
    m_body->block();
    m_body->loop();
    m_body->localGet(result);
    m_body->i32Const(tailCallStatus);
    m_body->op(Op::I32Ne);
    m_body->brIf(1);
    m_body->block();
    uint32_t viaFinishTailCall = m_body->depth();
    auto finishIf = [&] { m_body->brIf(m_body->depth() - viaFinishTailCall); };
    // The end of the frame, then the call it made: the callee, argv (a frame below the frame's
    // registers) and argc, argc 0 for a varargs call
    m_body->localGet(frame);
    alignedFrameSize();
    m_body->op(Op::I32Add);
    m_body->localSet(end);
    loadAddress(&pendingTailCall.argc);
    m_body->localTee(argc);
    m_body->op(Op::I32Eqz);
    finishIf();
    loadAddress(&pendingTailCall.calleeTag);
    m_body->localSet(calleeTag);
    loadAddress(&pendingTailCall.callee);
    m_body->localSet(callee);
    m_body->i32Const(0);
    m_body->localSet(isConstruct);
    lookUp(finishIf, true);
    // The arguments (`this` first) from below the frame's registers to their place, from the last
    // down: the place is above them
    m_body->localGet(frame);
    loadAddress(&pendingTailCall.argvBytes);
    m_body->op(Op::I32Sub);
    m_body->localSet(key);
    m_body->localGet(end);
    alignedFrameSize();
    m_body->op(Op::I32Sub);
    m_body->localTee(moved);
    m_body->localGet(key);
    m_body->op(Op::I32LtU);
    finishIf();
    roomIf(moved, finishIf);
    m_body->localGet(moved);
    m_body->localSet(frame);
    m_body->localGet(argc);
    m_body->i32Const(3);
    m_body->op(Op::I32Shl);
    m_body->localSet(temporary);
    m_body->block();
    m_body->loop();
    m_body->localGet(temporary);
    m_body->op(Op::I32Eqz);
    m_body->brIf(1);
    m_body->localGet(temporary);
    m_body->i32Const(4);
    m_body->op(Op::I32Sub);
    m_body->localSet(temporary);
    m_body->localGet(frame);
    m_body->localGet(temporary);
    m_body->op(Op::I32Add);
    m_body->localGet(key);
    m_body->localGet(temporary);
    m_body->op(Op::I32Add);
    m_body->i32Load(header(CallFrameSlot::thisArgument, 0));
    m_body->i32Store(header(CallFrameSlot::thisArgument, 0));
    m_body->br(0);
    m_body->end();
    m_body->end();
    m_body->localGet(function);
    m_body->ifThen();
    runInFrame();
    m_body->elseThen();
    // A host function, like callFromCompiledCode calls one
    m_body->localGet(frame);
    m_body->localGet(cfr);
    m_body->i32Store(field(CallFrame::callerFrameOffset()));
    m_body->localGet(frame);
    m_body->i32Const(0);
    m_body->i32Store(field(CallFrame::returnPCOffset()));
    m_body->localGet(frame);
    m_body->i32Const(0);
    m_body->i32Store(header(CallFrameSlot::codeBlock, 0));
    m_body->localGet(frame);
    m_body->i32Const(cellTag);
    m_body->i32Store(header(CallFrameSlot::callee, TagOffset));
    m_body->localGet(frame);
    m_body->localGet(callee);
    m_body->i32Store(header(CallFrameSlot::callee, PayloadOffset));
    m_body->localGet(frame);
    m_body->localGet(argc);
    m_body->i32Store(header(CallFrameSlot::argumentCountIncludingThis, PayloadOffset));
    m_body->localGet(frame);
    m_body->i32Const(0);
    m_body->i32Const(reinterpret_cast<uintptr_t>(hostTailCallFromCompiledCode));
    m_body->callIndirect(m_slowPathType);
    m_body->op(Op::I32WrapI64);
    m_body->i32Const(reinterpret_cast<uintptr_t>(exceptionInstructions()));
    m_body->op(Op::I32Eq);
    m_body->localSet(result);
    m_body->end();
    m_body->br(1);
    m_body->end();
    m_body->localGet(frame);
    m_body->i32Const(0);
    m_body->i32Const(reinterpret_cast<uintptr_t>(tailCallFromCompiledCode));
    m_body->callIndirect(m_slowPathType);
    m_body->op(Op::I32WrapI64);
    m_body->i32Const(reinterpret_cast<uintptr_t>(exceptionInstructions()));
    m_body->op(Op::I32Eq);
    m_body->localSet(result);
    m_body->end();
    m_body->end();
    // The result of the last call where the caller reads it: the `this` slot of the first frame
    m_body->localGet(frame);
    m_body->localGet(first);
    m_body->op(Op::I32Ne);
    m_body->ifThen();
    m_body->localGet(first);
    m_body->localGet(frame);
    m_body->i32Load(header(CallFrameSlot::thisArgument, TagOffset));
    m_body->i32Store(header(CallFrameSlot::thisArgument, TagOffset));
    m_body->localGet(first);
    m_body->localGet(frame);
    m_body->i32Load(header(CallFrameSlot::thisArgument, PayloadOffset));
    m_body->i32Store(header(CallFrameSlot::thisArgument, PayloadOffset));
    m_body->end();
    storeAddress(cloopStackPointerAddress(vm), saved);
    storeAddress(&vm.topCallFrame, cfr);
    m_body->localGet(result);
    m_body = main;
}

uint32_t Compiler::helper(Helper kind, OpcodeID opcode)
{
    auto index = m_helpers.find(std::pair { kind, opcode });
    if (index == notFound) {
        m_helpers.append(std::pair { kind, opcode });
        index = m_helpers.size() - 1;
    }
    return index + 1;
}

void Compiler::emitHelpers()
{
    // A function may need others, which come after it
    for (size_t i = 0; i < m_helpers.size(); ++i) {
        switch (m_helpers[i].first) {
        case Helper::CompiledCall: emitCompiledCallFunction(); break;
        case Helper::KeyedLoad: emitKeyedLoadFunction(); break;
        case Helper::KeyedStore: emitKeyedStoreFunction(); break;
        case Helper::SlowPathCall: emitSlowPathCallFunction(); break;
        case Helper::GetById: emitGetByIdFunction(); break;
        case Helper::GetByVal: emitGetByValFunction(); break;
        case Helper::PutByVal: emitPutByValFunction(); break;
        case Helper::ResolveScope: emitResolveScopeFunction(); break;
        case Helper::GetFromScope: emitGetFromScopeFunction(); break;
        case Helper::PutToScope: emitPutToScopeFunction(); break;
        case Helper::InlineHostCall: emitInlineHostCallFunction(); break;
        case Helper::OutOfLine: emitOutOfLineFunction(m_helpers[i].second); break;
        case Helper::ToBoolean: emitToBooleanFunction(); break;
        case Helper::NewArray: emitNewArrayFunction(); break;
        case Helper::NewArrayBuffer: emitNewArrayBufferFunction(); break;
        }
        // Profiles show the helpers by name (wasm-function[n] otherwise)
        static constexpr const char* names[] = { "compiledCall", "keyedLoad", "keyedStore", "slowPathCall", "getById", "getByVal", "putByVal", "resolveScope", "getFromScope", "putToScope", "inlineHostCall", "outOfLine ", "toBoolean", "newArray", "newArrayBuffer" };
        static_assert(std::size(names) == static_cast<size_t>(Helper::NewArrayBuffer) + 1);
        std::string name = names[static_cast<size_t>(m_helpers[i].first)];
        if (m_helpers[i].first == Helper::OutOfLine)
            name += opcodeNames[m_helpers[i].second];
        m_module.functionAt(i + 1).setName(WTF::move(name));
    }
}

void Compiler::addScratchLocals()
{
    m_a = m_body->addLocal(ValueType::I32);
    m_b = m_body->addLocal(ValueType::I32);
    m_c = m_body->addLocal(ValueType::I32);
    m_d = m_body->addLocal(ValueType::I32);
    m_e = m_body->addLocal(ValueType::I32);
    m_g = m_body->addLocal(ValueType::I32);
    m_t1 = m_body->addLocal(ValueType::I32);
    m_t2 = m_body->addLocal(ValueType::I32);
    m_next = m_body->addLocal(ValueType::I32);
    m_wide = m_body->addLocal(ValueType::I64);
    m_x = m_body->addLocal(ValueType::F64);
    m_y = m_body->addLocal(ValueType::F64);
}

template<typename Emit>
void Compiler::emitFastPathFunction(std::span<const ValueType> parameters, const Emit& emit)
{
    const ValueType status[] = { ValueType::I32 };
    auto* main = m_body;
    auto locals = std::tuple { m_a, m_b, m_c, m_d, m_e, m_g, m_t1, m_t2, m_next, m_wide, m_x, m_y };
    m_body = &m_module.addFunction(m_module.addType(parameters, status), parameters.size());
    addScratchLocals();
    beginFastPaths();
    emit();
    m_body->localGet(m_next);
    m_body = main;
    std::tie(m_a, m_b, m_c, m_d, m_e, m_g, m_t1, m_t2, m_next, m_wide, m_x, m_y) = locals;
}

void Compiler::emitSlowPathCallFunction()
{
    const ValueType parameters[] = { ValueType::I32, ValueType::I32, ValueType::I32 };
    const ValueType result[] = { ValueType::I64 };
    auto* main = m_body;
    m_body = &m_module.addFunction(m_module.addType(parameters, result), std::size(parameters));
    m_body->localGet(0);
    m_body->localGet(1);
    m_body->localGet(2);
    m_body->callIndirect(m_slowPathType);
    m_body = main;
}

void Compiler::stringKeyUid(uint32_t keyLocal, uint32_t uidLocal)
{
    cellType(keyLocal);
    m_body->i32Const(StringType);
    m_body->op(Op::I32Ne);
    m_body->ifThen();
    m_body->i32Const(0);
    m_body->returnValue();
    m_body->end();
    m_body->localGet(keyLocal);
    m_body->i32Load(JSString::offsetOfValue());
    m_body->localTee(uidLocal);
    m_body->i32Const(JSString::isRopeInPointer);
    m_body->op(Op::I32And);
    m_body->ifThen();
    m_body->i32Const(0);
    m_body->returnValue();
    m_body->end();
}

void Compiler::findMegamorphicEntry(uint32_t structureLocal, uint32_t uidLocal, uint32_t hashShift, uint32_t primaryMask, ptrdiff_t primaryOffset, uint32_t secondaryShift, uint32_t secondaryMask, ptrdiff_t secondaryOffset, size_t entrySize, ptrdiff_t structureOffset, ptrdiff_t uidOffset, ptrdiff_t epochOffset)
{
    auto* cache = reinterpret_cast<uint8_t*>(&m_codeBlock->vm().ensureMegamorphicCache());
    uint32_t epoch = m_body->addLocal(ValueType::I32);
    uint32_t entry = m_body->addLocal(ValueType::I32);
    uint32_t key = m_body->addLocal(ValueType::I32);
    auto matches = [&] {
        m_body->localGet(entry);
        m_body->i32Load(structureOffset);
        m_body->localGet(structureLocal);
        m_body->op(Op::I32Eq);
        m_body->localGet(entry);
        m_body->i32Load(uidOffset);
        m_body->localGet(uidLocal);
        m_body->op(Op::I32Eq);
        m_body->op(Op::I32And);
    };
    auto epochDiffers = [&] {
        m_body->localGet(entry);
        m_body->i32Load16U(epochOffset);
        m_body->localGet(epoch);
        m_body->op(Op::I32Ne);
    };
    auto entryAt = [&](uint32_t mask, ptrdiff_t offset) {
        m_body->i32Const(mask);
        m_body->op(Op::I32And);
        m_body->i32Const(entrySize);
        m_body->op(Op::I32Mul);
        m_body->i32Const(reinterpret_cast<uintptr_t>(cache + offset));
        m_body->op(Op::I32Add);
        m_body->localSet(entry);
    };
    m_body->i32Const(reinterpret_cast<uintptr_t>(cache + MegamorphicCache::offsetOfEpoch()));
    m_body->i32Load16U(0);
    m_body->localSet(epoch);
    // ((structure >> shift1) ^ (structure >> shift)) + the key's hash
    m_body->localGet(structureLocal);
    m_body->i32Const(MegamorphicCache::structureIDHashShift1);
    m_body->op(Op::I32ShrU);
    m_body->localGet(structureLocal);
    m_body->i32Const(hashShift);
    m_body->op(Op::I32ShrU);
    m_body->op(Op::I32Xor);
    m_body->localGet(uidLocal);
    m_body->i32Load(StringImpl::flagsOffset());
    m_body->i32Const(StringImpl::s_flagCount);
    m_body->op(Op::I32ShrU);
    m_body->op(Op::I32Add);
    entryAt(primaryMask, primaryOffset);
    m_body->block();
    m_body->block();
    matches();
    m_body->op(Op::I32Eqz);
    m_body->brIf(0);
    // An entry of the structure and key from an older epoch: the secondary table has none newer
    epochDiffers();
    m_body->ifThen();
    m_body->i32Const(0);
    m_body->returnValue();
    m_body->end();
    m_body->br(1);
    m_body->end();
    // key = structure + uid, key + (key >> shift)
    m_body->localGet(structureLocal);
    m_body->localGet(uidLocal);
    m_body->op(Op::I32Add);
    m_body->localTee(key);
    m_body->localGet(key);
    m_body->i32Const(secondaryShift);
    m_body->op(Op::I32ShrU);
    m_body->op(Op::I32Add);
    entryAt(secondaryMask, secondaryOffset);
    matches();
    m_body->op(Op::I32Eqz);
    epochDiffers();
    m_body->op(Op::I32Or);
    m_body->ifThen();
    m_body->i32Const(0);
    m_body->returnValue();
    m_body->end();
    m_body->end();
    m_body->localGet(entry);
}

// (base, key) -> the address of the value for a string key that is no rope, from the VM's
// megamorphic cache (an own or prototype property, or a constant undefined for an absent one), or
// 0, also for a getter. The base is a cell: only objects have entries.
void Compiler::emitKeyedLoadFunction()
{
    using Entry = MegamorphicCache::LoadEntry;
    static const EncodedJSValue undefinedValue = JSValue::encode(jsUndefined());
    auto* main = m_body;
    m_body = &m_module.addFunction(m_checkType, 2);
    constexpr uint32_t base = 0, key = 1;
    uint32_t uid = m_body->addLocal(ValueType::I32);
    uint32_t structure = m_body->addLocal(ValueType::I32);
    uint32_t entry = m_body->addLocal(ValueType::I32);
    uint32_t holder = m_body->addLocal(ValueType::I32);
    uint32_t offset = m_body->addLocal(ValueType::I32);
    uint32_t address = m_body->addLocal(ValueType::I32);
    stringKeyUid(key, uid);
    m_body->localGet(base);
    m_body->i32Load(JSCell::structureIDOffset());
    m_body->localSet(structure);
    findMegamorphicEntry(structure, uid, MegamorphicCache::structureIDHashShift2,
        MegamorphicCache::loadCachePrimaryMask, MegamorphicCache::offsetOfLoadCachePrimaryEntries(),
        MegamorphicCache::structureIDHashShift3, MegamorphicCache::loadCacheSecondaryMask, MegamorphicCache::offsetOfLoadCacheSecondaryEntries(),
        sizeof(Entry), Entry::offsetOfStructureID(), Entry::offsetOfUid(), Entry::offsetOfEpoch());
    m_body->localTee(entry);
    m_body->i32Load(Entry::offsetOfHolder());
    m_body->localTee(holder);
    m_body->op(Op::I32Eqz);
    m_body->ifThen();
    m_body->i32Const(reinterpret_cast<uintptr_t>(&undefinedValue));
    m_body->returnValue();
    m_body->end();
    // An own property: the base itself
    m_body->localGet(holder);
    m_body->i32Const(reinterpret_cast<uintptr_t>(JSCell::seenMultipleCalleeObjects()));
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    m_body->localGet(base);
    m_body->localSet(holder);
    m_body->end();
    m_body->localGet(entry);
    m_body->i32Load16U(Entry::offsetOfOffset());
    m_body->localSet(offset);
    propertyAddress(holder, offset, address);
    // A getter: getByValFromCompiledCode calls it
    m_body->i32Load(TagOffset);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    m_body->ifThen(Hint::Unlikely);
    m_body->localGet(address);
    m_body->i32Load(PayloadOffset);
    m_body->localSet(holder);
    cellType(holder);
    m_body->i32Const(GetterSetterType);
    m_body->op(Op::I32Eq);
    m_body->ifThen(Hint::Unlikely);
    m_body->i32Const(0);
    m_body->returnValue();
    m_body->end();
    m_body->end();
    m_body->localGet(address);
    m_body = main;
}

// (base, key, tag, payload) -> 1 when it stored the value for a string key that is no rope as an
// entry of the VM's megamorphic cache says (a replacement or a transition without a new butterfly),
// 2 after such a transition (the base needs the write barrier), 0 when not
void Compiler::emitKeyedStoreFunction()
{
    using Entry = MegamorphicCache::StoreEntry;
    const ValueType parameters[] = { ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32 };
    const ValueType status[] = { ValueType::I32 };
    auto* main = m_body;
    m_body = &m_module.addFunction(m_module.addType(parameters, status), std::size(parameters));
    constexpr uint32_t base = 0, key = 1, tag = 2, payload = 3;
    uint32_t uid = m_body->addLocal(ValueType::I32);
    uint32_t structure = m_body->addLocal(ValueType::I32);
    uint32_t entry = m_body->addLocal(ValueType::I32);
    uint32_t newStructure = m_body->addLocal(ValueType::I32);
    uint32_t offset = m_body->addLocal(ValueType::I32);
    uint32_t address = m_body->addLocal(ValueType::I32);
    stringKeyUid(key, uid);
    m_body->localGet(base);
    m_body->i32Load(JSCell::structureIDOffset());
    m_body->localSet(structure);
    findMegamorphicEntry(structure, uid, MegamorphicCache::structureIDHashShift4,
        MegamorphicCache::storeCachePrimaryMask, MegamorphicCache::offsetOfStoreCachePrimaryEntries(),
        MegamorphicCache::structureIDHashShift5, MegamorphicCache::storeCacheSecondaryMask, MegamorphicCache::offsetOfStoreCacheSecondaryEntries(),
        sizeof(Entry), Entry::offsetOfOldStructureID(), Entry::offsetOfUid(), Entry::offsetOfEpoch());
    m_body->localTee(entry);
    m_body->i32Load8U(Entry::offsetOfReallocating());
    m_body->ifThen();
    m_body->i32Const(0);
    m_body->returnValue();
    m_body->end();
    m_body->localGet(entry);
    m_body->i32Load16U(Entry::offsetOfOffset());
    m_body->localSet(offset);
    m_body->localGet(entry);
    m_body->i32Load(Entry::offsetOfNewStructureID());
    m_body->localTee(newStructure);
    m_body->localGet(structure);
    m_body->op(Op::I32Ne);
    m_body->ifThen();
    m_body->localGet(base);
    m_body->localGet(newStructure);
    m_body->i32Store(JSCell::structureIDOffset());
    m_body->end();
    propertyAddress(base, offset, address);
    m_body->localTee(address);
    m_body->localGet(tag);
    m_body->i32Store(TagOffset);
    m_body->localGet(address);
    m_body->localGet(payload);
    m_body->i32Store(PayloadOffset);
    m_body->i32Const(1);
    m_body->localGet(newStructure);
    m_body->localGet(structure);
    m_body->op(Op::I32Ne);
    m_body->op(Op::I32Add);
    m_body = main;
}

// Math.imul(a, b) of two numbers without a call into C++ (emitInlineHostCallFunction): sets m_next
// when it did the call
void Compiler::emitInlineHostCall(VirtualRegister callee, unsigned argv, VirtualRegister dst)
{
    auto argument = [&](int index) {
        return virtualRegisterForArgumentIncludingThis(index, -static_cast<int>(argv));
    };
    loadTag(callee);
    loadPayload(callee);
    loadTag(argument(1));
    loadPayload(argument(1));
    loadTag(argument(2));
    loadPayload(argument(2));
    if (dst.isValid())
        registerAddress(dst);
    else
        m_body->i32Const(0);
    m_body->call(helper(Helper::InlineHostCall));
    m_body->localSet(m_next);
}

// (callee tag and payload, two arguments' tags and payloads, destination address or 0) -> 1 when
// the callee is Math.imul and it did the call
void Compiler::emitInlineHostCallFunction()
{
    uintptr_t imul = imulHostFunction(m_codeBlock->globalObject());
    const ValueType parameters[] = { ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32 };
    constexpr uint32_t calleeTag = 0, calleePayload = 1, dst = 6;
    const Operand first = Operand::value(2, 3);
    const Operand second = Operand::value(4, 5);
    emitFastPathFunction(parameters, [&] {
        m_body->block();
        m_body->localGet(calleeTag);
        m_body->i32Const(cellTag);
        m_body->op(Op::I32Ne);
        m_body->brIf(0);
        m_body->localGet(calleePayload);
        m_body->localTee(m_d);
        m_body->i32Load8U(JSCell::typeInfoTypeOffset());
        m_body->i32Const(JSFunctionType);
        m_body->op(Op::I32Ne);
        m_body->brIf(0);
        // The executable, also through the function's rare data
        m_body->localGet(m_d);
        m_body->i32Load(JSFunction::offsetOfExecutableOrRareData());
        m_body->localTee(m_e);
        m_body->i32Const(JSFunction::rareDataTag);
        m_body->op(Op::I32And);
        m_body->ifThen();
        m_body->localGet(m_e);
        m_body->i32Load(FunctionRareData::offsetOfExecutable() - JSFunction::rareDataTag);
        m_body->localSet(m_e);
        m_body->end();
        m_body->localGet(m_e);
        m_body->i32Load8U(JSCell::typeInfoTypeOffset());
        m_body->i32Const(NativeExecutableType);
        m_body->op(Op::I32Ne);
        m_body->brIf(0);
        m_body->localGet(m_e);
        m_body->i32Load(NativeExecutable::offsetOfNativeFunctionFor(CodeSpecializationKind::CodeForCall));
        m_body->i32Const(imul);
        m_body->op(Op::I32Ne);
        m_body->brIf(0);
        // Numbers through ToInt32, hashes multiply uint32 values above 2^31
        loadTag(first);
        m_body->localSet(m_t1);
        loadTag(second);
        m_body->localSet(m_t2);
        toInt32(first, m_t1, m_a, m_x);
        toInt32(second, m_t2, m_b, m_y);
        m_body->op(Op::I32And);
        m_body->op(Op::I32Eqz);
        m_body->brIf(0);
        m_body->localGet(m_a);
        m_body->localGet(m_b);
        m_body->op(Op::I32Mul);
        m_body->localSet(m_c);
        m_body->localGet(dst);
        m_body->ifThen();
        storeInt32(Operand::at(dst), m_c);
        m_body->end();
        fastPathDone();
        m_body->end();
    });
}

void Compiler::checkException(const JSInstructionStream::Ref& instruction)
{
    m_body->op(Op::I32WrapI64);
    m_body->localTee(m_next);
    m_body->i32Const(reinterpret_cast<uintptr_t>(exceptionInstructions()));
    m_body->op(Op::I32Eq);
    if (!m_codeBlock->handlerForBytecodeIndex(BytecodeIndex(instruction.offset()))) {
        // Out through the block around everything, which returns 1
        m_body->brIf(m_body->depth() - 1, Hint::Unlikely);
        return;
    }
    m_body->ifThen(Hint::Unlikely);
    exceptionExit(instruction);
    m_body->end();
}

void Compiler::exceptionExit(const JSInstructionStream::Ref& instruction)
{
    if (auto* handler = m_codeBlock->handlerForBytecodeIndex(BytecodeIndex(instruction.offset()))) {
        m_body->localGet(cfr);
        m_body->i32Const(0);
        m_body->i32Const(reinterpret_cast<uintptr_t>(&exceptionIsCatchable));
        m_body->callIndirect(m_checkType);
        m_body->op(Op::I32Eqz);
        m_body->ifThen();
        m_body->i32Const(1);
        m_body->returnValue();
        m_body->end();
        jumpTo(handler->target, m_currentBlock);
    } else {
        m_body->i32Const(1);
        m_body->returnValue();
    }
}

void Compiler::beginFastPaths()
{
    m_body->i32Const(0);
    m_body->localSet(m_next);
}

void Compiler::fastPathDone()
{
    m_body->i32Const(1);
    m_body->localSet(m_next);
}

void Compiler::endFastPaths(SlowPath slowPath, const JSInstructionStream::Ref& instruction)
{
    m_body->localGet(m_next);
    m_body->op(Op::I32Eqz);
    m_body->ifThen(Hint::Unlikely);
    callSlowPath(slowPath, instruction);
    m_body->end();
}

// The code of block i sits after the end of the i-th of the blocks nested in the dispatch loop,
// within the blocks i + 1 ... n - 1: a jump forward is a branch out to the end of the target's
// block, a jump back goes through the loop's br_table with the block of the target
void Compiler::jumpTo(unsigned targetOffset, unsigned fromBlock)
{
    unsigned target = m_blockAt.get(targetOffset);
    if (target > fromBlock) {
        m_body->br(m_body->depth() - m_blockDepth + target - fromBlock - 1);
        return;
    }
    m_body->i32Const(target);
    m_body->localSet(m_block);
    m_body->br(m_body->depth() - m_blockDepth + m_blockCount - 1 - fromBlock);
}

void Compiler::jumpIfSlowPathReturned(unsigned targetOffset, unsigned fromBlock)
{
    m_body->localGet(m_next);
    m_body->i32Const(reinterpret_cast<uintptr_t>(instructionPointer(targetOffset)));
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    jumpTo(targetOffset, fromBlock);
    m_body->end();
}

void Compiler::propertyAddress(uint32_t objectLocal, uint32_t offsetLocal, uint32_t addressLocal)
{
    m_body->localGet(offsetLocal);
    m_body->i32Const(firstOutOfLineOffset);
    m_body->op(Op::I32LtS);
    m_body->ifThen();
    {
        m_body->localGet(objectLocal);
        m_body->i32Const(sizeof(JSObjectWithButterfly));
        m_body->op(Op::I32Add);
        m_body->localGet(offsetLocal);
        m_body->i32Const(3);
        m_body->op(Op::I32Shl);
        m_body->op(Op::I32Add);
        m_body->localSet(addressLocal);
    }
    m_body->elseThen();
    {
        // below the butterfly: (offset minus firstOutOfLineOffset plus 2) * 8
        m_body->localGet(objectLocal);
        m_body->i32Load(JSObject::butterflyOffset());
        m_body->localGet(offsetLocal);
        m_body->i32Const(firstOutOfLineOffset - 2);
        m_body->op(Op::I32Sub);
        m_body->i32Const(3);
        m_body->op(Op::I32Shl);
        m_body->op(Op::I32Sub);
        m_body->localSet(addressLocal);
    }
    m_body->end();
    m_body->localGet(addressLocal);
}

void Compiler::loadProperty(uint32_t objectLocal, uint32_t offsetLocal)
{
    propertyAddress(objectLocal, offsetLocal);
    m_body->localTee(m_c);
    m_body->i32Load(TagOffset);
    m_body->localSet(m_a);
    m_body->localGet(m_c);
    m_body->i32Load(PayloadOffset);
    m_body->localSet(m_b);
}

// The interpreter's inline cache (metadata) in its modes: own property, prototype's property,
// array length, unset (undefined)
template<typename Bytecode>
void Compiler::emitGetById(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<Bytecode>();
    m_propertyCaches.append(makeUnique<PropertyCache>());
    PropertyCache* propertyCache = m_propertyCaches.last().get();
    loadTag(bytecode.m_base);
    loadPayload(bytecode.m_base);
    m_body->i32Const(reinterpret_cast<uintptr_t>(&bytecode.metadata(m_codeBlock).m_modeMetadata));
    registerAddress(bytecode.m_dst);
    m_body->call(helper(Helper::GetById));
    m_body->localSet(m_next);
    m_body->localGet(m_next);
    m_body->op(Op::I32Eqz);
    m_body->ifThen(Hint::Unlikely);
    m_body->localGet(cfr);
    m_body->i32Const(reinterpret_cast<uintptr_t>(instruction.ptr()));
    m_body->i32Const(reinterpret_cast<uintptr_t>(propertyCache));
    m_body->i32Const(reinterpret_cast<uintptr_t>(&getByIdFromCompiledCode<Bytecode>));
    m_body->callIndirect(m_callType);
    checkException(instruction);
    m_body->end();
}

// (base tag and payload, the cache's mode metadata, destination address) -> 1 when done
void Compiler::emitGetByIdFunction()
{
    const ValueType parameters[] = { ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32 };
    constexpr uint32_t baseTag = 0, basePayload = 1, cache = 2;
    const Operand dst = Operand::at(3);
    auto mode = [&](GetByIdMode value) {
        m_body->localGet(m_t1);
        m_body->i32Const(static_cast<int32_t>(value));
        m_body->op(Op::I32Eq);
    };
    auto loadCached = [&](ptrdiff_t offset) {
        m_body->localGet(cache);
        m_body->i32Load(offset);
    };
    auto structureIs = [&](ptrdiff_t offset) {
        m_body->localGet(m_d);
        m_body->i32Load(JSCell::structureIDOffset());
        loadCached(offset);
        m_body->op(Op::I32Eq);
    };
    emitFastPathFunction(parameters, [&] {
        m_body->localGet(baseTag);
        m_body->i32Const(cellTag);
        m_body->op(Op::I32Eq);
        m_body->ifThen();
        {
            m_body->localGet(basePayload);
            m_body->localSet(m_d);
            m_body->localGet(cache);
            m_body->i32Load8U(OBJECT_OFFSETOF(GetByIdModeMetadata, mode));
            m_body->localSet(m_t1);

            mode(GetByIdMode::Default);
            structureIs(OBJECT_OFFSETOF(GetByIdModeMetadata, defaultMode.structureID));
            m_body->op(Op::I32And);
            m_body->ifThen();
            loadCached(OBJECT_OFFSETOF(GetByIdModeMetadata, defaultMode.cachedOffset));
            m_body->localSet(m_t2);
            loadProperty(m_d, m_t2);
            storeTagAndPayload(dst, m_a, m_b);
            fastPathDone();
            m_body->end();

            // The site's second structure, like the interpreter's fast path (patch 0179)
            mode(GetByIdMode::Default);
            structureIs(OBJECT_OFFSETOF(GetByIdModeMetadata, defaultMode.secondStructureID));
            m_body->op(Op::I32And);
            m_body->ifThen();
            m_body->localGet(cache);
            m_body->i32Load16S(OBJECT_OFFSETOF(GetByIdModeMetadata, secondCachedOffset));
            m_body->localSet(m_t2);
            loadProperty(m_d, m_t2);
            storeTagAndPayload(dst, m_a, m_b);
            fastPathDone();
            m_body->end();

            mode(GetByIdMode::ProtoLoad);
            structureIs(OBJECT_OFFSETOF(GetByIdModeMetadata, protoLoadMode.structureID));
            m_body->op(Op::I32And);
            m_body->ifThen();
            loadCached(OBJECT_OFFSETOF(GetByIdModeMetadata, protoLoadMode.cachedOffset));
            m_body->localSet(m_t2);
            loadCached(OBJECT_OFFSETOF(GetByIdModeMetadata, protoLoadMode.cachedSlot));
            m_body->localSet(m_d);
            loadProperty(m_d, m_t2);
            storeTagAndPayload(dst, m_a, m_b);
            fastPathDone();
            m_body->end();

            // An array's length: a public length that is an int32
            mode(GetByIdMode::ArrayLength);
            m_body->ifThen();
            m_body->localGet(m_d);
            m_body->i32Load8U(JSCell::indexingTypeAndMiscOffset());
            m_body->localTee(m_t2);
            m_body->i32Const(IsArray);
            m_body->op(Op::I32And);
            m_body->i32Const(0);
            m_body->op(Op::I32Ne);
            m_body->localGet(m_t2);
            m_body->i32Const(IndexingShapeMask);
            m_body->op(Op::I32And);
            m_body->i32Const(0);
            m_body->op(Op::I32Ne);
            m_body->op(Op::I32And);
            m_body->ifThen();
            m_body->localGet(m_d);
            m_body->i32Load(JSObject::butterflyOffset());
            m_body->i32Const(Butterfly::offsetOfPublicLength());
            m_body->op(Op::I32Add);
            m_body->i32Load(0);
            m_body->localTee(m_b);
            m_body->i32Const(0);
            m_body->op(Op::I32GeS);
            m_body->ifThen();
            storeInt32(dst, m_b);
            fastPathDone();
            m_body->end();
            m_body->end();
            m_body->end();

            mode(GetByIdMode::Unset);
            structureIs(OBJECT_OFFSETOF(GetByIdModeMetadata, unsetMode.structureID));
            m_body->op(Op::I32And);
            m_body->ifThen();
            m_body->i32Const(0);
            m_body->localSet(m_b);
            storeTag(dst, static_cast<int32_t>(JSValue::UndefinedTag), m_b);
            fastPathDone();
            m_body->end();
        }
        m_body->end();
    });
}

// An own property: same structure, value at the offset
void Compiler::emitGetByIdDirect(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpGetByIdDirect>();
    auto& cache = bytecode.metadata(m_codeBlock);
    beginFastPaths();
    loadTag(bytecode.m_base);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    {
        loadPayload(bytecode.m_base);
        m_body->localTee(m_d);
        m_body->i32Load(JSCell::structureIDOffset());
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_structureID));
        m_body->i32Load(0);
        m_body->op(Op::I32Eq);
        m_body->ifThen();
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_offset));
        m_body->i32Load(0);
        m_body->localSet(m_t2);
        loadProperty(m_d, m_t2);
        storeTagAndPayload(bytecode.m_dst, m_a, m_b);
        fastPathDone();
        m_body->end();
    }
    m_body->end();
    endFastPaths(llint_slow_path_get_by_id_direct, instruction);
}

// The interpreter's cache: a store into an existing property, or a cached transition without a
// new butterfly (its prototype chain checked when the cache has one); the write barrier first
void Compiler::emitPutById(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpPutById>();
    auto& cache = bytecode.metadata(m_codeBlock);
    auto storeValue = [&] {
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_offset));
        m_body->i32Load(0);
        m_body->localSet(m_t2);
        propertyAddress(m_d, m_t2);
        m_body->localSet(m_t2);
        m_body->localGet(m_t2);
        loadTag(bytecode.m_value);
        m_body->i32Store(TagOffset);
        m_body->localGet(m_t2);
        loadPayload(bytecode.m_value);
        m_body->i32Store(PayloadOffset);
        fastPathDone();
    };
    writeBarrierOnOperands(bytecode.m_base, bytecode.m_value);
    beginFastPaths();
    loadTag(bytecode.m_base);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    {
        loadPayload(bytecode.m_base);
        m_body->localTee(m_d);
        m_body->i32Load(JSCell::structureIDOffset());
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_oldStructureID));
        m_body->i32Load(0);
        m_body->op(Op::I32Eq);
        m_body->ifThen();
        {
            m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_newStructureID));
            m_body->i32Load(0);
            m_body->localTee(m_t1);
            m_body->op(Op::I32Eqz);
            m_body->ifThen();
            storeValue();
            m_body->elseThen();
            {
                // Transition: the chain, if any, still matches
                m_body->i32Const(1);
                m_body->localSet(m_e);
                m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_structureChain));
                m_body->i32Load(0);
                m_body->localTee(m_t2);
                m_body->ifThen();
                m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_oldStructureID));
                m_body->i32Load(0);
                m_body->localGet(m_t2);
                m_body->i32Const(reinterpret_cast<uintptr_t>(&structureChainMatches));
                m_body->callIndirect(m_checkType);
                m_body->localSet(m_e);
                m_body->end();
                m_body->localGet(m_e);
                m_body->ifThen();
                m_body->localGet(m_d);
                m_body->localGet(m_t1);
                m_body->i32Store(JSCell::structureIDOffset());
                storeValue();
                writeBarrier(m_d);
                m_body->end();
            }
            m_body->end();
        }
        m_body->end();
    }
    m_body->end();
    endFastPaths(llint_slow_path_put_by_id, instruction);
}

// Like the interpreter: an int32 index into an int32, double, contiguous or array storage
// butterfly, within its length and not a hole
// The fast paths of get_by_val, in a function of the module that all its sites call (they made
// compiled code 20 to 40 times its bytecode, too much code for the processor's caches: an
// obfuscated VM's function of 50 KB ran little faster than the interpreter, #630)
bool Compiler::profiledContiguousElements(ArrayProfile& profile, bool writes)
{
    ConcurrentJSLocker locker(m_codeBlock->m_lock);
    profile.computeUpdatedPrediction(m_codeBlock);
    constexpr ArrayModes contiguous = asArrayModesIgnoringTypedArrays(NonArrayWithInt32) | asArrayModesIgnoringTypedArrays(NonArrayWithContiguous)
        | asArrayModesIgnoringTypedArrays(ArrayWithInt32) | asArrayModesIgnoringTypedArrays(ArrayWithContiguous);
    constexpr ArrayModes copyOnWrite = asArrayModesIgnoringTypedArrays(CopyOnWriteArrayWithInt32) | asArrayModesIgnoringTypedArrays(CopyOnWriteArrayWithContiguous);
    ArrayModes modes = profile.observedArrayModes(locker);
    return modes && !(modes & ~(writes ? contiguous : contiguous | copyOnWrite)) && !profile.outOfBounds(locker);
}

// A site whose profile saw only int32 and contiguous butterflies within bounds (an obfuscated VM's
// stack, registers and operands) reads the element inline, like JSC's baseline JIT for its array
// mode; anything else, and that site after a miss, calls the module's function
void Compiler::emitGetByVal(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpGetByVal>();
    bool inlineElement = profiledContiguousElements(bytecode.metadata(m_codeBlock).m_arrayProfile, false);
    if (inlineElement) {
        beginFastPaths();
        loadTag(bytecode.m_base);
        m_body->i32Const(cellTag);
        m_body->op(Op::I32Eq);
        loadTag(bytecode.m_property);
        m_body->i32Const(int32Tag);
        m_body->op(Op::I32Eq);
        m_body->op(Op::I32And);
        m_body->ifThen(Hint::Likely);
        {
            loadPayload(bytecode.m_base);
            m_body->localTee(m_d);
            m_body->i32Load8U(JSCell::indexingTypeAndMiscOffset());
            m_body->i32Const(IndexingShapeMask);
            m_body->op(Op::I32And);
            m_body->localTee(m_t1);
            m_body->i32Const(Int32Shape);
            m_body->op(Op::I32Eq);
            m_body->localGet(m_t1);
            m_body->i32Const(ContiguousShape);
            m_body->op(Op::I32Eq);
            m_body->op(Op::I32Or);
            m_body->ifThen(Hint::Likely);
            {
                loadPayload(bytecode.m_property);
                m_body->localTee(m_b);
                m_body->localGet(m_d);
                m_body->i32Load(JSObject::butterflyOffset());
                m_body->localTee(m_t2);
                m_body->i32Const(Butterfly::offsetOfPublicLength());
                m_body->op(Op::I32Add);
                m_body->i32Load(0);
                m_body->op(Op::I32LtU);
                m_body->ifThen(Hint::Likely);
                {
                    // Not a hole
                    m_body->localGet(m_t2);
                    m_body->localGet(m_b);
                    m_body->i32Const(3);
                    m_body->op(Op::I32Shl);
                    m_body->op(Op::I32Add);
                    m_body->localTee(m_c);
                    m_body->i32Load(TagOffset);
                    m_body->localTee(m_a);
                    m_body->i32Const(emptyTag);
                    m_body->op(Op::I32Ne);
                    m_body->ifThen(Hint::Likely);
                    m_body->localGet(m_c);
                    m_body->i32Load(PayloadOffset);
                    m_body->localSet(m_e);
                    storeTagAndPayload(bytecode.m_dst, m_a, m_e);
                    fastPathDone();
                    m_body->end();
                }
                m_body->end();
            }
            m_body->end();
        }
        m_body->end();
        m_body->localGet(m_next);
        m_body->op(Op::I32Eqz);
        m_body->ifThen(Hint::Unlikely);
    }
    loadTag(bytecode.m_base);
    loadPayload(bytecode.m_base);
    loadTag(bytecode.m_property);
    loadPayload(bytecode.m_property);
    registerAddress(bytecode.m_dst);
    m_body->call(helper(Helper::GetByVal));
    m_body->localSet(m_next);
    endFastPaths(getByValFromCompiledCode, instruction);
    if (inlineElement)
        m_body->end();
}

// (base tag, base payload, property tag, property payload, destination address) -> 1 when done
void Compiler::emitGetByValFunction()
{
    const ValueType parameters[] = { ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32 };
    emitFastPathFunction(parameters, [&] {
        getByValFastPaths(Operand::at(4), Operand::value(0, 1), Operand::value(2, 3));
    });
}

void Compiler::getByValFastPaths(const Operand& dst, const Operand& base, const Operand& property)
{
    auto shapeIs = [&](int32_t shape) {
        m_body->localGet(m_t1);
        m_body->i32Const(shape);
        m_body->op(Op::I32Eq);
    };
    auto below = [&](ptrdiff_t lengthOffset) {
        m_body->localGet(m_b);
        m_body->localGet(m_t2);
        m_body->i32Const(lengthOffset);
        m_body->op(Op::I32Add);
        m_body->i32Load(0);
        m_body->op(Op::I32LtU);
    };
    auto element = [&](int32_t base) {
        m_body->localGet(m_t2);
        m_body->localGet(m_b);
        m_body->i32Const(3);
        m_body->op(Op::I32Shl);
        m_body->op(Op::I32Add);
        if (base) {
            m_body->i32Const(base);
            m_body->op(Op::I32Add);
        }
        m_body->localSet(m_c);
    };
    auto storeUnlessHole = [&] {
        m_body->localGet(m_c);
        m_body->i32Load(TagOffset);
        m_body->localTee(m_a);
        m_body->i32Const(emptyTag);
        m_body->op(Op::I32Ne);
        m_body->ifThen();
        m_body->localGet(m_c);
        m_body->i32Load(PayloadOffset);
        m_body->localSet(m_e);
        storeTagAndPayload(dst, m_a, m_e);
        fastPathDone();
        m_body->end();
    };
    loadTag(base);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    loadTag(property);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32And);
    m_body->ifThen();
    {
        loadPayload(base);
        m_body->localTee(m_d);
        m_body->i32Load8U(JSCell::indexingTypeAndMiscOffset());
        m_body->i32Const(IndexingShapeMask);
        m_body->op(Op::I32And);
        m_body->localSet(m_t1);
        m_body->localGet(m_d);
        m_body->i32Load(JSObject::butterflyOffset());
        m_body->localSet(m_t2);
        loadPayload(property);
        m_body->localSet(m_b);

        // The shape first: without one there may be no butterfly
        shapeIs(Int32Shape);
        shapeIs(ContiguousShape);
        m_body->op(Op::I32Or);
        m_body->ifThen();
        below(Butterfly::offsetOfPublicLength());
        m_body->ifThen();
        element(0);
        storeUnlessHole();
        m_body->end();
        m_body->end();

        // A hole of a double butterfly is NaN
        shapeIs(DoubleShape);
        m_body->ifThen();
        below(Butterfly::offsetOfPublicLength());
        m_body->ifThen();
        element(0);
        m_body->localGet(m_c);
        m_body->f64Load(0);
        m_body->localTee(m_x);
        m_body->localGet(m_x);
        m_body->op(Op::F64Eq);
        m_body->ifThen();
        storeDouble(dst, m_x);
        fastPathDone();
        m_body->end();
        m_body->end();
        m_body->end();

        m_body->localGet(m_t1);
        m_body->i32Const(ArrayStorageShape);
        m_body->op(Op::I32Sub);
        m_body->i32Const(SlowPutArrayStorageShape - ArrayStorageShape);
        m_body->op(Op::I32LeU);
        m_body->ifThen();
        below(Butterfly::offsetOfVectorLength());
        m_body->ifThen();
        element(ArrayStorage::vectorOffset());
        storeUnlessHole();
        m_body->end();
        m_body->end();

        // Typed arrays like the interpreter, also a Uint32 above 2^31 (a double) and Float32
        typedArrayElement(m_d, m_b, [&](JSType type) {
            switch (type) {
            case Int8ArrayType: m_body->i32Load8S(0); break;
            case Uint8ArrayType: case Uint8ClampedArrayType: m_body->i32Load8U(0); break;
            case Int16ArrayType: m_body->i32Load16S(0); break;
            case Uint16ArrayType: m_body->i32Load16U(0); break;
            case Int32ArrayType: case Uint32ArrayType: m_body->i32Load(0); break;
            case Float32ArrayType:
                m_body->f32Load(0);
                m_body->op(Op::F64PromoteF32);
                break;
            case Float64ArrayType: m_body->f64Load(0); break;
            default: RELEASE_ASSERT_NOT_REACHED();
            }
            if (type == Float32ArrayType || type == Float64ArrayType) {
                // A NaN of other bits could look like a tag
                m_body->localTee(m_x);
                m_body->f64Const(PNaN);
                m_body->localGet(m_x);
                m_body->localGet(m_x);
                m_body->op(Op::F64Eq);
                m_body->select();
                m_body->localSet(m_x);
                storeDouble(dst, m_x);
                return;
            }
            m_body->localSet(m_c);
            if (type == Uint32ArrayType) {
                m_body->localGet(m_c);
                m_body->i32Const(0);
                m_body->op(Op::I32LtS);
                m_body->ifThen();
                m_body->localGet(m_c);
                m_body->op(Op::F64ConvertI32U);
                m_body->localSet(m_x);
                storeDouble(dst, m_x);
                m_body->elseThen();
                storeInt32(dst, m_c);
                m_body->end();
                return;
            }
            storeInt32(dst, m_c);
        });
    }
    m_body->end();

    // A string key: the VM's megamorphic cache (emitKeyedLoadFunction)
    loadTag(base);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    loadTag(property);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32And);
    m_body->ifThen();
    loadPayload(base);
    loadPayload(property);
    m_body->call(helper(Helper::KeyedLoad));
    m_body->localTee(m_c);
    m_body->ifThen();
    m_body->localGet(m_c);
    m_body->i32Load(TagOffset);
    m_body->localSet(m_a);
    m_body->localGet(m_c);
    m_body->i32Load(PayloadOffset);
    m_body->localSet(m_b);
    storeTagAndPayload(dst, m_a, m_b);
    fastPathDone();
    m_body->end();
    m_body->end();
}

// For an element of a typed array (not Float16, BigInt or resizable) at an index within its
// length: `access(type)` with the element's address pushed, then the fast path is done. Uses m_t1.
template<typename Access>
void Compiler::typedArrayElement(uint32_t viewLocal, uint32_t indexLocal, const Access& access)
{
    cellType(viewLocal);
    m_body->i32Const(FirstTypedArrayType);
    m_body->op(Op::I32Sub);
    m_body->localTee(m_t1);
    m_body->i32Const(NumberOfTypedArrayTypesExcludingBigIntArraysAndDataView);
    m_body->op(Op::I32LtU);
    m_body->ifThen();
    m_body->localGet(viewLocal);
    m_body->i32Load8U(JSArrayBufferView::offsetOfMode());
    m_body->i32Const(isResizableOrGrowableSharedMode);
    m_body->op(Op::I32And);
    m_body->op(Op::I32Eqz);
    m_body->localGet(indexLocal);
    m_body->localGet(viewLocal);
    m_body->i32Load(JSArrayBufferView::offsetOfLength());
    m_body->op(Op::I32LtU);
    m_body->op(Op::I32And);
    m_body->ifThen();
    for (JSType type : { Uint8ArrayType, Int32ArrayType, Float64ArrayType, Uint32ArrayType, Float32ArrayType, Int8ArrayType,
             Uint8ClampedArrayType, Int16ArrayType, Uint16ArrayType }) {
        m_body->localGet(m_t1);
        m_body->i32Const(type - FirstTypedArrayType);
        m_body->op(Op::I32Eq);
        m_body->ifThen();
        m_body->localGet(viewLocal);
        m_body->i32Load(JSArrayBufferView::offsetOfVector());
        m_body->localGet(indexLocal);
        m_body->i32Const(WTF::fastLog2(static_cast<unsigned>(elementSize(typedArrayType(type)))));
        m_body->op(Op::I32Shl);
        m_body->op(Op::I32Add);
        access(type);
        fastPathDone();
        m_body->end();
    }
    m_body->end();
    m_body->end();
}

// Like the interpreter: an int32 index into an int32 (an int32 value), double (a number, not
// NaN) or contiguous butterfly that is not copy on write, within its vector (growing the public
// length) ; the write barrier first
// Like reads: a site whose profile saw only int32 and contiguous butterflies within bounds writes
// an element within the public length inline (into an int32 one an int32 value), with the write
// barrier; anything else, and that site after a miss, calls the module's function
void Compiler::emitPutByVal(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpPutByVal>();
    bool inlineElement = profiledContiguousElements(bytecode.metadata(m_codeBlock).m_arrayProfile, true);
    if (inlineElement) {
        beginFastPaths();
        loadTag(bytecode.m_base);
        m_body->i32Const(cellTag);
        m_body->op(Op::I32Eq);
        loadTag(bytecode.m_property);
        m_body->i32Const(int32Tag);
        m_body->op(Op::I32Eq);
        m_body->op(Op::I32And);
        m_body->ifThen(Hint::Likely);
        {
            // An int32 butterfly and an int32 value, or a contiguous one; not copy-on-write
            loadPayload(bytecode.m_base);
            m_body->localTee(m_d);
            m_body->i32Load8U(JSCell::indexingTypeAndMiscOffset());
            m_body->i32Const(IndexingShapeMask | CopyOnWrite);
            m_body->op(Op::I32And);
            m_body->localTee(m_t1);
            m_body->i32Const(Int32Shape);
            m_body->op(Op::I32Eq);
            loadTag(bytecode.m_value);
            m_body->i32Const(int32Tag);
            m_body->op(Op::I32Eq);
            m_body->op(Op::I32And);
            m_body->localGet(m_t1);
            m_body->i32Const(ContiguousShape);
            m_body->op(Op::I32Eq);
            m_body->op(Op::I32Or);
            m_body->ifThen(Hint::Likely);
            {
                loadPayload(bytecode.m_property);
                m_body->localTee(m_b);
                m_body->localGet(m_d);
                m_body->i32Load(JSObject::butterflyOffset());
                m_body->localTee(m_t2);
                m_body->i32Const(Butterfly::offsetOfPublicLength());
                m_body->op(Op::I32Add);
                m_body->i32Load(0);
                m_body->op(Op::I32LtU);
                m_body->ifThen(Hint::Likely);
                {
                    writeBarrierOnOperands(bytecode.m_base, bytecode.m_value);
                    m_body->localGet(m_t2);
                    m_body->localGet(m_b);
                    m_body->i32Const(3);
                    m_body->op(Op::I32Shl);
                    m_body->op(Op::I32Add);
                    m_body->localTee(m_c);
                    loadTag(bytecode.m_value);
                    m_body->i32Store(TagOffset);
                    m_body->localGet(m_c);
                    loadPayload(bytecode.m_value);
                    m_body->i32Store(PayloadOffset);
                    fastPathDone();
                }
                m_body->end();
            }
            m_body->end();
        }
        m_body->end();
        m_body->localGet(m_next);
        m_body->op(Op::I32Eqz);
        m_body->ifThen(Hint::Unlikely);
    }
    m_body->localGet(cfr);
    loadTag(bytecode.m_base);
    loadPayload(bytecode.m_base);
    loadTag(bytecode.m_property);
    loadPayload(bytecode.m_property);
    loadTag(bytecode.m_value);
    loadPayload(bytecode.m_value);
    m_body->call(helper(Helper::PutByVal));
    m_body->localSet(m_next);
    endFastPaths(putByValFromCompiledCode, instruction);
    if (inlineElement)
        m_body->end();
}

// (frame, base tag and payload, property tag and payload, value tag and payload) -> 1 when done
void Compiler::emitPutByValFunction()
{
    const ValueType parameters[] = { ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32 };
    emitFastPathFunction(parameters, [&] {
        putByValFastPaths(Operand::value(1, 2), Operand::value(3, 4), Operand::value(5, 6));
    });
}

void Compiler::putByValFastPaths(const Operand& base, const Operand& property, const Operand& value)
{
    auto shapeIs = [&](int32_t shape) {
        m_body->localGet(m_t1);
        m_body->i32Const(shape);
        m_body->op(Op::I32Eq);
    };
    auto length = [&](ptrdiff_t offset) {
        m_body->localGet(m_t2);
        m_body->i32Const(offset);
        m_body->op(Op::I32Add);
    };
    writeBarrierOnOperands(base, value);
    loadTag(base);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    loadTag(property);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32And);
    m_body->ifThen();
    {
        loadPayload(base);
        m_body->localTee(m_d);
        m_body->i32Load8U(JSCell::indexingTypeAndMiscOffset());
        m_body->localTee(m_t1);
        m_body->i32Const(CopyOnWrite);
        m_body->op(Op::I32And);
        m_body->op(Op::I32Eqz);
        m_body->localGet(m_t1);
        m_body->i32Const(IndexingShapeMask);
        m_body->op(Op::I32And);
        m_body->localSet(m_t1);
        loadTag(value);
        m_body->localSet(m_a);
        loadNumber(value, m_a);
        m_body->localSet(m_x);
        // The value fits the shape
        shapeIs(Int32Shape);
        m_body->localGet(m_a);
        m_body->i32Const(int32Tag);
        m_body->op(Op::I32Eq);
        m_body->op(Op::I32And);
        shapeIs(DoubleShape);
        isNumberTag(m_a);
        m_body->op(Op::I32And);
        m_body->localGet(m_x);
        m_body->localGet(m_x);
        m_body->op(Op::F64Eq);
        m_body->op(Op::I32And);
        m_body->op(Op::I32Or);
        shapeIs(ContiguousShape);
        m_body->op(Op::I32Or);
        m_body->op(Op::I32And);
        m_body->localSet(m_e);
        m_body->localGet(m_e);
        m_body->ifThen();
        {
            m_body->localGet(m_d);
            m_body->i32Load(JSObject::butterflyOffset());
            m_body->localSet(m_t2);
            loadPayload(property);
            m_body->localTee(m_b);
            length(Butterfly::offsetOfPublicLength());
            m_body->i32Load(0);
            m_body->op(Op::I32GeU);
            m_body->ifThen();
            {
                // Past the public length but within the vector: the length grows
                m_body->localGet(m_b);
                length(Butterfly::offsetOfVectorLength());
                m_body->i32Load(0);
                m_body->op(Op::I32LtU);
                m_body->localTee(m_e);
                m_body->ifThen();
                length(Butterfly::offsetOfPublicLength());
                m_body->localGet(m_b);
                m_body->i32Const(1);
                m_body->op(Op::I32Add);
                m_body->i32Store(0);
                m_body->end();
            }
            m_body->end();
            m_body->localGet(m_e);
            m_body->ifThen();
            {
                m_body->localGet(m_t2);
                m_body->localGet(m_b);
                m_body->i32Const(3);
                m_body->op(Op::I32Shl);
                m_body->op(Op::I32Add);
                m_body->localSet(m_c);
                shapeIs(DoubleShape);
                m_body->ifThen();
                m_body->localGet(m_c);
                m_body->localGet(m_x);
                m_body->f64Store(0);
                m_body->elseThen();
                m_body->localGet(m_c);
                m_body->localGet(m_a);
                m_body->i32Store(TagOffset);
                m_body->localGet(m_c);
                loadPayload(value);
                m_body->i32Store(PayloadOffset);
                m_body->end();
                fastPathDone();
            }
            m_body->end();
        }
        m_body->end();

        // A number into a typed array, converted like the interpreter does: ToInt32 (inline when
        // it converts), clamped and rounded to even for Uint8Clamped, rounded for Float32
        m_body->localGet(m_next);
        m_body->op(Op::I32Eqz);
        isNumberTag(m_a);
        m_body->op(Op::I32And);
        m_body->ifThen();
        toInt32(value, m_a, m_e, m_x);
        m_body->localSet(m_c);
        loadPayload(property);
        m_body->localSet(m_b);
        typedArrayElement(m_d, m_b, [&](JSType type) {
            m_body->localSet(m_t2);
            switch (type) {
            case Float32ArrayType:
                m_body->localGet(m_t2);
                m_body->localGet(m_x);
                m_body->op(Op::F32DemoteF64);
                m_body->f32Store(0);
                return;
            case Float64ArrayType:
                m_body->localGet(m_t2);
                m_body->localGet(m_x);
                m_body->f64Store(0);
                return;
            case Uint8ClampedArrayType:
                m_body->localGet(m_t2);
                m_body->localGet(m_x);
                m_body->op(Op::F64Nearest);
                m_body->prefixedOp(Op::I32TruncSatF64U);
                m_body->localTee(m_e);
                m_body->i32Const(255);
                m_body->localGet(m_e);
                m_body->i32Const(255);
                m_body->op(Op::I32LeU);
                m_body->select();
                m_body->i32Store8(0);
                return;
            default:
                break;
            }
            // The other conversions need the int32, else the slow path
            m_body->localGet(m_c);
            m_body->op(Op::I32Eqz);
            m_body->brIf(0);
            m_body->localGet(m_t2);
            m_body->localGet(m_e);
            switch (type) {
            case Int8ArrayType: case Uint8ArrayType: m_body->i32Store8(0); break;
            case Int16ArrayType: case Uint16ArrayType: m_body->i32Store16(0); break;
            case Int32ArrayType: case Uint32ArrayType: m_body->i32Store(0); break;
            default: RELEASE_ASSERT_NOT_REACHED();
            }
        });
        m_body->end();
    }
    m_body->end();

    // A string key: the VM's megamorphic cache (emitKeyedStoreFunction), the write barrier again
    // after a transition
    loadTag(base);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    loadTag(property);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32And);
    m_body->ifThen();
    loadPayload(base);
    m_body->localTee(m_d);
    loadPayload(property);
    loadTag(value);
    loadPayload(value);
    m_body->call(helper(Helper::KeyedStore));
    m_body->localTee(m_e);
    m_body->ifThen();
    m_body->localGet(m_e);
    m_body->i32Const(2);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    writeBarrier(m_d);
    m_body->end();
    fastPathDone();
    m_body->end();
    m_body->end();
}

void Compiler::tagInto(VirtualRegister reg, uint32_t tagLocal)
{
    if (reg.isConstant())
        return;
    loadTag(reg);
    m_body->localSet(tagLocal);
}

void Compiler::pushTag(VirtualRegister reg, uint32_t tagLocal)
{
    if (reg.isConstant())
        loadTag(reg);
    else
        m_body->localGet(tagLocal);
}

void Compiler::bothInt32(VirtualRegister lhs, uint32_t lhsTag, VirtualRegister rhs, uint32_t rhsTag)
{
    // The int32 tag has every bit set
    static_assert(int32Tag == -1);
    unsigned unknown = 0;
    for (auto reg : { lhs, rhs }) {
        if (!reg.isConstant())
            ++unknown;
        else if (!m_codeBlock->getConstant(reg).isInt32()) {
            m_body->i32Const(0);
            return;
        }
    }
    if (!unknown) {
        m_body->i32Const(1);
        return;
    }
    if (!lhs.isConstant())
        m_body->localGet(lhsTag);
    if (!rhs.isConstant())
        m_body->localGet(rhsTag);
    if (unknown == 2)
        m_body->op(Op::I32And);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
}

void Compiler::jumpIf(unsigned targetOffset, unsigned fromBlock)
{
    unsigned target = m_blockAt.get(targetOffset);
    if (target > fromBlock) {
        m_body->brIf(m_body->depth() - m_blockDepth + target - fromBlock - 1);
        return;
    }
    m_body->ifThen();
    jumpTo(targetOffset, fromBlock);
    m_body->end();
}

void Compiler::callOutOfLine(const JSInstructionStream::Ref& instruction, VirtualRegister lhs, uint32_t lhsTag, VirtualRegister rhs, uint32_t rhsTag, std::optional<VirtualRegister> dst)
{
    bool isJump = !dst;
    m_body->localGet(cfr);
    m_body->i32Const(reinterpret_cast<uintptr_t>(instruction.ptr()));
    pushTag(lhs, lhsTag);
    loadPayload(lhs);
    pushTag(rhs, rhsTag);
    loadPayload(rhs);
    if (dst)
        registerAddress(*dst);
    m_body->call(helper(Helper::OutOfLine, instruction->opcodeID()));
    // A value's status is not 0 only after an exception
    if (isJump) {
        m_body->localTee(m_next);
        m_body->i32Const(outOfLineException);
        m_body->op(Op::I32Eq);
    }
    if (m_codeBlock->handlerForBytecodeIndex(BytecodeIndex(instruction.offset()))) {
        m_body->ifThen(Hint::Unlikely);
        exceptionExit(instruction);
        m_body->end();
    } else {
        // Out through the block around everything, which returns 1
        m_body->brIf(m_body->depth() - 1, Hint::Unlikely);
    }
    if (isJump)
        m_body->localGet(m_next);
}

// Equal lengths of two 8-bit strings up to this many characters compare in WASM, longer ones in C++
constexpr unsigned maximumInlineStringComparison = 64;

void Compiler::stringCharacters(uint32_t stringLocal, uint32_t dataLocal, uint32_t lengthLocal, uint32_t is8BitLocal)
{
    static_assert(JSRopeString::is8BitInPointer == StringImpl::flagIs8Bit());
    m_body->localGet(stringLocal);
    m_body->i32Load(JSString::offsetOfValue());
    m_body->localTee(m_g);
    m_body->i32Const(JSString::isRopeInPointer);
    m_body->op(Op::I32And);
    m_body->ifThen();
    {
        // A substring: the characters of its base (no rope) from its offset
        m_body->localGet(m_g);
        m_body->i32Const(JSRopeString::isSubstringInPointer);
        m_body->op(Op::I32And);
        m_body->op(Op::I32Eqz);
        m_body->brIf(1);
        m_body->localGet(m_g);
        m_body->i32Const(JSRopeString::is8BitInPointer);
        m_body->op(Op::I32And);
        m_body->localSet(is8BitLocal);
        m_body->localGet(stringLocal);
        m_body->i32Load(JSRopeString::offsetOfLength());
        m_body->localSet(lengthLocal);
        m_body->localGet(stringLocal);
        m_body->i32Load(JSRopeString::offsetOfFiber1());
        m_body->i32Load(JSString::offsetOfValue());
        m_body->i32Load(StringImpl::dataOffset());
        m_body->localGet(stringLocal);
        m_body->i32Load(JSRopeString::offsetOfFiber2());
        m_body->localGet(is8BitLocal);
        m_body->op(Op::I32Eqz);
        m_body->op(Op::I32Shl);
        m_body->op(Op::I32Add);
        m_body->localSet(dataLocal);
    }
    m_body->elseThen();
    {
        m_body->localGet(m_g);
        m_body->i32Load(StringImpl::lengthMemoryOffset());
        m_body->localSet(lengthLocal);
        m_body->localGet(m_g);
        m_body->i32Load(StringImpl::flagsOffset());
        m_body->i32Const(StringImpl::flagIs8Bit());
        m_body->op(Op::I32And);
        m_body->localSet(is8BitLocal);
        m_body->localGet(m_g);
        m_body->i32Load(StringImpl::dataOffset());
        m_body->localSet(dataLocal);
    }
    m_body->end();
}

void Compiler::emitOutOfLineFunction(OpcodeID opcode)
{
    enum class Kind : uint8_t { Arithmetic, Divide, Bits, Compare, Equality };
    Kind kind = Kind::Compare;
    bool isJump = false, negate = false, strict = false;
    uint8_t f64Op = 0, i32Op = 0;
    switch (opcode) {
    case op_add: kind = Kind::Arithmetic; f64Op = Op::F64Add; break;
    case op_sub: kind = Kind::Arithmetic; f64Op = Op::F64Sub; break;
    case op_mul: kind = Kind::Arithmetic; f64Op = Op::F64Mul; break;
    case op_div: kind = Kind::Divide; break;
    case op_bitand: kind = Kind::Bits; i32Op = Op::I32And; break;
    case op_bitor: kind = Kind::Bits; i32Op = Op::I32Or; break;
    case op_bitxor: kind = Kind::Bits; i32Op = Op::I32Xor; break;
    case op_lshift: kind = Kind::Bits; i32Op = Op::I32Shl; break;
    case op_rshift: kind = Kind::Bits; i32Op = Op::I32ShrS; break;
    case op_urshift: kind = Kind::Bits; i32Op = Op::I32ShrU; break;
    case op_jless: isJump = true; [[fallthrough]];
    case op_less: f64Op = Op::F64Lt; break;
    case op_jlesseq: isJump = true; [[fallthrough]];
    case op_lesseq: f64Op = Op::F64Le; break;
    case op_jgreater: isJump = true; [[fallthrough]];
    case op_greater: f64Op = Op::F64Gt; break;
    case op_jgreatereq: isJump = true; [[fallthrough]];
    case op_greatereq: f64Op = Op::F64Ge; break;
    case op_jnless: isJump = negate = true; f64Op = Op::F64Lt; break;
    case op_jnlesseq: isJump = negate = true; f64Op = Op::F64Le; break;
    case op_jngreater: isJump = negate = true; f64Op = Op::F64Gt; break;
    case op_jngreatereq: isJump = negate = true; f64Op = Op::F64Ge; break;
    case op_jeq: isJump = true; [[fallthrough]];
    case op_eq: kind = Kind::Equality; break;
    case op_jneq: isJump = true; [[fallthrough]];
    case op_neq: kind = Kind::Equality; negate = true; break;
    case op_jstricteq: isJump = true; [[fallthrough]];
    case op_stricteq: kind = Kind::Equality; strict = true; break;
    case op_jnstricteq: isJump = true; [[fallthrough]];
    case op_nstricteq: kind = Kind::Equality; strict = negate = true; break;
    default: RELEASE_ASSERT_NOT_REACHED();
    }
    constexpr uint32_t frame = 0, instructionLocal = 1, lhsTag = 2, lhsPayload = 3, rhsTag = 4, rhsPayload = 5;
    const Operand lhs = Operand::value(lhsTag, lhsPayload), rhs = Operand::value(rhsTag, rhsPayload), dst = Operand::at(6);
    const ValueType parameters[] = { ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32 };
    emitFastPathFunction(std::span(parameters).first(isJump ? 6 : 7), [&] {
        auto done = [&] {
            m_body->i32Const(outOfLineDone);
            m_body->returnValue();
        };
        // The boolean in m_c: a jump's status or the value of the destination
        auto finish = [&] {
            if (isJump) {
                m_body->localGet(m_c);
                m_body->returnValue();
                return;
            }
            storeBoolean(dst, m_c);
            done();
        };
        auto bothNumbers = [&] {
            isNumberTag(lhsTag);
            isNumberTag(rhsTag);
            m_body->op(Op::I32And);
        };
        auto numbers = [&](uint8_t op) {
            loadNumber(lhs, lhsTag);
            loadNumber(rhs, rhsTag);
            m_body->op(op);
        };
        switch (kind) {
        case Kind::Arithmetic:
            bothNumbers();
            m_body->ifThen();
            numbers(f64Op);
            m_body->localSet(m_x);
            storeDouble(dst, m_x);
            done();
            m_body->end();
            break;
        case Kind::Divide:
            // A result that is an int32 (not -0) as one, like the interpreter
            bothNumbers();
            m_body->ifThen();
            numbers(Op::F64Div);
            m_body->localTee(m_x);
            m_body->prefixedOp(Op::I32TruncSatF64S);
            m_body->localTee(m_c);
            m_body->op(Op::F64ConvertI32S);
            m_body->localGet(m_x);
            m_body->op(Op::F64Eq);
            m_body->localGet(m_c);
            m_body->i32Const(0);
            m_body->op(Op::I32Ne);
            m_body->op(Op::I32And);
            m_body->ifThen();
            storeInt32(dst, m_c);
            m_body->elseThen();
            storeDouble(dst, m_x);
            m_body->end();
            done();
            m_body->end();
            break;
        case Kind::Bits:
            toInt32(lhs, lhsTag, m_a, m_x);
            toInt32(rhs, rhsTag, m_b, m_y);
            m_body->op(Op::I32And);
            m_body->ifThen();
            m_body->localGet(m_a);
            m_body->localGet(m_b);
            m_body->op(i32Op);
            m_body->localSet(m_c);
            storeInt32(dst, m_c);
            done();
            m_body->end();
            break;
        case Kind::Compare:
            bothNumbers();
            m_body->ifThen();
            numbers(f64Op);
            if (negate)
                m_body->op(Op::I32Eqz);
            m_body->localSet(m_c);
            finish();
            m_body->end();
            break;
        case Kind::Equality: {
            auto known = [&](bool equal) {
                m_body->i32Const(equal != negate);
                m_body->localSet(m_c);
                finish();
            };
            auto compare = [&](uint32_t first, uint32_t second) {
                m_body->localGet(first);
                m_body->localGet(second);
                m_body->op(negate ? Op::I32Ne : Op::I32Eq);
                m_body->localSet(m_c);
                finish();
            };
            // The same tag, no double
            m_body->localGet(lhsTag);
            m_body->localGet(rhsTag);
            m_body->op(Op::I32Eq);
            m_body->localGet(lhsTag);
            m_body->i32Const(lowestTag);
            m_body->op(Op::I32GeU);
            m_body->op(Op::I32And);
            m_body->ifThen();
            {
                m_body->localGet(lhsTag);
                m_body->i32Const(cellTag);
                m_body->op(Op::I32Ne);
                m_body->ifThen();
                compare(lhsPayload, rhsPayload);
                m_body->end();
                // Two cells: one is equal to itself (a string, a symbol or a BigInt too)
                m_body->localGet(lhsPayload);
                m_body->localGet(rhsPayload);
                m_body->op(Op::I32Eq);
                m_body->ifThen();
                known(true);
                m_body->end();
                // An object only to itself: for === if either is one, for == if both are
                cellType(lhsPayload);
                m_body->i32Const(ObjectType);
                m_body->op(Op::I32GeU);
                cellType(rhsPayload);
                m_body->i32Const(ObjectType);
                m_body->op(Op::I32GeU);
                m_body->op(strict ? Op::I32Or : Op::I32And);
                m_body->ifThen();
                known(false);
                m_body->end();
                // Two strings: no ropes of the same text or two atoms compare as pointers
                cellType(lhsPayload);
                m_body->i32Const(StringType);
                m_body->op(Op::I32Eq);
                cellType(rhsPayload);
                m_body->i32Const(StringType);
                m_body->op(Op::I32Eq);
                m_body->op(Op::I32And);
                m_body->ifThen();
                {
                    m_body->localGet(lhsPayload);
                    m_body->i32Load(JSString::offsetOfValue());
                    m_body->localTee(m_a);
                    m_body->localGet(rhsPayload);
                    m_body->i32Load(JSString::offsetOfValue());
                    m_body->localTee(m_b);
                    m_body->op(Op::I32Or);
                    m_body->i32Const(JSString::isRopeInPointer);
                    m_body->op(Op::I32And);
                    m_body->op(Op::I32Eqz);
                    m_body->ifThen();
                    {
                        m_body->localGet(m_a);
                        m_body->localGet(m_b);
                        m_body->op(Op::I32Eq);
                        m_body->localGet(m_a);
                        m_body->i32Load(StringImpl::flagsOffset());
                        m_body->localGet(m_b);
                        m_body->i32Load(StringImpl::flagsOffset());
                        m_body->op(Op::I32And);
                        m_body->i32Const(StringImpl::flagIsAtom());
                        m_body->op(Op::I32And);
                        m_body->op(Op::I32Or);
                        m_body->ifThen();
                        compare(m_a, m_b);
                        m_body->end();
                    }
                    m_body->end();
                    // Strings made at run time (decoded text, substrings, which are ropes of a
                    // part of another string) against atoms: of another length unequal, the same
                    // characters equal, two short 8-bit ones compared here byte by byte
                    m_body->block();
                    stringCharacters(lhsPayload, m_a, m_d, m_t1);
                    stringCharacters(rhsPayload, m_b, m_e, m_t2);
                    m_body->localGet(m_d);
                    m_body->localGet(m_e);
                    m_body->op(Op::I32Ne);
                    m_body->ifThen();
                    known(false);
                    m_body->end();
                    m_body->localGet(m_a);
                    m_body->localGet(m_b);
                    m_body->op(Op::I32Eq);
                    m_body->localGet(m_t1);
                    m_body->localGet(m_t2);
                    m_body->op(Op::I32Eq);
                    m_body->op(Op::I32And);
                    m_body->ifThen();
                    known(true);
                    m_body->end();
                    m_body->localGet(m_t1);
                    m_body->localGet(m_t2);
                    m_body->op(Op::I32And);
                    m_body->localGet(m_d);
                    m_body->i32Const(maximumInlineStringComparison);
                    m_body->op(Op::I32LeU);
                    m_body->op(Op::I32And);
                    m_body->ifThen();
                    {
                        m_body->block();
                        m_body->loop();
                        m_body->localGet(m_d);
                        m_body->op(Op::I32Eqz);
                        m_body->brIf(1);
                        m_body->localGet(m_d);
                        m_body->i32Const(1);
                        m_body->op(Op::I32Sub);
                        m_body->localSet(m_d);
                        m_body->localGet(m_a);
                        m_body->localGet(m_d);
                        m_body->op(Op::I32Add);
                        m_body->i32Load8U(0);
                        m_body->localGet(m_b);
                        m_body->localGet(m_d);
                        m_body->op(Op::I32Add);
                        m_body->i32Load8U(0);
                        m_body->op(Op::I32Ne);
                        m_body->ifThen();
                        known(false);
                        m_body->end();
                        m_body->br(0);
                        m_body->end();
                        m_body->end();
                        known(true);
                    }
                    m_body->end();
                    m_body->end();
                }
                m_body->end();
            }
            m_body->end();
            bothNumbers();
            m_body->ifThen();
            numbers(negate ? Op::F64Ne : Op::F64Eq);
            m_body->localSet(m_c);
            finish();
            m_body->end();
            break;
        }
        }
        m_body->localGet(frame);
        m_body->localGet(instructionLocal);
        m_body->i32Const(reinterpret_cast<uintptr_t>(outOfLineSlowPathOf(opcode)));
        m_body->callIndirect(m_slowPathType);
        m_body->op(Op::I32WrapI64);
        m_body->localSet(m_next);
    });
}

// add, sub, mul: two int32 in 64 bit, the result back if it fits (and is no -0 for mul); other
// numbers (and int32 results that do not fit) as doubles out of line
template<typename Bytecode>
void Compiler::emitArithmetic(const JSInstructionStream::Ref& instruction, uint8_t i64Op)
{
    auto bytecode = instruction->as<Bytecode>();
    bool isMul = i64Op == Op::I64Mul;
    tagInto(bytecode.m_lhs, m_t1);
    tagInto(bytecode.m_rhs, m_t2);
    m_body->block();
    bothInt32(bytecode.m_lhs, m_t1, bytecode.m_rhs, m_t2);
    m_body->ifThen(Hint::Likely);
    {
        loadPayload(bytecode.m_lhs);
        if (isMul)
            m_body->localTee(m_a);
        m_body->op(Op::I64ExtendI32S);
        loadPayload(bytecode.m_rhs);
        if (isMul)
            m_body->localTee(m_b);
        m_body->op(Op::I64ExtendI32S);
        m_body->op(i64Op);
        m_body->localTee(m_wide);
        m_body->op(Op::I32WrapI64);
        m_body->localTee(m_c);
        // fits: sign extension of the low 32 bits is the whole result
        m_body->op(Op::I64ExtendI32S);
        m_body->localGet(m_wide);
        m_body->op(Op::I64Eq);
        if (isMul) {
            // and no -0: a zero result from a negative factor
            m_body->localGet(m_c);
            m_body->op(Op::I32Eqz);
            m_body->localGet(m_a);
            m_body->localGet(m_b);
            m_body->op(Op::I32Or);
            m_body->i32Const(0);
            m_body->op(Op::I32LtS);
            m_body->op(Op::I32And);
            m_body->op(Op::I32Eqz);
            m_body->op(Op::I32And);
        }
        m_body->ifThen(Hint::Likely);
        storeInt32(bytecode.m_dst, m_c);
        // Past the out-of-line call
        m_body->br(2);
        m_body->end();
    }
    m_body->end();
    callOutOfLine(instruction, bytecode.m_lhs, m_t1, bytecode.m_rhs, m_t2, bytecode.m_dst);
    m_body->end();
}

// Numbers as doubles, out of line
void Compiler::emitDivide(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpDiv>();
    tagInto(bytecode.m_lhs, m_t1);
    tagInto(bytecode.m_rhs, m_t2);
    callOutOfLine(instruction, bytecode.m_lhs, m_t1, bytecode.m_rhs, m_t2, bytecode.m_dst);
}

// ToInt32 of a number register (its tag in the local): pushes whether it converts inline (an int32,
// NaN or a double of less than 2^63 in magnitude, which i64.trunc_sat makes exact), the int32 into
// `resultLocal`, the register as f64 through `doubleLocal`
void Compiler::toInt32(const Operand& operand, uint32_t tagLocal, uint32_t resultLocal, uint32_t doubleLocal)
{
    if (operand.isConstant() && m_codeBlock->getConstant(operand.reg).isNumber()) {
        double value = m_codeBlock->getConstant(operand.reg).asNumber();
        m_body->f64Const(value);
        m_body->localSet(doubleLocal);
        m_body->i32Const(JSC::toInt32(value));
        m_body->localSet(resultLocal);
        m_body->i32Const(1);
        return;
    }
    loadNumber(operand, tagLocal);
    m_body->localTee(doubleLocal);
    m_body->prefixedOp(Op::I64TruncSatF64S);
    m_body->op(Op::I32WrapI64);
    m_body->localSet(resultLocal);
    isNumberTag(tagLocal);
    m_body->localGet(doubleLocal);
    m_body->op(Op::F64Abs);
    m_body->f64Const(0x1p63);
    m_body->op(Op::F64Ge);
    m_body->op(Op::I32Eqz);
    m_body->op(Op::I32And);
}

// bitand, bitor, bitxor, lshift, rshift, urshift: two int32, other numbers through ToInt32 out of
// line (hashes mix in uint32 values above 2^31, which are doubles). urshift's result is the int32
// of its bits like in the interpreter, op_unsigned after it makes the number.
template<typename Bytecode>
void Compiler::emitBitOp(const JSInstructionStream::Ref& instruction, uint8_t i32Op)
{
    auto bytecode = instruction->as<Bytecode>();
    tagInto(bytecode.m_lhs, m_t1);
    tagInto(bytecode.m_rhs, m_t2);
    bothInt32(bytecode.m_lhs, m_t1, bytecode.m_rhs, m_t2);
    m_body->ifThen();
    storeTagWithPayload(bytecode.m_dst, int32Tag, [&] {
        loadPayload(bytecode.m_lhs);
        loadPayload(bytecode.m_rhs);
        m_body->op(i32Op);
    });
    m_body->elseThen();
    callOutOfLine(instruction, bytecode.m_lhs, m_t1, bytecode.m_rhs, m_t2, bytecode.m_dst);
    m_body->end();
}

// less, lesseq, ... into a boolean or a jump (negated for jnless and the like, which jump also
// for NaN): int32 inline, doubles and the rest out of line
template<typename Bytecode>
void Compiler::emitCompare(const JSInstructionStream::Ref& instruction, unsigned block, uint8_t i32Op)
{
    auto bytecode = instruction->as<Bytecode>();
    constexpr bool isJump = requires { bytecode.m_targetLabel; };
    constexpr bool negate = std::is_same_v<Bytecode, OpJnless> || std::is_same_v<Bytecode, OpJnlesseq> || std::is_same_v<Bytecode, OpJngreater> || std::is_same_v<Bytecode, OpJngreatereq>;
    tagInto(bytecode.m_lhs, m_t1);
    tagInto(bytecode.m_rhs, m_t2);
    auto compare = [&] {
        loadPayload(bytecode.m_lhs);
        loadPayload(bytecode.m_rhs);
        m_body->op(i32Op);
        if (negate)
            m_body->op(Op::I32Eqz);
    };
    bothInt32(bytecode.m_lhs, m_t1, bytecode.m_rhs, m_t2);
    if constexpr (isJump) {
        m_body->ifThen(ValueType::I32, Hint::Likely);
        compare();
        m_body->elseThen();
        callOutOfLine(instruction, bytecode.m_lhs, m_t1, bytecode.m_rhs, m_t2, std::nullopt);
        m_body->end();
        jumpIf(targetOf(instruction, bytecode.m_targetLabel.target()), block);
    } else {
        m_body->ifThen(Hint::Likely);
        storeTagWithPayload(bytecode.m_dst, booleanTag, compare);
        m_body->elseThen();
        callOutOfLine(instruction, bytecode.m_lhs, m_t1, bytecode.m_rhs, m_t2, bytecode.m_dst);
        m_body->end();
    }
}

// eq, neq, stricteq, nstricteq into a boolean or a jump: two int32, booleans, undefined or null
// compare their payloads inline, the rest (cells, doubles, mixed tags) out of line
template<typename Bytecode>
void Compiler::emitEquality(const JSInstructionStream::Ref& instruction, unsigned block, bool negate)
{
    auto bytecode = instruction->as<Bytecode>();
    constexpr bool isJump = requires { bytecode.m_targetLabel; };
    static_assert(JSValue::UndefinedTag < JSValue::NullTag && JSValue::NullTag < JSValue::BooleanTag && JSValue::BooleanTag < JSValue::Int32Tag && JSValue::CellTag < JSValue::UndefinedTag);
    constexpr int32_t lowestPayloadTag = static_cast<int32_t>(JSValue::UndefinedTag);
    tagInto(bytecode.m_lhs, m_t1);
    tagInto(bytecode.m_rhs, m_t2);
    auto callOutOfLineAndJump = [&] {
        if constexpr (isJump) {
            callOutOfLine(instruction, bytecode.m_lhs, m_t1, bytecode.m_rhs, m_t2, std::nullopt);
            jumpIf(targetOf(instruction, bytecode.m_targetLabel.target()), block);
        } else
            callOutOfLine(instruction, bytecode.m_lhs, m_t1, bytecode.m_rhs, m_t2, bytecode.m_dst);
    };
    // Whether the inline path takes them: the same tag of a value that is its payload
    std::optional<int32_t> constantTag;
    for (auto reg : { bytecode.m_lhs, bytecode.m_rhs }) {
        if (reg.isConstant())
            constantTag = static_cast<int32_t>(m_codeBlock->getConstant(reg).tag());
    }
    if (bytecode.m_lhs.isConstant() && bytecode.m_rhs.isConstant()) {
        callOutOfLineAndJump();
        return;
    }
    if (constantTag) {
        if (static_cast<uint32_t>(*constantTag) < static_cast<uint32_t>(lowestPayloadTag)) {
            callOutOfLineAndJump();
            return;
        }
        m_body->localGet(bytecode.m_lhs.isConstant() ? m_t2 : m_t1);
        m_body->i32Const(*constantTag);
        m_body->op(Op::I32Eq);
    } else {
        m_body->localGet(m_t1);
        m_body->localGet(m_t2);
        m_body->op(Op::I32Eq);
        m_body->localGet(m_t1);
        m_body->i32Const(lowestPayloadTag);
        m_body->op(Op::I32GeU);
        m_body->op(Op::I32And);
    }
    auto compare = [&] {
        loadPayload(bytecode.m_lhs);
        loadPayload(bytecode.m_rhs);
        m_body->op(negate ? Op::I32Ne : Op::I32Eq);
    };
    if constexpr (isJump) {
        m_body->ifThen(ValueType::I32);
        compare();
        m_body->elseThen();
        callOutOfLine(instruction, bytecode.m_lhs, m_t1, bytecode.m_rhs, m_t2, std::nullopt);
        m_body->end();
        jumpIf(targetOf(instruction, bytecode.m_targetLabel.target()), block);
    } else {
        m_body->ifThen();
        storeTagWithPayload(bytecode.m_dst, booleanTag, compare);
        m_body->elseThen();
        callOutOfLine(instruction, bytecode.m_lhs, m_t1, bytecode.m_rhs, m_t2, bytecode.m_dst);
        m_body->end();
    }
}

void Compiler::emitToBoolean(const Operand& operand)
{
    auto tagIs = [&](int32_t tag) {
        m_body->localGet(m_t1);
        m_body->i32Const(tag);
        m_body->op(Op::I32Eq);
    };
    load(operand, m_t1, m_a);
    m_body->localGet(m_a);
    m_body->i32Const(0);
    m_body->op(Op::I32Ne);
    m_body->localSet(m_c);
    tagIs(int32Tag);
    tagIs(booleanTag);
    m_body->op(Op::I32Or);
    m_body->localSet(m_e);
    m_body->localGet(m_t1);
    m_body->i32Const(1);
    m_body->op(Op::I32Or);
    m_body->i32Const(static_cast<int32_t>(JSValue::NullTag));
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    m_body->i32Const(0);
    m_body->localSet(m_c);
    m_body->i32Const(1);
    m_body->localSet(m_e);
    m_body->end();
    tagIs(cellTag);
    m_body->ifThen();
    cellType(m_a);
    m_body->i32Const(ObjectType);
    m_body->op(Op::I32GeU);
    m_body->localGet(m_a);
    m_body->i32Load8U(JSCell::typeInfoFlagsOffset());
    m_body->i32Const(MasqueradesAsUndefined);
    m_body->op(Op::I32And);
    m_body->op(Op::I32Eqz);
    m_body->op(Op::I32And);
    m_body->localTee(m_e);
    m_body->localSet(m_c);
    // Only the empty string is false, and every empty string is the VM's one (which JSC's own
    // JITs rely on too)
    cellType(m_a);
    m_body->i32Const(StringType);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    m_body->localGet(m_a);
    m_body->i32Const(static_cast<int32_t>(reinterpret_cast<uintptr_t>(jsEmptyString(m_codeBlock->vm()))));
    m_body->op(Op::I32Ne);
    m_body->localSet(m_c);
    m_body->i32Const(1);
    m_body->localSet(m_e);
    m_body->end();
    m_body->end();
    // A double: neither 0, -0 nor NaN
    m_body->localGet(m_t1);
    m_body->i32Const(lowestTag);
    m_body->op(Op::I32LtU);
    m_body->ifThen();
    loadNumber(operand, m_t1);
    m_body->localTee(m_x);
    m_body->f64Const(0);
    m_body->op(Op::F64Lt);
    m_body->localGet(m_x);
    m_body->f64Const(0);
    m_body->op(Op::F64Gt);
    m_body->op(Op::I32Or);
    m_body->localSet(m_c);
    m_body->i32Const(1);
    m_body->localSet(m_e);
    m_body->end();
}

void Compiler::emitToBooleanFunction()
{
    const ValueType parameters[] = { ValueType::I32, ValueType::I32 };
    emitFastPathFunction(parameters, [&] {
        emitToBoolean(Operand::value(0, 1));
        m_body->localGet(m_e);
        m_body->ifThen(ValueType::I32);
        m_body->localGet(m_c);
        m_body->elseThen();
        m_body->i32Const(reinterpret_cast<uintptr_t>(m_codeBlock->globalObject()));
        m_body->localGet(0);
        m_body->localGet(1);
        m_body->i32Const(reinterpret_cast<uintptr_t>(&toBooleanFromCompiledCode));
        m_body->callIndirect(m_toBooleanType);
        m_body->end();
        m_body->localSet(m_next);
    });
}

void Compiler::toBoolean(VirtualRegister reg)
{
    if (reg.isConstant()) {
        TriState known = m_codeBlock->getConstant(reg).pureToBoolean();
        if (known != TriState::Indeterminate) {
            m_body->i32Const(known == TriState::True);
            return;
        }
    }
    // An int32 or a boolean: the payload
    static_assert(booleanTag == int32Tag - 1);
    loadTag(reg);
    m_body->localTee(m_t1);
    m_body->i32Const(booleanTag);
    m_body->op(Op::I32GeU);
    m_body->ifThen(ValueType::I32);
    loadPayload(reg);
    m_body->elseThen();
    m_body->localGet(m_t1);
    loadPayload(reg);
    m_body->call(helper(Helper::ToBoolean));
    m_body->end();
}

// jtrue, jfalse: booleans and int32 inline, other values out of line, without a slow path
template<typename Bytecode>
void Compiler::emitConditionJump(const JSInstructionStream::Ref& instruction, unsigned block, bool jumpIfTrue)
{
    auto bytecode = instruction->as<Bytecode>();
    toBoolean(bytecode.m_condition);
    if (!jumpIfTrue)
        m_body->op(Op::I32Eqz);
    jumpIf(targetOf(instruction, bytecode.m_targetLabel.target()), block);
}

// inc, dec of an int32 that does not overflow
template<typename Bytecode>
void Compiler::emitIncrement(const JSInstructionStream::Ref& instruction, int32_t delta, SlowPath slowPath)
{
    auto bytecode = instruction->as<Bytecode>();
    loadTag(bytecode.m_srcDst);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    loadPayload(bytecode.m_srcDst);
    m_body->localTee(m_a);
    m_body->i32Const(delta > 0 ? std::numeric_limits<int32_t>::max() : std::numeric_limits<int32_t>::min());
    m_body->op(Op::I32Ne);
    m_body->op(Op::I32And);
    m_body->ifThen();
    m_body->localGet(m_a);
    m_body->i32Const(delta);
    m_body->op(Op::I32Add);
    m_body->localSet(m_c);
    storeInt32(bytecode.m_srcDst, m_c);
    m_body->elseThen();
    callSlowPath(slowPath, instruction);
    m_body->end();
}

// int32 % int32 inline unless the divisor is 0, INT_MIN % -1, or the result is -0
void Compiler::emitMod(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpMod>();
    beginFastPaths();
    loadTag(bytecode.m_lhs);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    loadTag(bytecode.m_rhs);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32And);
    m_body->ifThen();
    {
        loadPayload(bytecode.m_lhs);
        m_body->localSet(m_a);
        loadPayload(bytecode.m_rhs);
        m_body->localSet(m_b);
        // divisor > 0 (then no INT_MIN % -1), dividend >= 0 (then no -0)
        m_body->localGet(m_b);
        m_body->i32Const(0);
        m_body->op(Op::I32GtS);
        m_body->localGet(m_a);
        m_body->i32Const(0);
        m_body->op(Op::I32GeS);
        m_body->op(Op::I32And);
        m_body->ifThen();
        m_body->localGet(m_a);
        m_body->localGet(m_b);
        m_body->op(Op::I32RemS);
        m_body->localSet(m_c);
        storeInt32(bytecode.m_dst, m_c);
        fastPathDone();
        m_body->end();
    }
    m_body->end();
    endFastPaths(slow_path_mod, instruction);
}

// !x (obfuscated code writes true and false as !0 and !1)
void Compiler::emitNot(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpNot>();
    storeTagWithPayload(bytecode.m_dst, booleanTag, [&] {
        toBoolean(bytecode.m_operand);
        m_body->op(Op::I32Eqz);
    });
}

// An int32 other than 0 and INT_MIN, a double by its sign bit
void Compiler::emitNegate(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpNegate>();
    load(bytecode.m_operand, m_t1, m_a);
    beginFastPaths();
    m_body->localGet(m_t1);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    m_body->localGet(m_a);
    m_body->i32Const(0x7fffffff);
    m_body->op(Op::I32And);
    m_body->i32Const(0);
    m_body->op(Op::I32Ne);
    m_body->op(Op::I32And);
    m_body->ifThen();
    m_body->i32Const(0);
    m_body->localGet(m_a);
    m_body->op(Op::I32Sub);
    m_body->localSet(m_c);
    storeInt32(bytecode.m_dst, m_c);
    fastPathDone();
    m_body->end();
    m_body->localGet(m_t1);
    m_body->i32Const(lowestTag);
    m_body->op(Op::I32LtU);
    m_body->ifThen();
    m_body->localGet(m_t1);
    m_body->i32Const(static_cast<int32_t>(0x80000000));
    m_body->op(Op::I32Xor);
    m_body->localSet(m_t1);
    storeTagAndPayload(bytecode.m_dst, m_t1, m_a);
    fastPathDone();
    m_body->end();
    endFastPaths(slow_path_negate, instruction);
}

template<typename CellCondition>
void Compiler::emitCopyIf(const JSInstructionStream::Ref& instruction, VirtualRegister dst, VirtualRegister src, bool numbers, bool immediates, const CellCondition& cellCondition, SlowPath slowPath)
{
    load(src, m_t1, m_a);
    m_body->localGet(m_t1);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    cellCondition();
    m_body->localSet(m_c);
    m_body->elseThen();
    if (immediates)
        m_body->i32Const(1);
    else if (numbers)
        isNumberTag(m_t1);
    else
        m_body->i32Const(0);
    m_body->localSet(m_c);
    m_body->end();
    m_body->localGet(m_c);
    m_body->ifThen();
    storeTagAndPayload(dst, m_t1, m_a);
    m_body->elseThen();
    callSlowPath(slowPath, instruction);
    m_body->end();
}

template<typename Condition>
void Compiler::emitIs(VirtualRegister dst, VirtualRegister operand, const Condition& condition)
{
    load(operand, m_t1, m_a);
    condition();
    m_body->localSet(m_c);
    storeBoolean(dst, m_c);
}

// Nothing to do for a final object with the cached structure
void Compiler::emitToThis(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpToThis>();
    auto& cache = bytecode.metadata(m_codeBlock);
    beginFastPaths();
    load(bytecode.m_srcDst, m_t1, m_a);
    m_body->localGet(m_t1);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    cellType(m_a);
    m_body->i32Const(FinalObjectType);
    m_body->op(Op::I32Eq);
    m_body->localGet(m_a);
    m_body->i32Load(JSCell::structureIDOffset());
    m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_cachedStructureID));
    m_body->i32Load(0);
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32And);
    m_body->localSet(m_next);
    m_body->end();
    endFastPaths(slow_path_to_this, instruction);
}

// Like the interpreter: by the resolve type in the cache, the constant scope or the scope some
// levels up; dynamic cases and the ones with var injection checks in the slow path. The scope
// operations of an obfuscated VM (its strings and state in global variables) were half its
// instructions: their fast paths, which dispatch on the type in the metadata at run time, are
// functions of the module that the sites call with the metadata (#630).
// Array literals. An obfuscated VM makes one for nearly every instruction it runs (its operands,
// a call's arguments), each a call into the interpreter's slow path, which went through JSC's
// generic allocation and initialization of every element: 4 to 6 % of the engine thread in
// Turnstile's challenge, 50 to 80 ns per array in the jsc shell. Compiled code makes the array
// like JSC's JITs: both cells from the free lists of their allocators (a bump within the current
// interval, else the slow path), the structure of the indexing type the site's allocation profile
// selects, the elements checked against it (an int32 array takes only int32 values, a double array
// numbers but NaN) and the rest of the vector filled with holes. Sizes beyond the allocators of
// small cells and a global object having a bad time stay with the slow path.
constexpr unsigned maximumInlineArrayLiteral = 32;

// ArrayAllocationProfile keeps the last array and the indexing type in a private CompactPointerTuple,
// on 32 bits the pointer and then the type (indexing type << 8 | vector length)
constexpr ptrdiff_t profileLastArrayOffset = 0;
constexpr ptrdiff_t profileTypeOffset = sizeof(void*);
static_assert(sizeof(ArrayAllocationProfile) == 2 * sizeof(void*));

bool arrayProfileLayoutMatches()
{
    static const bool matches = [] {
        ArrayAllocationProfile profile(ArrayWithDouble);
        auto* fake = reinterpret_cast<JSArray*>(static_cast<uintptr_t>(0x12340));
        profile.updateLastAllocation(fake);
        auto* bytes = reinterpret_cast<const uint8_t*>(&profile);
        return *reinterpret_cast<JSArray* const*>(bytes + profileLastArrayOffset) == fake
            && (*reinterpret_cast<const uint16_t*>(bytes + profileTypeOffset) >> 8) == ArrayWithDouble;
    }();
    return matches;
}

LocalAllocator* arrayCellAllocator(VM& vm)
{
    return JSArray::subspaceFor<JSArray, SubspaceAccess::OnMainThread>(vm)->allocatorFor(WTF::roundUpToMultipleOf<JSCell::atomSize>(sizeof(JSArray)), AllocatorForMode::EnsureAllocator).localAllocator();
}

void Compiler::profiledIndexingType(uint32_t profileLocal)
{
    // The last array's type differs: 0
    m_body->localGet(profileLocal);
    m_body->i32Load(profileLastArrayOffset);
    m_body->localTee(m_t2);
    m_body->ifThen(ValueType::I32);
    m_body->localGet(m_t2);
    m_body->i32Load8U(JSCell::indexingTypeAndMiscOffset());
    m_body->i32Const(AllWritableArrayTypes);
    m_body->op(Op::I32And);
    m_body->elseThen();
    m_body->i32Const(-1);
    m_body->end();
    m_body->localSet(m_t2);
    m_body->localGet(profileLocal);
    m_body->i32Load16U(profileTypeOffset);
    m_body->i32Const(8);
    m_body->op(Op::I32ShrU);
    m_body->localTee(m_t1);
    m_body->i32Const(0);
    m_body->localGet(m_t2);
    m_body->i32Const(-1);
    m_body->op(Op::I32Eq);
    m_body->localGet(m_t2);
    m_body->localGet(m_t1);
    m_body->i32Const(AllWritableArrayTypes);
    m_body->op(Op::I32And);
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32Or);
    m_body->select();
}

void Compiler::arrayStructure(uint32_t typeLocal, std::span<const IndexingType> types)
{
    auto* globalObject = m_codeBlock->globalObject();
    // Having a bad time: other structures (array storage), from the slow path
    m_body->i32Const(reinterpret_cast<uintptr_t>(&globalObject->havingABadTimeWatchpointSet()) + WatchpointSet::offsetOfState());
    m_body->i32Load8U(0);
    m_body->i32Const(IsInvalidated);
    m_body->op(Op::I32Eq);
    m_body->ifThen(Hint::Unlikely);
    m_body->i32Const(0);
    m_body->returnValue();
    m_body->end();
    m_body->i32Const(0);
    for (auto type : types) {
        m_body->localSet(m_t1);
        m_body->i32Const(reinterpret_cast<uintptr_t>(globalObject->arrayStructureForIndexingTypeDuringAllocation(type)));
        m_body->localGet(m_t1);
        m_body->localGet(typeLocal);
        m_body->i32Const(type);
        m_body->op(Op::I32Eq);
        m_body->select();
    }
}

void Compiler::checkFreeCell(LocalAllocator*, uint32_t allocatorLocal)
{
    m_body->localGet(allocatorLocal);
    m_body->i32Load(LocalAllocator::offsetOfFreeList() + FreeList::offsetOfIntervalStart());
    m_body->localGet(allocatorLocal);
    m_body->i32Load(LocalAllocator::offsetOfFreeList() + FreeList::offsetOfIntervalEnd());
    m_body->op(Op::I32GeU);
    m_body->ifThen(Hint::Unlikely);
    m_body->i32Const(0);
    m_body->returnValue();
    m_body->end();
}

void Compiler::allocateCell(LocalAllocator*, uint32_t allocatorLocal, uint32_t cellLocal)
{
    m_body->localGet(allocatorLocal);
    m_body->i32Load(LocalAllocator::offsetOfFreeList() + FreeList::offsetOfIntervalStart());
    m_body->localSet(cellLocal);
    m_body->localGet(allocatorLocal);
    m_body->localGet(cellLocal);
    m_body->localGet(allocatorLocal);
    m_body->i32Load(LocalAllocator::offsetOfCellSize());
    m_body->op(Op::I32Add);
    m_body->i32Store(LocalAllocator::offsetOfFreeList() + FreeList::offsetOfIntervalStart());
}

void Compiler::initializeArray(uint32_t arrayLocal, uint32_t structureLocal, uint32_t butterflyLocal)
{
    // The structure ID (its pointer on 32 bits) and the type info of the structure in one store,
    // like JSC's JITs (emitStoreStructureWithTypeInfo)
    static_assert(sizeof(StructureID) == sizeof(Structure*));
    m_body->localGet(arrayLocal);
    m_body->localGet(structureLocal);
    m_body->i32Store(JSCell::structureIDOffset());
    m_body->localGet(arrayLocal);
    m_body->localGet(structureLocal);
    m_body->i32Load(Structure::indexingModeIncludingHistoryOffset());
    m_body->i32Store(JSCell::indexingTypeAndMiscOffset());
    m_body->localGet(arrayLocal);
    m_body->localGet(butterflyLocal);
    m_body->i32Store(JSObject::butterflyOffset());
}

// The elements are the registers below `argv` (constructArrayNegativeIndexed)
void Compiler::emitNewArray(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpNewArray>();
    unsigned count = bytecode.m_argc;
    VM& vm = m_codeBlock->vm();
    LocalAllocator* butterflyAllocator = nullptr;
    unsigned vectorLength = Butterfly::optimalContiguousVectorLength(static_cast<size_t>(0), count);
    if (count <= maximumInlineArrayLiteral && arrayProfileLayoutMatches()) {
        size_t size = Butterfly::totalSize(0, 0, true, vectorLength * sizeof(EncodedJSValue));
        butterflyAllocator = vm.auxiliarySpace().allocatorFor(size, AllocatorForMode::EnsureAllocator).localAllocator();
    }
    if (!butterflyAllocator || !arrayCellAllocator(vm)) {
        callSlowPath(llint_slow_path_new_array, instruction);
        return;
    }
    registerAddress(bytecode.m_argv);
    m_body->i32Const(count);
    m_body->i32Const(reinterpret_cast<uintptr_t>(&bytecode.metadata(m_codeBlock).m_arrayAllocationProfile));
    m_body->i32Const(reinterpret_cast<uintptr_t>(butterflyAllocator));
    m_body->i32Const(vectorLength);
    registerAddress(bytecode.m_dst);
    m_body->call(helper(Helper::NewArray));
    m_body->localSet(m_next);
    endFastPaths(llint_slow_path_new_array, instruction);
}

// (address of the first element's register, count, profile, the butterfly's allocator, vector
// length, destination address) -> 1 when it made the array
void Compiler::emitNewArrayFunction()
{
    const ValueType parameters[] = { ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32 };
    const ValueType status[] = { ValueType::I32 };
    auto* main = m_body;
    m_body = &m_module.addFunction(m_module.addType(parameters, status), std::size(parameters));
    constexpr uint32_t values = 0, count = 1, profile = 2, butterflyAllocator = 3, vectorLength = 4, dst = 5;
    auto temporaries = std::tuple { m_t1, m_t2 };
    m_t1 = m_body->addLocal(ValueType::I32);
    m_t2 = m_body->addLocal(ValueType::I32);
    uint32_t zero = m_body->addLocal(ValueType::I32);
    uint32_t type = m_body->addLocal(ValueType::I32);
    uint32_t structure = m_body->addLocal(ValueType::I32);
    uint32_t index = m_body->addLocal(ValueType::I32);
    uint32_t address = m_body->addLocal(ValueType::I32);
    uint32_t tag = m_body->addLocal(ValueType::I32);
    uint32_t butterfly = m_body->addLocal(ValueType::I32);
    uint32_t array = m_body->addLocal(ValueType::I32);
    uint32_t arrayAllocator = m_body->addLocal(ValueType::I32);
    auto* cellAllocator = arrayCellAllocator(m_codeBlock->vm());
    auto fail = [&] {
        m_body->i32Const(0);
        m_body->returnValue();
    };
    // for (index = from; index < limit; ++index) body
    auto forEach = [&](uint32_t from, uint32_t limit, const auto& body) {
        m_body->localGet(from);
        m_body->localSet(index);
        m_body->block();
        m_body->loop();
        m_body->localGet(index);
        m_body->localGet(limit);
        m_body->op(Op::I32GeU);
        m_body->brIf(1);
        body();
        m_body->localGet(index);
        m_body->i32Const(1);
        m_body->op(Op::I32Add);
        m_body->localSet(index);
        m_body->br(0);
        m_body->end();
        m_body->end();
    };
    // The element's register
    auto elementAddress = [&] {
        m_body->localGet(values);
        m_body->localGet(index);
        m_body->i32Const(3);
        m_body->op(Op::I32Shl);
        m_body->op(Op::I32Sub);
        m_body->localTee(address);
        m_body->i32Load(TagOffset);
        m_body->localSet(tag);
    };
    auto typeIs = [&](IndexingType indexingType) {
        m_body->localGet(type);
        m_body->i32Const(indexingType);
        m_body->op(Op::I32Eq);
    };

    profiledIndexingType(profile);
    m_body->localSet(type);
    static constexpr IndexingType types[] = { ArrayWithUndecided, ArrayWithInt32, ArrayWithDouble, ArrayWithContiguous };
    arrayStructure(type, types);
    m_body->localTee(structure);
    m_body->op(Op::I32Eqz);
    // An undecided array is an empty one
    typeIs(ArrayWithUndecided);
    m_body->localGet(count);
    m_body->i32Const(0);
    m_body->op(Op::I32Ne);
    m_body->op(Op::I32And);
    m_body->op(Op::I32Or);
    m_body->ifThen(Hint::Unlikely);
    fail();
    m_body->end();
    // The elements fit the type
    typeIs(ArrayWithInt32);
    m_body->ifThen();
    forEach(zero, count, [&] {
        elementAddress();
        m_body->localGet(tag);
        m_body->i32Const(int32Tag);
        m_body->op(Op::I32Ne);
        m_body->ifThen(Hint::Unlikely);
        fail();
        m_body->end();
    });
    m_body->end();
    typeIs(ArrayWithDouble);
    m_body->ifThen();
    forEach(zero, count, [&] {
        elementAddress();
        // Not a number, or NaN (a double array's hole)
        m_body->localGet(tag);
        m_body->i32Const(int32Tag);
        m_body->op(Op::I32Ne);
        m_body->ifThen();
        m_body->localGet(tag);
        m_body->i32Const(lowestTag);
        m_body->op(Op::I32GeU);
        m_body->localGet(address);
        m_body->f64Load(0);
        m_body->localGet(address);
        m_body->f64Load(0);
        m_body->op(Op::F64Ne);
        m_body->op(Op::I32Or);
        m_body->ifThen(Hint::Unlikely);
        fail();
        m_body->end();
        m_body->end();
    });
    m_body->end();

    // Both cells, without a call between them (a collection would not see the first)
    m_body->i32Const(reinterpret_cast<uintptr_t>(cellAllocator));
    m_body->localSet(arrayAllocator);
    checkFreeCell(nullptr, butterflyAllocator);
    checkFreeCell(cellAllocator, arrayAllocator);
    allocateCell(nullptr, butterflyAllocator, butterfly);
    allocateCell(cellAllocator, arrayAllocator, array);
    // The indexing header, then the butterfly's address after it
    m_body->localGet(butterfly);
    m_body->localGet(count);
    m_body->i32Store(IndexingHeader::offsetOfPublicLength());
    m_body->localGet(butterfly);
    m_body->localGet(vectorLength);
    m_body->i32Store(IndexingHeader::offsetOfVectorLength());
    m_body->localGet(butterfly);
    m_body->i32Const(sizeof(IndexingHeader));
    m_body->op(Op::I32Add);
    m_body->localSet(butterfly);
    // The elements and the holes after them
    auto slot = [&] {
        m_body->localGet(butterfly);
        m_body->localGet(index);
        m_body->i32Const(3);
        m_body->op(Op::I32Shl);
        m_body->op(Op::I32Add);
    };
    uint64_t pureNaN = std::bit_cast<uint64_t>(PNaN);
    EncodedJSValue empty = JSValue::encode(JSValue());
    typeIs(ArrayWithDouble);
    m_body->ifThen();
    {
        forEach(zero, count, [&] {
            elementAddress();
            slot();
            m_body->localGet(tag);
            m_body->i32Const(int32Tag);
            m_body->op(Op::I32Eq);
            m_body->ifThen(ValueType::F64);
            m_body->localGet(address);
            m_body->i32Load(PayloadOffset);
            m_body->op(Op::F64ConvertI32S);
            m_body->elseThen();
            m_body->localGet(address);
            m_body->f64Load(0);
            m_body->end();
            m_body->f64Store(0);
        });
        forEach(count, vectorLength, [&] {
            slot();
            m_body->localTee(address);
            m_body->i32Const(static_cast<int32_t>(pureNaN));
            m_body->i32Store(0);
            m_body->localGet(address);
            m_body->i32Const(static_cast<int32_t>(pureNaN >> 32));
            m_body->i32Store(4);
        });
    }
    m_body->elseThen();
    {
        forEach(zero, count, [&] {
            slot();
            m_body->localGet(values);
            m_body->localGet(index);
            m_body->i32Const(3);
            m_body->op(Op::I32Shl);
            m_body->op(Op::I32Sub);
            m_body->f64Load(0);
            m_body->f64Store(0);
        });
        forEach(count, vectorLength, [&] {
            slot();
            m_body->localTee(address);
            m_body->i32Const(static_cast<int32_t>(JSValue::decode(empty).tag()));
            m_body->i32Store(TagOffset);
            m_body->localGet(address);
            m_body->i32Const(JSValue::decode(empty).payload());
            m_body->i32Store(PayloadOffset);
        });
    }
    m_body->end();
    initializeArray(array, structure, butterfly);
    // ArrayAllocationProfile::updateLastAllocationFor
    m_body->localGet(profile);
    m_body->localGet(array);
    m_body->i32Store(profileLastArrayOffset);
    m_body->localGet(dst);
    m_body->i32Const(cellTag);
    m_body->i32Store(TagOffset);
    m_body->localGet(dst);
    m_body->localGet(array);
    m_body->i32Store(PayloadOffset);
    m_body->i32Const(1);
    m_body = main;
    std::tie(m_t1, m_t2) = temporaries;
}

// A literal of constants: an array of the constant's copy-on-write butterfly, which the slow path
// replaces by one of another indexing type when the profile selects another (so it is read at
// run time)
void Compiler::emitNewArrayBuffer(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpNewArrayBuffer>();
    if (!arrayProfileLayoutMatches() || !arrayCellAllocator(m_codeBlock->vm()) || !bytecode.m_immutableButterfly.isConstant()) {
        callSlowPath(slow_path_new_array_buffer, instruction);
        return;
    }
    m_body->i32Const(reinterpret_cast<uintptr_t>(&m_codeBlock->constantRegister(bytecode.m_immutableButterfly)));
    m_body->i32Const(reinterpret_cast<uintptr_t>(&bytecode.metadata(m_codeBlock).m_arrayAllocationProfile));
    registerAddress(bytecode.m_dst);
    m_body->call(helper(Helper::NewArrayBuffer));
    m_body->localSet(m_next);
    endFastPaths(slow_path_new_array_buffer, instruction);
}

// (address of the constant register of the butterfly, profile, destination address) -> 1 when it
// made the array
void Compiler::emitNewArrayBufferFunction()
{
    const ValueType parameters[] = { ValueType::I32, ValueType::I32, ValueType::I32 };
    const ValueType status[] = { ValueType::I32 };
    auto* main = m_body;
    m_body = &m_module.addFunction(m_module.addType(parameters, status), std::size(parameters));
    constexpr uint32_t constant = 0, profile = 1, dst = 2;
    auto temporaries = std::tuple { m_t1, m_t2 };
    m_t1 = m_body->addLocal(ValueType::I32);
    m_t2 = m_body->addLocal(ValueType::I32);
    uint32_t type = m_body->addLocal(ValueType::I32);
    uint32_t structure = m_body->addLocal(ValueType::I32);
    uint32_t immutableButterfly = m_body->addLocal(ValueType::I32);
    uint32_t butterfly = m_body->addLocal(ValueType::I32);
    uint32_t array = m_body->addLocal(ValueType::I32);
    uint32_t arrayAllocator = m_body->addLocal(ValueType::I32);
    auto* cellAllocator = arrayCellAllocator(m_codeBlock->vm());
    profiledIndexingType(profile);
    m_body->localSet(type);
    static constexpr IndexingType types[] = { CopyOnWriteArrayWithInt32, CopyOnWriteArrayWithDouble, CopyOnWriteArrayWithContiguous };
    arrayStructure(type, types);
    m_body->localSet(structure);
    m_body->localGet(constant);
    m_body->i32Load(PayloadOffset);
    m_body->localSet(immutableButterfly);
    // The butterfly of the selected type (else the slow path makes one)
    m_body->localGet(structure);
    m_body->op(Op::I32Eqz);
    m_body->localGet(immutableButterfly);
    m_body->i32Load8U(JSCell::indexingTypeAndMiscOffset());
    m_body->i32Const(AllArrayTypes);
    m_body->op(Op::I32And);
    m_body->localGet(type);
    m_body->op(Op::I32Ne);
    m_body->op(Op::I32Or);
    m_body->ifThen(Hint::Unlikely);
    m_body->i32Const(0);
    m_body->returnValue();
    m_body->end();
    m_body->i32Const(reinterpret_cast<uintptr_t>(cellAllocator));
    m_body->localSet(arrayAllocator);
    checkFreeCell(cellAllocator, arrayAllocator);
    allocateCell(cellAllocator, arrayAllocator, array);
    m_body->localGet(immutableButterfly);
    m_body->i32Const(JSCellButterfly::offsetOfData());
    m_body->op(Op::I32Add);
    m_body->localSet(butterfly);
    initializeArray(array, structure, butterfly);
    m_body->localGet(profile);
    m_body->localGet(array);
    m_body->i32Store(profileLastArrayOffset);
    m_body->localGet(dst);
    m_body->i32Const(cellTag);
    m_body->i32Store(TagOffset);
    m_body->localGet(dst);
    m_body->localGet(array);
    m_body->i32Store(PayloadOffset);
    m_body->i32Const(1);
    m_body = main;
    std::tie(m_t1, m_t2) = temporaries;
}

// Scope access inline, like JSC's baseline JIT before it shared its code: a closure variable that
// linking resolved (ClosureVar, for good like ResolvedClosureVar) at its depth and offset, a global
// variable or property behind a check that the metadata still has the type it had when the
// function compiled (only an unresolved one changes after its first runs: those keep calling the
// module's function, which dispatches on the type), the slow path otherwise. Calls of that
// function at every access to a global or a free variable of a closure were 13 to 15 % of the
// engine thread in Turnstile's challenge.
bool Compiler::inlinesGlobalAccess(ResolveType type)
{
    return type == GlobalProperty || type == GlobalVar || type == GlobalLexicalVar;
}

void Compiler::emitResolveScope(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpResolveScope>();
    auto& metadata = bytecode.metadata(m_codeBlock);
    ResolveType type = metadata.m_resolveType;
    if (type == ClosureVar) {
        loadPayload(bytecode.m_scope);
        for (unsigned depth = 0; depth < metadata.m_localScopeDepth; ++depth)
            m_body->i32Load(JSScope::offsetOfNext());
        m_body->localSet(m_a);
        storeCell(bytecode.m_dst, m_a);
        return;
    }
    if (inlinesGlobalAccess(type)) {
        beginFastPaths();
        m_body->i32Const(reinterpret_cast<uintptr_t>(&metadata));
        m_body->localTee(m_e);
        m_body->i32Load(OBJECT_OFFSETOF(OpResolveScope::Metadata, m_resolveType));
        m_body->i32Const(type);
        m_body->op(Op::I32Eq);
        m_body->ifThen(Hint::Likely);
        resolveScopeFastPath(type, noLocal, m_e, bytecode.m_dst);
        m_body->end();
        endFastPaths(slow_path_resolve_scope, instruction);
        return;
    }
    loadPayload(bytecode.m_scope);
    m_body->i32Const(reinterpret_cast<uintptr_t>(&metadata));
    registerAddress(bytecode.m_dst);
    m_body->call(helper(Helper::ResolveScope));
    m_body->localSet(m_next);
    endFastPaths(slow_path_resolve_scope, instruction);
}

void Compiler::resolveScopeFastPath(ResolveType type, uint32_t scope, uint32_t metadata, const Operand& dst)
{
    using Metadata = OpResolveScope::Metadata;
    auto field = [&](ptrdiff_t offset) {
        m_body->localGet(metadata);
        m_body->i32Load(offset);
    };
    switch (type) {
    case GlobalProperty:
        // The global lexical bindings did not change since the cache was made
        field(OBJECT_OFFSETOF(Metadata, m_constantScope));
        m_body->localTee(m_a);
        m_body->i32Load(JSGlobalObject::offsetOfGlobalLexicalBindingEpoch());
        field(OBJECT_OFFSETOF(Metadata, m_globalLexicalBindingEpoch));
        m_body->op(Op::I32Eq);
        m_body->ifThen();
        storeCell(dst, m_a);
        fastPathDone();
        m_body->end();
        return;
    case GlobalVar:
    case GlobalLexicalVar:
    case ModuleVar:
        field(OBJECT_OFFSETOF(Metadata, m_constantScope));
        m_body->localSet(m_a);
        storeCell(dst, m_a);
        fastPathDone();
        return;
    case ClosureVar:
        m_body->localGet(scope);
        m_body->localSet(m_a);
        field(OBJECT_OFFSETOF(Metadata, m_localScopeDepth));
        m_body->localSet(m_b);
        m_body->block();
        m_body->loop();
        m_body->localGet(m_b);
        m_body->op(Op::I32Eqz);
        m_body->brIf(1);
        m_body->localGet(m_a);
        m_body->i32Load(JSScope::offsetOfNext());
        m_body->localSet(m_a);
        m_body->localGet(m_b);
        m_body->i32Const(1);
        m_body->op(Op::I32Sub);
        m_body->localSet(m_b);
        m_body->br(0);
        m_body->end();
        m_body->end();
        storeCell(dst, m_a);
        fastPathDone();
        return;
    default:
        RELEASE_ASSERT_NOT_REACHED();
    }
}

// (scope, metadata, destination address) -> 1 when done
void Compiler::emitResolveScopeFunction()
{
    const ValueType parameters[] = { ValueType::I32, ValueType::I32, ValueType::I32 };
    constexpr uint32_t scope = 0, metadata = 1;
    emitFastPathFunction(parameters, [&] {
        for (auto type : { GlobalProperty, GlobalVar, GlobalLexicalVar, ModuleVar, ClosureVar }) {
            m_body->localGet(metadata);
            m_body->i32Load(OBJECT_OFFSETOF(OpResolveScope::Metadata, m_resolveType));
            m_body->i32Const(type);
            m_body->op(Op::I32Eq);
            m_body->ifThen();
            resolveScopeFastPath(type, scope, metadata, Operand::at(2));
            m_body->end();
        }
    });
}

// Like the interpreter: a global property behind a structure check, a global variable through its
// pointer (a lexical one not before its initialization), a closure variable in its environment
void Compiler::emitGetFromScope(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpGetFromScope>();
    auto& cache = bytecode.metadata(m_codeBlock);
    ResolveType type = cache.m_getPutInfo.resolveType();
    // A variable the bytecode generator or linking resolved in a closure: a ClosureVar for good
    // (CodeBlock::finishCreation), at its offset in the environment, which the interpreter reads
    // without a slow path
    if (bytecode.m_getPutInfo.resolveType() == ResolvedClosureVar || type == ClosureVar) {
        closureVariableAddress(bytecode.m_scope, &cache.m_operand);
        m_body->localTee(m_c);
        m_body->i32Load(TagOffset);
        m_body->localSet(m_a);
        m_body->localGet(m_c);
        m_body->i32Load(PayloadOffset);
        m_body->localSet(m_b);
        storeTagAndPayload(bytecode.m_dst, m_a, m_b);
        return;
    }
    if (inlinesGlobalAccess(type)) {
        beginFastPaths();
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache));
        m_body->localTee(m_e);
        m_body->i32Load(OBJECT_OFFSETOF(OpGetFromScope::Metadata, m_getPutInfo));
        m_body->i32Const(GetPutInfo::typeBits);
        m_body->op(Op::I32And);
        m_body->i32Const(type);
        m_body->op(Op::I32Eq);
        m_body->ifThen(Hint::Likely);
        if (type == GlobalProperty) {
            loadPayload(bytecode.m_scope);
            m_body->localSet(m_g);
        }
        getFromScopeFastPath(type, m_g, m_e, bytecode.m_dst, static_cast<PropertyOffset>(cache.m_operand) >= firstOutOfLineOffset);
        m_body->end();
        endFastPaths(llint_slow_path_get_from_scope, instruction);
        return;
    }
    loadPayload(bytecode.m_scope);
    m_body->i32Const(reinterpret_cast<uintptr_t>(&cache));
    registerAddress(bytecode.m_dst);
    m_body->call(helper(Helper::GetFromScope));
    m_body->localSet(m_next);
    endFastPaths(llint_slow_path_get_from_scope, instruction);
}

// Pushes the address of the closure variable at the offset in `operand` (the metadata's) in the
// scope's environment
void Compiler::closureVariableAddress(const Operand& scope, const void* operand)
{
    loadPayload(scope);
    m_body->i32Const(JSLexicalEnvironment::offsetOfVariables());
    m_body->op(Op::I32Add);
    m_body->i32Const(reinterpret_cast<uintptr_t>(operand));
    m_body->i32Load(0);
    m_body->i32Const(3);
    m_body->op(Op::I32Shl);
    m_body->op(Op::I32Add);
}

void Compiler::getFromScopeFastPath(ResolveType type, uint32_t scope, uint32_t metadata, const Operand& dst, std::optional<bool> outOfLine)
{
    using Metadata = OpGetFromScope::Metadata;
    auto operand = [&] {
        m_body->localGet(metadata);
        m_body->i32Load(OBJECT_OFFSETOF(Metadata, m_operand));
    };
    // The value at the pushed address plus the bias
    auto loadValue = [&](int32_t bias = 0) {
        if (bias) {
            m_body->i32Const(bias);
            m_body->op(Op::I32Add);
        }
        m_body->localTee(m_c);
        m_body->i32Load(TagOffset);
        m_body->localSet(m_a);
        m_body->localGet(m_c);
        m_body->i32Load(PayloadOffset);
        m_body->localSet(m_b);
    };
    auto finish = [&] {
        storeTagAndPayload(dst, m_a, m_b);
        fastPathDone();
    };
    switch (type) {
    case GlobalProperty:
        // The cached structure; at a site, also the kind of offset it had when its function compiled
        m_body->localGet(scope);
        m_body->localTee(m_d);
        m_body->i32Load(JSCell::structureIDOffset());
        m_body->localGet(metadata);
        m_body->i32Load(OBJECT_OFFSETOF(Metadata, m_structureID));
        m_body->op(Op::I32Eq);
        if (outOfLine) {
            operand();
            m_body->localTee(m_t2);
            m_body->i32Const(firstOutOfLineOffset);
            m_body->op(*outOfLine ? Op::I32GeS : Op::I32LtS);
            m_body->op(Op::I32And);
        }
        m_body->ifThen();
        if (!outOfLine) {
            operand();
            m_body->localSet(m_t2);
            loadProperty(m_d, m_t2);
        } else {
            // Inline: after the object's header; out of line: (offset minus firstOutOfLineOffset
            // plus 2) * 8 below the butterfly
            m_body->localGet(m_d);
            if (*outOfLine)
                m_body->i32Load(JSObject::butterflyOffset());
            m_body->localGet(m_t2);
            m_body->i32Const(3);
            m_body->op(Op::I32Shl);
            m_body->op(*outOfLine ? Op::I32Sub : Op::I32Add);
            loadValue(static_cast<int32_t>(*outOfLine ? (firstOutOfLineOffset - 2) * sizeof(EncodedJSValue) : sizeof(JSObjectWithButterfly)));
        }
        finish();
        m_body->end();
        return;
    case GlobalVar:
        operand();
        loadValue();
        finish();
        return;
    case GlobalLexicalVar:
        // Not before its initialization (TDZ): the slow path throws
        operand();
        loadValue();
        m_body->localGet(m_a);
        m_body->i32Const(emptyTag);
        m_body->op(Op::I32Ne);
        m_body->ifThen();
        finish();
        m_body->end();
        return;
    case ClosureVar:
        m_body->localGet(scope);
        m_body->i32Const(JSLexicalEnvironment::offsetOfVariables());
        m_body->op(Op::I32Add);
        operand();
        m_body->i32Const(3);
        m_body->op(Op::I32Shl);
        m_body->op(Op::I32Add);
        loadValue();
        finish();
        return;
    default:
        RELEASE_ASSERT_NOT_REACHED();
    }
}

// (scope, metadata, destination address) -> 1 when done
void Compiler::emitGetFromScopeFunction()
{
    const ValueType parameters[] = { ValueType::I32, ValueType::I32, ValueType::I32 };
    constexpr uint32_t scope = 0, metadata = 1;
    emitFastPathFunction(parameters, [&] {
        for (auto type : { GlobalProperty, GlobalVar, GlobalLexicalVar, ClosureVar }) {
            m_body->localGet(metadata);
            m_body->i32Load(OBJECT_OFFSETOF(OpGetFromScope::Metadata, m_getPutInfo));
            m_body->i32Const(GetPutInfo::typeBits);
            m_body->op(Op::I32And);
            m_body->i32Const(type);
            m_body->op(Op::I32Eq);
            m_body->ifThen();
            getFromScopeFastPath(type, scope, metadata, Operand::at(2));
            m_body->end();
        }
    });
}

// Like the interpreter: a closure variable (one with a watchpoint set only when that is already
// invalidated), a global property behind a structure check, a global variable (writable, no
// watchpoint to fire, a lexical one initialized); with the write barrier after the store
void Compiler::emitPutToScope(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpPutToScope>();
    m_body->localGet(cfr);
    loadTag(bytecode.m_scope);
    loadPayload(bytecode.m_scope);
    loadTag(bytecode.m_value);
    loadPayload(bytecode.m_value);
    m_body->i32Const(reinterpret_cast<uintptr_t>(&bytecode.metadata(m_codeBlock)));
    m_body->call(helper(Helper::PutToScope));
    m_body->localSet(m_next);
    endFastPaths(llint_slow_path_put_to_scope, instruction);
}

// (frame, scope tag and payload, value tag and payload, metadata) -> 1 when done
void Compiler::emitPutToScopeFunction()
{
    using Metadata = OpPutToScope::Metadata;
    const ValueType parameters[] = { ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32, ValueType::I32 };
    const Operand scope = Operand::value(1, 2);
    const Operand value = Operand::value(3, 4);
    constexpr uint32_t metadata = 5;
    JSGlobalObject* globalObject = m_codeBlock->globalObject();
    auto field = [&](ptrdiff_t offset) {
        m_body->localGet(metadata);
        m_body->i32Load(offset);
    };
    auto resolveType = [&](ResolveType type) {
        field(OBJECT_OFFSETOF(Metadata, m_getPutInfo));
        m_body->i32Const(GetPutInfo::typeBits);
        m_body->op(Op::I32And);
        m_body->i32Const(type);
        m_body->op(Op::I32Eq);
    };
    auto operand = [&] {
        field(OBJECT_OFFSETOF(Metadata, m_operand));
    };
    // No watchpoint set, or an invalidated one (a write fires nothing)
    auto watchpointFree = [&] {
        field(OBJECT_OFFSETOF(Metadata, m_watchpointSet));
        m_body->localTee(m_e);
        m_body->op(Op::I32Eqz);
        m_body->localGet(m_e);
        m_body->i32Load8U(WatchpointSet::offsetOfState());
        m_body->i32Const(IsInvalidated);
        m_body->op(Op::I32Eq);
        m_body->op(Op::I32Or);
    };
    // The value at the address on the stack
    auto store = [&] {
        m_body->localTee(m_c);
        loadTag(value);
        m_body->i32Store(TagOffset);
        m_body->localGet(m_c);
        loadPayload(value);
        m_body->i32Store(PayloadOffset);
        fastPathDone();
    };
    auto closureVariable = [&] {
        loadPayload(scope);
        m_body->i32Const(JSLexicalEnvironment::offsetOfVariables());
        m_body->op(Op::I32Add);
        operand();
        m_body->i32Const(3);
        m_body->op(Op::I32Shl);
        m_body->op(Op::I32Add);
        store();
        writeBarrierOnOperands(scope, value);
    };
    emitFastPathFunction(parameters, [&] {
        resolveType(ClosureVar);
        m_body->ifThen();
        closureVariable();
        m_body->end();

        resolveType(ResolvedClosureVar);
        m_body->ifThen();
        watchpointFree();
        m_body->ifThen();
        closureVariable();
        m_body->end();
        m_body->end();

        resolveType(GlobalProperty);
        m_body->ifThen();
        {
            loadPayload(scope);
            m_body->localTee(m_d);
            m_body->i32Load(JSCell::structureIDOffset());
            field(OBJECT_OFFSETOF(Metadata, m_structureID));
            m_body->op(Op::I32Eq);
            m_body->ifThen();
            operand();
            m_body->localSet(m_t2);
            propertyAddress(m_d, m_t2);
            store();
            writeBarrierOnOperands(scope, value);
            m_body->end();
        }
        m_body->end();

        // A global var while no var is read only
        resolveType(GlobalVar);
        m_body->ifThen();
        m_body->i32Const(reinterpret_cast<uintptr_t>(&globalObject->varReadOnlyWatchpointSet()));
        m_body->i32Load8U(WatchpointSet::offsetOfState());
        m_body->i32Const(IsInvalidated);
        m_body->op(Op::I32Ne);
        watchpointFree();
        m_body->op(Op::I32And);
        m_body->ifThen();
        operand();
        store();
        writeBarrierOnConstant(globalObject, value);
        m_body->end();
        m_body->end();

        // A global let or const: an assignment (not the initialization) only after the initialization
        resolveType(GlobalLexicalVar);
        m_body->ifThen();
        watchpointFree();
        m_body->ifThen();
        {
            field(OBJECT_OFFSETOF(Metadata, m_getPutInfo));
            m_body->i32Const(GetPutInfo::initializationBits);
            m_body->op(Op::I32And);
            m_body->i32Const(static_cast<int32_t>(InitializationMode::NotInitialization) << GetPutInfo::initializationShift);
            m_body->op(Op::I32LtU);
            operand();
            m_body->i32Load(TagOffset);
            m_body->i32Const(emptyTag);
            m_body->op(Op::I32Ne);
            m_body->op(Op::I32Or);
            m_body->ifThen();
            operand();
            store();
            writeBarrierOnConstant(globalObject->globalLexicalEnvironment(), value);
            m_body->end();
        }
        m_body->end();
        m_body->end();
    });
}

// == null jumps: undefined and null inline, a cell that masquerades as undefined (document.all)
// in C++
template<typename Bytecode>
void Compiler::emitJumpIfNull(const JSInstructionStream::Ref& instruction, unsigned block)
{
    auto bytecode = instruction->as<Bytecode>();
    constexpr bool jumpIfNull = std::is_same_v<Bytecode, OpJeqNull>;
    unsigned target = targetOf(instruction, bytecode.m_targetLabel.target());
    load(bytecode.m_value, m_t1, m_a);
    m_body->localGet(m_t1);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    {
        m_body->localGet(m_a);
        m_body->i32Load8U(JSCell::typeInfoFlagsOffset());
        m_body->i32Const(MasqueradesAsUndefined);
        m_body->op(Op::I32And);
        m_body->ifThen();
        callSlowPath(jumpIfNullFromCompiledCode<Bytecode>, instruction);
        m_body->localGet(m_next);
        m_body->i32Const(reinterpret_cast<uintptr_t>(instructionPointer(target)));
        m_body->op(Op::I32Eq);
        m_body->localSet(m_c);
        m_body->elseThen();
        m_body->i32Const(!jumpIfNull);
        m_body->localSet(m_c);
        m_body->end();
    }
    m_body->elseThen();
    {
        // Undefined and null differ only in the lowest bit of the tag
        m_body->localGet(m_t1);
        m_body->i32Const(1);
        m_body->op(Op::I32Or);
        m_body->i32Const(static_cast<int32_t>(JSValue::NullTag));
        m_body->op(jumpIfNull ? Op::I32Eq : Op::I32Ne);
        m_body->localSet(m_c);
    }
    m_body->end();
    m_body->localGet(m_c);
    m_body->ifThen();
    jumpTo(target, block);
    m_body->end();
}

Vector<unsigned> Compiler::switchTargets(const JSInstructionStream::Ref& instruction)
{
    Vector<unsigned> targets;
    auto simple = [&](const UnlinkedSimpleJumpTable& table) {
        targets.append(instruction.offset() + table.defaultOffset());
        for (unsigned i = table.isList() ? 1 : 0; i < table.m_branchOffsets.size(); i += table.isList() ? 2 : 1) {
            if (table.m_branchOffsets[i])
                targets.append(instruction.offset() + table.m_branchOffsets[i]);
        }
    };
    switch (instruction->opcodeID()) {
    case op_switch_imm:
        simple(m_codeBlock->unlinkedSwitchJumpTable(instruction->as<OpSwitchImm>().m_tableIndex));
        break;
    case op_switch_char:
        simple(m_codeBlock->unlinkedSwitchJumpTable(instruction->as<OpSwitchChar>().m_tableIndex));
        break;
    default: {
        auto& table = m_codeBlock->unlinkedStringSwitchJumpTable(instruction->as<OpSwitchString>().m_tableIndex);
        targets.append(instruction.offset() + table.defaultOffset());
        for (auto& entry : table.m_offsetTable)
            targets.append(instruction.offset() + entry.value.m_branchOffset);
        break;
    }
    }
    return targets;
}

template<typename Bytecode>
void Compiler::emitSwitch(const JSInstructionStream::Ref& instruction, unsigned block)
{
    if constexpr (std::is_same_v<Bytecode, OpSwitchImm>) {
        // An int32 through a br_table to one jump per target (an obfuscated VM's dispatch), with
        // a dense table of a sane size; other numbers and tables take the path below
        auto bytecode = instruction->as<OpSwitchImm>();
        auto& table = m_codeBlock->unlinkedSwitchJumpTable(bytecode.m_tableIndex);
        if (!table.isList() && table.m_branchOffsets.size() <= maximumInlineSwitchSize) {
            Vector<unsigned> targets;
            HashMap<unsigned, uint32_t, WTF::IntHash<unsigned>, WTF::UnsignedWithZeroKeyHashTraits<unsigned>> caseOf;
            auto caseFor = [&](unsigned target) {
                auto result = caseOf.add(target, targets.size());
                if (result.isNewEntry)
                    targets.append(target);
                return result.iterator->value;
            };
            caseFor(instruction.offset() + table.defaultOffset());
            // From the innermost block (the slow path's), case k is the end of the block k + 1 out
            Vector<uint32_t> depths;
            for (auto offset : table.m_branchOffsets)
                depths.append(1 + caseFor(offset ? instruction.offset() + offset : instruction.offset() + table.defaultOffset()));
            for (unsigned i = 0; i < targets.size(); ++i)
                m_body->block();
            m_body->block();
            // An int32, or a double of an int32's value (an obfuscated VM's opcodes after `>>> 0`
            // or a division); -0 is case 0 like 0 === -0, NaN and others go to the slow path
            loadTag(bytecode.m_scrutinee);
            m_body->localTee(m_t1);
            m_body->i32Const(int32Tag);
            m_body->op(Op::I32Eq);
            m_body->ifThen(ValueType::I32);
            loadPayload(bytecode.m_scrutinee);
            m_body->elseThen();
            m_body->localGet(m_t1);
            m_body->i32Const(lowestTag);
            m_body->op(Op::I32GeU);
            m_body->brIf(1);
            loadNumber(bytecode.m_scrutinee, m_t1);
            m_body->localTee(m_x);
            m_body->prefixedOp(Op::I32TruncSatF64S);
            m_body->localTee(m_c);
            m_body->op(Op::F64ConvertI32S);
            m_body->localGet(m_x);
            m_body->op(Op::F64Ne);
            m_body->brIf(1);
            m_body->localGet(m_c);
            m_body->end();
            m_body->i32Const(table.m_min);
            m_body->op(Op::I32Sub);
            m_body->brTable(depths.span(), 1);
            m_body->end();
            emitSwitchSlowPath<Bytecode>(instruction, block);
            for (unsigned i = 0; i < targets.size(); ++i) {
                m_body->end();
                jumpTo(targets[i], block);
            }
            return;
        }
    }
    emitSwitchSlowPath<Bytecode>(instruction, block);
}

// The target from C++, then to its block
template<typename Bytecode>
void Compiler::emitSwitchSlowPath(const JSInstructionStream::Ref& instruction, unsigned block)
{
    auto targets = switchTargets(instruction);
    callSlowPath(switchFromCompiledCode<Bytecode>, instruction);
    HashSet<unsigned, WTF::IntHash<unsigned>, WTF::UnsignedWithZeroKeyHashTraits<unsigned>> seen;
    seen.add(targets[0]);
    for (unsigned i = 1; i < targets.size(); ++i) {
        if (seen.add(targets[i]).isNewEntry)
            jumpIfSlowPathReturned(targets[i], block);
    }
    jumpTo(targets[0], block);
}

// Conditional jumps without a fast path: the slow path returns the target or the next instruction
template<typename Bytecode>
void Compiler::emitGenericJump(const JSInstructionStream::Ref& instruction, unsigned block, SlowPath slowPath)
{
    auto bytecode = instruction->as<Bytecode>();
    callSlowPath(slowPath, instruction);
    jumpIfSlowPathReturned(targetOf(instruction, bytecode.m_targetLabel.target()), block);
}

// Which instructions this compiler takes, and where its basic blocks start
bool Compiler::scan()
{
    auto& instructions = m_codeBlock->instructions();
    auto it = instructions.begin();
    if (it == instructions.end() || (*it)->opcodeID() != op_enter)
        return false;
    HashSet<unsigned, WTF::IntHash<unsigned>, WTF::UnsignedWithZeroKeyHashTraits<unsigned>> starts;
    unsigned first = (*it).offset() + (*it)->size();
    starts.add(first);
    Vector<unsigned> loopStarts;
    for (++it; it != instructions.end(); ++it) {
        auto& instruction = *it;
        unsigned next = instruction.offset() + instruction->size();
        auto jump = [&](int label) {
            starts.add(targetOf(instruction, label));
            starts.add(next);
        };
        switch (instruction->opcodeID()) {
        case op_mov: case op_add: case op_sub: case op_mul: case op_div: case op_mod: case op_inc: case op_dec:
        case op_negate: case op_less: case op_lesseq: case op_greater: case op_greatereq: case op_eq: case op_neq:
        case op_stricteq: case op_nstricteq: case op_bitand: case op_bitor: case op_bitxor: case op_lshift:
        case op_rshift: case op_urshift: case op_not: case op_to_number: case op_to_numeric: case op_get_by_id:
        case op_put_by_id: case op_get_by_id_direct: case op_get_length: case op_get_by_val: case op_put_by_val:
        case op_get_from_scope: case op_put_to_scope: case op_resolve_scope: case op_typeof: case op_new_object:
        case op_new_array: case op_new_array_buffer: case op_to_primitive: case op_to_string: case op_to_object: case op_to_this:
        case op_to_property_key: case op_to_property_key_or_number: case op_check_traps: case op_call:
        case op_call_ignore_result: case op_tail_call: case op_construct: case op_call_varargs:
        case op_tail_call_varargs: case op_construct_varargs: case op_super_construct:
        case op_super_construct_varargs: case op_argument_count: case op_get_argument:
        case op_eq_null: case op_neq_null: case op_nop: case op_check_tdz: case op_get_scope: case op_is_empty:
        case op_is_undefined_or_null: case op_is_boolean: case op_is_number: case op_is_cell_with_type:
        case op_is_object: case op_typeof_is_undefined: case op_catch: case op_bitnot: case op_get_parent_scope:
        case op_get_internal_field: case op_put_internal_field: case op_iterator_open: case op_iterator_next:
        case op_get_from_arguments: case op_put_to_arguments: case op_unsigned:
#define BL_JIT_CASE(name) case op_##name:
        BL_JIT_COMMON_SLOW_PATH_OPS(BL_JIT_CASE)
        BL_JIT_LLINT_SLOW_PATH_OPS(BL_JIT_CASE)
#undef BL_JIT_CASE
            break;
        case op_loop_hint:
            // A running loop enters there
            starts.add(next);
            loopStarts.append(next);
            break;
        case op_switch_imm: case op_switch_char: case op_switch_string:
            for (auto target : switchTargets(instruction))
                starts.add(target);
            starts.add(next);
            break;
        case op_jundefined_or_null: jump(instruction->as<OpJundefinedOrNull>().m_targetLabel.target()); break;
        case op_jnundefined_or_null: jump(instruction->as<OpJnundefinedOrNull>().m_targetLabel.target()); break;
        case op_jeq_null: jump(instruction->as<OpJeqNull>().m_targetLabel.target()); break;
        case op_jneq_null: jump(instruction->as<OpJneqNull>().m_targetLabel.target()); break;
        case op_jeq_ptr: jump(instruction->as<OpJeqPtr>().m_targetLabel.target()); break;
        case op_jneq_ptr: jump(instruction->as<OpJneqPtr>().m_targetLabel.target()); break;
        case op_ret:
            starts.add(next);
            break;
        case op_jmp: jump(instruction->as<OpJmp>().m_targetLabel.target()); break;
        case op_jtrue: jump(instruction->as<OpJtrue>().m_targetLabel.target()); break;
        case op_jfalse: jump(instruction->as<OpJfalse>().m_targetLabel.target()); break;
        case op_jless: jump(instruction->as<OpJless>().m_targetLabel.target()); break;
        case op_jlesseq: jump(instruction->as<OpJlesseq>().m_targetLabel.target()); break;
        case op_jgreater: jump(instruction->as<OpJgreater>().m_targetLabel.target()); break;
        case op_jgreatereq: jump(instruction->as<OpJgreatereq>().m_targetLabel.target()); break;
        case op_jnless: jump(instruction->as<OpJnless>().m_targetLabel.target()); break;
        case op_jnlesseq: jump(instruction->as<OpJnlesseq>().m_targetLabel.target()); break;
        case op_jngreater: jump(instruction->as<OpJngreater>().m_targetLabel.target()); break;
        case op_jngreatereq: jump(instruction->as<OpJngreatereq>().m_targetLabel.target()); break;
        case op_jeq: jump(instruction->as<OpJeq>().m_targetLabel.target()); break;
        case op_jneq: jump(instruction->as<OpJneq>().m_targetLabel.target()); break;
        case op_jstricteq: jump(instruction->as<OpJstricteq>().m_targetLabel.target()); break;
        case op_jnstricteq: jump(instruction->as<OpJnstricteq>().m_targetLabel.target()); break;
        default:
            m_unsupported = instruction->opcodeID();
            return false;
        }
    }
    // Handlers start at their op_catch
    for (size_t i = 0; i < m_codeBlock->numberOfExceptionHandlers(); ++i)
        starts.add(m_codeBlock->exceptionHandler(i).target);
    unsigned end = instructions.size();
    for (auto start : starts) {
        if (start < end)
            m_starts.append(start);
    }
    std::sort(m_starts.begin(), m_starts.end());
    for (unsigned i = 0; i < m_starts.size(); ++i)
        m_blockAt.add(m_starts[i], i);
    m_blockCount = m_starts.size();
    for (auto start : loopStarts) {
        if (start < end)
            m_loops.add(start, m_blockAt.get(start));
    }
    return true;
}

// Like the interpreter: the trap bits, and with any set the bytecode offset in the frame and the
// trap handler (a GC at this safepoint, a watchdog's exception, the embedder's work, patch 0149)
void Compiler::emitTrapCheck(const JSInstructionStream::Ref& instruction)
{
    m_body->i32Const(reinterpret_cast<uintptr_t>(m_codeBlock->vm().traps().trapBitsAddress()));
    m_body->i32Load(0);
    m_body->i32Const(VMTraps::AsyncEvents);
    m_body->op(Op::I32And);
    m_body->ifThen(Hint::Unlikely);
    m_body->localGet(cfr);
    m_body->i32Const(instruction.offset());
    m_body->i32Store(CallFrameSlot::argumentCountIncludingThis * sizeof(Register) + TagOffset);
    m_body->localGet(cfr);
    m_body->i32Const(reinterpret_cast<uintptr_t>(instruction.ptr()));
    m_body->i32Const(reinterpret_cast<uintptr_t>(static_cast<SlowPath>(llint_slow_path_handle_traps)));
    m_body->callIndirect(m_slowPathType);
    m_body->op(Op::I32WrapI64);
    m_body->ifThen(Hint::Unlikely);
    m_body->i32Const(1);
    m_body->returnValue();
    m_body->end();
    m_body->end();
}

void Compiler::emitInstruction(const JSInstructionStream::Ref& instruction, unsigned block)
{
    auto isObject = [&] {
        cellType(m_a);
        m_body->i32Const(ObjectType);
        m_body->op(Op::I32GeU);
    };
    auto isString = [&] {
        cellType(m_a);
        m_body->i32Const(StringType);
        m_body->op(Op::I32Eq);
    };
    auto isPropertyKey = [&] {
        isString();
        cellType(m_a);
        m_body->i32Const(SymbolType);
        m_body->op(Op::I32Eq);
        m_body->op(Op::I32Or);
    };
    auto no = [&] { m_body->i32Const(0); };
    auto tagIs = [&](int32_t tag) {
        m_body->localGet(m_t1);
        m_body->i32Const(tag);
        m_body->op(Op::I32Eq);
    };
    // A cell condition of emitIs: for cells only
    auto cellAnd = [&](const auto& condition) {
        return [&, condition] {
            m_body->i32Const(0);
            m_body->localSet(m_c);
            tagIs(cellTag);
            m_body->ifThen();
            condition();
            m_body->localSet(m_c);
            m_body->end();
            m_body->localGet(m_c);
        };
    };

    switch (instruction->opcodeID()) {
    case op_mov: {
        auto bytecode = instruction->as<OpMov>();
        load(bytecode.m_src, m_a, m_b);
        storeTagAndPayload(bytecode.m_dst, m_a, m_b);
        return;
    }
    case op_nop:
        return;
    case op_loop_hint: {
        // Every loopIterationsPerCall iterations out to runCompiled, which calls the function again
        // from the block after this (where a loop entered from the interpreter starts too)
        m_body->localGet(m_iterations);
        m_body->i32Const(1);
        m_body->op(Op::I32Sub);
        m_body->localTee(m_iterations);
        m_body->op(Op::I32Eqz);
        m_body->ifThen();
        m_body->i32Const(reenterStatus + static_cast<int32_t>(m_blockAt.get(instruction.offset() + instruction->size())));
        m_body->returnValue();
        m_body->end();
        return;
    }
    case op_add: emitArithmetic<OpAdd>(instruction, Op::I64Add); return;
    case op_sub: emitArithmetic<OpSub>(instruction, Op::I64Sub); return;
    case op_mul: emitArithmetic<OpMul>(instruction, Op::I64Mul); return;
    case op_div: emitDivide(instruction); return;
    case op_mod: emitMod(instruction); return;
    case op_inc: emitIncrement<OpInc>(instruction, 1, slow_path_inc); return;
    case op_dec: emitIncrement<OpDec>(instruction, -1, slow_path_dec); return;
    case op_negate: emitNegate(instruction); return;
    case op_less: emitCompare<OpLess>(instruction, block, Op::I32LtS); return;
    case op_lesseq: emitCompare<OpLesseq>(instruction, block, Op::I32LeS); return;
    case op_greater: emitCompare<OpGreater>(instruction, block, Op::I32GtS); return;
    case op_greatereq: emitCompare<OpGreatereq>(instruction, block, Op::I32GeS); return;
    case op_eq: emitEquality<OpEq>(instruction, block, false); return;
    case op_neq: emitEquality<OpNeq>(instruction, block, true); return;
    case op_stricteq: emitEquality<OpStricteq>(instruction, block, false); return;
    case op_nstricteq: emitEquality<OpNstricteq>(instruction, block, true); return;
    case op_bitand: emitBitOp<OpBitand>(instruction, Op::I32And); return;
    case op_bitor: emitBitOp<OpBitor>(instruction, Op::I32Or); return;
    case op_bitxor: emitBitOp<OpBitxor>(instruction, Op::I32Xor); return;
    case op_lshift: emitBitOp<OpLshift>(instruction, Op::I32Shl); return;
    case op_rshift: emitBitOp<OpRshift>(instruction, Op::I32ShrS); return;
    case op_urshift: emitBitOp<OpUrshift>(instruction, Op::I32ShrU); return;
    case op_not: emitNot(instruction); return;
    case op_to_number: {
        auto bytecode = instruction->as<OpToNumber>();
        emitCopyIf(instruction, bytecode.m_dst, bytecode.m_operand, true, false, no, slow_path_to_number);
        return;
    }
    case op_to_numeric: {
        auto bytecode = instruction->as<OpToNumeric>();
        emitCopyIf(instruction, bytecode.m_dst, bytecode.m_operand, true, false, no, slow_path_to_numeric);
        return;
    }
    case op_to_primitive: {
        auto bytecode = instruction->as<OpToPrimitive>();
        emitCopyIf(instruction, bytecode.m_dst, bytecode.m_src, true, true, [&] {
            cellType(m_a);
            m_body->i32Const(ObjectType);
            m_body->op(Op::I32LtU);
        }, slow_path_to_primitive);
        return;
    }
    case op_to_string: {
        auto bytecode = instruction->as<OpToString>();
        emitCopyIf(instruction, bytecode.m_dst, bytecode.m_operand, false, false, isString, slow_path_to_string);
        return;
    }
    case op_to_object: {
        auto bytecode = instruction->as<OpToObject>();
        emitCopyIf(instruction, bytecode.m_dst, bytecode.m_operand, false, false, isObject, slow_path_to_object);
        return;
    }
    case op_to_property_key: {
        auto bytecode = instruction->as<OpToPropertyKey>();
        emitCopyIf(instruction, bytecode.m_dst, bytecode.m_src, false, false, isPropertyKey, slow_path_to_property_key);
        return;
    }
    case op_to_property_key_or_number: {
        auto bytecode = instruction->as<OpToPropertyKeyOrNumber>();
        emitCopyIf(instruction, bytecode.m_dst, bytecode.m_src, true, false, isPropertyKey, slow_path_to_property_key_or_number);
        return;
    }
    case op_to_this: emitToThis(instruction); return;
    case op_check_tdz: {
        // Throws (in the slow path) when the variable is not initialized yet
        loadTag(instruction->as<OpCheckTdz>().m_targetVirtualRegister);
        m_body->i32Const(emptyTag);
        m_body->op(Op::I32Eq);
        m_body->ifThen();
        callSlowPath(slow_path_check_tdz, instruction);
        m_body->end();
        return;
    }
    case op_bitnot: {
        auto bytecode = instruction->as<OpBitnot>();
        loadTag(bytecode.m_operand);
        m_body->localSet(m_t1);
        toInt32(bytecode.m_operand, m_t1, m_a, m_x);
        m_body->ifThen();
        m_body->localGet(m_a);
        m_body->i32Const(-1);
        m_body->op(Op::I32Xor);
        m_body->localSet(m_c);
        storeInt32(bytecode.m_dst, m_c);
        m_body->elseThen();
        callSlowPath(slow_path_bitnot, instruction);
        m_body->end();
        return;
    }
    // The uint32 of urshift's int32: as it is when it fits, else as a double
    case op_unsigned: {
        auto bytecode = instruction->as<OpUnsigned>();
        load(bytecode.m_operand, m_t1, m_a);
        tagIs(int32Tag);
        m_body->ifThen();
        m_body->localGet(m_a);
        m_body->i32Const(0);
        m_body->op(Op::I32GeS);
        m_body->ifThen();
        storeInt32(bytecode.m_dst, m_a);
        m_body->elseThen();
        m_body->localGet(m_a);
        m_body->op(Op::F64ConvertI32U);
        m_body->localSet(m_x);
        storeDouble(bytecode.m_dst, m_x);
        m_body->end();
        m_body->elseThen();
        callSlowPath(slow_path_unsigned, instruction);
        m_body->end();
        return;
    }
    case op_get_parent_scope: {
        auto bytecode = instruction->as<OpGetParentScope>();
        loadPayload(bytecode.m_scope);
        m_body->i32Load(JSScope::offsetOfNext());
        m_body->localSet(m_a);
        storeCell(bytecode.m_dst, m_a);
        return;
    }
    case op_get_internal_field: {
        // Promises, iterators, generators: a field at a fixed index
        auto bytecode = instruction->as<OpGetInternalField>();
        loadPayload(bytecode.m_base);
        m_body->i32Const(JSInternalFieldObjectImpl<>::offsetOfInternalField(bytecode.m_index));
        m_body->op(Op::I32Add);
        m_body->localTee(m_c);
        m_body->i32Load(TagOffset);
        m_body->localSet(m_a);
        m_body->localGet(m_c);
        m_body->i32Load(PayloadOffset);
        m_body->localSet(m_b);
        storeTagAndPayload(bytecode.m_dst, m_a, m_b);
        return;
    }
    case op_put_internal_field: {
        auto bytecode = instruction->as<OpPutInternalField>();
        loadPayload(bytecode.m_base);
        m_body->localTee(m_d);
        m_body->i32Const(JSInternalFieldObjectImpl<>::offsetOfInternalField(bytecode.m_index));
        m_body->op(Op::I32Add);
        m_body->localTee(m_c);
        loadTag(bytecode.m_value);
        m_body->i32Store(TagOffset);
        m_body->localGet(m_c);
        loadPayload(bytecode.m_value);
        m_body->i32Store(PayloadOffset);
        writeBarrier(m_d);
        return;
    }
    case op_get_from_arguments: {
        // A slot of the function's own arguments object
        auto bytecode = instruction->as<OpGetFromArguments>();
        loadPayload(bytecode.m_arguments);
        m_body->i32Const(DirectArguments::offsetOfSlot(bytecode.m_index));
        m_body->op(Op::I32Add);
        m_body->localTee(m_c);
        m_body->i32Load(TagOffset);
        m_body->localSet(m_a);
        m_body->localGet(m_c);
        m_body->i32Load(PayloadOffset);
        m_body->localSet(m_b);
        storeTagAndPayload(bytecode.m_dst, m_a, m_b);
        return;
    }
    case op_put_to_arguments: {
        auto bytecode = instruction->as<OpPutToArguments>();
        writeBarrierOnOperands(bytecode.m_arguments, bytecode.m_value);
        loadPayload(bytecode.m_arguments);
        m_body->i32Const(DirectArguments::offsetOfSlot(bytecode.m_index));
        m_body->op(Op::I32Add);
        m_body->localTee(m_c);
        loadTag(bytecode.m_value);
        m_body->i32Store(TagOffset);
        m_body->localGet(m_c);
        loadPayload(bytecode.m_value);
        m_body->i32Store(PayloadOffset);
        return;
    }
    case op_get_scope: {
        m_body->localGet(cfr);
        m_body->i32Load(CallFrameSlot::callee * sizeof(Register) + PayloadOffset);
        m_body->i32Load(JSCallee::offsetOfScopeChain());
        m_body->localSet(m_a);
        storeCell(instruction->as<OpGetScope>().m_dst, m_a);
        return;
    }
    case op_is_empty: {
        auto bytecode = instruction->as<OpIsEmpty>();
        emitIs(bytecode.m_dst, bytecode.m_operand, [&] { tagIs(emptyTag); });
        return;
    }
    case op_is_undefined_or_null: {
        auto bytecode = instruction->as<OpIsUndefinedOrNull>();
        emitIs(bytecode.m_dst, bytecode.m_operand, [&] {
            m_body->localGet(m_t1);
            m_body->i32Const(1);
            m_body->op(Op::I32Or);
            m_body->i32Const(static_cast<int32_t>(JSValue::NullTag));
            m_body->op(Op::I32Eq);
        });
        return;
    }
    case op_is_boolean: {
        auto bytecode = instruction->as<OpIsBoolean>();
        emitIs(bytecode.m_dst, bytecode.m_operand, [&] { tagIs(booleanTag); });
        return;
    }
    case op_is_number: {
        auto bytecode = instruction->as<OpIsNumber>();
        emitIs(bytecode.m_dst, bytecode.m_operand, [&] { isNumberTag(m_t1); });
        return;
    }
    case op_is_cell_with_type: {
        auto bytecode = instruction->as<OpIsCellWithType>();
        JSType type = bytecode.m_type;
        emitIs(bytecode.m_dst, bytecode.m_operand, cellAnd([&, type] {
            cellType(m_a);
            m_body->i32Const(type);
            m_body->op(Op::I32Eq);
        }));
        return;
    }
    case op_is_object: {
        auto bytecode = instruction->as<OpIsObject>();
        emitIs(bytecode.m_dst, bytecode.m_operand, cellAnd(isObject));
        return;
    }
    case op_typeof_is_undefined: {
        // A cell that masquerades as undefined in C++
        auto bytecode = instruction->as<OpTypeofIsUndefined>();
        load(bytecode.m_operand, m_t1, m_a);
        tagIs(cellTag);
        m_body->ifThen();
        {
            m_body->localGet(m_a);
            m_body->i32Load8U(JSCell::typeInfoFlagsOffset());
            m_body->i32Const(MasqueradesAsUndefined);
            m_body->op(Op::I32And);
            m_body->ifThen();
            callSlowPath(typeofIsUndefinedFromCompiledCode, instruction);
            m_body->elseThen();
            m_body->i32Const(0);
            m_body->localSet(m_c);
            storeBoolean(bytecode.m_dst, m_c);
            m_body->end();
        }
        m_body->elseThen();
        tagIs(static_cast<int32_t>(JSValue::UndefinedTag));
        m_body->localSet(m_c);
        storeBoolean(bytecode.m_dst, m_c);
        m_body->end();
        return;
    }
    case op_get_by_id: emitGetById<OpGetById>(instruction); return;
    case op_get_length: emitGetById<OpGetLength>(instruction); return;
    case op_get_by_id_direct: emitGetByIdDirect(instruction); return;
    case op_put_by_id: emitPutById(instruction); return;
    case op_get_by_val: emitGetByVal(instruction); return;
    case op_put_by_val: emitPutByVal(instruction); return;
    case op_get_from_scope: emitGetFromScope(instruction); return;
    case op_put_to_scope: emitPutToScope(instruction); return;
    case op_resolve_scope: emitResolveScope(instruction); return;
    case op_typeof: callSlowPath(slow_path_typeof, instruction); return;
    case op_new_object: callSlowPath(llint_slow_path_new_object, instruction); return;
    case op_new_array: emitNewArray(instruction); return;
    case op_new_array_buffer: emitNewArrayBuffer(instruction); return;
#define BL_JIT_COMMON(name) case op_##name: callSlowPath(slow_path_##name, instruction); return;
#define BL_JIT_LLINT(name) case op_##name: callSlowPath(llint_slow_path_##name, instruction); return;
    BL_JIT_COMMON_SLOW_PATH_OPS(BL_JIT_COMMON)
    BL_JIT_LLINT_SLOW_PATH_OPS(BL_JIT_LLINT)
#undef BL_JIT_COMMON
#undef BL_JIT_LLINT
    case op_call: emitCall<OpCall>(instruction); return;
    case op_call_ignore_result: emitCall<OpCallIgnoreResult>(instruction); return;
    case op_tail_call: emitCall<OpTailCall>(instruction); return;
    case op_construct: emitCall<OpConstruct>(instruction); return;
    case op_super_construct: emitCall<OpSuperConstruct>(instruction); return;
    case op_call_varargs: emitCall<OpCallVarargs>(instruction); return;
    case op_tail_call_varargs: emitCall<OpTailCallVarargs>(instruction); return;
    case op_construct_varargs: emitCall<OpConstructVarargs>(instruction); return;
    case op_super_construct_varargs: emitCall<OpSuperConstructVarargs>(instruction); return;
    case op_catch: callSlowPath(catchFromCompiledCode, instruction); return;
    case op_iterator_open: callSlowPath(iteratorOpenFromCompiledCode, instruction); return;
    case op_iterator_next: callSlowPath(iteratorNextFromCompiledCode, instruction); return;
    case op_eq_null: callSlowPath(equalsNullFromCompiledCode<OpEqNull>, instruction); return;
    case op_neq_null: callSlowPath(equalsNullFromCompiledCode<OpNeqNull>, instruction); return;
    case op_jeq_null: emitJumpIfNull<OpJeqNull>(instruction, block); return;
    case op_jneq_null: emitJumpIfNull<OpJneqNull>(instruction, block); return;
    case op_switch_imm: emitSwitch<OpSwitchImm>(instruction, block); return;
    case op_switch_char: emitSwitch<OpSwitchChar>(instruction, block); return;
    case op_switch_string: emitSwitch<OpSwitchString>(instruction, block); return;
    case op_jeq_ptr: {
        // Jump if the value is that cell (an intrinsic like Array)
        auto bytecode = instruction->as<OpJeqPtr>();
        loadTag(bytecode.m_value);
        m_body->i32Const(cellTag);
        m_body->op(Op::I32Eq);
        loadPayload(bytecode.m_value);
        loadPayload(bytecode.m_specialPointer);
        m_body->op(Op::I32Eq);
        m_body->op(Op::I32And);
        m_body->ifThen();
        jumpTo(targetOf(instruction, bytecode.m_targetLabel.target()), block);
        m_body->end();
        return;
    }
    case op_jneq_ptr: {
        // Jump unless the value is that cell, noted in the cache
        auto bytecode = instruction->as<OpJneqPtr>();
        loadTag(bytecode.m_value);
        m_body->i32Const(cellTag);
        m_body->op(Op::I32Ne);
        loadPayload(bytecode.m_value);
        loadPayload(bytecode.m_specialPointer);
        m_body->op(Op::I32Ne);
        m_body->op(Op::I32Or);
        m_body->ifThen();
        m_body->i32Const(reinterpret_cast<uintptr_t>(&bytecode.metadata(m_codeBlock).m_hasJumped));
        m_body->i32Const(1);
        m_body->i32Store8(0);
        jumpTo(targetOf(instruction, bytecode.m_targetLabel.target()), block);
        m_body->end();
        return;
    }
    case op_argument_count: {
        // argc including this, minus this
        m_body->localGet(cfr);
        m_body->i32Load(CallFrameSlot::argumentCountIncludingThis * sizeof(Register) + PayloadOffset);
        m_body->i32Const(1);
        m_body->op(Op::I32Sub);
        m_body->localSet(m_c);
        storeInt32(instruction->as<OpArgumentCount>().m_dst, m_c);
        return;
    }
    case op_get_argument: {
        // The argument at the index (with this at 0), undefined past the ones passed
        auto bytecode = instruction->as<OpGetArgument>();
        m_body->localGet(cfr);
        m_body->i32Load(CallFrameSlot::argumentCountIncludingThis * sizeof(Register) + PayloadOffset);
        m_body->i32Const(bytecode.m_index);
        m_body->op(Op::I32GtS);
        m_body->ifThen();
        load(virtualRegisterForArgumentIncludingThis(bytecode.m_index), m_a, m_b);
        m_body->elseThen();
        m_body->i32Const(static_cast<int32_t>(JSValue::UndefinedTag));
        m_body->localSet(m_a);
        m_body->i32Const(0);
        m_body->localSet(m_b);
        m_body->end();
        storeTagAndPayload(bytecode.m_dst, m_a, m_b);
        return;
    }
    case op_jundefined_or_null:
    case op_jnundefined_or_null: {
        // Undefined and null differ only in the lowest bit of the tag
        bool jumpIfNullish = instruction->opcodeID() == op_jundefined_or_null;
        VirtualRegister value = jumpIfNullish ? instruction->as<OpJundefinedOrNull>().m_value : instruction->as<OpJnundefinedOrNull>().m_value;
        int label = jumpIfNullish ? instruction->as<OpJundefinedOrNull>().m_targetLabel.target() : instruction->as<OpJnundefinedOrNull>().m_targetLabel.target();
        loadTag(value);
        m_body->i32Const(1);
        m_body->op(Op::I32Or);
        m_body->i32Const(static_cast<int32_t>(JSValue::NullTag));
        m_body->op(jumpIfNullish ? Op::I32Eq : Op::I32Ne);
        m_body->ifThen();
        jumpTo(targetOf(instruction, label), block);
        m_body->end();
        return;
    }
    case op_check_traps:
        emitTrapCheck(instruction);
        return;
    case op_ret: {
        auto bytecode = instruction->as<OpRet>();
        load(bytecode.m_value, m_a, m_b);
        storeTagAndPayload(virtualRegisterForArgumentIncludingThis(0), m_a, m_b);
        m_body->i32Const(0);
        m_body->returnValue();
        return;
    }
    case op_jmp:
        jumpTo(targetOf(instruction, instruction->as<OpJmp>().m_targetLabel.target()), block);
        return;
    case op_jtrue: emitConditionJump<OpJtrue>(instruction, block, true); return;
    case op_jfalse: emitConditionJump<OpJfalse>(instruction, block, false); return;
    case op_jless: emitCompare<OpJless>(instruction, block, Op::I32LtS); return;
    case op_jlesseq: emitCompare<OpJlesseq>(instruction, block, Op::I32LeS); return;
    case op_jgreater: emitCompare<OpJgreater>(instruction, block, Op::I32GtS); return;
    case op_jgreatereq: emitCompare<OpJgreatereq>(instruction, block, Op::I32GeS); return;
    // jn...: jump when the comparison is false (also for NaN)
    case op_jnless: emitCompare<OpJnless>(instruction, block, Op::I32LtS); return;
    case op_jnlesseq: emitCompare<OpJnlesseq>(instruction, block, Op::I32LeS); return;
    case op_jngreater: emitCompare<OpJngreater>(instruction, block, Op::I32GtS); return;
    case op_jngreatereq: emitCompare<OpJngreatereq>(instruction, block, Op::I32GeS); return;
    case op_jeq: emitEquality<OpJeq>(instruction, block, false); return;
    case op_jneq: emitEquality<OpJneq>(instruction, block, true); return;
    case op_jstricteq: emitEquality<OpJstricteq>(instruction, block, false); return;
    case op_jnstricteq: emitEquality<OpJnstricteq>(instruction, block, true); return;
    default:
        RELEASE_ASSERT_NOT_REACHED();
    }
}

std::optional<std::vector<uint8_t>> Compiler::compile()
{
    if (m_codeBlock->instructions().size() > maximumBytecodeSize) {
        m_tooLarge = true;
        return std::nullopt;
    }
    if (!scan())
        return std::nullopt;

    const ValueType parameters[] = { ValueType::I32, ValueType::I32 };
    const ValueType status[] = { ValueType::I32 };
    m_module.addType(parameters, status);
    const ValueType slowPathResult[] = { ValueType::I64 };
    m_slowPathType = m_module.addType(parameters, slowPathResult);
    m_barrierType = m_module.addType(parameters, std::span<const ValueType>());
    m_checkType = m_module.addType(parameters, status);
    const ValueType callParameters[] = { ValueType::I32, ValueType::I32, ValueType::I32 };
    m_callType = m_module.addType(callParameters, slowPathResult);
    m_toBooleanType = m_module.addType(callParameters, status);
    m_body = &m_module.function(2);
    m_body->setName(std::string("js:") + m_codeBlock->inferredName().data() + "#" + toCString(m_codeBlock->hash()).data());
    m_block = m_body->addLocal(ValueType::I32);
    addScratchLocals();
    m_iterations = m_body->addLocal(ValueType::I32);

    m_base = m_body->addLocal(ValueType::I32);
    m_baseBias = (m_codeBlock->numCalleeLocals() + 16) * sizeof(Register);
    m_body->localGet(cfr);
    m_body->i32Const(m_baseBias);
    m_body->op(Op::I32Sub);
    m_body->localSet(m_base);
    m_body->localGet(entry);
    m_body->localSet(m_block);
    m_body->i32Const(loopIterationsPerCall);
    m_body->localSet(m_iterations);
    // block { loop { block * n { br_table } code 0 } code 1 ... } code n - 1 } } return 1: the outer
    // block is the exit after an exception
    auto& instructions = m_codeBlock->instructions();
    // The function's entry is a safepoint like the interpreter's, whose stack check traps there:
    // calls without a loop stop for the watchdog too, and a hidden view's script pauses there
    // for the user (patch 0149). Calls between compiled functions check no stack limit of traps.
    m_body->localGet(entry);
    m_body->op(Op::I32Eqz);
    m_body->ifThen();
    emitTrapCheck(instructions.at(m_starts[0]));
    m_body->end();
    m_body->block();
    m_body->loop();
    for (unsigned i = 0; i < m_blockCount; ++i)
        m_body->block();
    m_body->localGet(m_block);
    Vector<uint32_t> depths;
    for (unsigned i = 0; i < m_blockCount; ++i)
        depths.append(i);
    m_body->brTable(depths.span(), m_blockCount - 1);

    for (unsigned block = 0; block < m_blockCount; ++block) {
        m_body->end();
        m_currentBlock = block;
        m_blockDepth = m_body->depth();
        unsigned end = block + 1 < m_blockCount ? m_starts[block + 1] : instructions.size();
        for (unsigned offset = m_starts[block]; offset < end;) {
            auto instruction = instructions.at(offset);
            emitInstruction(instruction, block);
            offset += instruction->size();
        }
    }
    m_body->end();
    m_body->unreachable();
    m_body->end();
    m_body->i32Const(1);
    emitHelpers();
    return m_module.bytes();
}

} // namespace

const JSInstruction* wasmJITEnter(CallFrame* callFrame, CodeBlock* codeBlock)
{
    if (!enabled())
        return nullptr;
    // Through the callee table like calls in compiled code: the interpreter's calls of compiled
    // functions (and JSC's generic call) come here for each call
    VM& vm = codeBlock->vm();
    if (!existingCallTargets(vm))
        return nullptr;
    bool isConstruct = codeBlock->specializationKind() == CodeSpecializationKind::CodeForConstruct;
    auto* target = cachedCallTarget(vm, codeBlock->ownerExecutable(), isConstruct);
    uint32_t function = target && target->codeBlock == codeBlock ? target->function : 0;
    if (!function) {
        function = compiledFunction(codeBlock);
        auto* executable = dynamicDowncast<FunctionExecutable>(codeBlock->ownerExecutable());
        if (function && executable && !codeBlock->couldBeTainted())
            fillCallTarget(vm, executable, codeBlock, function, isConstruct);
    }
    if (!function || !roomForCompiledCode())
        return nullptr;
    auto status = runCompiled(function, callFrame, 0);
    // A tail call: the interpreter makes it, its callee's frame replaces this one
    if (status == tailCallStatus)
        return callFrame->currentVPC();
    return status ? exceptionInstructions() : returnInstruction();
}

void wasmJITTierUp(CodeBlock* codeBlock)
{
    // The callee table of the VM, which compiled calls read at its address: a thread compiles for
    // one VM at a time
    auto& table = threadCallTargets();
    bool otherVM = table && &table->vm != &codeBlock->vm();
    if (enabled() && !otherVM && !compiledCode().contains(codeBlock)) {
        // Not yet hot enough: the interpreter's counter once more
        auto& entry = warmUpOf(codeBlock);
        unsigned fires = warmUpFires(codeBlock);
        if (entry.fires < fires)
            ++entry.fires;
        unsigned fired = entry.fires;
        Seconds interpreted = entry.interpreted;
        if (entry.fires < fires) {
            if (!warmsUpByTime(codeBlock) || entry.interpreted < interpretedTimeBeforeCompile(codeBlock)) {
                if (warmsUpByTime(codeBlock))
                    requestSample(codeBlock->vm(), warmUps());
                codeBlock->unlinkedCodeBlock()->llintExecuteCounter().setNewThreshold(Options::thresholdForJITAfterWarmUp(), codeBlock);
                return;
            }
            // Warm by its time: the next CodeBlock of this code compiles at its first fire too
            entry.fires = fires;
        }
        if (!table)
            table = makeUnique<CallTargets>(codeBlock->vm());
        Compiled compiled;
        Compiler compiler(codeBlock);
        auto bytes = compiler.compile();
        if (bytes) {
            compiled.function = wasmJITInstall(bytes->data(), bytes->size(), level() >= 3);
            if (compiled.function) {
                ++table->compiledCodeBlocks;
                Locker locker { compiledCodeBlocksLock };
                compiledCodeBlocks().add(codeBlock);
            }
            compiled.loops = compiler.takeLoops();
            compiled.propertyCaches = compiler.takePropertyCaches();
        }
        if (level() >= 2) {
            if (bytes)
                dataLogLn("[jit] ", *codeBlock, ": ", bytes->size(), " bytes, ", compiler.branchHints(), " branch hints, function ", compiled.function, ", warm after ", fired, " fires and ", static_cast<int>(interpreted.milliseconds()), " ms interpreted");
            else
                dataLogLn("[jit] ", *codeBlock, ": not compiled (", compiler.tooLarge() ? "too large" : opcodeNames[compiler.unsupported()], ")");
        }
        compiledCode().add(codeBlock, WTF::move(compiled));
        if (!table->compiledCodeBlocks)
            table = nullptr;
    }
    // The counter belongs to the UnlinkedCodeBlock, which every CodeBlock of the same code shares:
    // those of the same script in other frames, of the builtins in every global object and the
    // one that replaces this when the code was thrown away (memory short, or before it compiled).
    // Stopping it for good kept them all interpreted; it goes on firing, once per about 50 calls
    // of them in the interpreter, so they warm up and compile too.
    codeBlock->unlinkedCodeBlock()->llintExecuteCounter().setNewThreshold(Options::thresholdForJITAfterWarmUp(), codeBlock);
}

void wasmJITLoop(CallFrame* callFrame, CodeBlock* codeBlock, const JSInstruction* pc)
{
    wasmJITTierUp(codeBlock);
    auto it = compiledCode().find(codeBlock);
    if (it == compiledCode().end() || !it->value.function || !roomForCompiledCode())
        return;
    auto loop = it->value.loops.find(codeBlock->bytecodeOffset(pc) + pc->size());
    if (loop == it->value.loops.end())
        return;
    auto status = runCompiled(it->value.function, callFrame, loop->value);
    // The C loop reloads its PC (an offset from the first instruction) from the frame and steps
    // over the op_loop_hint; at a tail call it makes the call
    auto* next = status == tailCallStatus ? callFrame->currentVPC() : status ? exceptionInstructions() : returnInstruction();
    uintptr_t offset = reinterpret_cast<uintptr_t>(next) - reinterpret_cast<uintptr_t>(codeBlock->instructions().at(0).ptr()) - pc->size();
    reinterpret_cast<Register*>(callFrame)[static_cast<int>(CallFrameSlot::argumentCountIncludingThis)].tag() = static_cast<int32_t>(offset);
}

unsigned wasmJITGenericEntries()
{
    return genericEntries;
}

GenericEntry::GenericEntry()
{
    ++genericEntries;
}

GenericEntry::~GenericEntry()
{
    --genericEntries;
}

void wasmJITForget(CodeBlock* codeBlock)
{
    auto it = compiledCode().find(codeBlock);
    if (it == compiledCode().end())
        return;
    if (it->value.function) {
        // Its table slot serves another function next
        auto& table = callTargets(codeBlock->vm());
        auto& target = table.slot(CallTargets::key(codeBlock->ownerExecutable(), codeBlock->specializationKind() == CodeSpecializationKind::CodeForConstruct));
        if (target.codeBlock == codeBlock)
            target = { };
        if (!--table.compiledCodeBlocks)
            threadCallTargets() = nullptr;
        wasmJITRelease(it->value.function);
        Locker locker { compiledCodeBlocksLock };
        compiledCodeBlocks().remove(codeBlock);
    }
    compiledCode().remove(it);
}

bool wasmJITHasCompiledCode(const CodeBlock* codeBlock)
{
    Locker locker { compiledCodeBlocksLock };
    return compiledCodeBlocks().contains(codeBlock);
}

} // namespace JSC::LLInt

// The embedder's side of the samples (engine/src/EngineLoop.cpp), declared there: it sets the
// function that brings the running script to a safepoint after a delay, and calls
// bl_jsc_jit_sample at its safepoints
extern "C" void bl_jsc_set_jit_sample_requester(void (*)(JSC::VM&, double seconds));
extern "C" void bl_jsc_jit_sample(JSC::VM&);

extern "C" void bl_jsc_set_jit_sample_requester(void (*requester)(JSC::VM&, double seconds))
{
    JSC::LLInt::sampleRequester = requester;
}

// A sample (requestSample): the time since the request counts for the code of the top frame when
// the interpreter runs it and it warms up, and the next sample is asked for while the interpreter
// runs. A safepoint that came for other work before half the interval is no sample; the request's
// own safepoint follows.
extern "C" void bl_jsc_jit_sample(JSC::VM& vm)
{
    using namespace JSC::LLInt;
    auto& state = warmUps();
    if (!state.samplePending)
        return;
    Seconds elapsed = MonotonicTime::now() - state.sampleRequested;
    if (elapsed < sampleInterval / 2)
        return;
    state.samplePending = false;
    JSC::CallFrame* frame = vm.topCallFrame;
    // At a function's entry (the safepoint of its stack check, bytecode offset 0) its frame ran
    // nothing yet: the time was its caller's, unless that is beyond a VM entry. Credited to the
    // callee, the handlers of an obfuscated VM took the samples of its dispatch loop.
    if (frame && frame->codeBlock() && !frame->callSiteIndex().bits())
        frame = frame->callerFrameOrEntryFrame() == vm.topEntryFrame ? nullptr : frame->callerFrame();
    JSC::CodeBlock* codeBlock = frame ? frame->codeBlock() : nullptr;
    if (!codeBlock || &codeBlock->vm() != &vm || compiledCode().contains(codeBlock) || !warmsUpByTime(codeBlock))
        return;
    auto it = state.map.find(codeBlock->unlinkedCodeBlock());
    if (it == state.map.end())
        return;
    it->value.interpreted += std::min(elapsed, sampleInterval * 4);
    requestSample(vm, state);
}
