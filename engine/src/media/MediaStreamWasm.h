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

#include <WebCore/MediaStreamPrivate.h>
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

namespace MediaStreams {
void enableIn(WebCore::Settings&);
void attachTo(int viewId, WebCore::Page&);
}

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
    WebCore::MediaStreamPrivate& stream() const { return m_stream; }

private:
    MediaStreamPlayback(MediaPlayerPrivateWasm&, WebCore::MediaStreamPrivate&);

    void updateVideoTrack();

    // MediaStreamPrivateObserver
    void characteristicsChanged() final;
    void activeStatusChanged() final;
    void didAddTrack(WebCore::MediaStreamTrackPrivate&) final { updateVideoTrack(); }
    void didRemoveTrack(WebCore::MediaStreamTrackPrivate&) final { updateVideoTrack(); }

    // VideoFrameObserver (kann von jedem Thread kommen)
    void videoFrameAvailable(WebCore::VideoFrame&, WebCore::VideoFrameTimeMetadata) final;

    WeakPtr<MediaPlayerPrivateWasm> m_player;
    const Ref<WebCore::MediaStreamPrivate> m_stream;
    RefPtr<WebCore::RealtimeMediaSource> m_videoSource;
    mutable Lock m_frameLock;
    RefPtr<WebCore::VideoFrame> m_frame WTF_GUARDED_BY_LOCK(m_frameLock);
    bool m_stopped { false };
};

} // namespace BrowserLite
