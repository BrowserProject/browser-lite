#!/usr/bin/env python3
# Haengt an engine.wasm eine Custom Section "bl_build_id" an: Anfang des
# SHA-256 des Moduls ohne diese Section. Die Engine liest sie zur Laufzeit
# (engine/src/BytecodeCache.cpp), so passt die ID sicher zum laufenden Code.
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
        sys.exit(f'{path}: kein WebAssembly')
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
    print(f'Build-ID {build_id.decode()}')


if __name__ == '__main__':
    main(sys.argv[1])
