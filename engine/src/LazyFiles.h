// Read-only files of the engine folder that load on first read (LazyFiles.cpp).
#pragma once

#include <string>
#include <vector>

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

// Reads on the engine thread of files in these folders of `mountPoint` (fonts only used as a
// fallback for characters) wait at most `budget` ms from the first such read that waits: the
// reads after that deadline do not wait at all, they fail. A file that could not wait goes on
// loading; once every such file arrived, `arrived` runs on the engine thread (to look up the fonts
// again). A negative budget waits for every file. While `waitsFully` returns true the reads wait
// like the ones outside these folders (text whose result the page reads back at once).
void setLazyWaitLimit(const char* mountPoint, const std::vector<std::string>& folders, double budget, void (*arrived)(), bool (*waitsFully)() = nullptr);

// How many limited reads of `mountPoint` failed so far (the text went on without their file)
unsigned lazyReadsGivenUp(const char* mountPoint);

// Fetches files of the mounted indexes (paths in the engine folder) in the background with low
// priority and keeps them in memory, so their first reads need no request; files already in
// memory or on the way and unknown paths are left out. On the engine thread.
void preloadLazyFiles(const std::vector<std::string>& paths);

// Starts fetching files of the engine folder (paths, one per line) without waiting, so their
// first reads find them in the HTTP cache. Low: behind the other requests of the host (the
// synchronous reads come first).
void prefetchLazyFiles(const char* paths, bool low = false);

} // namespace BrowserLite
