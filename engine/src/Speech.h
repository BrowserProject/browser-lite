// speechSynthesis ueber den Host-Browser (Speech.cpp)
#pragma once

#include <wtf/Forward.h>

namespace BrowserLite {

void installSpeech();
// Stimmen des Hosts als JSON-Liste [{uri, name, lang, local, default}]
void setSpeechVoices(const String& json);
// type wie WasmPlatform::SpeechEvent: 0 Start, 1 Ende, 2 Pause, 3 Weiter, 4 Fehler, 5 Wort, 6 Satz
void speechEvent(uint64_t id, int type, unsigned charIndex, unsigned charLength);

} // namespace BrowserLite
