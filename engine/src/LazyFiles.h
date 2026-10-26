// Read-only files of the engine folder that load on first read (LazyFiles.cpp).
#pragma once

namespace BrowserLite {

// Mounts the files of `index` (lines "<path> <size> [<group>]") at `mountPoint`, whose parent is created
// when missing (outside the read-only folders of the data package). A file loads from
// <engine folder>/<urlFolder>/<path> on its first read, synchronously, and stays in memory.
// The first read of a file of a group starts fetching the other files of that group in parallel.
// Returns false when the mount failed.
bool mountLazyFiles(const char* mountPoint, const char* urlFolder, const char* index);

} // namespace BrowserLite
