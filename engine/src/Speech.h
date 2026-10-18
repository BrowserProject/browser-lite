// speechSynthesis through the host browser (Speech.cpp)
#pragma once

#include <wtf/Forward.h>

namespace BrowserLite {

void installSpeech();
// Voices of the host as a JSON list [{uri, name, lang, local, default}]
void setSpeechVoices(const String& json);
// type like WasmPlatform::SpeechEvent: 0 start, 1 end, 2 pause, 3 resume, 4 error, 5 word, 6 sentence
void speechEvent(uint64_t id, int type, unsigned charIndex, unsigned charLength);

} // namespace BrowserLite
