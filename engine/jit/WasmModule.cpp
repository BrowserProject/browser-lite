#include "config.h"
#include "WasmModule.h"

#include <cstring>

namespace JSC::LLInt::WasmJIT {

static void unsignedLEB(std::vector<uint8_t>& out, uint64_t value)
{
    do {
        uint8_t byte = value & 0x7f;
        value >>= 7;
        out.push_back(value ? byte | 0x80 : byte);
    } while (value);
}

static void signedLEB(std::vector<uint8_t>& out, int64_t value)
{
    for (;;) {
        uint8_t byte = value & 0x7f;
        value >>= 7;
        bool done = (!value && !(byte & 0x40)) || (value == -1 && (byte & 0x40));
        out.push_back(done ? byte : byte | 0x80);
        if (done)
            return;
    }
}

static void name(std::vector<uint8_t>& out, const char* text)
{
    unsignedLEB(out, strlen(text));
    out.insert(out.end(), text, text + strlen(text));
}

static void section(std::vector<uint8_t>& out, uint8_t id, const std::vector<uint8_t>& body)
{
    out.push_back(id);
    unsignedLEB(out, body.size());
    out.insert(out.end(), body.begin(), body.end());
}

uint32_t FunctionBody::addLocal(ValueType type)
{
    m_locals.push_back(type);
    return m_parameterCount + m_locals.size() - 1;
}

void FunctionBody::localGet(uint32_t index) { m_code.push_back(0x20); unsignedLEB(m_code, index); }
void FunctionBody::localSet(uint32_t index) { m_code.push_back(0x21); unsignedLEB(m_code, index); }
void FunctionBody::localTee(uint32_t index) { m_code.push_back(0x22); unsignedLEB(m_code, index); }
void FunctionBody::i32Const(int32_t value) { m_code.push_back(0x41); signedLEB(m_code, value); }
void FunctionBody::i64Const(int64_t value) { m_code.push_back(0x42); signedLEB(m_code, value); }

void FunctionBody::f64Const(double value)
{
    m_code.push_back(0x44);
    uint8_t bytes[8];
    memcpy(bytes, &value, 8);
    m_code.insert(m_code.end(), bytes, bytes + 8);
}

// Memory access: alignment as log2 of the natural one, then the offset
void FunctionBody::i32Load(uint32_t offset) { m_code.push_back(0x28); m_code.push_back(2); unsignedLEB(m_code, offset); }
void FunctionBody::i32Store(uint32_t offset) { m_code.push_back(0x36); m_code.push_back(2); unsignedLEB(m_code, offset); }
void FunctionBody::f64Load(uint32_t offset) { m_code.push_back(0x2b); m_code.push_back(3); unsignedLEB(m_code, offset); }
void FunctionBody::f64Store(uint32_t offset) { m_code.push_back(0x39); m_code.push_back(3); unsignedLEB(m_code, offset); }

void FunctionBody::op(uint8_t opcode) { m_code.push_back(opcode); }
// Blocks without results (empty block type 0x40)
void FunctionBody::block() { m_code.push_back(0x02); m_code.push_back(0x40); }
void FunctionBody::loop() { m_code.push_back(0x03); m_code.push_back(0x40); }
void FunctionBody::ifThen() { m_code.push_back(0x04); m_code.push_back(0x40); }
void FunctionBody::elseThen() { m_code.push_back(0x05); }
void FunctionBody::end() { m_code.push_back(0x0b); }
void FunctionBody::br(uint32_t depth) { m_code.push_back(0x0c); unsignedLEB(m_code, depth); }
void FunctionBody::brIf(uint32_t depth) { m_code.push_back(0x0d); unsignedLEB(m_code, depth); }

void FunctionBody::brTable(std::span<const uint32_t> depths, uint32_t defaultDepth)
{
    m_code.push_back(0x0e);
    unsignedLEB(m_code, depths.size());
    for (auto depth : depths)
        unsignedLEB(m_code, depth);
    unsignedLEB(m_code, defaultDepth);
}

void FunctionBody::returnValue() { m_code.push_back(0x0f); }
void FunctionBody::unreachable() { m_code.push_back(0x00); }
void FunctionBody::drop() { m_code.push_back(0x1a); }

void FunctionBody::callIndirect(uint32_t typeIndex)
{
    m_code.push_back(0x11);
    unsignedLEB(m_code, typeIndex);
    m_code.push_back(0);
}

uint32_t Module::addType(std::span<const ValueType> parameters, std::span<const ValueType> results)
{
    std::vector<uint8_t> type { 0x60 };
    unsignedLEB(type, parameters.size());
    for (auto parameter : parameters)
        type.push_back(static_cast<uint8_t>(parameter));
    unsignedLEB(type, results.size());
    for (auto result : results)
        type.push_back(static_cast<uint8_t>(result));
    m_types.push_back(WTF::move(type));
    return m_types.size() - 1;
}

FunctionBody& Module::function(uint32_t parameterCount)
{
    m_function.m_parameterCount = parameterCount;
    return m_function;
}

std::vector<uint8_t> Module::bytes() const
{
    std::vector<uint8_t> out { 0, 'a', 's', 'm', 1, 0, 0, 0 };

    std::vector<uint8_t> types;
    unsignedLEB(types, m_types.size());
    for (auto& type : m_types)
        types.insert(types.end(), type.begin(), type.end());
    section(out, 1, types);

    // env.memory: shared, 32 bit, at least 1 page, at most 4 GB; env.table: funcref, at least 1
    std::vector<uint8_t> imports;
    unsignedLEB(imports, 2);
    name(imports, "env");
    name(imports, "memory");
    imports.insert(imports.end(), { 0x02, 0x03, 0x01, 0x80, 0x80, 0x04 });
    name(imports, "env");
    name(imports, "table");
    imports.insert(imports.end(), { 0x01, 0x70, 0x00, 0x01 });
    section(out, 2, imports);

    section(out, 3, { 1, 0 });

    std::vector<uint8_t> exports;
    unsignedLEB(exports, 1);
    name(exports, "f");
    exports.insert(exports.end(), { 0x00, 0x00 });
    section(out, 7, exports);

    // Locals in runs of the same type
    std::vector<uint8_t> body;
    std::vector<std::pair<uint32_t, ValueType>> runs;
    for (auto type : m_function.m_locals) {
        if (runs.empty() || runs.back().second != type)
            runs.push_back({ 0, type });
        runs.back().first++;
    }
    unsignedLEB(body, runs.size());
    for (auto [count, type] : runs) {
        unsignedLEB(body, count);
        body.push_back(static_cast<uint8_t>(type));
    }
    body.insert(body.end(), m_function.m_code.begin(), m_function.m_code.end());
    body.push_back(0x0b);
    std::vector<uint8_t> code;
    unsignedLEB(code, 1);
    unsignedLEB(code, body.size());
    code.insert(code.end(), body.begin(), body.end());
    section(out, 10, code);
    return out;
}

} // namespace JSC::LLInt::WasmJIT
