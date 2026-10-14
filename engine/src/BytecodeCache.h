// Dauerhafter Bytecode-Cache fuer Skripte (siehe BytecodeCache.cpp).
#pragma once

#include <wtf/URL.h>

namespace BrowserLite::BytecodeCache {

// Schaltet den Cache ein, wenn die Oberflaeche eine Build-ID gesetzt hat
void initialize();

// Gespeicherten Bytecode fuer dieses Skript schon mal holen (beim Start des Ladens)
void prefetch(const URL&);

// Neuen Bytecode bald speichern (nach dem Laden einer Seite)
void scheduleCommit();

} // namespace BrowserLite::BytecodeCache
