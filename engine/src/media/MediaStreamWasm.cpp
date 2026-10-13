#include "config.h"
#include "MediaStreamWasm.h"

#include "DeviceClients.h"
#include "Engine.h"
#include "Host.h"
#include "MediaPlayerPrivateWasm.h"
#include "VideoFrameWasm.h"
#include <WebCore/AudioBus.h>
#include <WebCore/AudioSourceProviderClient.h>
#include <WebCore/AudioStreamDescription.h>
#include <WebCore/CaptureDevice.h>
#include <WebCore/CaptureDeviceManager.h>
#include <WebCore/CaptureDeviceWithCapabilities.h>
#include <WebCore/DisplayCaptureManager.h>
#include <WebCore/Document.h>
#include <WebCore/MediaStreamTrackPrivate.h>
#include <WebCore/MockRealtimeAudioSource.h>
#include <WebCore/MockRealtimeVideoSource.h>
#include <WebCore/Page.h>
#include <WebCore/PlatformAudioData.h>
#include <WebCore/RealtimeMediaSourceCenter.h>
#include <WebCore/RealtimeMediaSourceFactory.h>
#include <WebCore/RealtimeVideoCaptureSource.h>
#include <WebCore/SecurityOrigin.h>
#include <WebCore/Settings.h>
#include <WebCore/UserMediaClient.h>
#include <WebCore/UserMediaRequest.h>
#include <WebCore/WebAudioSourceProvider.h>
#include <cstdlib>
#include <emscripten/emscripten.h>
#include <wtf/CryptographicallyRandomNumber.h>
#include <wtf/HashMap.h>
#include <wtf/MainThread.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringHash.h>

namespace BrowserLite {
using namespace WebCore;

namespace {

// ------------------------------------------------------------ Geraete

const CaptureDevice& cameraDevice()
{
    static NeverDestroyed<CaptureDevice> device { CaptureDevice { "bl-camera"_s, CaptureDevice::DeviceType::Camera, "Kamera"_s, "bl-group-camera"_s, true, true } };
    return device;
}

const CaptureDevice& microphoneDevice()
{
    static NeverDestroyed<CaptureDevice> device { CaptureDevice { "bl-microphone"_s, CaptureDevice::DeviceType::Microphone, "Mikrofon"_s, "bl-group-microphone"_s, true, true } };
    return device;
}

const CaptureDevice& screenDevice()
{
    static NeverDestroyed<CaptureDevice> device { CaptureDevice { "bl-screen"_s, CaptureDevice::DeviceType::Screen, "Bildschirm"_s, emptyString(), true, true } };
    return device;
}

class DeviceManager final : public CaptureDeviceManager {
public:
    explicit DeviceManager(const CaptureDevice& device)
        : m_devices({ device })
    {
    }
    const Vector<CaptureDevice>& captureDevices() final { return m_devices; }

private:
    Vector<CaptureDevice> m_devices;
};

class ScreenManager final : public DisplayCaptureManager {
public:
    // Sonst sucht WebCore fuer getDisplayMedia unter den Kameras
    bool requiresCaptureDevicesEnumeration() const final { return true; }
    const Vector<CaptureDevice>& captureDevices() final
    {
        static NeverDestroyed<Vector<CaptureDevice>> devices { Vector<CaptureDevice> { screenDevice() } };
        return devices;
    }
};

// ------------------------------------------------------------ Quellen

// Ton im Speicher der Engine: Float32, ein Block pro Kanal
class WasmAudioData final : public PlatformAudioData {
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

class WasmAudioStreamDescription final : public AudioStreamDescription {
public:
    WasmAudioStreamDescription(double sampleRate, unsigned channels)
        : m_sampleRate(sampleRate)
        , m_channels(channels)
    {
    }

private:
    const PlatformDescription& platformDescription() const final { return m_description; }
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

    PlatformDescription m_description { PlatformDescription::None, nullptr };
    double m_sampleRate;
    unsigned m_channels;
};

int nextSourceId()
{
    static int next = 1;
    return next++;
}

void notifyCapture(ASCIILiteral type, const String& json)
{
    notifyHost(0, type.characters(), json);
}

class VideoCaptureSourceWasm;
class AudioCaptureSourceWasm;

HashMap<int, VideoCaptureSourceWasm*>& videoSources()
{
    static NeverDestroyed<HashMap<int, VideoCaptureSourceWasm*>> map;
    return map;
}

HashMap<int, AudioCaptureSourceWasm*>& audioSources()
{
    static NeverDestroyed<HashMap<int, AudioCaptureSourceWasm*>> map;
    return map;
}

class VideoCaptureSourceWasm final : public RealtimeVideoCaptureSource {
public:
    static CaptureSourceOrError create(const CaptureDevice& device, MediaDeviceHashSalts&& hashSalts, const MediaConstraints* constraints, std::optional<PageIdentifier> pageIdentifier)
    {
        Ref source = adoptRef(*new VideoCaptureSourceWasm(device, WTF::move(hashSalts), pageIdentifier));
        if (constraints) {
            if (auto error = source->applyConstraints(*constraints))
                return CaptureSourceOrError(CaptureSourceError { error->invalidConstraint });
        }
        return CaptureSourceOrError(Ref<RealtimeMediaSource> { WTF::move(source) });
    }

    ~VideoCaptureSourceWasm()
    {
        videoSources().remove(m_id);
        if (m_producing)
            notifyCapture("capture-stop"_s, makeString("{\"id\":"_s, m_id, '}'));
    }

    void deliver(Ref<VideoFrame>&& frame)
    {
        if (!m_producing)
            return;
        auto frameSize = frame->presentationSize();
        if (frameSize != size())
            setSize(frameSize);
        dispatchVideoFrameToObservers(frame, { });
    }

    void hostFailed() { captureFailed(); }
    void hostEnded() { end(); }

private:
    VideoCaptureSourceWasm(const CaptureDevice& device, MediaDeviceHashSalts&& hashSalts, std::optional<PageIdentifier> pageIdentifier)
        : RealtimeVideoCaptureSource(device, WTF::move(hashSalts), pageIdentifier)
        , m_id(nextSourceId())
        , m_type(device.type())
    {
        videoSources().add(m_id, this);
    }

    void generatePresets() final
    {
        Vector<VideoPreset> presets;
        double maximumFrameRate = m_type == CaptureDevice::DeviceType::Camera ? 30 : 60;
        for (auto size : { IntSize { 320, 240 }, IntSize { 640, 360 }, IntSize { 640, 480 }, IntSize { 1280, 720 }, IntSize { 1920, 1080 }, IntSize { 3840, 2160 } })
            presets.append(VideoPreset { VideoPresetData { size, { { 1, maximumFrameRate } } } });
        setSupportedPresets(WTF::move(presets));
    }

    const RealtimeMediaSourceCapabilities& capabilities() final
    {
        RealtimeMediaSourceCapabilities capabilities(settings().supportedConstraints());
        capabilities.setDeviceId(hashedId());
        capabilities.setGroupId(hashedGroupId());
        updateCapabilities(capabilities);
        if (m_type == CaptureDevice::DeviceType::Camera)
            capabilities.addFacingMode(VideoFacingMode::User);
        m_capabilities = WTF::move(capabilities);
        return *m_capabilities;
    }

    const RealtimeMediaSourceSettings& settings() final
    {
        if (!m_settings) {
            RealtimeMediaSourceSettings settings;
            settings.setDeviceId(hashedId());
            settings.setGroupId(hashedGroupId());
            settings.setLabel(AtomString { name() });
            RealtimeMediaSourceSupportedConstraints supportedConstraints;
            supportedConstraints.setSupportsDeviceId(true);
            supportedConstraints.setSupportsGroupId(true);
            supportedConstraints.setSupportsWidth(true);
            supportedConstraints.setSupportsHeight(true);
            supportedConstraints.setSupportsAspectRatio(true);
            supportedConstraints.setSupportsFrameRate(true);
            if (m_type == CaptureDevice::DeviceType::Camera)
                supportedConstraints.setSupportsFacingMode(true);
            else
                supportedConstraints.setSupportsDisplaySurface(true);
            settings.setSupportedConstraints(supportedConstraints);
            m_settings = WTF::move(settings);
        }
        m_settings->setWidth(size().width());
        m_settings->setHeight(size().height());
        m_settings->setFrameRate(frameRate());
        if (m_type == CaptureDevice::DeviceType::Camera)
            m_settings->setFacingMode(VideoFacingMode::User);
        else
            m_settings->setDisplaySurface(DisplaySurfaceType::Monitor);
        return *m_settings;
    }

    void settingsDidChange(OptionSet<RealtimeMediaSourceSettings::Flag> flags) final
    {
        UNUSED_PARAM(flags);
        m_settings = std::nullopt;
    }

    void startProducingData() final
    {
        m_producing = true;
        auto requested = size();
        notifyCapture("capture-start"_s, makeString("{\"id\":"_s, m_id, ",\"kind\":\""_s, m_type == CaptureDevice::DeviceType::Camera ? "camera"_s : "screen"_s,
            "\",\"width\":"_s, requested.width(), ",\"height\":"_s, requested.height(), ",\"frameRate\":"_s, frameRate(), '}'));
    }

    void stopProducingData() final
    {
        m_producing = false;
        notifyCapture("capture-stop"_s, makeString("{\"id\":"_s, m_id, '}'));
    }

    CaptureDevice::DeviceType deviceType() const final { return m_type; }
    bool isCaptureSource() const final { return true; }

    const int m_id;
    const CaptureDevice::DeviceType m_type;
    bool m_producing { false };
    std::optional<RealtimeMediaSourceCapabilities> m_capabilities;
    std::optional<RealtimeMediaSourceSettings> m_settings;
};

class AudioCaptureSourceWasm final : public RealtimeMediaSource, public ThreadSafeRefCountedAndCanMakeThreadSafeWeakPtr<AudioCaptureSourceWasm, WTF::DestructionThread::MainRunLoop> {
public:
    static CaptureSourceOrError create(const CaptureDevice& device, MediaDeviceHashSalts&& hashSalts, const MediaConstraints* constraints, std::optional<PageIdentifier> pageIdentifier)
    {
        Ref source = adoptRef(*new AudioCaptureSourceWasm(device, WTF::move(hashSalts), pageIdentifier));
        if (constraints) {
            if (auto error = source->applyConstraints(*constraints))
                return CaptureSourceOrError(CaptureSourceError { error->invalidConstraint });
        }
        return CaptureSourceOrError(Ref<RealtimeMediaSource> { WTF::move(source) });
    }

    ~AudioCaptureSourceWasm()
    {
        audioSources().remove(m_id);
        if (m_producing)
            notifyCapture("capture-stop"_s, makeString("{\"id\":"_s, m_id, '}'));
    }

    WTF_ABSTRACT_THREAD_SAFE_REF_COUNTED_AND_CAN_MAKE_WEAK_PTR_IMPL;

    void deliver(const float* samples, size_t frames, unsigned channels, double sampleRate, double timestamp)
    {
        if (!m_producing || !frames || !channels)
            return;
        if (static_cast<double>(this->sampleRate()) != sampleRate)
            setSampleRate(sampleRate);
        WasmAudioData data(samples, frames, channels);
        WasmAudioStreamDescription description(sampleRate, channels);
        audioSamplesAvailable(MediaTime(static_cast<int64_t>(timestamp), 1000000), data, description, frames);
    }

    void hostFailed() { captureFailed(); }
    void hostEnded() { end(); }

private:
    AudioCaptureSourceWasm(const CaptureDevice& device, MediaDeviceHashSalts&& hashSalts, std::optional<PageIdentifier> pageIdentifier)
        : RealtimeMediaSource(device, WTF::move(hashSalts), pageIdentifier)
        , m_id(nextSourceId())
    {
        audioSources().add(m_id, this);
        setSampleRate(48000);
        initializeEchoCancellation(true);
    }

    const RealtimeMediaSourceCapabilities& capabilities() final
    {
        if (!m_capabilities) {
            RealtimeMediaSourceCapabilities capabilities(settings().supportedConstraints());
            capabilities.setDeviceId(hashedId());
            capabilities.setGroupId(hashedGroupId());
            capabilities.setVolume({ 0.0, 1.0 });
            capabilities.setEchoCancellation(RealtimeMediaSourceCapabilities::EchoCancellation::OnOrOff);
            capabilities.setSampleRate({ 8000, 96000 });
            m_capabilities = WTF::move(capabilities);
        }
        return *m_capabilities;
    }

    const RealtimeMediaSourceSettings& settings() final
    {
        if (!m_settings) {
            RealtimeMediaSourceSettings settings;
            settings.setDeviceId(hashedId());
            settings.setGroupId(hashedGroupId());
            settings.setVolume(volume());
            settings.setEchoCancellation(echoCancellation());
            settings.setSampleRate(sampleRate());
            settings.setLabel(AtomString { name() });
            RealtimeMediaSourceSupportedConstraints supportedConstraints;
            supportedConstraints.setSupportsDeviceId(true);
            supportedConstraints.setSupportsGroupId(true);
            supportedConstraints.setSupportsVolume(true);
            supportedConstraints.setSupportsEchoCancellation(true);
            supportedConstraints.setSupportsSampleRate(true);
            settings.setSupportedConstraints(supportedConstraints);
            m_settings = WTF::move(settings);
        }
        return *m_settings;
    }

    void settingsDidChange(OptionSet<RealtimeMediaSourceSettings::Flag>) final { m_settings = std::nullopt; }

    void startProducingData() final
    {
        m_producing = true;
        notifyCapture("capture-start"_s, makeString("{\"id\":"_s, m_id, ",\"kind\":\"microphone\",\"echoCancellation\":"_s, echoCancellation() ? "true"_s : "false"_s, '}'));
    }

    void stopProducingData() final
    {
        m_producing = false;
        notifyCapture("capture-stop"_s, makeString("{\"id\":"_s, m_id, '}'));
    }

    CaptureDevice::DeviceType deviceType() const final { return CaptureDevice::DeviceType::Microphone; }
    bool isCaptureSource() const final { return true; }

    const int m_id;
    bool m_producing { false };
    std::optional<RealtimeMediaSourceCapabilities> m_capabilities;
    std::optional<RealtimeMediaSourceSettings> m_settings;
};

// ------------------------------------------------------------ Factories

class AudioFactory final : public AudioCaptureFactory {
    CaptureSourceOrError createAudioCaptureSource(const CaptureDevice& device, MediaDeviceHashSalts&& hashSalts, const MediaConstraints* constraints, std::optional<PageIdentifier> pageIdentifier) final
    {
        return AudioCaptureSourceWasm::create(device, WTF::move(hashSalts), constraints, pageIdentifier);
    }
    CaptureDeviceManager& audioCaptureDeviceManager() final
    {
        static NeverDestroyed<DeviceManager> manager { microphoneDevice() };
        return manager;
    }
    const Vector<CaptureDevice>& speakerDevices() const final
    {
        static NeverDestroyed<Vector<CaptureDevice>> devices;
        return devices;
    }
};

class VideoFactory final : public VideoCaptureFactory {
    CaptureSourceOrError createVideoCaptureSource(const CaptureDevice& device, MediaDeviceHashSalts&& hashSalts, const MediaConstraints* constraints, std::optional<PageIdentifier> pageIdentifier) final
    {
        return VideoCaptureSourceWasm::create(device, WTF::move(hashSalts), constraints, pageIdentifier);
    }
    CaptureDeviceManager& videoCaptureDeviceManager() final
    {
        static NeverDestroyed<DeviceManager> manager { cameraDevice() };
        return manager;
    }
};

class DisplayFactory final : public DisplayCaptureFactory {
    CaptureSourceOrError createDisplayCaptureSource(const CaptureDevice& device, MediaDeviceHashSalts&& hashSalts, const MediaConstraints* constraints, std::optional<PageIdentifier> pageIdentifier) final
    {
        return VideoCaptureSourceWasm::create(device, WTF::move(hashSalts), constraints, pageIdentifier);
    }
    DisplayCaptureManager& displayCaptureDeviceManager() final
    {
        static NeverDestroyed<ScreenManager> manager;
        return manager;
    }
};

// ------------------------------------------------------------ Mikrofon fuer Web Audio

class AudioSourceProviderWasm final
    : public WebAudioSourceProvider
    , public MediaStreamTrackPrivateObserver
    , public RealtimeMediaSource::AudioSampleObserver
    , public CanMakeCheckedPtr<AudioSourceProviderWasm> {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(AudioSourceProviderWasm);
    WTF_OVERRIDE_DELETE_FOR_CHECKED_PTR(AudioSourceProviderWasm);
public:
    static Ref<AudioSourceProviderWasm> create(MediaStreamTrackPrivate& track) { return adoptRef(*new AudioSourceProviderWasm(track)); }

    ~AudioSourceProviderWasm()
    {
        m_source->removeAudioSampleObserver(*this);
    }

    void ref() const final { WebAudioSourceProvider::ref(); }
    void deref() const final { WebAudioSourceProvider::deref(); }

private:
    explicit AudioSourceProviderWasm(MediaStreamTrackPrivate& track)
        : m_track(track)
        , m_source(track.source())
    {
    }

    uint32_t checkedPtrCount() const final { return CanMakeCheckedPtr::checkedPtrCount(); }
    uint32_t checkedPtrCountWithoutThreadCheck() const final { return CanMakeCheckedPtr::checkedPtrCountWithoutThreadCheck(); }
    void incrementCheckedPtrCount() const final { CanMakeCheckedPtr::incrementCheckedPtrCount(); }
    void decrementCheckedPtrCount() const final { CanMakeCheckedPtr::decrementCheckedPtrCount(); }
    void setDidBeginCheckedPtrDeletion() final { CanMakeCheckedPtr::setDidBeginCheckedPtrDeletion(); }

    void setClient(WeakPtr<AudioSourceProviderClient>&& client) final
    {
        if (m_client == client)
            return;
        m_client = WTF::move(client);
        bool connect = !!m_client;
        if (connect == m_connected)
            return;
        m_connected = connect;
        if (!connect) {
            if (RefPtr track = m_track.get())
                track->removeObserver(*this);
            m_source->removeAudioSampleObserver(*this);
            return;
        }
        if (RefPtr track = m_track.get()) {
            m_enabled = track->enabled();
            track->addObserver(*this);
        }
        m_source->addAudioSampleObserver(*this);
    }

    // Audio-Thread: so viel nehmen wie da ist, der Rest bleibt still
    void provideInput(AudioBus& bus, size_t frames) final
    {
        if (!m_lock.tryLock()) {
            bus.zero();
            return;
        }
        Locker locker { AdoptLock, m_lock };
        if (!m_channels || !m_enabled) {
            bus.zero();
            return;
        }
        size_t available = m_written - m_read;
        size_t count = std::min(frames, available);
        size_t capacity = m_ring[0].size();
        for (unsigned index = 0; index < bus.numberOfChannels(); ++index) {
            auto target = bus.channel(index)->mutableSpan();
            auto& ring = m_ring[std::min<unsigned>(index, m_channels - 1)];
            for (size_t frame = 0; frame < count; ++frame)
                target[frame] = ring[(m_read + frame) % capacity];
            for (size_t frame = count; frame < frames && frame < target.size(); ++frame)
                target[frame] = 0;
        }
        m_read += count;
    }

    void audioSamplesAvailable(const MediaTime&, const PlatformAudioData& data, const AudioStreamDescription& description, size_t frames) final
    {
        if (!m_enabled || description.platformDescription().type != PlatformDescription::None || data.kind() != PlatformAudioData::Kind::None)
            return;
        auto& audio = static_cast<const WasmAudioData&>(data);
        Locker locker { m_lock };
        unsigned channels = audio.channels();
        double sampleRate = description.sampleRate();
        if (channels != m_channels || sampleRate != m_sampleRate) {
            m_channels = channels;
            m_sampleRate = sampleRate;
            m_ring.clear();
            for (unsigned index = 0; index < channels; ++index) {
                Vector<float> ring;
                ring.fill(0.0f, static_cast<size_t>(sampleRate));
                m_ring.append(WTF::move(ring));
            }
            m_written = 0;
            m_read = 0;
            callOnMainThread([protectedThis = Ref { *this }, channels, sampleRate] {
                if (RefPtr client = protectedThis->m_client.get())
                    client->setFormat(channels, sampleRate);
            });
        }
        size_t capacity = m_ring[0].size();
        for (unsigned index = 0; index < channels; ++index) {
            auto samples = audio.channel(index);
            auto& ring = m_ring[index];
            for (size_t frame = 0; frame < frames; ++frame)
                ring[(m_written + frame) % capacity] = samples[frame];
        }
        m_written += frames;
        // Hoechstens 0.2 s Verzoegerung: aeltere Samples fallen weg
        size_t maximum = static_cast<size_t>(sampleRate / 5);
        if (m_written - m_read > maximum)
            m_read = m_written - maximum;
    }

    void trackEnded(MediaStreamTrackPrivate&) final { }
    void trackMutedChanged(MediaStreamTrackPrivate&) final { }
    void trackSettingsChanged(MediaStreamTrackPrivate&) final { }
    void trackEnabledChanged(MediaStreamTrackPrivate& track) final { m_enabled = track.enabled(); }

    WeakPtr<MediaStreamTrackPrivate> m_track;
    const Ref<RealtimeMediaSource> m_source;
    WeakPtr<AudioSourceProviderClient> m_client;
    bool m_connected { false };
    std::atomic<bool> m_enabled { true };
    Lock m_lock;
    Vector<Vector<float>> m_ring WTF_GUARDED_BY_LOCK(m_lock);
    unsigned m_channels WTF_GUARDED_BY_LOCK(m_lock) { 0 };
    double m_sampleRate WTF_GUARDED_BY_LOCK(m_lock) { 0 };
    uint64_t m_written WTF_GUARDED_BY_LOCK(m_lock) { 0 };
    uint64_t m_read WTF_GUARDED_BY_LOCK(m_lock) { 0 };
};

// ------------------------------------------------------------ Berechtigung (wie Chrome)

MediaDeviceHashSalts saltsFor(const String& origin)
{
    // Pro Ursprung gleich, solange die Engine laeuft (stabile deviceId wie in Chrome)
    static NeverDestroyed<HashMap<String, String>> salts;
    auto salt = salts->ensure(origin, [] {
        return makeString(cryptographicallyRandomNumber<uint64_t>(), '-', cryptographicallyRandomNumber<uint64_t>());
    }).iterator->value;
    return { salt, salt };
}

class UserMediaClientWasm final : public UserMediaClient, public RefCounted<UserMediaClientWasm> {
public:
    static Ref<UserMediaClientWasm> create(int viewId) { return adoptRef(*new UserMediaClientWasm(viewId)); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    explicit UserMediaClientWasm(int viewId)
        : m_viewId(viewId)
    {
    }

    void requestUserMediaAccess(UserMediaRequest& request) final
    {
        RefPtr origin = request.topLevelDocumentOrigin();
        String originString = origin ? origin->toString() : String { };
        RealtimeMediaSourceCenter::singleton().validateRequestConstraints([viewId = m_viewId, request = Ref { request }, originString](Expected<RealtimeMediaSourceCenter::ValidDevices, MediaConstraintType>&& result) mutable {
            if (!result) {
                request->deny(MediaAccessDenialReason::InvalidConstraint, emptyString(), result.error());
                return;
            }
            auto audio = result->audioDevices.isEmpty() ? CaptureDevice { } : result->audioDevices[0];
            auto video = result->videoDevices.isEmpty() ? CaptureDevice { } : result->videoDevices[0];
            if (!audio && !video) {
                request->deny(MediaAccessDenialReason::NoCaptureDevices);
                return;
            }
            auto allow = [request, audio, video, originString](bool granted) mutable {
                if (!granted) {
                    request->deny(MediaAccessDenialReason::PermissionDenied);
                    return;
                }
                request->allow(WTF::move(audio), WTF::move(video), saltsFor(originString), [] { });
            };
            // Bildschirm: Chrome zeigt seine eigene Auswahl, dort entscheidet man
            if (request->request().type != MediaStreamRequest::Type::UserMedia) {
                allow(true);
                return;
            }
            String kind = audio && video ? "camera-microphone"_s : video ? "camera"_s : "microphone"_s;
            if (audio && video) {
                auto camera = storedPermission("camera"_s, originString);
                auto microphone = storedPermission("microphone"_s, originString);
                if (camera == PermissionDecision::Denied || microphone == PermissionDecision::Denied) {
                    allow(false);
                    return;
                }
                if (camera == PermissionDecision::Granted && microphone == PermissionDecision::Granted) {
                    allow(true);
                    return;
                }
            }
            requestDevicePermission(viewId, kind, originString, [allow = WTF::move(allow), kind, originString](bool granted) mutable {
                if (kind == "camera-microphone"_s) {
                    auto decision = granted ? PermissionDecision::Granted : PermissionDecision::Denied;
                    setStoredPermission("camera"_s, originString, decision);
                    setStoredPermission("microphone"_s, originString, decision);
                }
                allow(granted);
            });
        }, request.request(), saltsFor(originString));
    }

    void cancelUserMediaAccessRequest(UserMediaRequest&) final { }

    void enumerateMediaDevices(Document& document, EnumerateDevicesCallback&& callback) final
    {
        String origin = document.topOrigin().toString();
        RealtimeMediaSourceCenter::singleton().getMediaStreamDevices([callback = WTF::move(callback), origin](Vector<CaptureDevice>&& devices) mutable {
            Vector<CaptureDeviceWithCapabilities> result;
            for (auto& device : devices) {
                bool isCamera = device.type() == CaptureDevice::DeviceType::Camera;
                if (!isCamera && device.type() != CaptureDevice::DeviceType::Microphone)
                    continue;
                // Wie Chrome: Namen erst, wenn die Seite das Geraet benutzen darf
                auto copy = device;
                if (storedPermission(isCamera ? "camera"_s : "microphone"_s, origin) != PermissionDecision::Granted)
                    copy.setLabel(emptyString());
                result.append({ WTF::move(copy), { } });
            }
            callback(WTF::move(result), saltsFor(origin));
        });
    }

    DeviceChangeObserverToken addDeviceChangeObserver(Function<void()>&&) final { return DeviceChangeObserverToken::generate(); }
    void removeDeviceChangeObserver(DeviceChangeObserverToken) final { }

    // Die Anzeige im Tab kommt ueber ChromeClient::isPlayingMediaDidChange
    void updateCaptureState(const Document&, bool, MediaProducerMediaCaptureKind, CompletionHandler<void(std::optional<Exception>&&)>&& completionHandler) final
    {
        completionHandler({ });
    }

    void setShouldListenToVoiceActivity(bool) final { }

    const int m_viewId;
};

} // namespace

// ------------------------------------------------------------ <video>.srcObject

Ref<MediaStreamPlayback> MediaStreamPlayback::create(MediaPlayerPrivateWasm& player, MediaStreamPrivate& stream)
{
    Ref playback = adoptRef(*new MediaStreamPlayback(player, stream));
    stream.addObserver(playback.get());
    playback->updateVideoTrack();
    return playback;
}

MediaStreamPlayback::MediaStreamPlayback(MediaPlayerPrivateWasm& player, MediaStreamPrivate& stream)
    : m_player(player)
    , m_stream(stream)
{
}

MediaStreamPlayback::~MediaStreamPlayback()
{
    stop();
}

void MediaStreamPlayback::stop()
{
    if (m_stopped)
        return;
    m_stopped = true;
    m_stream->removeObserver(*this);
    if (RefPtr source = std::exchange(m_videoSource, nullptr))
        source->removeVideoFrameObserver(*this);
}

void MediaStreamPlayback::updateVideoTrack()
{
    if (m_stopped)
        return;
    RefPtr track = m_stream->activeVideoTrack();
    RefPtr<RealtimeMediaSource> source = track ? &track->source() : nullptr;
    if (source == m_videoSource)
        return;
    if (m_videoSource)
        m_videoSource->removeVideoFrameObserver(*this);
    m_videoSource = source;
    if (m_videoSource)
        m_videoSource->addVideoFrameObserver(*this);
    if (RefPtr player = m_player.get())
        player->streamChanged();
}

void MediaStreamPlayback::characteristicsChanged()
{
    updateVideoTrack();
    if (RefPtr player = m_player.get())
        player->streamChanged();
}

void MediaStreamPlayback::activeStatusChanged()
{
    if (RefPtr player = m_player.get())
        player->streamChanged();
}

void MediaStreamPlayback::videoFrameAvailable(VideoFrame& frame, VideoFrameTimeMetadata)
{
    {
        Locker locker { m_frameLock };
        m_frame = &frame;
    }
    ensureOnMainThread([weakPlayer = m_player] {
        if (RefPtr player = weakPlayer.get())
            player->streamFrameAvailable();
    });
}

RefPtr<VideoFrame> MediaStreamPlayback::currentFrame() const
{
    Locker locker { m_frameLock };
    return m_frame;
}

namespace MediaStreams {

void enableIn(Settings& settings)
{
    settings.setMediaDevicesEnabled(true);
    settings.setScreenCaptureEnabled(true);
    settings.setGetUserMediaRequiresFocus(false);
}

void attachTo(int viewId, Page& page)
{
    provideUserMediaTo(&page, UserMediaClientWasm::create(viewId));
}

} // namespace MediaStreams

} // namespace BrowserLite

// Teile von WebCore, die jede Plattform selber liefert (Patch 0027)
namespace WebCore {

AudioCaptureFactory& RealtimeMediaSourceCenter::defaultAudioCaptureFactory()
{
    static NeverDestroyed<BrowserLite::AudioFactory> factory;
    return factory;
}

VideoCaptureFactory& RealtimeMediaSourceCenter::defaultVideoCaptureFactory()
{
    static NeverDestroyed<BrowserLite::VideoFactory> factory;
    return factory;
}

DisplayCaptureFactory& RealtimeMediaSourceCenter::defaultDisplayCaptureFactory()
{
    static NeverDestroyed<BrowserLite::DisplayFactory> factory;
    return factory;
}

CaptureSourceOrError MockRealtimeAudioSource::create(String&&, AtomString&&, MediaDeviceHashSalts&&, const MediaConstraints*, std::optional<PageIdentifier>)
{
    return CaptureSourceOrError(CaptureSourceError { "Mock capture devices are not supported"_s, MediaAccessDenialReason::HardwareError });
}

CaptureSourceOrError MockRealtimeVideoSource::create(String&&, AtomString&&, MediaDeviceHashSalts&&, const MediaConstraints*, std::optional<PageIdentifier>)
{
    return CaptureSourceOrError(CaptureSourceError { "Mock capture devices are not supported"_s, MediaAccessDenialReason::HardwareError });
}

RefPtr<WebAudioSourceProvider> createMediaStreamTrackAudioSourceProviderWasm(MediaStreamTrackPrivate& track)
{
    return BrowserLite::AudioSourceProviderWasm::create(track);
}

} // namespace WebCore

// Bilder und Ton vom Host (engine/js/webcodecs-host.js, blCapture), Engine-Thread
extern "C" {

EMSCRIPTEN_KEEPALIVE void bl_capture_video(int id, uint8_t* data, int size, int format, int width, int height, double timestamp)
{
    auto* source = BrowserLite::videoSources().get(id);
    if (!source || format < 0 || format > static_cast<int>(WebCore::VideoPixelFormat::BGRX)) {
        std::free(data);
        return;
    }
    auto frame = BrowserLite::VideoFrameWasm::adopt(static_cast<WebCore::VideoPixelFormat>(format), width, height, data, size, MediaTime(static_cast<int64_t>(timestamp), 1000000),
        { WebCore::PlatformVideoColorPrimaries::Bt709, WebCore::PlatformVideoTransferCharacteristics::Bt709, WebCore::PlatformVideoMatrixCoefficients::Bt709, false });
    if (frame)
        Ref { *source }->deliver(frame.releaseNonNull());
}

EMSCRIPTEN_KEEPALIVE void bl_capture_audio(int id, float* samples, int frames, int channels, double sampleRate, double timestamp)
{
    if (auto* source = BrowserLite::audioSources().get(id))
        Ref { *source }->deliver(samples, frames, channels, sampleRate, timestamp);
}

// Von der Oberflaeche (Haupt-Thread): Host-Kamera verweigert oder beendet
EMSCRIPTEN_KEEPALIVE void bl_capture_failed(int id)
{
    BrowserLite::runOnEngineThread([id] {
        if (auto* source = BrowserLite::videoSources().get(id))
            Ref { *source }->hostFailed();
        else if (auto* source = BrowserLite::audioSources().get(id))
            Ref { *source }->hostFailed();
    });
}

EMSCRIPTEN_KEEPALIVE void bl_capture_ended(int id)
{
    BrowserLite::runOnEngineThread([id] {
        if (auto* source = BrowserLite::videoSources().get(id))
            Ref { *source }->hostEnded();
        else if (auto* source = BrowserLite::audioSources().get(id))
            Ref { *source }->hostEnded();
    });
}

} // extern "C"
