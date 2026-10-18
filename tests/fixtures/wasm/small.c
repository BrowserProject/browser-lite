#include <stdint.h>
#include <wasm_simd128.h>
static int table[16] = { 3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3 };
static char text[] = "Hallo WebAssembly";
int counter;
__attribute__((export_name("sum"))) int sum(void) { int s = 0; for (int i = 0; i < 16; i++) s += table[i]; return s; }
__attribute__((export_name("simd_sum"))) int simd_sum(void) {
  v128_t acc = wasm_i32x4_splat(0);
  for (int i = 0; i < 16; i += 4) acc = wasm_i32x4_add(acc, wasm_v128_load(&table[i]));
  return wasm_i32x4_extract_lane(acc, 0) + wasm_i32x4_extract_lane(acc, 1) + wasm_i32x4_extract_lane(acc, 2) + wasm_i32x4_extract_lane(acc, 3);
}
__attribute__((export_name("text_ptr"))) char* text_ptr(void) { return text; }
__attribute__((export_name("copy"))) int copy(int n) { static char buf[64]; __builtin_memcpy(buf, text, n); __builtin_memset(buf + n, 'x', 3); return buf[0] + buf[n + 2]; }
__attribute__((export_name("grow"))) int grow(int pages) { return __builtin_wasm_memory_grow(0, pages); }
__attribute__((export_name("size"))) int size(void) { return __builtin_wasm_memory_size(0); }
__attribute__((export_name("poke"))) int poke(int page) { volatile int* p = (int*)(page * 65536 + 100); *p = 1234; return *p; }
__attribute__((export_name("atomic"))) int atomic(void) { __atomic_fetch_add(&counter, 5, __ATOMIC_SEQ_CST); int expected = 5; __atomic_compare_exchange_n(&counter, &expected, 42, 0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST); return __atomic_load_n(&counter, __ATOMIC_SEQ_CST); }
__attribute__((export_name("oob"))) int oob(void) { return *(volatile int*)(size() * 65536 - 2); }
