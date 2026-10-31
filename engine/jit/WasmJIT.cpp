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
#include "CellState.h"
#include "CodeBlock.h"
#include "CommonSlowPaths.h"
#include "Fits.h"
#include "JSObject.h"
#include "LLIntData.h"
#include "LLIntSlowPaths.h"
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
        case op_loop_hint: case op_check_traps:
            break;
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
    case op_get_from_scope: emitGeneric(instruction, llint_slow_path_get_from_scope); return;
    case op_put_to_scope: emitGeneric(instruction, llint_slow_path_put_to_scope); return;
    case op_resolve_scope: emitGeneric(instruction, slow_path_resolve_scope); return;
    case op_typeof: emitGeneric(instruction, slow_path_typeof); return;
    case op_new_object: emitGeneric(instruction, llint_slow_path_new_object); return;
    case op_new_array: emitGeneric(instruction, llint_slow_path_new_array); return;
    case op_get_length: emitGeneric(instruction, llint_slow_path_get_length); return;
    case op_to_primitive: emitGeneric(instruction, slow_path_to_primitive); return;
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
    // jn...: jump when the comparison is false (also for NaN), so int32 inline only as the inverse
    case op_jnless: emitGenericJump<OpJnless>(instruction, block, llint_slow_path_jnless); return;
    case op_jnlesseq: emitGenericJump<OpJnlesseq>(instruction, block, llint_slow_path_jnlesseq); return;
    case op_jngreater: emitGenericJump<OpJngreater>(instruction, block, llint_slow_path_jngreater); return;
    case op_jngreatereq: emitGenericJump<OpJngreatereq>(instruction, block, llint_slow_path_jngreatereq); return;
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

} // namespace

const JSInstruction* wasmJITEnter(CallFrame* callFrame, CodeBlock* codeBlock)
{
    if (!enabled())
        return nullptr;
    auto function = compiledCode().get(codeBlock);
    if (!function)
        return nullptr;
    auto status = reinterpret_cast<CompiledFunction>(static_cast<uintptr_t>(function))(callFrame);
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
