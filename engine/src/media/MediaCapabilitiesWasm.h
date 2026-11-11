// navigator.mediaCapabilities of the pages and their workers (decodingInfo,
// encodingInfo), answered with the host browser that plays the media.
#pragma once

namespace BrowserLite::MediaCapabilities {

// Installs the engine's answers into WebCore (engine thread, once at start)
void initialize();

} // namespace BrowserLite::MediaCapabilities
