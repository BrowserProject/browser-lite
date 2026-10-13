// Kamera, Mikrofon und Bildschirm des Host-Browsers fuer getUserMedia und
// getDisplayMedia.
//
// WebCore macht die ganze MediaStream-Logik (Tracks, Constraints, Klone).
// Wir liefern die Geraete und Quellen: startet eine Quelle, oeffnet die
// Oberflaeche die Kamera/das Mikrofon des Host (web/capture.js) und schickt
// die Bilder und den Ton als Stream an den Engine-Worker (engine/js/
// webcodecs-host.js, blCapture). Die kommen ueber bl_capture_* hier an.
// Wie in Chrome fragt die Oberflaeche pro Ursprung nach Kamera/Mikrofon.
#pragma once

#include <WebCore/AudioStreamDescription.h>
#include <WebCore/MediaStreamPrivate.h>
#include <WebCore/PlatformAudioData.h>
#include <WebCore/RealtimeMediaSource.h>
#include <wtf/Lock.h>
#include <wtf/RefCounted.h>
#include <wtf/WeakPtr.h>

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
}

// Ton im Speicher der Engine: Float32, ein Block pro Kanal
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

// <video>.srcObject = stream: haelt das neuste Bild der Video-Spur
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
    // Ton der Spur abspielen (nur wenn das Element spielt und nicht stumm ist)
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

    // VideoFrameObserver (kann von jedem Thread kommen)
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
