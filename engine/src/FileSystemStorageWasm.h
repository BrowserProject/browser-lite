// Origin Private File System (navigator.storage.getDirectory) fuer Seiten
// und Worker.
//
// In WebKit2 steckt die Umsetzung im Netzwerk-Prozess (FileSystemStorageManager,
// FileSystemStorageHandle). Hier eine kleine eigene im Engine-Thread, mit den
// gleichen Regeln (Namen, Sperren, Fehler). Die Dateien liegen unter
// /data/opfs/<Ursprung>/ und werden wie alles unter /data dauerhaft gespeichert.
#pragma once

#include <WebCore/StorageConnection.h>

namespace BrowserLite {

// Fuer StorageConnection::fileSystemGetDirectory (Engine-Thread)
void fileSystemGetDirectory(const WebCore::ClientOrigin&, WebCore::StorageConnection::GetDirectoryCallback&&);
// Belegter Platz im OPFS eines Ursprungs
uint64_t fileSystemUsage(const WebCore::ClientOrigin&);

} // namespace BrowserLite
