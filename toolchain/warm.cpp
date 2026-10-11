// Wird nur beim Bauen des Toolchain-Images kompiliert, damit Emscripten seine
// System-Libs (libc, libc++, ... normal und mit pthreads) schon im Cache hat.
#include <cstdio>
#include <string>
#include <thread>

int main()
{
    std::string text = "ok";
    std::thread([&] { text += "!"; }).join();
    std::printf("%s\n", text.c_str());
    return 0;
}
