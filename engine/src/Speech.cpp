// speechSynthesis of the pages: WebCore (platform/wasm/PlatformSpeechSynthesizerWasm.cpp)
// hands utterances here, the host speaks them with speechSynthesis of the host
// browser and reports start/end/word boundaries back (bl_speech_event).
#include "config.h"
#include "Speech.h"

#include "Host.h"
#include <WebCore/WasmPlatform.h>
#include <wtf/JSONValues.h>
#include <wtf/text/MakeString.h>

using namespace WebCore;

namespace BrowserLite {

void installSpeech()
{
    WasmPlatform::setSpeechCallbacks([](const WasmPlatform::SpeechRequest& request) {
        notifyHost(0, "speak", makeString("{\"id\":"_s, request.id, ",\"text\":\""_s, jsonEscape(request.text),
            "\",\"lang\":\""_s, jsonEscape(request.lang), "\",\"voice\":\""_s, jsonEscape(request.voiceURI),
            "\",\"volume\":"_s, request.volume, ",\"rate\":"_s, request.rate, ",\"pitch\":"_s, request.pitch, '}'));
    }, [](WasmPlatform::SpeechCommand command) {
        ASCIILiteral name = command == WasmPlatform::SpeechCommand::Pause ? "pause"_s
            : command == WasmPlatform::SpeechCommand::Resume ? "resume"_s : "cancel"_s;
        notifyHost(0, "speech-command", makeString("{\"command\":\""_s, name, "\"}"_s));
    });
}

void setSpeechVoices(const String& json)
{
    auto value = JSON::Value::parseJSON(json);
    auto array = value ? value->asArray() : nullptr;
    if (!array)
        return;
    Vector<WasmPlatform::SpeechVoice> voices;
    for (auto& item : *array) {
        auto object = item->asObject();
        if (!object)
            continue;
        voices.append({ object->getString("uri"_s), object->getString("name"_s), object->getString("lang"_s),
            object->getBoolean("local"_s).value_or(true), object->getBoolean("default"_s).value_or(false) });
    }
    WasmPlatform::setSpeechVoices(WTF::move(voices));
}

void speechEvent(uint64_t id, int type, unsigned charIndex, unsigned charLength)
{
    if (type < 0 || type > static_cast<int>(WasmPlatform::SpeechEvent::SentenceBoundary))
        return;
    WasmPlatform::speechEvent(id, static_cast<WasmPlatform::SpeechEvent>(type), charIndex, charLength);
}

} // namespace BrowserLite
