// navigator.mediaCapabilities of the pages and their workers.
//
// WebCore asks on the engine thread, also for workers. decodingInfo needs the
// engine's own player to take the type (MediaPlayerPrivateWasm::takesType: the
// media feature, the containers of our MSE parsers), and for the rest asks the
// host browser, which decodes the media, with its own decodingInfo on its main
// thread, where its <video> and MediaSource live. supported, smooth and
// powerEfficient are its answer, so they agree with canPlayType and
// isTypeSupported, which ask the same host. Players like Twitch's drop every
// variant that decodingInfo calls unsupported (WebCore's default without a
// factory said so for everything).
//
// encodingInfo: "record" is the engine's MediaRecorder (WebM with the host's
// encoders, MediaRecorderWasm.cpp) and answers like its isTypeSupported;
// "webrtc" goes to the host like decodingInfo (its RTCPeerConnection carries
// the page's connections, WebRTCPolyfill.cpp).
#include "config.h"
#include "MediaCapabilitiesWasm.h"

#include "Engine.h"
#include "MediaPlayerPrivateWasm.h"

#include <WebCore/ContentType.h>
#include <WebCore/MediaPlayer.h>
#include <WebCore/PlatformMediaCapabilitiesDecodingInfo.h>
#include <WebCore/PlatformMediaCapabilitiesEncodingInfo.h>
#include <WebCore/PlatformMediaDecodingConfiguration.h>
#include <WebCore/PlatformMediaEncodingConfiguration.h>
#include <WebCore/PlatformMediaEngineConfigurationFactory.h>
#include <cstdlib>
#include <cstring>
#include <emscripten/emscripten.h>
#include <wtf/HashMap.h>
#include <wtf/JSONValues.h>
#include <wtf/NeverDestroyed.h>

namespace WebCore {
// MediaRecorderWasm.cpp
bool isMediaRecorderTypeSupportedWasm(const ContentType&);
}

namespace BrowserLite::MediaCapabilities {

using namespace WebCore;

// The host's answer: supported is -1 when the host has no MediaCapabilities
using Answer = Function<void(int supported, bool smooth, bool powerEfficient)>;

// Questions waiting for the host (engine thread only)
static HashMap<int, Answer>& pendingAnswers()
{
    static NeverDestroyed<HashMap<int, Answer>> answers;
    return answers;
}

static int lastQuestionId;

static ASCIILiteral colorGamutName(PlatformMediaCapabilitiesColorGamut value)
{
    switch (value) {
    case PlatformMediaCapabilitiesColorGamut::SRGB: return "srgb"_s;
    case PlatformMediaCapabilitiesColorGamut::P3: return "p3"_s;
    case PlatformMediaCapabilitiesColorGamut::Rec2020: return "rec2020"_s;
    }
    return "srgb"_s;
}

static ASCIILiteral hdrMetadataTypeName(PlatformMediaCapabilitiesHdrMetadataType value)
{
    switch (value) {
    case PlatformMediaCapabilitiesHdrMetadataType::SmpteSt2086: return "smpteSt2086"_s;
    case PlatformMediaCapabilitiesHdrMetadataType::SmpteSt209410: return "smpteSt2094-10"_s;
    case PlatformMediaCapabilitiesHdrMetadataType::SmpteSt209440: return "smpteSt2094-40"_s;
    }
    return "smpteSt2086"_s;
}

static ASCIILiteral transferFunctionName(PlatformMediaCapabilitiesTransferFunction value)
{
    switch (value) {
    case PlatformMediaCapabilitiesTransferFunction::SRGB: return "srgb"_s;
    case PlatformMediaCapabilitiesTransferFunction::PQ: return "pq"_s;
    case PlatformMediaCapabilitiesTransferFunction::HLG: return "hlg"_s;
    }
    return "srgb"_s;
}

static ASCIILiteral decodingTypeName(PlatformMediaDecodingType type)
{
    switch (type) {
    case PlatformMediaDecodingType::FileOrHLS: return "file"_s;
    case PlatformMediaDecodingType::MediaSource: return "media-source"_s;
    case PlatformMediaDecodingType::MediaStream: return "webrtc"_s;
    }
    return "file"_s;
}

// The configuration as the page gave it, for the host's MediaCapabilities
static String hostQuestion(const PlatformMediaConfiguration& configuration, ASCIILiteral type)
{
    auto question = JSON::Object::create();
    question->setString("type"_s, type);
    if (auto& video = configuration.video) {
        auto object = JSON::Object::create();
        object->setString("contentType"_s, video->contentType);
        object->setDouble("width"_s, video->width);
        object->setDouble("height"_s, video->height);
        object->setDouble("bitrate"_s, video->bitrate);
        object->setDouble("framerate"_s, video->framerate);
        if (video->alphaChannel)
            object->setBoolean("alphaChannel"_s, *video->alphaChannel);
        if (video->colorGamut)
            object->setString("colorGamut"_s, colorGamutName(*video->colorGamut));
        if (video->hdrMetadataType)
            object->setString("hdrMetadataType"_s, hdrMetadataTypeName(*video->hdrMetadataType));
        if (video->transferFunction)
            object->setString("transferFunction"_s, transferFunctionName(*video->transferFunction));
        question->setObject("video"_s, WTF::move(object));
    }
    if (auto& audio = configuration.audio) {
        auto object = JSON::Object::create();
        object->setString("contentType"_s, audio->contentType);
        if (!audio->channels.isNull())
            object->setString("channels"_s, audio->channels);
        if (audio->bitrate)
            object->setDouble("bitrate"_s, *audio->bitrate);
        if (audio->samplerate)
            object->setDouble("samplerate"_s, *audio->samplerate);
        if (audio->spatialRendering)
            object->setBoolean("spatialRendering"_s, *audio->spatialRendering);
        question->setObject("audio"_s, WTF::move(object));
    }
    return question->toJSONString();
}

// Asks the host's navigator.mediaCapabilities on its main thread; the answer
// comes back through bl__media_capabilities
static void askHost(bool encoding, const String& question, Answer&& answer)
{
    ASSERT(isEngineThread());
    int id = ++lastQuestionId;
    pendingAnswers().add(id, WTF::move(answer));
    char* text = strdup(question.utf8().data());
    MAIN_THREAD_ASYNC_EM_ASM({
        var id = $0;
        var encoding = $1;
        var question = JSON.parse(UTF8ToString($2));
        _free($2);
        var answer = function(supported, smooth, powerEfficient) {
            Module['_bl__media_capabilities'](id, supported, smooth, powerEfficient);
        };
        var capabilities = navigator.mediaCapabilities;
        if (!capabilities) {
            answer(-1, 0, 0);
            return;
        }
        Promise.resolve().then(function() {
            return encoding ? capabilities.encodingInfo(question) : capabilities.decodingInfo(question);
        }).then(function(info) {
            answer(info.supported ? 1 : 0, info.smooth ? 1 : 0, info.powerEfficient ? 1 : 0);
        }, function() {
            answer(0, 0, 0);
        });
    }, id, encoding, text);
}

static bool takesConfiguration(const PlatformMediaDecodingConfiguration& configuration)
{
    if (configuration.video && !MediaPlayerPrivateWasm::takesType(configuration.type, ContentType(configuration.video->contentType)))
        return false;
    if (configuration.audio && !MediaPlayerPrivateWasm::takesType(configuration.type, ContentType(configuration.audio->contentType)))
        return false;
    return true;
}

// Without the host's MediaCapabilities: the questions of canPlayType and isTypeSupported
static bool playerSupports(const PlatformMediaDecodingConfiguration& configuration)
{
    auto supports = [&](const String& contentType) {
        MediaEngineSupportParameters parameters {
            .platformType = configuration.type,
            .type = ContentType(contentType),
        };
        return MediaPlayer::supportsType(parameters) != MediaPlayer::SupportsType::IsNotSupported;
    };
    return (!configuration.video || supports(configuration.video->contentType))
        && (!configuration.audio || supports(configuration.audio->contentType));
}

static void createDecodingConfiguration(PlatformMediaDecodingConfiguration&& configuration, PlatformMediaEngineConfigurationFactory::DecodingConfigurationCallback&& callback)
{
    if (!takesConfiguration(configuration)) {
        callback({ { }, WTF::move(configuration) });
        return;
    }
    auto question = hostQuestion(configuration, decodingTypeName(configuration.type));
    askHost(false, question, [configuration = WTF::move(configuration), callback = WTF::move(callback)](int supported, bool smooth, bool powerEfficient) mutable {
        PlatformMediaCapabilitiesInfo info;
        if (supported < 0)
            info = { playerSupports(configuration), true, false };
        else
            info = { !!supported, smooth, powerEfficient };
        if (!info.supported)
            info = { };
        callback({ info, WTF::move(configuration) });
    });
}

static void createEncodingConfiguration(PlatformMediaEncodingConfiguration&& configuration, PlatformMediaEngineConfigurationFactory::EncodingConfigurationCallback&& callback)
{
    if (configuration.type == PlatformMediaEncodingType::Record) {
        bool supported = (!configuration.video || isMediaRecorderTypeSupportedWasm(ContentType(configuration.video->contentType)))
            && (!configuration.audio || isMediaRecorderTypeSupportedWasm(ContentType(configuration.audio->contentType)));
        callback({ { supported, supported, false }, WTF::move(configuration) });
        return;
    }
    auto question = hostQuestion(configuration, "webrtc"_s);
    askHost(true, question, [configuration = WTF::move(configuration), callback = WTF::move(callback)](int supported, bool smooth, bool powerEfficient) mutable {
        PlatformMediaCapabilitiesInfo info;
        if (supported > 0)
            info = { true, smooth, powerEfficient };
        callback({ info, WTF::move(configuration) });
    });
}

void initialize()
{
    PlatformMediaEngineConfigurationFactory::installFactory({ createDecodingConfiguration, createEncodingConfiguration });
}

} // namespace BrowserLite::MediaCapabilities

// From the main thread (askHost)
extern "C" EMSCRIPTEN_KEEPALIVE void bl__media_capabilities(int id, int supported, int smooth, int powerEfficient)
{
    BrowserLite::runOnEngineThread([id, supported, smooth, powerEfficient] {
        if (auto answer = BrowserLite::MediaCapabilities::pendingAnswers().take(id))
            answer(supported, smooth, powerEfficient);
    });
}
