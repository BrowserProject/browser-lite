// Read-only files of the engine folder that load on first read (LazyFiles.cpp).
#pragma once

namespace BrowserLite {

// Mounts the files of `index` (lines "<path> <size>") at `mountPoint`. A file loads from
// <engine folder>/<urlFolder>/<path> on its first read, synchronously, and stays in memory.
// Returns false when the mount failed.
bool mountLazyFiles(const char* mountPoint, const char* urlFolder, const char* index);

} // namespace BrowserLite
