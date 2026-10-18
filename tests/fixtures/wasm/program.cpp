// Test program for WebAssembly of the pages (tests/core/wasm-test.mjs): grows the memory, uses
// C++ exceptions, std::string and SIMD.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>
#include <wasm_simd128.h>

static unsigned hash(const void* data, size_t n)
{
    unsigned h = 2166136261u;
    for (size_t i = 0; i < n; i++) {
        h ^= static_cast<const unsigned char*>(data)[i];
        h *= 16777619u;
    }
    return h;
}

static int check(int x)
{
    if (x % 3 == 0)
        throw std::runtime_error("durch drei teilbar: " + std::to_string(x));
    return x;
}

int main()
{
    // 64 MB: the memory must grow
    std::vector<unsigned char> big(64 << 20);
    for (size_t i = 0; i < big.size(); i += 4096)
        big[i] = static_cast<unsigned char>(i >> 12);
    unsigned h = hash(big.data(), big.size());

    std::string text;
    int thrown = 0;
    for (int i = 1; i <= 20; i++) {
        try {
            text += std::to_string(check(i)) + ",";
        } catch (const std::exception& e) {
            thrown += static_cast<int>(strlen(e.what()));
        }
    }
    h ^= hash(text.data(), text.size()) + thrown;

    v128_t sum = wasm_i32x4_splat(0);
    for (int i = 0; i < 1000; i++)
        sum = wasm_i32x4_add(sum, wasm_i32x4_make(i, i * 2, i * 3, i * 4));
    h ^= wasm_i32x4_extract_lane(sum, 3);

    printf("RESULT emscripten=%u\n", h);
    return 0;
}
