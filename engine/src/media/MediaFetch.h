#pragma once

namespace BrowserLite {

// Loads a piece of the media file of a player (end < 0: to the end).
// Result through Module.onEngineMediaFetch: head, data..., end or error.
void startMediaFetch(int playerId, int fetchId, double start, double end);
void cancelMediaFetch(int fetchId);

} // namespace BrowserLite
