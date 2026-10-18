#!/usr/bin/env python3
# Appends a custom section "bl_build_id" to engine.wasm: the start of the
# SHA-256 of the module without this section. The engine reads it at runtime
# (engine/src/BytecodeCache.cpp), so the ID always matches the running code.
# tools/engine-manifest.mjs copies it into manifest.json.
import hashlib
import sys

NAME = b'bl_build_id'


def leb(value):
    out = bytearray()
    while True:
        byte = value & 0x7f
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def read_leb(data, pos):
    result = shift = 0
    while True:
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7f) << shift
        shift += 7
        if not byte & 0x80:
            return result, pos


def main(path):
    data = open(path, 'rb').read()
    if data[:4] != b'\0asm':
        sys.exit(f'{path}: not WebAssembly')
    out = bytearray(data[:8])
    pos = 8
    while pos < len(data):
        start = pos
        section_id = data[pos]
        size, body = read_leb(data, pos + 1)
        end = body + size
        if section_id == 0:
            name_length, name_pos = read_leb(data, body)
            if data[name_pos:name_pos + name_length] == NAME:
                pos = end
                continue
        out += data[start:end]
        pos = end
    build_id = hashlib.sha256(out).hexdigest()[:16].encode()
    payload = leb(len(NAME)) + NAME + build_id
    out += b'\0' + leb(len(payload)) + payload
    open(path, 'wb').write(out)
    print(f'Build ID {build_id.decode()}')


if __name__ == '__main__':
    main(sys.argv[1])
