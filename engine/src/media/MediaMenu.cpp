#include "config.h"
#include "MediaMenu.h"

#include "Host.h"
#include "JSHTMLVideoElement.h"
#include "WebPlatformExtras.h"
#include <JavaScriptCore/CallData.h>
#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/JSLock.h>
#include <WebCore/DOMWrapperWorld.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/FrameDestructionObserverInlines.h>
#include <WebCore/HTMLMediaElement.h>
#include <WebCore/HTMLVideoElement.h>
#include <WebCore/HitTestResult.h>
#include <WebCore/JSDOMExceptionHandling.h>
#include <WebCore/JSExecState.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/MediaError.h>
#include <WebCore/ScriptController.h>
#include <WebCore/UserGestureIndicator.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite {
using namespace WebCore;

// The element itself or its controls: the menu's hit test leaves the controls (shadow content of
// the user agent) out, like Chrome's
static RefPtr<HTMLMediaElement> mediaElement(const HitTestResult& hit)
{
    return dynamicDowncast<HTMLMediaElement>(hit.innerNonSharedNode());
}

static bool playsStream(const HTMLMediaElement& media)
{
#if ENABLE(MEDIA_STREAM)
    auto& provider = media.srcObject();
    return provider && std::holds_alternative<Ref<MediaStream>>(*provider);
#else
    UNUSED_PARAM(media);
    return false;
#endif
}

// Like Chrome: a stream has no end to loop to, and a failed element neither
static bool canLoop(const HTMLMediaElement& media)
{
    return !media.error() && !playsStream(media);
}

// Like Chrome only a video with a picture: an <audio> without controls disappears with no way to
// get them back, and a fullscreen video keeps its controls anyway
static bool canToggleControls(const HTMLMediaElement& media)
{
    return is<HTMLVideoElement>(media) && media.hasVideo() && !media.isFullscreen() && !media.error();
}

// The polyfill's function for the video in the window of its document; null without one (the
// host has no picture-in-picture, like Firefox)
static String callPictureInPictureMenu(HTMLVideoElement& video, ASCIILiteral command)
{
    RefPtr frame = video.document().frame();
    auto* globalObject = frame ? frame->script().globalObject(mainThreadNormalWorldSingleton()) : nullptr;
    if (!globalObject)
        return { };
    auto& vm = globalObject->vm();
    JSC::JSLockHolder lock(vm);
    auto* bridge = pageBridge(*globalObject);
    if (!bridge)
        return { };
    auto function = bridge->get(globalObject, JSC::Identifier::fromString(vm, "pictureInPictureMenu"_s));
    auto callData = JSC::getCallData(function);
    if (callData.type == JSC::CallData::Type::None)
        return { };
    JSC::MarkedArgumentBuffer arguments;
    arguments.append(toJS(globalObject, globalObject, video));
    arguments.append(JSC::jsString(vm, String { command }));
    NakedPtr<JSC::Exception> exception;
    auto result = JSExecState::profiledCall(globalObject, JSC::ProfilingReason::Other, function, callData, JSC::jsUndefined(), arguments, exception);
    if (exception) {
        reportException(globalObject, exception);
        return { };
    }
    return result.isString() ? result.getString(globalObject) : String { };
}

// "unsupported" (no item: an <audio>, or no picture-in-picture in the host), "unavailable" (not
// now: no metadata yet, disablepictureinpicture), "available" or "active" (in the window)
static String pictureInPictureState(HTMLMediaElement& media)
{
    RefPtr video = dynamicDowncast<HTMLVideoElement>(media);
    auto state = video ? callPictureInPictureMenu(*video, "state"_s) : String { };
    if (state == "unavailable"_s || state == "available"_s || state == "active"_s)
        return state;
    return "unsupported"_s;
}

String mediaMenuJSON(const HitTestResult& hit)
{
    RefPtr media = mediaElement(hit);
    if (!media)
        return "null"_s;
    auto flag = [](bool value) { return value ? "true"_s : "false"_s; };
    return makeString("{\"type\":\""_s, is<HTMLVideoElement>(*media) ? "video"_s : "audio"_s,
        "\",\"url\":\""_s, jsonEscape(hit.absoluteMediaURL().string()),
        "\",\"canSave\":"_s, flag(media->canSaveMediaData()),
        ",\"loop\":"_s, flag(media->loop()), ",\"canLoop\":"_s, flag(canLoop(*media)),
        ",\"controls\":"_s, flag(media->controls()), ",\"canToggleControls\":"_s, flag(canToggleControls(*media)),
        ",\"pictureInPicture\":\""_s, pictureInPictureState(*media), "\"}"_s);
}

void mediaMenuAction(const HitTestResult& hit, const String& action, bool enable)
{
    RefPtr media = mediaElement(hit);
    if (!media)
        return;
    UserGestureIndicator gesture(IsProcessingUserGesture::Yes, &media->document());
    if (action == "loop"_s) {
        if (canLoop(*media))
            media->setLoop(enable);
    } else if (action == "controls"_s) {
        if (canToggleControls(*media))
            media->setControls(enable);
    } else if (action == "picture-in-picture"_s) {
        if (RefPtr video = dynamicDowncast<HTMLVideoElement>(*media))
            callPictureInPictureMenu(*video, enable ? "enter"_s : "exit"_s);
    }
}

} // namespace BrowserLite
