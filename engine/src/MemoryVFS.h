// SQLite-Datenbanken unter /data im WASM-Speicher (siehe MemoryVFS.cpp).
#pragma once

namespace BrowserLite {

// Vor dem ersten Oeffnen einer Datenbank aufrufen: wird das Standard-VFS
void registerMemoryVFS();

// Geaenderte Datenbanken ins Dateisystem schreiben (alle, die gerade nicht
// mitten in einer Schreib-Transaktion sind). Von jedem Thread aus erlaubt,
// auch vom Haupt-Thread des Host (vor dem Speichern des IDBFS).
// fromHostThread: blockiert nie (ueberspringt, wenn gerade jemand schreibt).
void flushMemoryVFS(bool fromHostThread);

} // namespace BrowserLite
