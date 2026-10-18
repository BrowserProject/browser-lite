// Origin private file system (navigator.storage.getDirectory) for pages and
// workers.
//
// In WebKit2 the implementation lives in the network process
// (FileSystemStorageManager, FileSystemStorageHandle). Here a small one of our
// own on the engine thread, with the same rules (names, locks, errors). The
// files are under /data/opfs/<origin>/ and are stored persistently like
// everything under /data.
#pragma once

#include <WebCore/StorageConnection.h>

namespace BrowserLite {

// For StorageConnection::fileSystemGetDirectory (engine thread)
void fileSystemGetDirectory(const WebCore::ClientOrigin&, WebCore::StorageConnection::GetDirectoryCallback&&);
// Space used in the OPFS of an origin
uint64_t fileSystemUsage(const WebCore::ClientOrigin&);

} // namespace BrowserLite
