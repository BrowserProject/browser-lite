// WebCodecs der Seiten (VideoDecoder, VideoEncoder, AudioDecoder,
// AudioEncoder) ueber die WebCodecs des Host-Browsers im Engine-Worker
// (engine/js/webcodecs-host.js).
//
// WebCore ruft die Codecs aus dem Thread der Seite oder eines Workers auf.
// Wir geben alles an den Engine-Thread weiter (dort laeuft der Host-Codec),
// die Ergebnisse gehen ueber die Callbacks von WebCore zurueck, die selber in
// den richtigen Thread wechseln. Dekodierte Bilder werden zu VideoFrameWasm,
// Ton zu PlatformRawAudioData (beides im Speicher der Engine).
#pragma once

namespace WebCore {
class Settings;
}

namespace BrowserLite::WebCodecs {

void initialize();
void enableIn(WebCore::Settings&);

} // namespace BrowserLite::WebCodecs
