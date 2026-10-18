// Camera, microphone and screen of the host browser for getUserMedia and
// getDisplayMedia.
//
// WebCore does all the MediaStream logic (tracks, constraints, clones). We
// provide the devices and sources: when a source starts, the host opens the
// host camera/microphone and sends the frames and the sound as a stream to
// the engine worker (engine/js/webcodecs-host.js, blCapture). They arrive here
// through bl__capture_*. Like in Chrome the host asks per origin for
// camera/microphone.
#pragma once

#include <WebCore/AudioStreamDescription.h>
#include <WebCore/MediaStreamPrivate.h>
#include <WebCore/PlatformAudioData.h>
#include <WebCore/RealtimeMediaSource.h>
#include <wtf/Lock.h>
#include <wtf/RefCounted.h>
#include <wtf/WeakPtr.h>

namespace JSC {
class JSGlobalObject;
class JSObject;
}

namespace WebCore {
class Page;
class Settings;
class VideoFrame;
}

namespace BrowserLite {

class MediaPlayerPrivateWasm;
class StreamAudioOutput;

namespace MediaStreams {
void enableIn(WebCore::Settings&);
void attachTo(int viewId, WebCore::Page&);
// media(op, ...) of the polyfill bridge for WebRTC and picture-in-picture
// (tracks and players of the page <-> host), see WebPlatformExtras.h
JSC::JSObject* createBridge(JSC::JSGlobalObject&);
}

// Sound in the engine memory: Float32, one block per channel
class WasmAudioData final : public WebCore::PlatformAudioData {
public:
    WasmAudioData(const float* samples, size_t frames, unsigned channels)
        : m_samples(samples)
        , m_frames(frames)
        , m_channels(channels)
    {
    }
    std::span<const float> channel(unsigned index) const { return { m_samples + index * m_frames, m_frames }; }
    unsigned channels() const { return m_channels; }

private:
    const float* m_samples;
    size_t m_frames;
    unsigned m_channels;
};

class WasmAudioStreamDescription final : public WebCore::AudioStreamDescription {
public:
    WasmAudioStreamDescription(double sampleRate, unsigned channels)
        : m_sampleRate(sampleRate)
        , m_channels(channels)
    {
    }

private:
    const WebCore::PlatformDescription& platformDescription() const final { return m_description; }
    PCMFormat format() const final { return Float32; }
    double sampleRate() const final { return m_sampleRate; }
    bool isInterleaved() const final { return false; }
    bool isSignedInteger() const final { return false; }
    bool isFloat() const final { return true; }
    bool isNativeEndian() const final { return true; }
    uint32_t numberOfInterleavedChannels() const final { return 1; }
    uint32_t numberOfChannelStreams() const final { return m_channels; }
    uint32_t numberOfChannels() const final { return m_channels; }
    uint32_t sampleWordSize() const final { return sizeof(float); }

    WebCore::PlatformDescription m_description { WebCore::PlatformDescription::None, nullptr };
    double m_sampleRate;
    unsigned m_channels;
};

// <video>.srcObject = stream: holds the newest frame of the video track
class MediaStreamPlayback final
    : public RefCounted<MediaStreamPlayback>
    , public WebCore::MediaStreamPrivateObserver
    , public WebCore::RealtimeMediaSource::VideoFrameObserver {
public:
    static Ref<MediaStreamPlayback> create(MediaPlayerPrivateWasm&, WebCore::MediaStreamPrivate&);
    ~MediaStreamPlayback();

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    void stop();
    RefPtr<WebCore::VideoFrame> currentFrame() const;
    // Play the sound of the track (only when the element plays and is not muted)
    void setAudioState(bool playing, float volume, bool muted);
    WebCore::MediaStreamPrivate& stream() const { return m_stream; }

private:
    MediaStreamPlayback(MediaPlayerPrivateWasm&, WebCore::MediaStreamPrivate&);

    void updateVideoTrack();
    void updateAudioTrack();
    void updateTracks();

    // MediaStreamPrivateObserver
    void characteristicsChanged() final;
    void activeStatusChanged() final;
    void didAddTrack(WebCore::MediaStreamTrackPrivate&) final { updateTracks(); }
    void didRemoveTrack(WebCore::MediaStreamTrackPrivate&) final { updateTracks(); }

    // VideoFrameObserver (may come from any thread)
    void videoFrameAvailable(WebCore::VideoFrame&, WebCore::VideoFrameTimeMetadata) final;

    WeakPtr<MediaPlayerPrivateWasm> m_player;
    const Ref<WebCore::MediaStreamPrivate> m_stream;
    RefPtr<WebCore::RealtimeMediaSource> m_videoSource;
    mutable Lock m_frameLock;
    RefPtr<WebCore::VideoFrame> m_frame WTF_GUARDED_BY_LOCK(m_frameLock);
    bool m_stopped { false };
    RefPtr<StreamAudioOutput> m_audio;
    bool m_audioPlaying { false };
    float m_audioVolume { 1 };
    bool m_audioMuted { false };
};

} // namespace BrowserLite
