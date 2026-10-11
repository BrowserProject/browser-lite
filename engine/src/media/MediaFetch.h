#pragma once

namespace BrowserLite {

// Ein Stueck der Mediendatei eines Players laden (end < 0: bis zum Ende).
// Ergebnis ueber Module.onEngineMediaFetch: head, data..., end oder error.
void startMediaFetch(int playerId, int fetchId, double start, double end);
void cancelMediaFetch(int fetchId);

} // namespace BrowserLite
