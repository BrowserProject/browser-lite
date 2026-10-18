// WebCodecs of the pages (VideoDecoder, VideoEncoder, AudioDecoder,
// AudioEncoder) through the WebCodecs of the host browser in the engine worker
// (engine/js/webcodecs-host.js).
//
// WebCore calls the codecs from the thread of the page or of a worker. We hand
// everything to the engine thread (the host codec runs there), the results go
// back through WebCore's callbacks, which switch to the right thread
// themselves. Decoded frames become VideoFrameWasm, sound
// PlatformRawAudioData (both in the engine memory).
#pragma once

namespace WebCore {
class Settings;
}

namespace BrowserLite::WebCodecs {

void initialize();
void enableIn(WebCore::Settings&);

} // namespace BrowserLite::WebCodecs
