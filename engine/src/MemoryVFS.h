// SQLite-Datenbanken unter /data im WASM-Speicher (siehe MemoryVFS.cpp).
#pragma once

#include <cstdint>
#include <wtf/Forward.h>
#include <wtf/Seconds.h>

namespace BrowserLite {

// Vor dem ersten Oeffnen einer Datenbank aufrufen: wird das Standard-VFS
void registerMemoryVFS();

// Geaenderte Datenbanken jetzt ins Dateisystem schreiben (alle, die gerade
// nicht mitten in einer Schreib-Transaktion sind). Im Engine-Thread oder einem
// anderen Worker-Thread.
void flushMemoryVFS();

// Haupt-Thread des Host (pagehide): den Engine-Thread schreiben lassen und
// hoechstens timeout darauf warten. false: nicht rechtzeitig fertig
bool flushMemoryVFSAndWait(Seconds timeout);

// Belegter Platz der Dateien direkt in directory (ohne Unterordner): offene
// Datenbanken, wie sie im Speicher sind (mit WAL), alles andere auf der Platte.
// Von Datenbanken zaehlen nur die belegten Seiten, nicht die freien.
uint64_t memoryVFSDirectorySize(const String& directory);

} // namespace BrowserLite
