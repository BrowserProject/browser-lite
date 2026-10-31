// The JIT to WebAssembly (docs/jit.md): hooks of the C loop (LLIntWasmJIT.h, patch 0067) and the
// compiler of a CodeBlock's bytecode into one WASM function.
//
// The function runs the CodeBlock from the instruction after op_enter: (cfr) -> status, 0 when
// it returned (the value in the frame's `this` slot, an op_ret of the C loop takes it from there),
// 1 on an exception (the C loop unwinds). Virtual registers stay in the frame, as tag and payload
// in linear memory, so a safepoint inside sees every value like in the interpreter.
#include "config.h"
#include "LLIntWasmJIT.h"

#include "BytecodeGenerator.h"
#include "BytecodeStructs.h"
#include "CallData.h"
#include "CellState.h"
#include "ConstructData.h"
#include "CodeBlock.h"
#include "CommonSlowPaths.h"
#include "Fits.h"
#include "FrameTracers.h"
#include "JSCJSValueInlines.h"
#include "JSFunction.h"
#include "JSFunctionInlines.h"
#include "JSLexicalEnvironment.h"
#include "JSObject.h"
#include "LLIntData.h"
#include "LLIntSlowPaths.h"
#include "SlowPathCall.h"
#include "VMTraps.h"
#include "WasmModule.h"
#include <emscripten.h>
#include <optional>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>

namespace JSC::LLInt {

using namespace WasmJIT;

namespace {

// BL_JIT=1 turns it on (off by default while it grows), 2 also logs what it compiles, 3 also
// writes the modules to files (node): in the engine's environment, or in node's for the jsc shell
EM_JS(int, wasmJITSwitch, (), {
    const value = (typeof ENV === 'object' && ENV.BL_JIT) || (typeof process === 'object' && process.env && process.env.BL_JIT);
    return Number(value) || 0;
});

int level()
{
    static const int value = wasmJITSwitch();
    return value;
}

bool enabled()
{
    return level() > 0;
}

// CodeBlocks of this thread's VM: the table index of their function, or 0 when they cannot be
// compiled. Tables are per thread, so are the indexes.
HashMap<CodeBlock*, uint32_t>& compiledCode()
{
    static thread_local HashMap<CodeBlock*, uint32_t> map;
    return map;
}

EM_JS(uint32_t, wasmJITInstall, (const uint8_t* bytes, uint32_t size, int dump), {
    try {
        const code = HEAPU8.slice(bytes, bytes + size);
        // BL_JIT=3 in node: every module into the working directory, for wasm-dis
        if (dump && typeof require === 'function')
            require('fs').writeFileSync('jit-' + wasmTable.length + '.wasm', code);
        const module = new WebAssembly.Module(code);
        const instance = new WebAssembly.Instance(module, { env: { memory: wasmMemory, table: wasmTable } });
        const index = wasmTable.grow(1);
        wasmTable.set(index, instance.exports.f);
        return index;
    } catch (e) {
        err('[jit] ' + e);
        return 0;
    }
});

using CompiledFunction = int32_t (*)(CallFrame*);
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

uint32_t compiledFunction(CodeBlock*);

// Instructions the interpreter runs only as a slow path (slowPathOp, llintSlowPathOp in its
// assembly, and some more): compiled code calls the same one
#define BL_JIT_COMMON_SLOW_PATH_OPS(v) \
    v(create_async_generator) v(create_generator) v(create_promise) v(create_rest) v(create_this) \
    v(define_accessor_property) v(define_data_property) v(enumerator_has_own_property) v(enumerator_next) \
    v(get_by_val_with_this) v(get_property_enumerator) v(is_callable) v(is_constructor) v(new_array_buffer) \
    v(new_array_with_species) v(new_array_with_spread) v(new_async_function_generator) v(new_generator) \
    v(new_promise) v(push_with_scope) v(put_by_id_with_this) v(put_by_val_with_this) v(spread) v(strcat) \
    v(throw_static_error) v(typeof_is_function) v(typeof_is_object) v(unsigned) v(to_this) v(to_string) \
    v(to_object) v(get_prototype_of)
#define BL_JIT_LLINT_SLOW_PATH_OPS(v) \
    v(create_cloned_arguments) v(create_direct_arguments) v(create_lexical_environment) \
    v(create_scoped_arguments) v(del_by_id) v(del_by_val) v(get_by_id_with_this) v(has_private_brand) \
    v(has_private_name) v(has_structure_with_flags) v(new_array_with_size) v(new_async_func) \
    v(new_async_func_exp) v(new_async_generator_func) v(new_async_generator_func_exp) v(new_func) \
    v(new_func_exp) v(new_generator_func) v(new_generator_func_exp) v(new_reg_exp) v(put_getter_by_id) \
    v(put_getter_by_val) v(put_getter_setter_by_id) v(put_setter_by_id) v(put_setter_by_val) \
    v(set_function_name) v(throw) v(instanceof) v(in_by_id) v(in_by_val)

// Compiled code nests on the host's machine stack (every JS call is a WASM call), which is much
// smaller than the JS stack of the C loop: beyond this depth the interpreter takes the calls,
// which nest only in the JS stack, until JSC's own limit throws a RangeError
constexpr unsigned maximumDepth = 1000;
thread_local unsigned depth;

int32_t runCompiled(uint32_t function, CallFrame* callFrame)
{
    ++depth;
    auto status = reinterpret_cast<CompiledFunction>(static_cast<uintptr_t>(function))(callFrame);
    --depth;
    return status;
}

// A call from compiled code (op_call, op_call_ignore_result), with the signature of a slow path.
// A compiled callee runs directly in the frame the bytecode prepared (argv slots below callFrame), a host
// function like the interpreter calls it, everything else through JSC's generic call (bound
// functions, proxies, interpreted functions, arity fixup, stack overflow).
template<typename Bytecode>
UGPRPair callFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc)
{
    auto bytecode = pc->as<Bytecode>();
    CodeBlock* codeBlock = callFrame->codeBlock();
    VM& vm = codeBlock->vm();
    JSGlobalObject* globalObject = codeBlock->globalObject();
    SlowPathFrameTracer tracer(vm, callFrame);
    callFrame->setCurrentVPC(pc);
    auto scope = DECLARE_THROW_SCOPE(vm);

    CallFrame* calleeFrame = callFrame - bytecode.m_argv;
    JSValue callee = callFrame->r(bytecode.m_callee).jsValue();
    unsigned argumentCount = bytecode.m_argc;
    auto finish = [&](JSValue result) {
        if (scope.exception()) [[unlikely]]
            return encodeResult(exceptionInstructions(), callFrame);
        if constexpr (requires { bytecode.m_dst; })
            callFrame->uncheckedR(bytecode.m_dst) = result;
        return encodeResult(pc, callFrame);
    };
    auto setUpFrame = [&](CodeBlock* calleeCodeBlock) {
        calleeFrame->setCallerFrame(callFrame);
        calleeFrame->setReturnPC(nullptr);
        calleeFrame->setCodeBlock(calleeCodeBlock);
        calleeFrame->uncheckedR(VirtualRegister(CallFrameSlot::callee)) = callee;
        calleeFrame->setArgumentCountIncludingThis(argumentCount);
    };

    if (auto* function = dynamicDowncast<JSFunction>(callee); function && !function->isHostFunction() && depth < maximumDepth && vm.isSafeToRecurseSoft()) {
        auto* calleeCodeBlock = function->jsExecutable()->codeBlockForCall();
        uint32_t compiled = calleeCodeBlock ? compiledFunction(calleeCodeBlock) : 0;
        auto* top = compiled ? reinterpret_cast<Register*>(calleeFrame) - calleeCodeBlock->numCalleeLocals() : nullptr;
        if (compiled && argumentCount >= calleeCodeBlock->numParameters() && vm.cloopStack().ensureCapacityFor(top)) {
            setUpFrame(calleeCodeBlock);
            // What op_enter and slow_path_enter do
            for (int local = CodeBlock::llintBaselineCalleeSaveSpaceAsVirtualRegisters(); local < calleeCodeBlock->numVars(); ++local)
                calleeFrame->uncheckedR(virtualRegisterForLocal(local)) = jsUndefined();
            vm.writeBarrier(calleeCodeBlock);
            calleeFrame->uncheckedR(calleeCodeBlock->scopeRegister()) = function->scope();
            if (calleeCodeBlock->couldBeTainted()) [[unlikely]]
                vm.setMightBeExecutingTaintedCode();
            auto* previous = vm.cloopStack().currentStackPointer();
            vm.cloopStack().setCurrentStackPointer(top);
            auto status = runCompiled(compiled, calleeFrame);
            vm.cloopStack().setCurrentStackPointer(previous);
            vm.topCallFrame = callFrame;
            if (status)
                return encodeResult(exceptionInstructions(), callFrame);
            return finish(calleeFrame->uncheckedR(virtualRegisterForArgumentIncludingThis(0)).jsValue());
        }
    }

    auto callData = JSC::getCallData(callee);
    if (callData.type == CallData::Type::Native && vm.isSafeToRecurseSoft()) {
        setUpFrame(nullptr);
        auto* previous = vm.cloopStack().currentStackPointer();
        vm.cloopStack().setCurrentStackPointer(reinterpret_cast<Register*>(calleeFrame) + CallerFrameAndPC::sizeInRegisters);
        vm.topCallFrame = calleeFrame;
        JSValue result = JSValue::decode(callData.native.function(globalObject, calleeFrame));
        vm.cloopStack().setCurrentStackPointer(previous);
        vm.topCallFrame = callFrame;
        return finish(result);
    }
    if (callData.type == CallData::Type::None) {
        throwException(globalObject, scope, createNotAFunctionError(globalObject, callee));
        return encodeResult(exceptionInstructions(), callFrame);
    }
    MarkedArgumentBuffer arguments;
    for (unsigned i = 1; i < argumentCount; ++i)
        arguments.append(calleeFrame->uncheckedR(virtualRegisterForArgumentIncludingThis(i)).jsValue());
    if (arguments.hasOverflowed()) [[unlikely]] {
        throwOutOfMemoryError(globalObject, scope);
        return encodeResult(exceptionInstructions(), callFrame);
    }
    JSValue thisValue = calleeFrame->uncheckedR(virtualRegisterForArgumentIncludingThis(0)).jsValue();
    JSValue result = JSC::call(globalObject, callee, callData, thisValue, arguments);
    return finish(result);
}

// op_eq_null, op_neq_null: == null, also for objects that masquerade as undefined
template<typename Bytecode>
UGPRPair equalsNullFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc)
{
    auto bytecode = pc->as<Bytecode>();
    CodeBlock* codeBlock = callFrame->codeBlock();
    JSValue value = callFrame->r(bytecode.m_operand).jsValue();
    bool isNull = value.isUndefinedOrNull() || (value.isCell() && value.asCell()->structure()->masqueradesAsUndefined(codeBlock->globalObject()));
    callFrame->uncheckedR(bytecode.m_dst) = jsBoolean(std::is_same_v<Bytecode, OpEqNull> ? isNull : !isNull);
    return encodeResult(pc, callFrame);
}

// op_construct from compiled code: JSC's generic construct, new.target the callee
UGPRPair constructFromCompiledCode(CallFrame* callFrame, const JSInstruction* pc)
{
    auto bytecode = pc->as<OpConstruct>();
    CodeBlock* codeBlock = callFrame->codeBlock();
    VM& vm = codeBlock->vm();
    JSGlobalObject* globalObject = codeBlock->globalObject();
    SlowPathFrameTracer tracer(vm, callFrame);
    callFrame->setCurrentVPC(pc);
    auto scope = DECLARE_THROW_SCOPE(vm);

    CallFrame* calleeFrame = callFrame - bytecode.m_argv;
    JSValue callee = callFrame->r(bytecode.m_callee).jsValue();
    auto constructData = JSC::getConstructData(callee);
    if (constructData.type == CallData::Type::None) {
        throwException(globalObject, scope, createNotAConstructorError(globalObject, callee));
        return encodeResult(exceptionInstructions(), callFrame);
    }
    MarkedArgumentBuffer arguments;
    for (unsigned i = 1; i < bytecode.m_argc; ++i)
        arguments.append(calleeFrame->uncheckedR(virtualRegisterForArgumentIncludingThis(i)).jsValue());
    if (arguments.hasOverflowed()) [[unlikely]] {
        throwOutOfMemoryError(globalObject, scope);
        return encodeResult(exceptionInstructions(), callFrame);
    }
    JSObject* result = JSC::construct(globalObject, callee, constructData, arguments, callee);
    if (scope.exception()) [[unlikely]]
        return encodeResult(exceptionInstructions(), callFrame);
    callFrame->uncheckedR(bytecode.m_dst) = result;
    return encodeResult(pc, callFrame);
}

constexpr int32_t int32Tag = static_cast<int32_t>(JSValue::Int32Tag);
constexpr int32_t booleanTag = static_cast<int32_t>(JSValue::BooleanTag);

class Compiler {
public:
    explicit Compiler(CodeBlock* codeBlock)
        : m_codeBlock(codeBlock)
    {
    }

    std::optional<std::vector<uint8_t>> compile();
    OpcodeID unsupported() const { return m_unsupported; }

private:
    bool scan();
    // The first instruction it does not take, for the log
    OpcodeID m_unsupported { op_enter };
    void emitInstruction(const JSInstructionStream::Ref&, unsigned block);

    unsigned targetOf(const JSInstructionStream::Ref& instruction, int label)
    {
        return instruction.offset() + (label ? label : m_codeBlock->outOfLineJumpOffset(instruction));
    }

    // Value of a virtual register: tag or payload, from the frame or the constant pool
    void loadTag(VirtualRegister);
    void loadPayload(VirtualRegister);
    void storeTagAndPayload(VirtualRegister, uint32_t tagLocal, uint32_t payloadLocal);
    void storeInt32(VirtualRegister, uint32_t payloadLocal);
    void storeBoolean(VirtualRegister, uint32_t payloadLocal);
    void address(VirtualRegister);

    // Calls a slow path of the interpreter for the instruction; leaves the returned instruction
    // pointer in m_next and returns 1 on an exception
    void callSlowPath(SlowPath, const JSInstructionStream::Ref&);
    void jumpTo(unsigned targetOffset, unsigned fromBlock);
    // Within an `if`: one level deeper
    void jumpToFromIf(unsigned targetOffset, unsigned fromBlock);

    template<typename Bytecode> void emitBinaryInt32(const JSInstructionStream::Ref&, unsigned block, uint8_t i64Op, SlowPath);
    template<typename Bytecode> void emitBitOp(const JSInstructionStream::Ref&, uint8_t i32Op, SlowPath);
    template<typename Bytecode> void emitCompare(const JSInstructionStream::Ref&, uint8_t i32Op, SlowPath);
    template<typename Bytecode> void emitCompareJump(const JSInstructionStream::Ref&, unsigned block, uint8_t i32Op, SlowPath);
    template<typename Bytecode> void emitConditionJump(const JSInstructionStream::Ref&, unsigned block, bool jumpIfTrue, SlowPath);
    template<typename Bytecode> void emitIncrement(const JSInstructionStream::Ref&, int32_t delta, SlowPath);
    void emitGeneric(const JSInstructionStream::Ref&, SlowPath);
    void emitGetById(const JSInstructionStream::Ref&);
    void emitPutById(const JSInstructionStream::Ref&);
    void emitMod(const JSInstructionStream::Ref&);
    void emitResolveScope(const JSInstructionStream::Ref&);
    void emitGetFromScope(const JSInstructionStream::Ref&);
    // Stores a cell (tag CellTag) from the local
    void storeCell(VirtualRegister, uint32_t payloadLocal);
    // Address of a property at the offset in the local, of the object in the local: inline storage
    // or the butterfly's
    void propertyAddress(uint32_t objectLocal, uint32_t offsetLocal);
    template<typename Bytecode> void emitGenericJump(const JSInstructionStream::Ref&, unsigned block, SlowPath);

    CodeBlock* m_codeBlock;
    Module m_module;
    FunctionBody* m_body { nullptr };
    uint32_t m_slowPathType { 0 };
    uint32_t m_barrierType { 0 };
    // Locals: the frame is parameter 0
    static constexpr uint32_t cfr = 0;
    uint32_t m_block { 0 }, m_a { 0 }, m_b { 0 }, m_c { 0 }, m_next { 0 }, m_wide { 0 };
    // Basic blocks: bytecode offset of each start, and the block of an offset
    Vector<unsigned> m_starts;
    HashMap<unsigned, unsigned, WTF::IntHash<unsigned>, WTF::UnsignedWithZeroKeyHashTraits<unsigned>> m_blockAt;
    unsigned m_blockCount { 0 };
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

void Compiler::storeTagAndPayload(VirtualRegister reg, uint32_t tagLocal, uint32_t payloadLocal)
{
    address(reg);
    m_body->localGet(tagLocal);
    m_body->i32Store(TagOffset);
    address(reg);
    m_body->localGet(payloadLocal);
    m_body->i32Store(PayloadOffset);
}

void Compiler::storeInt32(VirtualRegister reg, uint32_t payloadLocal)
{
    address(reg);
    m_body->i32Const(int32Tag);
    m_body->i32Store(TagOffset);
    address(reg);
    m_body->localGet(payloadLocal);
    m_body->i32Store(PayloadOffset);
}

void Compiler::storeBoolean(VirtualRegister reg, uint32_t payloadLocal)
{
    address(reg);
    m_body->i32Const(booleanTag);
    m_body->i32Store(TagOffset);
    address(reg);
    m_body->localGet(payloadLocal);
    m_body->i32Store(PayloadOffset);
}

void Compiler::callSlowPath(SlowPath slowPath, const JSInstructionStream::Ref& instruction)
{
    m_body->localGet(cfr);
    m_body->i32Const(reinterpret_cast<uintptr_t>(instruction.ptr()));
    m_body->i32Const(reinterpret_cast<uintptr_t>(slowPath));
    m_body->callIndirect(m_slowPathType);
    m_body->op(Op::I32WrapI64);
    m_body->localTee(m_next);
    m_body->i32Const(reinterpret_cast<uintptr_t>(exceptionInstructions()));
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    m_body->i32Const(1);
    m_body->returnValue();
    m_body->end();
}

// To the dispatch loop with the block of the target: the code of block i sits in the blocks
// i + 1 ... n - 1 within the loop
void Compiler::jumpTo(unsigned targetOffset, unsigned fromBlock)
{
    m_body->i32Const(m_blockAt.get(targetOffset));
    m_body->localSet(m_block);
    m_body->br(m_blockCount - 1 - fromBlock);
}

void Compiler::jumpToFromIf(unsigned targetOffset, unsigned fromBlock)
{
    m_body->i32Const(m_blockAt.get(targetOffset));
    m_body->localSet(m_block);
    m_body->br(m_blockCount - fromBlock);
}

void Compiler::emitGeneric(const JSInstructionStream::Ref& instruction, SlowPath slowPath)
{
    callSlowPath(slowPath, instruction);
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

// The interpreter's inline cache (metadata), default mode: same structure, value at the offset
void Compiler::emitGetById(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpGetById>();
    auto& cache = bytecode.metadata(m_codeBlock).m_modeMetadata;
    m_body->i32Const(0);
    m_body->localSet(m_next);
    loadTag(bytecode.m_base);
    m_body->i32Const(static_cast<int32_t>(JSValue::CellTag));
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    {
        loadPayload(bytecode.m_base);
        m_body->localSet(m_a);
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.mode));
        m_body->i32Load8U(0);
        m_body->i32Const(static_cast<int32_t>(GetByIdMode::Default));
        m_body->op(Op::I32Eq);
        m_body->localGet(m_a);
        m_body->i32Load(JSCell::structureIDOffset());
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.defaultMode.structureID));
        m_body->i32Load(0);
        m_body->op(Op::I32Eq);
        m_body->op(Op::I32And);
        m_body->ifThen();
        {
            m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.defaultMode.cachedOffset));
            m_body->i32Load(0);
            m_body->localSet(m_b);
            propertyAddress(m_a, m_b);
            m_body->localSet(m_b);
            m_body->localGet(m_b);
            m_body->i32Load(TagOffset);
            m_body->localSet(m_a);
            m_body->localGet(m_b);
            m_body->i32Load(PayloadOffset);
            m_body->localSet(m_b);
            storeTagAndPayload(bytecode.m_dst, m_a, m_b);
            m_body->i32Const(1);
            m_body->localSet(m_next);
        }
        m_body->end();
    }
    m_body->end();
    m_body->localGet(m_next);
    m_body->op(Op::I32Eqz);
    m_body->ifThen();
    callSlowPath(llint_slow_path_get_by_id, instruction);
    m_body->end();
}

// Stores without a structure transition inline; the write barrier first, like the interpreter
void Compiler::emitPutById(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpPutById>();
    auto& cache = bytecode.metadata(m_codeBlock);
    loadTag(bytecode.m_value);
    m_body->i32Const(static_cast<int32_t>(JSValue::CellTag));
    m_body->op(Op::I32Eq);
    loadTag(bytecode.m_base);
    m_body->i32Const(static_cast<int32_t>(JSValue::CellTag));
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32And);
    m_body->ifThen();
    {
        loadPayload(bytecode.m_base);
        m_body->localTee(m_a);
        m_body->i32Load8U(JSCell::cellStateOffset());
        m_body->i32Const(blackThreshold);
        m_body->op(Op::I32LeU);
        m_body->ifThen();
        m_body->localGet(cfr);
        m_body->localGet(m_a);
        m_body->i32Const(reinterpret_cast<uintptr_t>(&llint_write_barrier_slow));
        m_body->callIndirect(m_barrierType);
        m_body->end();
    }
    m_body->end();

    m_body->i32Const(0);
    m_body->localSet(m_next);
    loadTag(bytecode.m_base);
    m_body->i32Const(static_cast<int32_t>(JSValue::CellTag));
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    {
        loadPayload(bytecode.m_base);
        m_body->localSet(m_a);
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_newStructureID));
        m_body->i32Load(0);
        m_body->op(Op::I32Eqz);
        m_body->localGet(m_a);
        m_body->i32Load(JSCell::structureIDOffset());
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_oldStructureID));
        m_body->i32Load(0);
        m_body->op(Op::I32Eq);
        m_body->op(Op::I32And);
        m_body->ifThen();
        {
            m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_offset));
            m_body->i32Load(0);
            m_body->localSet(m_b);
            propertyAddress(m_a, m_b);
            m_body->localSet(m_b);
            m_body->localGet(m_b);
            loadTag(bytecode.m_value);
            m_body->i32Store(TagOffset);
            m_body->localGet(m_b);
            loadPayload(bytecode.m_value);
            m_body->i32Store(PayloadOffset);
            m_body->i32Const(1);
            m_body->localSet(m_next);
        }
        m_body->end();
    }
    m_body->end();
    m_body->localGet(m_next);
    m_body->op(Op::I32Eqz);
    m_body->ifThen();
    callSlowPath(llint_slow_path_put_by_id, instruction);
    m_body->end();
}

// int32 % int32 inline unless the divisor is 0, INT_MIN % -1, or the result is -0
void Compiler::emitMod(const JSInstructionStream::Ref& instruction)
{
    auto bytecode = instruction->as<OpMod>();
    m_body->i32Const(0);
    m_body->localSet(m_next);
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
        m_body->i32Const(1);
        m_body->localSet(m_next);
        m_body->end();
    }
    m_body->end();
    m_body->localGet(m_next);
    m_body->op(Op::I32Eqz);
    m_body->ifThen();
    callSlowPath(slow_path_mod, instruction);
    m_body->end();
}

void Compiler::storeCell(VirtualRegister reg, uint32_t payloadLocal)
{
    address(reg);
    m_body->i32Const(static_cast<int32_t>(JSValue::CellTag));
    m_body->i32Store(TagOffset);
    address(reg);
    m_body->localGet(payloadLocal);
    m_body->i32Store(PayloadOffset);
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
    m_body->i32Const(0);
    m_body->localSet(m_next);

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
        m_body->i32Const(1);
        m_body->localSet(m_next);
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
        m_body->i32Const(1);
        m_body->localSet(m_next);
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
        m_body->i32Const(1);
        m_body->localSet(m_next);
    }
    m_body->end();

    m_body->localGet(m_next);
    m_body->op(Op::I32Eqz);
    m_body->ifThen();
    callSlowPath(slow_path_resolve_scope, instruction);
    m_body->end();
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
        m_body->i32Const(1);
        m_body->localSet(m_next);
    };
    m_body->i32Const(0);
    m_body->localSet(m_next);

    resolveType();
    m_body->i32Const(GlobalProperty);
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    {
        loadPayload(bytecode.m_scope);
        m_body->localTee(m_a);
        m_body->i32Load(JSCell::structureIDOffset());
        m_body->i32Const(reinterpret_cast<uintptr_t>(&cache.m_structureID));
        m_body->i32Load(0);
        m_body->op(Op::I32Eq);
        m_body->ifThen();
        operand();
        m_body->localSet(m_b);
        propertyAddress(m_a, m_b);
        m_body->localSet(m_c);
        m_body->localGet(m_c);
        m_body->i32Load(TagOffset);
        m_body->localSet(m_a);
        m_body->localGet(m_c);
        m_body->i32Load(PayloadOffset);
        m_body->localSet(m_b);
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
            m_body->i32Const(static_cast<int32_t>(JSValue::EmptyValueTag));
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

    m_body->localGet(m_next);
    m_body->op(Op::I32Eqz);
    m_body->ifThen();
    callSlowPath(llint_slow_path_get_from_scope, instruction);
    m_body->end();
}

// Conditional jumps without a fast path: the slow path returns the target or the next instruction
template<typename Bytecode>
void Compiler::emitGenericJump(const JSInstructionStream::Ref& instruction, unsigned block, SlowPath slowPath)
{
    auto bytecode = instruction->as<Bytecode>();
    unsigned target = targetOf(instruction, bytecode.m_targetLabel.target());
    callSlowPath(slowPath, instruction);
    m_body->localGet(m_next);
    m_body->i32Const(reinterpret_cast<uintptr_t>(m_codeBlock->instructions().at(target).ptr()));
    m_body->op(Op::I32Eq);
    m_body->ifThen();
    jumpToFromIf(target, block);
    m_body->end();
}

// add, sub, mul of two int32 in 64 bit, the result back if it fits (and is no -0 for mul)
template<typename Bytecode>
void Compiler::emitBinaryInt32(const JSInstructionStream::Ref& instruction, unsigned, uint8_t i64Op, SlowPath slowPath)
{
    auto bytecode = instruction->as<Bytecode>();
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
        m_body->localSet(m_a);
    }
    m_body->elseThen();
    m_body->i32Const(0);
    m_body->localSet(m_a);
    m_body->end();
    m_body->localGet(m_a);
    m_body->ifThen();
    storeInt32(bytecode.m_dst, m_c);
    m_body->elseThen();
    callSlowPath(slowPath, instruction);
    m_body->end();
}

template<typename Bytecode>
void Compiler::emitBitOp(const JSInstructionStream::Ref& instruction, uint8_t i32Op, SlowPath slowPath)
{
    auto bytecode = instruction->as<Bytecode>();
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
    m_body->localSet(m_c);
    storeInt32(bytecode.m_dst, m_c);
    m_body->elseThen();
    callSlowPath(slowPath, instruction);
    m_body->end();
}

// less, lesseq, ... into a boolean: int32 inline, the rest in the slow path
template<typename Bytecode>
void Compiler::emitCompare(const JSInstructionStream::Ref& instruction, uint8_t i32Op, SlowPath slowPath)
{
    auto bytecode = instruction->as<Bytecode>();
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
    m_body->localSet(m_c);
    storeBoolean(bytecode.m_dst, m_c);
    m_body->elseThen();
    callSlowPath(slowPath, instruction);
    m_body->end();
}

template<typename Bytecode>
void Compiler::emitCompareJump(const JSInstructionStream::Ref& instruction, unsigned block, uint8_t i32Op, SlowPath slowPath)
{
    auto bytecode = instruction->as<Bytecode>();
    unsigned target = targetOf(instruction, bytecode.m_targetLabel.target());
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
    m_body->localSet(m_c);
    m_body->elseThen();
    callSlowPath(slowPath, instruction);
    m_body->localGet(m_next);
    m_body->i32Const(reinterpret_cast<uintptr_t>(m_codeBlock->instructions().at(target).ptr()));
    m_body->op(Op::I32Eq);
    m_body->localSet(m_c);
    m_body->end();
    m_body->localGet(m_c);
    m_body->ifThen();
    jumpToFromIf(target, block);
    m_body->end();
}

// jtrue, jfalse: booleans and int32 inline
template<typename Bytecode>
void Compiler::emitConditionJump(const JSInstructionStream::Ref& instruction, unsigned block, bool jumpIfTrue, SlowPath slowPath)
{
    auto bytecode = instruction->as<Bytecode>();
    unsigned target = targetOf(instruction, bytecode.m_targetLabel.target());
    loadTag(bytecode.m_condition);
    m_body->localSet(m_a);
    m_body->localGet(m_a);
    m_body->i32Const(int32Tag);
    m_body->op(Op::I32Eq);
    m_body->localGet(m_a);
    m_body->i32Const(booleanTag);
    m_body->op(Op::I32Eq);
    m_body->op(Op::I32Or);
    m_body->ifThen();
    loadPayload(bytecode.m_condition);
    m_body->i32Const(0);
    m_body->op(jumpIfTrue ? Op::I32Ne : Op::I32Eq);
    m_body->localSet(m_c);
    m_body->elseThen();
    callSlowPath(slowPath, instruction);
    m_body->localGet(m_next);
    m_body->i32Const(reinterpret_cast<uintptr_t>(m_codeBlock->instructions().at(target).ptr()));
    m_body->op(Op::I32Eq);
    m_body->localSet(m_c);
    m_body->end();
    m_body->localGet(m_c);
    m_body->ifThen();
    jumpToFromIf(target, block);
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
        case op_rshift: case op_urshift: case op_not: case op_to_number: case op_get_by_id: case op_put_by_id:
        case op_get_by_val: case op_put_by_val: case op_get_from_scope: case op_put_to_scope: case op_resolve_scope:
        case op_typeof: case op_new_object: case op_new_array: case op_get_length: case op_to_primitive:
        case op_loop_hint: case op_check_traps: case op_call: case op_call_ignore_result: case op_construct:
        case op_argument_count: case op_get_argument: case op_eq_null: case op_neq_null:
#define BL_JIT_CASE(name) case op_##name:
        BL_JIT_COMMON_SLOW_PATH_OPS(BL_JIT_CASE)
        BL_JIT_LLINT_SLOW_PATH_OPS(BL_JIT_CASE)
#undef BL_JIT_CASE
            break;
        case op_jundefined_or_null: jump(instruction->as<OpJundefinedOrNull>().m_targetLabel.target()); break;
        case op_jneq_ptr: jump(instruction->as<OpJneqPtr>().m_targetLabel.target()); break;
        case op_jnundefined_or_null: jump(instruction->as<OpJnundefinedOrNull>().m_targetLabel.target()); break;
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
    unsigned end = instructions.size();
    for (auto start : starts) {
        if (start < end)
            m_starts.append(start);
    }
    std::sort(m_starts.begin(), m_starts.end());
    for (unsigned i = 0; i < m_starts.size(); ++i)
        m_blockAt.add(m_starts[i], i);
    m_blockCount = m_starts.size();
    return true;
}

void Compiler::emitInstruction(const JSInstructionStream::Ref& instruction, unsigned block)
{
    switch (instruction->opcodeID()) {
    case op_mov: {
        auto bytecode = instruction->as<OpMov>();
        loadTag(bytecode.m_src);
        m_body->localSet(m_a);
        loadPayload(bytecode.m_src);
        m_body->localSet(m_b);
        storeTagAndPayload(bytecode.m_dst, m_a, m_b);
        return;
    }
    case op_add: emitBinaryInt32<OpAdd>(instruction, block, Op::I64Add, slow_path_add); return;
    case op_sub: emitBinaryInt32<OpSub>(instruction, block, Op::I64Sub, slow_path_sub); return;
    case op_mul: emitBinaryInt32<OpMul>(instruction, block, Op::I64Mul, slow_path_mul); return;
    case op_div: emitGeneric(instruction, slow_path_div); return;
    case op_mod: emitMod(instruction); return;
    case op_inc: emitIncrement<OpInc>(instruction, 1, slow_path_inc); return;
    case op_dec: emitIncrement<OpDec>(instruction, -1, slow_path_dec); return;
    case op_negate: emitGeneric(instruction, slow_path_negate); return;
    case op_less: emitCompare<OpLess>(instruction, Op::I32LtS, llint_slow_path_less); return;
    case op_lesseq: emitCompare<OpLesseq>(instruction, Op::I32LeS, llint_slow_path_lesseq); return;
    case op_greater: emitCompare<OpGreater>(instruction, Op::I32GtS, llint_slow_path_greater); return;
    case op_greatereq: emitCompare<OpGreatereq>(instruction, Op::I32GeS, llint_slow_path_greatereq); return;
    case op_eq: emitGeneric(instruction, slow_path_eq); return;
    case op_neq: emitGeneric(instruction, slow_path_neq); return;
    case op_stricteq: emitGeneric(instruction, slow_path_stricteq); return;
    case op_nstricteq: emitGeneric(instruction, slow_path_nstricteq); return;
    case op_bitand: emitBitOp<OpBitand>(instruction, Op::I32And, slow_path_bitand); return;
    case op_bitor: emitBitOp<OpBitor>(instruction, Op::I32Or, slow_path_bitor); return;
    case op_bitxor: emitBitOp<OpBitxor>(instruction, Op::I32Xor, slow_path_bitxor); return;
    case op_lshift: emitGeneric(instruction, slow_path_lshift); return;
    case op_rshift: emitGeneric(instruction, slow_path_rshift); return;
    case op_urshift: emitGeneric(instruction, slow_path_urshift); return;
    case op_not: emitGeneric(instruction, slow_path_not); return;
    case op_to_number: emitGeneric(instruction, slow_path_to_number); return;
    case op_get_by_id: emitGetById(instruction); return;
    case op_put_by_id: emitPutById(instruction); return;
    case op_get_by_val: emitGeneric(instruction, llint_slow_path_get_by_val); return;
    case op_put_by_val: emitGeneric(instruction, llint_slow_path_put_by_val); return;
    case op_get_from_scope: emitGetFromScope(instruction); return;
    case op_put_to_scope: emitGeneric(instruction, llint_slow_path_put_to_scope); return;
    case op_resolve_scope: emitResolveScope(instruction); return;
    case op_typeof: emitGeneric(instruction, slow_path_typeof); return;
    case op_new_object: emitGeneric(instruction, llint_slow_path_new_object); return;
    case op_new_array: emitGeneric(instruction, llint_slow_path_new_array); return;
    case op_get_length: emitGeneric(instruction, llint_slow_path_get_length); return;
    case op_to_primitive: emitGeneric(instruction, slow_path_to_primitive); return;
#define BL_JIT_COMMON(name) case op_##name: emitGeneric(instruction, slow_path_##name); return;
#define BL_JIT_LLINT(name) case op_##name: emitGeneric(instruction, llint_slow_path_##name); return;
    BL_JIT_COMMON_SLOW_PATH_OPS(BL_JIT_COMMON)
    BL_JIT_LLINT_SLOW_PATH_OPS(BL_JIT_LLINT)
#undef BL_JIT_COMMON
#undef BL_JIT_LLINT
    case op_construct: emitGeneric(instruction, constructFromCompiledCode); return;
    case op_eq_null: emitGeneric(instruction, equalsNullFromCompiledCode<OpEqNull>); return;
    case op_neq_null: emitGeneric(instruction, equalsNullFromCompiledCode<OpNeqNull>); return;
    case op_jneq_ptr: {
        // Jump unless the value is that cell (an intrinsic like Array), noted in the cache
        auto bytecode = instruction->as<OpJneqPtr>();
        loadTag(bytecode.m_value);
        m_body->i32Const(static_cast<int32_t>(JSValue::CellTag));
        m_body->op(Op::I32Ne);
        loadPayload(bytecode.m_value);
        loadPayload(bytecode.m_specialPointer);
        m_body->op(Op::I32Ne);
        m_body->op(Op::I32Or);
        m_body->ifThen();
        m_body->i32Const(reinterpret_cast<uintptr_t>(&bytecode.metadata(m_codeBlock).m_hasJumped));
        m_body->i32Const(1);
        m_body->i32Store8(0);
        jumpToFromIf(targetOf(instruction, bytecode.m_targetLabel.target()), block);
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
        loadTag(virtualRegisterForArgumentIncludingThis(bytecode.m_index));
        m_body->localSet(m_a);
        loadPayload(virtualRegisterForArgumentIncludingThis(bytecode.m_index));
        m_body->localSet(m_b);
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
        jumpToFromIf(targetOf(instruction, label), block);
        m_body->end();
        return;
    }
    case op_call: emitGeneric(instruction, callFromCompiledCode<OpCall>); return;
    case op_call_ignore_result: emitGeneric(instruction, callFromCompiledCode<OpCallIgnoreResult>); return;
    case op_loop_hint:
        return;
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
        loadTag(bytecode.m_value);
        m_body->localSet(m_a);
        loadPayload(bytecode.m_value);
        m_body->localSet(m_b);
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
    case op_jless: emitCompareJump<OpJless>(instruction, block, Op::I32LtS, llint_slow_path_jless); return;
    case op_jlesseq: emitCompareJump<OpJlesseq>(instruction, block, Op::I32LeS, llint_slow_path_jlesseq); return;
    case op_jgreater: emitCompareJump<OpJgreater>(instruction, block, Op::I32GtS, llint_slow_path_jgreater); return;
    case op_jgreatereq: emitCompareJump<OpJgreatereq>(instruction, block, Op::I32GeS, llint_slow_path_jgreatereq); return;
    // jn...: jump when the comparison is false (also for NaN); int32 inline as the inverse
    case op_jnless: emitCompareJump<OpJnless>(instruction, block, Op::I32GeS, llint_slow_path_jnless); return;
    case op_jnlesseq: emitCompareJump<OpJnlesseq>(instruction, block, Op::I32GtS, llint_slow_path_jnlesseq); return;
    case op_jngreater: emitCompareJump<OpJngreater>(instruction, block, Op::I32LeS, llint_slow_path_jngreater); return;
    case op_jngreatereq: emitCompareJump<OpJngreatereq>(instruction, block, Op::I32LtS, llint_slow_path_jngreatereq); return;
    case op_jeq: emitGenericJump<OpJeq>(instruction, block, llint_slow_path_jeq); return;
    case op_jneq: emitGenericJump<OpJneq>(instruction, block, llint_slow_path_jneq); return;
    case op_jstricteq: emitGenericJump<OpJstricteq>(instruction, block, llint_slow_path_jstricteq); return;
    case op_jnstricteq: emitGenericJump<OpJnstricteq>(instruction, block, llint_slow_path_jnstricteq); return;
    default:
        RELEASE_ASSERT_NOT_REACHED();
    }
}

std::optional<std::vector<uint8_t>> Compiler::compile()
{
    if (!scan())
        return std::nullopt;

    const ValueType frame[] = { ValueType::I32 };
    const ValueType status[] = { ValueType::I32 };
    m_module.addType(frame, status);
    const ValueType slowPathParameters[] = { ValueType::I32, ValueType::I32 };
    const ValueType slowPathResult[] = { ValueType::I64 };
    m_slowPathType = m_module.addType(slowPathParameters, slowPathResult);
    m_barrierType = m_module.addType(slowPathParameters, std::span<const ValueType>());
    m_body = &m_module.function(1);
    m_block = m_body->addLocal(ValueType::I32);
    m_a = m_body->addLocal(ValueType::I32);
    m_b = m_body->addLocal(ValueType::I32);
    m_c = m_body->addLocal(ValueType::I32);
    m_next = m_body->addLocal(ValueType::I32);
    m_wide = m_body->addLocal(ValueType::I64);

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

uint32_t compiledFunction(CodeBlock* codeBlock)
{
    return compiledCode().get(codeBlock);
}

} // namespace

const JSInstruction* wasmJITEnter(CallFrame* callFrame, CodeBlock* codeBlock)
{
    if (!enabled())
        return nullptr;
    auto function = compiledCode().get(codeBlock);
    if (!function || depth >= maximumDepth)
        return nullptr;
    auto status = runCompiled(function, callFrame);
    return status ? exceptionInstructions() : returnInstruction();
}

void wasmJITTierUp(VM&, CodeBlock* codeBlock)
{
    if (!enabled() || compiledCode().contains(codeBlock))
        return;
    uint32_t function = 0;
    Compiler compiler(codeBlock);
    auto bytes = compiler.compile();
    if (bytes)
        function = wasmJITInstall(bytes->data(), bytes->size(), level() >= 3);
    if (level() >= 2) {
        if (bytes)
            dataLogLn("[jit] ", *codeBlock, ": ", bytes->size(), " bytes, function ", function);
        else
            dataLogLn("[jit] ", *codeBlock, ": not compiled (", opcodeNames[compiler.unsupported()], ")");
    }
    compiledCode().add(codeBlock, function);
}

void wasmJITForget(CodeBlock* codeBlock)
{
    compiledCode().remove(codeBlock);
}

} // namespace JSC::LLInt
