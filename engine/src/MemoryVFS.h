// SQLite databases under /data in WASM memory (see MemoryVFS.cpp).
#pragma once

#include <cstdint>
#include <wtf/Forward.h>
#include <wtf/Seconds.h>

namespace BrowserLite {

// Call before the first database is opened: becomes the default VFS
void registerMemoryVFS();

// Writes changed databases to the file system now (all that are not in the
// middle of a write transaction). On the engine thread or another worker
// thread.
void flushMemoryVFS();

// Main thread of the host (pagehide): let the engine thread write and wait at
// most timeout for it. false: not finished in time
bool flushMemoryVFSAndWait(Seconds timeout);

// Space used by the files directly in directory (without subfolders): open
// databases as they are in memory (with WAL), everything else on disk. For
// databases only the used pages count, not the free ones.
uint64_t memoryVFSDirectorySize(const String& directory);

} // namespace BrowserLite
