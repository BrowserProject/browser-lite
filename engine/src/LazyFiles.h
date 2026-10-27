// Read-only files of the engine folder that load on first read (LazyFiles.cpp).
#pragma once

namespace BrowserLite {

// Mounts the files of `index` (lines "<path> <size> [<group>]") at `mountPoint`, whose parent is created
// when missing (outside the read-only folders of the data package). A file loads from
// <engine folder>/<urlFolder>/<path> on its first read, synchronously, and stays in memory.
// The first read of a file of a group starts fetching the other files of that group in parallel.
// Returns false when the mount failed.
bool mountLazyFiles(const char* mountPoint, const char* urlFolder, const char* index);

// Starts fetching the files of group `name` of a mounted index without waiting, unless a read
// of one of them did already; an unknown group does nothing.
void prefetchLazyGroup(const char* name);

// Called on the thread of a read that is about to wait for a file of `mountPoint` (its path in
// the engine folder), before it waits; for example to start fetching what is needed next.
void setLazyMissHandler(const char* mountPoint, void (*handler)(const char* path));

// Starts fetching files of the engine folder (paths, one per line) without waiting, so their
// first reads find them in the HTTP cache.
void prefetchLazyFiles(const char* paths);

} // namespace BrowserLite
