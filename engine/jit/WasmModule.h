// A WebAssembly module with one function, written as bytes for the JIT (docs/jit.md). It imports
// the engine's memory (shared, 32 bit) and function table, so the function reads and writes the
// engine's memory and calls its C++ functions through their table index.
#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace JSC::LLInt::WasmJIT {

enum class ValueType : uint8_t { I32 = 0x7f, I64 = 0x7e, F64 = 0x7c };

// The body of the one function: instructions in the binary encoding
class FunctionBody {
public:
    // A local of the function (after its parameters), returns its index
    uint32_t addLocal(ValueType);

    void localGet(uint32_t);
    void localSet(uint32_t);
    void localTee(uint32_t);
    void i32Const(int32_t);
    void i64Const(int64_t);
    void f64Const(double);
    void i32Load(uint32_t offset);
    void i32Load8U(uint32_t offset);
    void i32Store(uint32_t offset);
    void i32Store8(uint32_t offset);
    void f64Load(uint32_t offset);
    void f64Store(uint32_t offset);
    // Numeric instructions without immediates (i32.add, i64.shr_u, ...)
    void op(uint8_t opcode);
    // The same with the prefix 0xfc (i32.trunc_sat_f64_s, ...)
    void prefixedOp(uint8_t opcode);
    void select();
    void block();
    void loop();
    void ifThen();
    void elseThen();
    void end();
    void br(uint32_t depth);
    void brIf(uint32_t depth);
    void brTable(std::span<const uint32_t> depths, uint32_t defaultDepth);
    void returnValue();
    void unreachable();
    void drop();
    // call_indirect through table 0 with the type `typeIndex` of the module
    void callIndirect(uint32_t typeIndex);

    const std::vector<uint8_t>& code() const { return m_code; }
    const std::vector<ValueType>& locals() const { return m_locals; }
    // Blocks, loops and ifs open at this point, for branch depths
    uint32_t depth() const { return m_depth; }

private:
    friend class Module;
    std::vector<uint8_t> m_code;
    std::vector<ValueType> m_locals;
    uint32_t m_parameterCount { 0 };
    uint32_t m_depth { 0 };
};

class Module {
public:
    // Function types, the first one is that of the function itself
    uint32_t addType(std::span<const ValueType> parameters, std::span<const ValueType> results);
    // The function, exported as "f", of type 0
    FunctionBody& function(uint32_t parameterCount);
    std::vector<uint8_t> bytes() const;

private:
    std::vector<std::vector<uint8_t>> m_types;
    FunctionBody m_function;
};

// Instruction codes without immediates that the JIT uses
namespace Op {
constexpr uint8_t I32Eqz = 0x45, I32Eq = 0x46, I32Ne = 0x47, I32LtS = 0x48, I32LtU = 0x49, I32GtS = 0x4a,
    I32GtU = 0x4b, I32LeS = 0x4c, I32LeU = 0x4d, I32GeS = 0x4e, I32GeU = 0x4f, I64Eq = 0x51, I64Ne = 0x52,
    F64Eq = 0x61, F64Ne = 0x62, F64Lt = 0x63, F64Gt = 0x64, F64Le = 0x65, F64Ge = 0x66, I32Add = 0x6a,
    I32Sub = 0x6b, I32Mul = 0x6c, I32RemS = 0x6f, I32And = 0x71, I32Or = 0x72, I32Xor = 0x73, I32Shl = 0x74,
    I32ShrS = 0x75, I32ShrU = 0x76, I64Add = 0x7c, I64Sub = 0x7d, I64Mul = 0x7e, I64ShrU = 0x88, F64Neg = 0x9a,
    F64Add = 0xa0, F64Sub = 0xa1, F64Mul = 0xa2, F64Div = 0xa3, I32WrapI64 = 0xa7, I64ExtendI32S = 0xac,
    I64ExtendI32U = 0xad, F64ConvertI32S = 0xb7;
// After the prefix 0xfc
constexpr uint8_t I32TruncSatF64S = 0x02;
}

} // namespace JSC::LLInt::WasmJIT
