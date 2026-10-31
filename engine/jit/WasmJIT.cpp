// The JIT to WebAssembly (docs/jit.md): hooks of the C loop (LLIntWasmJIT.h, patch 0067) and the
// compiler of a CodeBlock's bytecode into one WASM function.
//
// The function runs the CodeBlock from one of its basic blocks: (cfr, block) -> status, block 0
// after op_enter or the one after a loop hint, status 0 when it returned (the value in the
// frame's `this` slot, an op_ret of the C loop takes it from there), 1 on an exception (the C loop
// unwinds). Virtual registers stay in the frame, as tag and payload in linear memory, so a
// safepoint inside sees every value like in the interpreter.
#include "config.h"
#include "LLIntWasmJIT.h"

#include "ArrayStorage.h"
#include "BytecodeGenerator.h"
#include "BytecodeStructs.h"
#include "CallData.h"
#include "CellState.h"
#include "ConstructData.h"
#include "CodeBlock.h"
#include "CodeSpecializationKind.h"
#include "CommonSlowPaths.h"
#include "DirectArguments.h"
#include "Fits.h"
#include "FrameTracers.h"
#include "IndexingType.h"
#include "Interpreter.h"
#include "InterpreterInlines.h"
#include "JSCJSValueInlines.h"
#include "JSFunction.h"
#include "JSFunctionInlines.h"
#include "JSGlobalLexicalEnvironment.h"
#include "JSInternalFieldObjectImpl.h"
#include "JSLexicalEnvironment.h"
#include "JSObject.h"
#include "JSString.h"
#include "LLIntData.h"
#include "LLIntSlowPaths.h"
#include "SlowPathCall.h"
#include "StackAlignment.h"
#include "StructureChain.h"
#include "VMTraps.h"
#include "Watchpoint.h"
#include "WasmModule.h"
#include <emscripten.h>
#include <optional>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>

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

// A call site's last compiled callee by its executable, and what its frame needs, so a call
// neither looks up the map nor reads the executable and its CodeBlock. Valid until the next GC
// (which may throw the code away).
struct CallCache {
    WTF_DEPRECATED_MAKE_STRUCT_FAST_ALLOCATED(CallCache);
    ExecutableBase* executable { nullptr };
    HeapVersion markingVersion { 0 };
    HeapVersion edenVersion { 0 };
    CodeBlock* codeBlock { nullptr };
    uint32_t function { 0 };
    unsigned numParameters { 0 };
    unsigned numCalleeLocals { 0 };
    unsigned numVars { 0 };
    VirtualRegister scopeRegister;
};

// A CodeBlock the compiler saw: the table index of its function (0 when it cannot be compiled),
// by bytecode offset the blocks that start after its loop hints, the caches of its calls
struct Compiled {
    uint32_t function { 0 };
    OffsetMap loops;
    Vector<std::unique_ptr<CallCache>> callCaches;
};

// CodeBlocks of this thread's VM. Tables are per thread, so are the indexes.
HashMap<CodeBlock*, Compiled>& compiledCode()
{
    static thread_local HashMap<CodeBlock*, Compiled> map;
    return map;
}

uint32_t compiledFunction(CodeBlock* codeBlock)
{
    auto it = compiledCode().find(codeBlock);
    return it == compiledCode().end() ? 0 : it->value.function;
}

EM_JS(uint32_t, wasmJITInstall, (const uint8_t* bytes, uint32_t size, int dump), {
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
    v(get_by_val_with_this) v(get_property_enumerator) v(is_callable) v(is_constructor) v(new_array_buffer) \
    v(new_array_with_species) v(new_array_with_spread) v(new_async_function_generator) v(new_generator) \
    v(new_promise) v(push_with_scope) v(put_by_id_with_this) v(put_by_val_with_this) v(spread) v(strcat) \
    v(throw_static_error) v(typeof_is_function) v(typeof_is_object) v(unsigned) v(get_prototype_of) v(pow) \
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

// Whether the machine stack has room for about 200 KB more: a WASM recursion with frames of known
// size (32 values live across each call), which V8 stops with a RangeError where it would not
// fit, caught right there with nothing of the engine in between
EM_JS(int, wasmJITStackHasRoom, (), {
    let probe = globalThis.blJitStackProbe;
    if (!probe) {
        const values = 32;
        const body = [1, values, 0x7e];
        for (let k = 1; k <= values; k++)
            body.push(0x20, 0, 0xad, 0x42, k, 0x7c, 0x21, k);
        body.push(0x20, 0, 0x45, 0x04, 0x7f, 0x41, 0, 0x05, 0x20, 0, 0x41, 1, 0x6b, 0x10, 0, 0x0b, 0x20, 1);
        for (let k = 2; k <= values; k++)
            body.push(0x20, k, 0x7c);
        body.push(0xa7, 0x6a, 0x0b);
        const leb = (n) => (n < 128 ? [n] : [(n & 0x7f) | 0x80, n >> 7]);
        const code = [1, ...leb(body.length), ...body];
        const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f, 3, 2, 1, 0,
            7, 5, 1, 1, 0x70, 0, 0, 10, ...leb(code.length), ...code]);
        probe = globalThis.blJitStackProbe = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.p;
    }
    try {
        probe(700);
        return 1;
    } catch (e) {
        return 0;
    }
});

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
    if (!wasmJITStackHasRoom()) {
        crampedDepth = depth;
        return false;
    }
    roomyDepth = depth;
    return true;
}

int32_t runCompiled(uint32_t function, CallFrame* callFrame, uint32_t block)
{
    ++depth;
    auto status = reinterpret_cast<CompiledFunction>(static_cast<uintptr_t>(function))(callFrame, block);
    --depth;
    return status;
}

// Calls the callee in its frame below callFrame, where `this` (new.target for a construct) and
// the arguments already are: a compiled callee directly in that frame, a host function like the
// interpreter calls it, everything else through JSC's generic call or construct (bound functions,
// proxies, interpreted functions, stack overflow). Returns the result, empty after an exception.
template<bool isConstruct>
JSValue callInFrame(VM& vm, JSGlobalObject* globalObject, ThrowScope& scope, CallFrame* callFrame, CallFrame* calleeFrame, JSValue callee, unsigned argumentCount, CallCache* cache)
{
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
        auto& space = vm.heap.objectSpace();
        if (cache->executable != executable || cache->markingVersion != space.markingVersion() || cache->edenVersion != space.edenVersion()) {
            cache->executable = nullptr;
            CodeBlock* calleeCodeBlock = function->isHostFunction() ? nullptr : function->jsExecutable()->codeBlockFor(isConstruct ? CodeSpecializationKind::CodeForConstruct : CodeSpecializationKind::CodeForCall);
            uint32_t compiled = calleeCodeBlock && !calleeCodeBlock->couldBeTainted() ? compiledFunction(calleeCodeBlock) : 0;
            if (compiled) {
                *cache = { executable, space.markingVersion(), space.edenVersion(), calleeCodeBlock, compiled,
                    calleeCodeBlock->numParameters(), calleeCodeBlock->numCalleeLocals(), calleeCodeBlock->numVars(), calleeCodeBlock->scopeRegister() };
            }
        }
        if (cache->executable == executable) {
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
        return JSC::construct(globalObject, callee, constructData, arguments, thisValue);
    } else {
        auto callData = JSC::getCallData(callee);
        if (callData.type == CallData::Type::Native && vm.isSafeToRecurseSoft()) {
            setUpFrame(nullptr);
            // The whole frame is in use, its caller and return pc too: a host function that enters
            // the VM again puts its entry frame below
            auto* previous = vm.cloopStack().currentStackPointer();
            vm.cloopStack().setCurrentStackPointer(reinterpret_cast<Register*>(calleeFrame));
            vm.topCallFrame = calleeFrame;
            JSValue result = JSValue::decode(callData.native.function(globalObject, calleeFrame));
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
        return JSC::call(globalObject, callee, callData, thisValue, arguments);
    }
}

// A call from compiled code (op_call, op_call_ignore_result, op_tail_call, op_construct,
// op_super_construct), with the signature of a slow path and a cache of the call site: in the
// frame the bytecode prepared (argv slots below callFrame). A tail call is an ordinary call here.
template<typename Bytecode>
UGPRPair callFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc, CallCache* cache)
{
    constexpr bool isConstruct = std::is_same_v<Bytecode, OpConstruct> || std::is_same_v<Bytecode, OpSuperConstruct>;
    auto bytecode = pc->as<Bytecode>();
    CodeBlock* codeBlock = callFrame->codeBlock();
    VM& vm = codeBlock->vm();
    SlowPathFrameTracer tracer(vm, callFrame);
    callFrame->setCurrentVPC(pc);
    auto scope = DECLARE_THROW_SCOPE(vm);
    JSValue result = callInFrame<isConstruct>(vm, codeBlock->globalObject(), scope, callFrame, callFrame - bytecode.m_argv, callFrame->r(bytecode.m_callee).jsValue(), bytecode.m_argc, cache);
    if (scope.exception()) [[unlikely]]
        return encodeResult(exceptionInstructions(), callFrame);
    if constexpr (requires { bytecode.m_dst; })
        callFrame->uncheckedR(bytecode.m_dst) = result;
    return encodeResult(pc, callFrame);
}

// op_call_varargs, op_tail_call_varargs, op_construct_varargs, op_super_construct_varargs
// (f.apply(this, arguments), new F(...args)): like the interpreter, a frame below the caller's
// registers in use with the arguments of the array-like (the stack pointer covers it while they
// load), then the call in that frame
template<typename Bytecode>
UGPRPair callVarargsFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc, CallCache* cache)
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
        result = callInFrame<isConstruct>(vm, globalObject, scope, callFrame, calleeFrame, callFrame->r(bytecode.m_callee).jsValue(), length + 1, cache);
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
    // Blocks after loop hints, by bytecode offset
    OffsetMap takeLoops() { return WTF::move(m_loops); }
    Vector<std::unique_ptr<CallCache>> takeCallCaches() { return WTF::move(m_callCaches); }

private:
    bool scan();
    // The first instruction it does not take, for the log
    OpcodeID m_unsupported { op_enter };
    void emitInstruction(const JSInstructionStream::Ref&, unsigned block);

    unsigned targetOf(const JSInstructionStream::Ref& instruction, int label)
    {
        return instruction.offset() + (label ? label : m_codeBlock->outOfLineJumpOffset(instruction));
    }
    const JSInstruction* instructionPointer(unsigned offset) { return m_codeBlock->instructions().at(offset).ptr(); }
    // Bytecode offsets a switch can go to, its default first
    Vector<unsigned> switchTargets(const JSInstructionStream::Ref&);

    // Value of a virtual register: tag or payload, from the frame or the constant pool
    void loadTag(VirtualRegister);
    void loadPayload(VirtualRegister);
    // Tag and payload into the locals
    void load(VirtualRegister, uint32_t tagLocal, uint32_t payloadLocal);
    void storeTagAndPayload(VirtualRegister, uint32_t tagLocal, uint32_t payloadLocal);
    void storeTag(VirtualRegister, int32_t tag, uint32_t payloadLocal);
    void storeInt32(VirtualRegister reg, uint32_t payloadLocal) { storeTag(reg, int32Tag, payloadLocal); }
    void storeBoolean(VirtualRegister reg, uint32_t payloadLocal) { storeTag(reg, booleanTag, payloadLocal); }
    void storeCell(VirtualRegister reg, uint32_t payloadLocal) { storeTag(reg, cellTag, payloadLocal); }
    void storeDouble(VirtualRegister, uint32_t doubleLocal);
    void address(VirtualRegister);
    // Pushes whether the tag in the local is a number's (int32 or double)
    void isNumberTag(uint32_t tagLocal);
    // Pushes a number register as f64, its tag in the local
    void loadNumber(VirtualRegister, uint32_t tagLocal);
    // Pushes the JSType of the cell in the local
    void cellType(uint32_t cellLocal);
    // The write barrier of the cell in the local, like the interpreter's
    void writeBarrier(uint32_t cellLocal);
    // The interpreter's barrier on a store of `value` into `base`: when both are cells
    void writeBarrierOnOperands(VirtualRegister base, VirtualRegister value);
    // The same into a cell known now (the global object)
    void writeBarrierOnConstant(JSCell*, VirtualRegister value);

    // Calls a slow path of the interpreter for the instruction; leaves the returned instruction
    // pointer in m_next, and on an exception goes to the instruction's handler (a try around it)
    // or returns 1
    void callSlowPath(SlowPath, const JSInstructionStream::Ref&);
    // The same for a call (callFromCompiledCode, callVarargsFromCompiledCode), with a new cache of
    // the call site
    template<typename Bytecode> void emitCall(const JSInstructionStream::Ref&);
    // After a helper's call: its result into m_next, an exception to the handler or out
    void checkException(const JSInstructionStream::Ref&);
    // Fast paths mark m_next when they did the instruction; the slow path does it otherwise
    void beginFastPaths();
    void fastPathDone();
    void endFastPaths(SlowPath, const JSInstructionStream::Ref&);
    // To the block of the bytecode offset, from any depth within the block's code
    void jumpTo(unsigned targetOffset, unsigned fromBlock);
    // Jumps when the slow path (just called) returned the target
    void jumpIfSlowPathReturned(unsigned targetOffset, unsigned fromBlock);

    template<typename Bytecode> void emitArithmetic(const JSInstructionStream::Ref&, uint8_t i64Op, uint8_t f64Op, SlowPath);
    void emitDivide(const JSInstructionStream::Ref&);
    template<typename Bytecode> void emitBitOp(const JSInstructionStream::Ref&, uint8_t i32Op, SlowPath, bool unsignedResult = false);
    template<typename Bytecode> void emitCompare(const JSInstructionStream::Ref&, unsigned block, uint8_t i32Op, uint8_t f64Op, bool negate, SlowPath);
    template<typename Bytecode> void emitEquality(const JSInstructionStream::Ref&, unsigned block, bool strict, bool negate, SlowPath);
    template<typename Bytecode> void emitConditionJump(const JSInstructionStream::Ref&, unsigned block, bool jumpIfTrue, SlowPath);
    template<typename Bytecode> void emitIncrement(const JSInstructionStream::Ref&, int32_t delta, SlowPath);
    void emitMod(const JSInstructionStream::Ref&);
    void emitNot(const JSInstructionStream::Ref&);
    void emitNegate(const JSInstructionStream::Ref&);
    // dst = src when it is a number (`numbers`), any other non-cell (`immediates`) or a cell the
    // condition (pushing a boolean, the cell in m_a) takes; else the slow path
    template<typename CellCondition> void emitCopyIf(const JSInstructionStream::Ref&, VirtualRegister dst, VirtualRegister src, bool numbers, bool immediates, const CellCondition&, SlowPath);
    // dst = a boolean of the operand: `condition` pushes it from the tag in m_t1 and payload in m_a
    template<typename Condition> void emitIs(VirtualRegister dst, VirtualRegister operand, const Condition&);
    void emitToThis(const JSInstructionStream::Ref&);
    template<typename Bytecode> void emitGetById(const JSInstructionStream::Ref&, SlowPath);
    void emitGetByIdDirect(const JSInstructionStream::Ref&);
    void emitPutById(const JSInstructionStream::Ref&);
    void emitGetByVal(const JSInstructionStream::Ref&);
    void emitPutByVal(const JSInstructionStream::Ref&);
    void emitResolveScope(const JSInstructionStream::Ref&);
    void emitGetFromScope(const JSInstructionStream::Ref&);
    void emitPutToScope(const JSInstructionStream::Ref&);
    template<typename Bytecode> void emitJumpIfNull(const JSInstructionStream::Ref&, unsigned block);
    template<typename Bytecode> void emitSwitch(const JSInstructionStream::Ref&, unsigned block);
    template<typename Bytecode> void emitGenericJump(const JSInstructionStream::Ref&, unsigned block, SlowPath);
    // Address of a property at the offset in the local, of the object in the local: inline storage
    // or the butterfly's (uses m_c)
    void propertyAddress(uint32_t objectLocal, uint32_t offsetLocal);
    // Loads the property into m_a (tag) and m_b (payload)
    void loadProperty(uint32_t objectLocal, uint32_t offsetLocal);

    CodeBlock* m_codeBlock;
    Module m_module;
    FunctionBody* m_body { nullptr };
    uint32_t m_slowPathType { 0 };
    uint32_t m_barrierType { 0 };
    uint32_t m_checkType { 0 };
    uint32_t m_callType { 0 };
    Vector<std::unique_ptr<CallCache>> m_callCaches;
    // Parameters: the frame and the block to start with
    static constexpr uint32_t cfr = 0;
    static constexpr uint32_t entry = 1;
    uint32_t m_block { 0 }, m_a { 0 }, m_b { 0 }, m_c { 0 }, m_d { 0 }, m_e { 0 }, m_t1 { 0 }, m_t2 { 0 }, m_next { 0 }, m_wide { 0 }, m_x { 0 }, m_y { 0 };
    // Basic blocks: bytecode offset of each start, and the block of an offset
    Vector<unsigned> m_starts;
    OffsetMap m_blockAt;
    OffsetMap m_loops;
    unsigned m_blockCount { 0 };
    // The block being compiled and the depth of its code, for branches out of nested blocks
    unsigned m_currentBlock { 0 };
    uint32_t m_blockDepth { 0 };
};

void Compiler::address(VirtualRegister reg)
{
    m_body->localGet(cfr);
    m_body->i32Const(reg.offset() * static_cast<int>(sizeof(Register)));
    m_body->op(Op::I32Add);
}

void Compiler::loadTag(VirtualRegister reg)
{
    if (reg.isConstant()) {
        m_body->i32Const(static_cast<int32_t>(m_codeBlock->getConstant(reg).tag()));
        return;
    }
    address(reg);
    m_body->i32Load(TagOffset);
}

void Compiler::loadPayload(VirtualRegister reg)
{
    if (reg.isConstant()) {
        m_body->i32Const(m_codeBlock->getConstant(reg).payload());
        return;
    }
    address(reg);
    m_body->i32Load(PayloadOffset);
}

void Compiler::load(VirtualRegister reg, uint32_t tagLocal, uint32_t payloadLocal)
{
    loadTag(reg);
    m_body->localSet(tagLocal);
    loadPayload(reg);
    m_body->localSet(payloadLocal);
}

void Compiler::storeTagAndPayload(VirtualRegister reg, uint32_t tagLocal, uint32_t payloadLocal)
{
    address(reg);
    m_body->localGet(tagLocal);
    m_body->i32Store(TagOffset);
    address(reg);
    m_body->localGet(payloadLocal);
    m_body->i32Store(PayloadOffset);
}

void Compiler::storeTag(VirtualRegister reg, int32_t tag, uint32_t payloadLocal)
{
    address(reg);
    m_body->i32Const(tag);
    m_body->i32Store(TagOffset);
    address(reg);
    m_body->localGet(payloadLocal);
    m_body->i32Store(PayloadOffset);
}

// A double in the register's 8 bytes, as the interpreter stores them (not made int32)
void Compiler::storeDouble(VirtualRegister reg, uint32_t doubleLocal)
{
    address(reg);
    m_body->localGet(doubleLocal);
    m_body->f64Store(0);
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

void Compiler::loadNumber(VirtualRegister reg, uint32_t tagLocal)
{
    if (reg.isConstant()) {
        JSValue value = m_codeBlock->getConstant(reg);
        m_body->f64Const(value.isNumber() ? value.asNumber() : 0);
        return;
    }
    loadPayload(reg);
    m_body->op(Op::F64ConvertI32S);
    address(reg);
    m_body->f64Load(0);
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

void Compiler::writeBarrierOnOperands(VirtualRegister base, VirtualRegister value)
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

void Compiler::writeBarrierOnConstant(JSCell* cell, VirtualRegister value)
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
    m_body->callIndirect(m_slowPathType);
    checkException(instruction);
}

template<typename Bytecode>
void Compiler::emitCall(const JSInstructionStream::Ref& instruction)
{
    m_callCaches.append(makeUnique<CallCache>());
    m_body->localGet(cfr);
    m_body->i32Const(reinterpret_cast<uintptr_t>(instruction.ptr()));
    m_body->i32Const(reinterpret_cast<uintptr_t>(m_callCaches.last().get()));
    if constexpr (requires(Bytecode bytecode) { bytecode.m_firstVarArg; })
        m_body->i32Const(reinterpret_cast<uintptr_t>(&callVarargsFromCompiledCode<Bytecode>));
    else
        m_body->i32Const(reinterpret_cast<uintptr_t>(&callFromCompiledCode<Bytecode>));
    m_body->callIndirect(m_callType);
    checkException(instruction);
}

void Compiler::checkException(const JSInstructionStream::Ref& instruction)
{
    m_body->op(Op::I32WrapI64);
    m_body->localTee(m_next);
    m_body->i32Const(reinterpret_cast<uintptr_t>(exceptionInstructions()));
    m_body->op(Op::I32Eq);
    m_body->ifThen();
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
    m_body->end();
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
    m_body->ifThen();
    callSlowPath(slowPath, instruction);
    m_body->end();
}

// To the dispatch loop with the block of the target: the code of block i sits in the blocks
// i + 1 ... n - 1 within the loop
void Compiler::jumpTo(unsigned targetOffset, unsigned fromBlock)
{
    m_body->i32Const(m_blockAt.get(targetOffset));
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

void Compiler::propertyAddress(uint32_t objectLocal, uint32_t offsetLocal)
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
        m_body->localSet(m_c);
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
        m_body->localSet(m_c);
    }
    m_body->end();
    m_body->localGet(m_c);
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
void Compiler::emitGetById(const JSInstructionStream::Ref& instruction, SlowPath slowPath)
{
    auto bytecode = instruction->as<Bytecode>();
    auto& cache = bytecode.metadata(m_codeBlock).m_modeMetadata;
    auto mode = [&](GetByIdMode value) {
        m_body->localGet(m_t1);
        m_body->i32Const(static_cast<int32_t>(value));
        m_body->op(Op::I32Eq);
    };
    auto structureIs = [&](const StructureID* cached) {
        m_body->localGet(m_d);
        m_body->i32Load(JSCell::structureIDOffset());
        m_body->i32Const(reinterpret_cast<uintptr_t>(cached));
        m_body->i32Load(0);
        m_body->op(Op::I32Eq);
    };
    auto loadCached = [&](const void* field) {
        m_body->i32Const(reinterpret_cast<uintptr_t>(field));
        m_body->i32Load(0);
    };
    beginFastPaths();
    loadTag(bytecode.m_base);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    {
        loadPayload(bytecode.m_base);
        m_body->localSet(m_d);
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.mode));
        m_body->i32Load8U(0);
        m_body->localSet(m_t1);

        mode(GetByIdMode::Default);
        structureIs(&cache.defaultMode.structureID);
        m_body->op(Op::I32And);
        m_body->ifThen();
        loadCached(&cache.defaultMode.cachedOffset);
        m_body->localSet(m_t2);
        loadProperty(m_d, m_t2);
        storeTagAndPayload(bytecode.m_dst, m_a, m_b);
        fastPathDone();
        m_body->end();

        mode(GetByIdMode::ProtoLoad);
        structureIs(&cache.protoLoadMode.structureID);
        m_body->op(Op::I32And);
        m_body->ifThen();
        loadCached(&cache.protoLoadMode.cachedOffset);
        m_body->localSet(m_t2);
        loadCached(&cache.protoLoadMode.cachedSlot);
        m_body->localSet(m_d);
        loadProperty(m_d, m_t2);
        storeTagAndPayload(bytecode.m_dst, m_a, m_b);
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
        storeInt32(bytecode.m_dst, m_b);
        fastPathDone();
        m_body->end();
        m_body->end();
        m_body->end();

        mode(GetByIdMode::Unset);
        structureIs(&cache.unsetMode.structureID);
        m_body->op(Op::I32And);
        m_body->ifThen();
        m_body->i32Const(0);
        m_body->localSet(m_b);
        storeTag(bytecode.m_dst, static_cast<int32_t>(JSValue::UndefinedTag), m_b);
        fastPathDone();
        m_body->end();
    }
    m_body->end();
    endFastPaths(slowPath, instruction);
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
void Compiler::emitGetByVal(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpGetByVal>();
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
        storeTagAndPayload(bytecode.m_dst, m_a, m_e);
        fastPathDone();
        m_body->end();
    };
    beginFastPaths();
    loadTag(bytecode.m_base);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    loadTag(bytecode.m_property);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32And);
    m_body->ifThen();
    {
        loadPayload(bytecode.m_base);
        m_body->localTee(m_d);
        m_body->i32Load8U(JSCell::indexingTypeAndMiscOffset());
        m_body->i32Const(IndexingShapeMask);
        m_body->op(Op::I32And);
        m_body->localSet(m_t1);
        m_body->localGet(m_d);
        m_body->i32Load(JSObject::butterflyOffset());
        m_body->localSet(m_t2);
        loadPayload(bytecode.m_property);
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
        storeDouble(bytecode.m_dst, m_x);
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
    }
    m_body->end();
    endFastPaths(llint_slow_path_get_by_val, instruction);
}

// Like the interpreter: an int32 index into an int32 (an int32 value), double (a number, not
// NaN) or contiguous butterfly that is not copy on write, within its vector (growing the public
// length) ; the write barrier first
void Compiler::emitPutByVal(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpPutByVal>();
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
    writeBarrierOnOperands(bytecode.m_base, bytecode.m_value);
    beginFastPaths();
    loadTag(bytecode.m_base);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    loadTag(bytecode.m_property);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32And);
    m_body->ifThen();
    {
        loadPayload(bytecode.m_base);
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
        loadTag(bytecode.m_value);
        m_body->localSet(m_a);
        loadNumber(bytecode.m_value, m_a);
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
            loadPayload(bytecode.m_property);
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
                loadPayload(bytecode.m_value);
                m_body->i32Store(PayloadOffset);
                m_body->end();
                fastPathDone();
            }
            m_body->end();
        }
        m_body->end();
    }
    m_body->end();
    endFastPaths(llint_slow_path_put_by_val, instruction);
}

// add, sub, mul: two int32 in 64 bit, the result back if it fits (and is no -0 for mul); other
// numbers (and int32 results that do not fit) as doubles
template<typename Bytecode>
void Compiler::emitArithmetic(const JSInstructionStream::Ref& instruction, uint8_t i64Op, uint8_t f64Op, SlowPath slowPath)
{
    auto bytecode = instruction->as<Bytecode>();
    loadTag(bytecode.m_lhs);
    m_body->localSet(m_t1);
    loadTag(bytecode.m_rhs);
    m_body->localSet(m_t2);
    beginFastPaths();
    m_body->localGet(m_t1);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    m_body->localGet(m_t2);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32And);
    m_body->ifThen();
    {
        loadPayload(bytecode.m_lhs);
        m_body->localSet(m_a);
        loadPayload(bytecode.m_rhs);
        m_body->localSet(m_b);
        m_body->localGet(m_a);
        m_body->op(Op::I64ExtendI32S);
        m_body->localGet(m_b);
        m_body->op(Op::I64ExtendI32S);
        m_body->op(i64Op);
        m_body->localTee(m_wide);
        m_body->op(Op::I32WrapI64);
        m_body->localSet(m_c);
        // fits: sign extension of the low 32 bits is the whole result
        m_body->localGet(m_c);
        m_body->op(Op::I64ExtendI32S);
        m_body->localGet(m_wide);
        m_body->op(Op::I64Eq);
        if (i64Op == Op::I64Mul) {
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
        m_body->ifThen();
        storeInt32(bytecode.m_dst, m_c);
        fastPathDone();
        m_body->end();
    }
    m_body->end();
    m_body->localGet(m_next);
    m_body->op(Op::I32Eqz);
    isNumberTag(m_t1);
    m_body->op(Op::I32And);
    isNumberTag(m_t2);
    m_body->op(Op::I32And);
    m_body->ifThen();
    loadNumber(bytecode.m_lhs, m_t1);
    loadNumber(bytecode.m_rhs, m_t2);
    m_body->op(f64Op);
    m_body->localSet(m_x);
    storeDouble(bytecode.m_dst, m_x);
    fastPathDone();
    m_body->end();
    endFastPaths(slowPath, instruction);
}

// Numbers as doubles; a result that is an int32 (not -0) as one, like the interpreter
void Compiler::emitDivide(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpDiv>();
    loadTag(bytecode.m_lhs);
    m_body->localSet(m_t1);
    loadTag(bytecode.m_rhs);
    m_body->localSet(m_t2);
    beginFastPaths();
    isNumberTag(m_t1);
    isNumberTag(m_t2);
    m_body->op(Op::I32And);
    m_body->ifThen();
    {
        loadNumber(bytecode.m_lhs, m_t1);
        loadNumber(bytecode.m_rhs, m_t2);
        m_body->op(Op::F64Div);
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
        storeInt32(bytecode.m_dst, m_c);
        m_body->elseThen();
        storeDouble(bytecode.m_dst, m_x);
        m_body->end();
        fastPathDone();
    }
    m_body->end();
    endFastPaths(slow_path_div, instruction);
}

// bitand, bitor, bitxor, lshift, rshift of two int32; urshift when the result fits an int32
template<typename Bytecode>
void Compiler::emitBitOp(const JSInstructionStream::Ref& instruction, uint8_t i32Op, SlowPath slowPath, bool unsignedResult)
{
    auto bytecode = instruction->as<Bytecode>();
    beginFastPaths();
    loadTag(bytecode.m_lhs);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    loadTag(bytecode.m_rhs);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32And);
    m_body->ifThen();
    loadPayload(bytecode.m_lhs);
    loadPayload(bytecode.m_rhs);
    m_body->op(i32Op);
    m_body->localTee(m_c);
    if (unsignedResult) {
        m_body->i32Const(0);
        m_body->op(Op::I32GeS);
    } else {
        m_body->drop();
        m_body->i32Const(1);
    }
    m_body->ifThen();
    storeInt32(bytecode.m_dst, m_c);
    fastPathDone();
    m_body->end();
    m_body->end();
    endFastPaths(slowPath, instruction);
}

// less, lesseq, ... into a boolean or a jump (negated for jnless and the like, which jump also
// for NaN): int32 and doubles inline, the rest in the slow path
template<typename Bytecode>
void Compiler::emitCompare(const JSInstructionStream::Ref& instruction, unsigned block, uint8_t i32Op, uint8_t f64Op, bool negate, SlowPath slowPath)
{
    auto bytecode = instruction->as<Bytecode>();
    loadTag(bytecode.m_lhs);
    m_body->localSet(m_t1);
    loadTag(bytecode.m_rhs);
    m_body->localSet(m_t2);
    isNumberTag(m_t1);
    isNumberTag(m_t2);
    m_body->op(Op::I32And);
    m_body->ifThen();
    {
        m_body->localGet(m_t1);
        m_body->localGet(m_t2);
        m_body->op(Op::I32And);
        m_body->i32Const(int32Tag);
        m_body->op(Op::I32Eq);
        m_body->ifThen();
        loadPayload(bytecode.m_lhs);
        loadPayload(bytecode.m_rhs);
        m_body->op(i32Op);
        m_body->localSet(m_c);
        m_body->elseThen();
        loadNumber(bytecode.m_lhs, m_t1);
        loadNumber(bytecode.m_rhs, m_t2);
        m_body->op(f64Op);
        m_body->localSet(m_c);
        m_body->end();
        if (negate) {
            m_body->localGet(m_c);
            m_body->op(Op::I32Eqz);
            m_body->localSet(m_c);
        }
        if constexpr (!requires { bytecode.m_targetLabel; })
            storeBoolean(bytecode.m_dst, m_c);
    }
    m_body->elseThen();
    callSlowPath(slowPath, instruction);
    if constexpr (requires { bytecode.m_targetLabel; }) {
        m_body->localGet(m_next);
        m_body->i32Const(reinterpret_cast<uintptr_t>(instructionPointer(targetOf(instruction, bytecode.m_targetLabel.target()))));
        m_body->op(Op::I32Eq);
        m_body->localSet(m_c);
    }
    m_body->end();
    if constexpr (requires { bytecode.m_targetLabel; }) {
        m_body->localGet(m_c);
        m_body->ifThen();
        jumpTo(targetOf(instruction, bytecode.m_targetLabel.target()), block);
        m_body->end();
    }
}

// eq, neq, stricteq, nstricteq into a boolean or a jump: values with the same tag compare their
// payloads (not cells for ==, not two strings or the like for ===), numbers as doubles, the rest
// in the slow path
template<typename Bytecode>
void Compiler::emitEquality(const JSInstructionStream::Ref& instruction, unsigned block, bool strict, bool negate, SlowPath slowPath)
{
    auto bytecode = instruction->as<Bytecode>();
    constexpr bool isJump = requires { bytecode.m_targetLabel; };
    load(bytecode.m_lhs, m_t1, m_a);
    load(bytecode.m_rhs, m_t2, m_b);
    m_body->localGet(m_t1);
    m_body->localGet(m_t2);
    m_body->op(Op::I32Eq);
    m_body->localGet(m_t1);
    m_body->i32Const(lowestTag);
    m_body->op(Op::I32GeU);
    m_body->op(Op::I32And);
    m_body->localSet(m_e);
    m_body->localGet(m_e);
    m_body->localGet(m_t1);
    m_body->i32Const(cellTag);
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32And);
    m_body->ifThen();
    if (strict) {
        cellType(m_a);
        m_body->i32Const(ObjectType);
        m_body->op(Op::I32GeU);
        cellType(m_b);
        m_body->i32Const(ObjectType);
        m_body->op(Op::I32GeU);
        m_body->op(Op::I32Or);
    } else
        m_body->i32Const(0);
    m_body->localSet(m_e);
    m_body->end();

    m_body->localGet(m_e);
    m_body->ifThen();
    {
        m_body->localGet(m_a);
        m_body->localGet(m_b);
        m_body->op(negate ? Op::I32Ne : Op::I32Eq);
        m_body->localSet(m_c);
        if constexpr (!isJump)
            storeBoolean(bytecode.m_dst, m_c);
    }
    m_body->elseThen();
    {
        isNumberTag(m_t1);
        isNumberTag(m_t2);
        m_body->op(Op::I32And);
        m_body->ifThen();
        loadNumber(bytecode.m_lhs, m_t1);
        loadNumber(bytecode.m_rhs, m_t2);
        m_body->op(negate ? Op::F64Ne : Op::F64Eq);
        m_body->localSet(m_c);
        if constexpr (!isJump)
            storeBoolean(bytecode.m_dst, m_c);
        m_body->elseThen();
        callSlowPath(slowPath, instruction);
        if constexpr (isJump) {
            m_body->localGet(m_next);
            m_body->i32Const(reinterpret_cast<uintptr_t>(instructionPointer(targetOf(instruction, bytecode.m_targetLabel.target()))));
            m_body->op(Op::I32Eq);
            m_body->localSet(m_c);
        }
        m_body->end();
    }
    m_body->end();
    if constexpr (isJump) {
        m_body->localGet(m_c);
        m_body->ifThen();
        jumpTo(targetOf(instruction, bytecode.m_targetLabel.target()), block);
        m_body->end();
    }
}

// jtrue, jfalse: booleans, int32, undefined, null and objects (not masquerading as undefined)
// inline
template<typename Bytecode>
void Compiler::emitConditionJump(const JSInstructionStream::Ref& instruction, unsigned block, bool jumpIfTrue, SlowPath slowPath)
{
    auto bytecode = instruction->as<Bytecode>();
    unsigned target = targetOf(instruction, bytecode.m_targetLabel.target());
    auto tagIs = [&](int32_t tag) {
        m_body->localGet(m_t1);
        m_body->i32Const(tag);
        m_body->op(Op::I32Eq);
    };
    // m_c: whether it is true, m_e: whether that is known
    load(bytecode.m_condition, m_t1, m_a);
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
    m_body->end();

    m_body->localGet(m_e);
    m_body->ifThen();
    if (!jumpIfTrue) {
        m_body->localGet(m_c);
        m_body->op(Op::I32Eqz);
        m_body->localSet(m_c);
    }
    m_body->elseThen();
    callSlowPath(slowPath, instruction);
    m_body->localGet(m_next);
    m_body->i32Const(reinterpret_cast<uintptr_t>(instructionPointer(target)));
    m_body->op(Op::I32Eq);
    m_body->localSet(m_c);
    m_body->end();
    m_body->localGet(m_c);
    m_body->ifThen();
    jumpTo(target, block);
    m_body->end();
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

void Compiler::emitNot(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpNot>();
    loadTag(bytecode.m_operand);
    m_body->i32Const(booleanTag);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    loadPayload(bytecode.m_operand);
    m_body->i32Const(1);
    m_body->op(Op::I32Xor);
    m_body->localSet(m_c);
    storeBoolean(bytecode.m_dst, m_c);
    m_body->elseThen();
    callSlowPath(slow_path_not, instruction);
    m_body->end();
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
// levels up; dynamic cases and the ones with var injection checks in the slow path
void Compiler::emitResolveScope(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpResolveScope>();
    auto& cache = bytecode.metadata(m_codeBlock);
    auto resolveType = [&] {
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_resolveType));
        m_body->i32Load(0);
    };
    auto constantScope = [&] {
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_constantScope));
        m_body->i32Load(0);
    };
    beginFastPaths();

    resolveType();
    m_body->i32Const(GlobalProperty);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    {
        // The global lexical bindings did not change since the cache was made
        constantScope();
        m_body->localTee(m_a);
        m_body->i32Load(JSGlobalObject::offsetOfGlobalLexicalBindingEpoch());
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_globalLexicalBindingEpoch));
        m_body->i32Load(0);
        m_body->op(Op::I32Eq);
        m_body->ifThen();
        storeCell(bytecode.m_dst, m_a);
        fastPathDone();
        m_body->end();
    }
    m_body->end();

    for (auto type : { GlobalVar, GlobalLexicalVar, ModuleVar }) {
        resolveType();
        m_body->i32Const(type);
        m_body->op(Op::I32Eq);
        m_body->ifThen();
        constantScope();
        m_body->localSet(m_a);
        storeCell(bytecode.m_dst, m_a);
        fastPathDone();
        m_body->end();
    }

    resolveType();
    m_body->i32Const(ClosureVar);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    {
        loadPayload(bytecode.m_scope);
        m_body->localSet(m_a);
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_localScopeDepth));
        m_body->i32Load(0);
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
        storeCell(bytecode.m_dst, m_a);
        fastPathDone();
    }
    m_body->end();
    endFastPaths(slow_path_resolve_scope, instruction);
}

// Like the interpreter: a global property behind a structure check, a global variable through its
// pointer (a lexical one not before its initialization), a closure variable in its environment
void Compiler::emitGetFromScope(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpGetFromScope>();
    auto& cache = bytecode.metadata(m_codeBlock);
    auto resolveType = [&] {
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_getPutInfo));
        m_body->i32Load(0);
        m_body->i32Const(GetPutInfo::typeBits);
        m_body->op(Op::I32And);
    };
    auto operand = [&] {
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_operand));
        m_body->i32Load(0);
    };
    auto finish = [&] {
        storeTagAndPayload(bytecode.m_dst, m_a, m_b);
        fastPathDone();
    };
    beginFastPaths();

    resolveType();
    m_body->i32Const(GlobalProperty);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    {
        loadPayload(bytecode.m_scope);
        m_body->localTee(m_d);
        m_body->i32Load(JSCell::structureIDOffset());
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_structureID));
        m_body->i32Load(0);
        m_body->op(Op::I32Eq);
        m_body->ifThen();
        operand();
        m_body->localSet(m_t2);
        loadProperty(m_d, m_t2);
        finish();
        m_body->end();
    }
    m_body->end();

    for (auto type : { GlobalVar, GlobalLexicalVar }) {
        resolveType();
        m_body->i32Const(type);
        m_body->op(Op::I32Eq);
        m_body->ifThen();
        operand();
        m_body->localTee(m_c);
        m_body->i32Load(TagOffset);
        m_body->localSet(m_a);
        m_body->localGet(m_c);
        m_body->i32Load(PayloadOffset);
        m_body->localSet(m_b);
        if (type == GlobalLexicalVar) {
            // Not before its initialization (TDZ): the slow path throws
            m_body->localGet(m_a);
            m_body->i32Const(emptyTag);
            m_body->op(Op::I32Ne);
            m_body->ifThen();
            finish();
            m_body->end();
        } else
            finish();
        m_body->end();
    }

    resolveType();
    m_body->i32Const(ClosureVar);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    {
        loadPayload(bytecode.m_scope);
        m_body->i32Const(JSLexicalEnvironment::offsetOfVariables());
        m_body->op(Op::I32Add);
        operand();
        m_body->i32Const(3);
        m_body->op(Op::I32Shl);
        m_body->op(Op::I32Add);
        m_body->localTee(m_c);
        m_body->i32Load(TagOffset);
        m_body->localSet(m_a);
        m_body->localGet(m_c);
        m_body->i32Load(PayloadOffset);
        m_body->localSet(m_b);
        finish();
    }
    m_body->end();
    endFastPaths(llint_slow_path_get_from_scope, instruction);
}

// Like the interpreter: a closure variable (one with a watchpoint set only when that is already
// invalidated), a global property behind a structure check, a global variable (writable, no
// watchpoint to fire, a lexical one initialized); with the write barrier after the store
void Compiler::emitPutToScope(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpPutToScope>();
    auto& cache = bytecode.metadata(m_codeBlock);
    JSGlobalObject* globalObject = m_codeBlock->globalObject();
    auto resolveType = [&](ResolveType type) {
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_getPutInfo));
        m_body->i32Load(0);
        m_body->i32Const(GetPutInfo::typeBits);
        m_body->op(Op::I32And);
        m_body->i32Const(type);
        m_body->op(Op::I32Eq);
    };
    auto operand = [&] {
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_operand));
        m_body->i32Load(0);
    };
    // No watchpoint set, or an invalidated one (a write fires nothing)
    auto watchpointFree = [&] {
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_watchpointSet));
        m_body->i32Load(0);
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
        loadTag(bytecode.m_value);
        m_body->i32Store(TagOffset);
        m_body->localGet(m_c);
        loadPayload(bytecode.m_value);
        m_body->i32Store(PayloadOffset);
        fastPathDone();
    };
    auto closureVariable = [&] {
        loadPayload(bytecode.m_scope);
        m_body->i32Const(JSLexicalEnvironment::offsetOfVariables());
        m_body->op(Op::I32Add);
        operand();
        m_body->i32Const(3);
        m_body->op(Op::I32Shl);
        m_body->op(Op::I32Add);
        store();
        writeBarrierOnOperands(bytecode.m_scope, bytecode.m_value);
    };
    beginFastPaths();

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
        loadPayload(bytecode.m_scope);
        m_body->localTee(m_d);
        m_body->i32Load(JSCell::structureIDOffset());
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_structureID));
        m_body->i32Load(0);
        m_body->op(Op::I32Eq);
        m_body->ifThen();
        operand();
        m_body->localSet(m_t2);
        propertyAddress(m_d, m_t2);
        store();
        writeBarrierOnOperands(bytecode.m_scope, bytecode.m_value);
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
    writeBarrierOnConstant(globalObject, bytecode.m_value);
    m_body->end();
    m_body->end();

    // A global let or const: an assignment (not the initialization) only after the initialization
    resolveType(GlobalLexicalVar);
    m_body->ifThen();
    watchpointFree();
    m_body->ifThen();
    {
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_getPutInfo));
        m_body->i32Load(0);
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
        writeBarrierOnConstant(globalObject->globalLexicalEnvironment(), bytecode.m_value);
        m_body->end();
    }
    m_body->end();
    m_body->end();
    endFastPaths(llint_slow_path_put_to_scope, instruction);
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

// The target from C++, then to its block
template<typename Bytecode>
void Compiler::emitSwitch(const JSInstructionStream::Ref& instruction, unsigned block)
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
        case op_new_array: case op_to_primitive: case op_to_string: case op_to_object: case op_to_this:
        case op_to_property_key: case op_to_property_key_or_number: case op_check_traps: case op_call:
        case op_call_ignore_result: case op_tail_call: case op_construct: case op_call_varargs:
        case op_tail_call_varargs: case op_construct_varargs: case op_super_construct:
        case op_super_construct_varargs: case op_argument_count: case op_get_argument:
        case op_eq_null: case op_neq_null: case op_nop: case op_check_tdz: case op_get_scope: case op_is_empty:
        case op_is_undefined_or_null: case op_is_boolean: case op_is_number: case op_is_cell_with_type:
        case op_is_object: case op_typeof_is_undefined: case op_catch: case op_bitnot: case op_get_parent_scope:
        case op_get_internal_field: case op_put_internal_field: case op_iterator_open: case op_iterator_next:
        case op_get_from_arguments: case op_put_to_arguments:
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
    case op_loop_hint:
        return;
    case op_add: emitArithmetic<OpAdd>(instruction, Op::I64Add, Op::F64Add, slow_path_add); return;
    case op_sub: emitArithmetic<OpSub>(instruction, Op::I64Sub, Op::F64Sub, slow_path_sub); return;
    case op_mul: emitArithmetic<OpMul>(instruction, Op::I64Mul, Op::F64Mul, slow_path_mul); return;
    case op_div: emitDivide(instruction); return;
    case op_mod: emitMod(instruction); return;
    case op_inc: emitIncrement<OpInc>(instruction, 1, slow_path_inc); return;
    case op_dec: emitIncrement<OpDec>(instruction, -1, slow_path_dec); return;
    case op_negate: emitNegate(instruction); return;
    case op_less: emitCompare<OpLess>(instruction, block, Op::I32LtS, Op::F64Lt, false, llint_slow_path_less); return;
    case op_lesseq: emitCompare<OpLesseq>(instruction, block, Op::I32LeS, Op::F64Le, false, llint_slow_path_lesseq); return;
    case op_greater: emitCompare<OpGreater>(instruction, block, Op::I32GtS, Op::F64Gt, false, llint_slow_path_greater); return;
    case op_greatereq: emitCompare<OpGreatereq>(instruction, block, Op::I32GeS, Op::F64Ge, false, llint_slow_path_greatereq); return;
    case op_eq: emitEquality<OpEq>(instruction, block, false, false, slow_path_eq); return;
    case op_neq: emitEquality<OpNeq>(instruction, block, false, true, slow_path_neq); return;
    case op_stricteq: emitEquality<OpStricteq>(instruction, block, true, false, slow_path_stricteq); return;
    case op_nstricteq: emitEquality<OpNstricteq>(instruction, block, true, true, slow_path_nstricteq); return;
    case op_bitand: emitBitOp<OpBitand>(instruction, Op::I32And, slow_path_bitand); return;
    case op_bitor: emitBitOp<OpBitor>(instruction, Op::I32Or, slow_path_bitor); return;
    case op_bitxor: emitBitOp<OpBitxor>(instruction, Op::I32Xor, slow_path_bitxor); return;
    case op_lshift: emitBitOp<OpLshift>(instruction, Op::I32Shl, slow_path_lshift); return;
    case op_rshift: emitBitOp<OpRshift>(instruction, Op::I32ShrS, slow_path_rshift); return;
    case op_urshift: emitBitOp<OpUrshift>(instruction, Op::I32ShrU, slow_path_urshift, true); return;
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
        load(bytecode.m_operand, m_t1, m_a);
        tagIs(int32Tag);
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
    case op_get_by_id: emitGetById<OpGetById>(instruction, llint_slow_path_get_by_id); return;
    case op_get_length: emitGetById<OpGetLength>(instruction, llint_slow_path_get_length); return;
    case op_get_by_id_direct: emitGetByIdDirect(instruction); return;
    case op_put_by_id: emitPutById(instruction); return;
    case op_get_by_val: emitGetByVal(instruction); return;
    case op_put_by_val: emitPutByVal(instruction); return;
    case op_get_from_scope: emitGetFromScope(instruction); return;
    case op_put_to_scope: emitPutToScope(instruction); return;
    case op_resolve_scope: emitResolveScope(instruction); return;
    case op_typeof: callSlowPath(slow_path_typeof, instruction); return;
    case op_new_object: callSlowPath(llint_slow_path_new_object, instruction); return;
    case op_new_array: callSlowPath(llint_slow_path_new_array, instruction); return;
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
    case op_check_traps: {
        // Like the interpreter: the trap bits, and with any set the bytecode offset in the frame
        // and the trap handler (a GC at this safepoint, a watchdog's exception)
        m_body->i32Const(reinterpret_cast<uintptr_t>(m_codeBlock->vm().traps().trapBitsAddress()));
        m_body->i32Load(0);
        m_body->i32Const(VMTraps::AsyncEvents);
        m_body->op(Op::I32And);
        m_body->ifThen();
        m_body->localGet(cfr);
        m_body->i32Const(instruction.offset());
        m_body->i32Store(CallFrameSlot::argumentCountIncludingThis * sizeof(Register) + TagOffset);
        m_body->localGet(cfr);
        m_body->i32Const(reinterpret_cast<uintptr_t>(instruction.ptr()));
        m_body->i32Const(reinterpret_cast<uintptr_t>(static_cast<SlowPath>(llint_slow_path_handle_traps)));
        m_body->callIndirect(m_slowPathType);
        m_body->op(Op::I32WrapI64);
        m_body->ifThen();
        m_body->i32Const(1);
        m_body->returnValue();
        m_body->end();
        m_body->end();
        return;
    }
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
    case op_jtrue: emitConditionJump<OpJtrue>(instruction, block, true, llint_slow_path_jtrue); return;
    case op_jfalse: emitConditionJump<OpJfalse>(instruction, block, false, llint_slow_path_jfalse); return;
    case op_jless: emitCompare<OpJless>(instruction, block, Op::I32LtS, Op::F64Lt, false, llint_slow_path_jless); return;
    case op_jlesseq: emitCompare<OpJlesseq>(instruction, block, Op::I32LeS, Op::F64Le, false, llint_slow_path_jlesseq); return;
    case op_jgreater: emitCompare<OpJgreater>(instruction, block, Op::I32GtS, Op::F64Gt, false, llint_slow_path_jgreater); return;
    case op_jgreatereq: emitCompare<OpJgreatereq>(instruction, block, Op::I32GeS, Op::F64Ge, false, llint_slow_path_jgreatereq); return;
    // jn...: jump when the comparison is false (also for NaN)
    case op_jnless: emitCompare<OpJnless>(instruction, block, Op::I32LtS, Op::F64Lt, true, llint_slow_path_jnless); return;
    case op_jnlesseq: emitCompare<OpJnlesseq>(instruction, block, Op::I32LeS, Op::F64Le, true, llint_slow_path_jnlesseq); return;
    case op_jngreater: emitCompare<OpJngreater>(instruction, block, Op::I32GtS, Op::F64Gt, true, llint_slow_path_jngreater); return;
    case op_jngreatereq: emitCompare<OpJngreatereq>(instruction, block, Op::I32GeS, Op::F64Ge, true, llint_slow_path_jngreatereq); return;
    case op_jeq: emitEquality<OpJeq>(instruction, block, false, false, llint_slow_path_jeq); return;
    case op_jneq: emitEquality<OpJneq>(instruction, block, false, true, llint_slow_path_jneq); return;
    case op_jstricteq: emitEquality<OpJstricteq>(instruction, block, true, false, llint_slow_path_jstricteq); return;
    case op_jnstricteq: emitEquality<OpJnstricteq>(instruction, block, true, true, llint_slow_path_jnstricteq); return;
    default:
        RELEASE_ASSERT_NOT_REACHED();
    }
}

std::optional<std::vector<uint8_t>> Compiler::compile()
{
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
    m_body = &m_module.function(2);
    m_block = m_body->addLocal(ValueType::I32);
    m_a = m_body->addLocal(ValueType::I32);
    m_b = m_body->addLocal(ValueType::I32);
    m_c = m_body->addLocal(ValueType::I32);
    m_d = m_body->addLocal(ValueType::I32);
    m_e = m_body->addLocal(ValueType::I32);
    m_t1 = m_body->addLocal(ValueType::I32);
    m_t2 = m_body->addLocal(ValueType::I32);
    m_next = m_body->addLocal(ValueType::I32);
    m_wide = m_body->addLocal(ValueType::I64);
    m_x = m_body->addLocal(ValueType::F64);
    m_y = m_body->addLocal(ValueType::F64);

    m_body->localGet(entry);
    m_body->localSet(m_block);
    // loop { block * n { br_table } code 0 } code 1 ... } code n - 1 }
    m_body->loop();
    for (unsigned i = 0; i < m_blockCount; ++i)
        m_body->block();
    m_body->localGet(m_block);
    Vector<uint32_t> depths;
    for (unsigned i = 0; i < m_blockCount; ++i)
        depths.append(i);
    m_body->brTable(depths.span(), m_blockCount - 1);

    auto& instructions = m_codeBlock->instructions();
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
    return m_module.bytes();
}

} // namespace

const JSInstruction* wasmJITEnter(CallFrame* callFrame, CodeBlock* codeBlock)
{
    if (!enabled())
        return nullptr;
    auto function = compiledFunction(codeBlock);
    if (!function || !roomForCompiledCode())
        return nullptr;
    auto status = runCompiled(function, callFrame, 0);
    return status ? exceptionInstructions() : returnInstruction();
}

void wasmJITTierUp(CodeBlock* codeBlock)
{
    if (enabled() && !compiledCode().contains(codeBlock)) {
        Compiled compiled;
        Compiler compiler(codeBlock);
        auto bytes = compiler.compile();
        if (bytes) {
            compiled.function = wasmJITInstall(bytes->data(), bytes->size(), level() >= 3);
            compiled.loops = compiler.takeLoops();
            compiled.callCaches = compiler.takeCallCaches();
        }
        if (level() >= 2) {
            if (bytes)
                dataLogLn("[jit] ", *codeBlock, ": ", bytes->size(), " bytes, function ", compiled.function);
            else
                dataLogLn("[jit] ", *codeBlock, ": not compiled (", opcodeNames[compiler.unsupported()], ")");
        }
        compiledCode().add(codeBlock, WTF::move(compiled));
    }
    codeBlock->dontJITAnytimeSoon();
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
    // over the op_loop_hint
    auto* next = status ? exceptionInstructions() : returnInstruction();
    uintptr_t offset = reinterpret_cast<uintptr_t>(next) - reinterpret_cast<uintptr_t>(codeBlock->instructions().at(0).ptr()) - pc->size();
    reinterpret_cast<Register*>(callFrame)[static_cast<int>(CallFrameSlot::argumentCountIncludingThis)].tag() = static_cast<int32_t>(offset);
}

void wasmJITForget(CodeBlock* codeBlock)
{
    auto it = compiledCode().find(codeBlock);
    if (it == compiledCode().end())
        return;
    if (it->value.function)
        wasmJITRelease(it->value.function);
    compiledCode().remove(it);
}

} // namespace JSC::LLInt
