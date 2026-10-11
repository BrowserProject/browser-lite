#include "config.h"
#include "ContainerParser.h"

#include <cstring>
#include <wtf/StdLibExtras.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/StringBuilder.h>

namespace BrowserLite {

namespace {

uint32_t be32(std::span<const uint8_t> data, size_t offset)
{
    return (uint32_t { data[offset] } << 24) | (uint32_t { data[offset + 1] } << 16) | (uint32_t { data[offset + 2] } << 8) | data[offset + 3];
}

uint64_t be64(std::span<const uint8_t> data, size_t offset)
{
    return (uint64_t { be32(data, offset) } << 32) | be32(data, offset + 4);
}

uint32_t fourcc(const char* code)
{
    return (uint32_t(uint8_t(code[0])) << 24) | (uint32_t(uint8_t(code[1])) << 16) | (uint32_t(uint8_t(code[2])) << 8) | uint8_t(code[3]);
}

String fourccString(uint32_t value)
{
    std::array<char, 4> chars { char(value >> 24), char(value >> 16), char(value >> 8), char(value) };
    return String { std::span<const char> { chars } }.trim([](char16_t c) { return c == ' ' || !c; });
}

// Daten sammeln und von vorne verbrauchen
class InputBuffer {
public:
    void append(std::span<const uint8_t> data) { m_data.append(data); }
    std::span<const uint8_t> span() const { return m_data.span().subspan(m_offset); }
    size_t size() const { return m_data.size() - m_offset; }
    void consume(size_t count)
    {
        m_offset += count;
        if (m_offset > 1024 * 1024 || m_offset == m_data.size()) {
            m_data.removeAt(0, m_offset);
            m_offset = 0;
        }
    }
    void clear()
    {
        m_data.clear();
        m_offset = 0;
    }

private:
    Vector<uint8_t> m_data;
    size_t m_offset { 0 };
};

// ------------------------------------------------------------- fragmentiertes MP4

class Mp4Parser final : public ContainerParser {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(Mp4Parser);
public:
    bool append(std::span<const uint8_t> data, Client& client) final
    {
        m_input.append(data);
        while (true) {
            if (m_skip) {
                auto count = std::min<uint64_t>(m_skip, m_input.size());
                m_input.consume(count);
                m_skip -= count;
                if (m_skip)
                    return true;
            }
            auto input = m_input.span();
            if (input.size() < 8)
                return true;
            uint64_t size = be32(input, 0);
            uint32_t type = be32(input, 4);
            size_t header = 8;
            if (size == 1) {
                if (input.size() < 16)
                    return true;
                size = be64(input, 8);
                header = 16;
            } else if (!size)
                size = std::numeric_limits<uint64_t>::max(); // bis zum Ende
            if (size < header)
                return false;
            if (type != fourcc("moov") && type != fourcc("moof")) {
                // mdat, ftyp, styp, sidx, emsg, ...: brauchen wir nicht
                m_input.consume(header);
                m_skip = size == std::numeric_limits<uint64_t>::max() ? size : size - header;
                continue;
            }
            if (size > 64 * 1024 * 1024)
                return false;
            if (input.size() < size)
                return true;
            auto body = input.subspan(header, size - header);
            bool ok = type == fourcc("moov") ? parseMoov(body, client) : parseMoof(body, client);
            m_input.consume(size);
            if (!ok)
                return false;
        }
    }

    void reset() final
    {
        m_input.clear();
        m_skip = 0;
    }

private:
    struct Track {
        ParsedTrack info;
        uint32_t timescale { 1000 };
        uint32_t defaultDuration { 0 };
        uint32_t defaultSize { 0 };
        uint32_t defaultFlags { 0 };
        uint64_t nextDecodeTime { 0 };
    };

    // Kinder einer Box aufzaehlen
    template<typename Callback>
    static bool forEachBox(std::span<const uint8_t> data, Callback&& callback)
    {
        size_t offset = 0;
        while (offset + 8 <= data.size()) {
            uint64_t size = be32(data, offset);
            uint32_t type = be32(data, offset + 4);
            size_t header = 8;
            if (size == 1) {
                if (offset + 16 > data.size())
                    return false;
                size = be64(data, offset + 8);
                header = 16;
            } else if (!size)
                size = data.size() - offset;
            if (size < header || size > data.size() - offset)
                return false;
            if (!callback(type, data.subspan(offset + header, size - header)))
                return false;
            offset += size;
        }
        return true;
    }

    Track* track(uint64_t id)
    {
        for (auto& track : m_tracks) {
            if (track.info.id == id)
                return &track;
        }
        return nullptr;
    }

    bool parseMoov(std::span<const uint8_t> moov, Client& client)
    {
        Vector<Track> tracks;
        uint32_t movieTimescale = 1000;
        uint64_t movieDuration = 0;
        uint64_t fragmentDuration = 0;
        bool ok = forEachBox(moov, [&](uint32_t type, std::span<const uint8_t> box) {
            if (type == fourcc("mvhd") && box.size() >= 32) {
                bool v1 = box[0] == 1;
                movieTimescale = be32(box, v1 ? 20 : 12);
                movieDuration = v1 ? be64(box, 24) : be32(box, 16);
            } else if (type == fourcc("trak")) {
                Track track;
                if (!parseTrak(box, track))
                    return false;
                tracks.append(WTF::move(track));
            } else if (type == fourcc("mvex")) {
                return forEachBox(box, [&](uint32_t type, std::span<const uint8_t> box) {
                    if (type == fourcc("mehd") && box.size() >= 8)
                        fragmentDuration = box[0] == 1 && box.size() >= 12 ? be64(box, 4) : be32(box, 4);
                    else if (type == fourcc("trex") && box.size() >= 24) {
                        uint32_t id = be32(box, 4);
                        for (auto& track : tracks) {
                            if (track.info.id == id) {
                                track.defaultDuration = be32(box, 12);
                                track.defaultSize = be32(box, 16);
                                track.defaultFlags = be32(box, 20);
                            }
                        }
                    }
                    return true;
                });
            }
            return true;
        });
        if (!ok)
            return false;

        // Bei einem neuen Init-Segment (andere Qualitaet) die Zeiten behalten
        for (auto& track : tracks) {
            if (auto* old = this->track(track.info.id))
                track.nextDecodeTime = old->nextDecodeTime;
        }
        m_tracks = WTF::move(tracks);

        ParsedInitSegment segment;
        uint64_t duration = fragmentDuration ? fragmentDuration : movieDuration;
        if (duration && movieTimescale && duration != std::numeric_limits<uint32_t>::max() && duration != std::numeric_limits<uint64_t>::max())
            segment.duration = MediaTime(static_cast<int64_t>(duration), movieTimescale);
        for (auto& track : m_tracks) {
            if (track.info.isVideo || track.info.isAudio)
                segment.tracks.append(track.info);
        }
        client.initSegment(WTF::move(segment));
        return true;
    }

    static bool parseTrak(std::span<const uint8_t> trak, Track& track)
    {
        return forEachBox(trak, [&](uint32_t type, std::span<const uint8_t> box) {
            if (type == fourcc("tkhd") && box.size() >= 84) {
                bool v1 = box[0] == 1;
                track.info.id = be32(box, v1 ? 20 : 12);
                size_t sizeOffset = v1 ? 88 : 76;
                if (box.size() >= sizeOffset + 8) {
                    track.info.width = be32(box, sizeOffset) >> 16;
                    track.info.height = be32(box, sizeOffset + 4) >> 16;
                }
            } else if (type == fourcc("mdia")) {
                return forEachBox(box, [&](uint32_t type, std::span<const uint8_t> box) {
                    if (type == fourcc("mdhd") && box.size() >= 24) {
                        bool v1 = box[0] == 1;
                        track.timescale = be32(box, v1 ? 20 : 12);
                    } else if (type == fourcc("hdlr") && box.size() >= 12) {
                        uint32_t handler = be32(box, 8);
                        track.info.isVideo = handler == fourcc("vide");
                        track.info.isAudio = handler == fourcc("soun");
                    } else if (type == fourcc("minf")) {
                        return forEachBox(box, [&](uint32_t type, std::span<const uint8_t> box) {
                            if (type != fourcc("stbl"))
                                return true;
                            return forEachBox(box, [&](uint32_t type, std::span<const uint8_t> box) {
                                // Erster Eintrag in stsd: Codec (avc1, mp4a, vp09, ...)
                                if (type == fourcc("stsd") && box.size() >= 16)
                                    track.info.codec = fourccString(be32(box, 12));
                                return true;
                            });
                        });
                    }
                    return true;
                });
            }
            return true;
        });
    }

    bool parseMoof(std::span<const uint8_t> moof, Client& client)
    {
        return forEachBox(moof, [&](uint32_t type, std::span<const uint8_t> traf) {
            if (type != fourcc("traf"))
                return true;
            Track* current = nullptr;
            uint32_t defaultDuration = 0, defaultSize = 0, defaultFlags = 0;
            bool hasDefaultDuration = false, hasDefaultSize = false, hasDefaultFlags = false;
            std::optional<uint64_t> baseDecodeTime;
            return forEachBox(traf, [&](uint32_t type, std::span<const uint8_t> box) {
                if (type == fourcc("tfhd") && box.size() >= 8) {
                    uint32_t flags = be32(box, 0) & 0xffffff;
                    current = track(be32(box, 4));
                    size_t offset = 8;
                    if (flags & 0x1)
                        offset += 8;
                    if (flags & 0x2)
                        offset += 4;
                    if ((flags & 0x8) && offset + 4 <= box.size()) {
                        defaultDuration = be32(box, offset);
                        hasDefaultDuration = true;
                        offset += 4;
                    }
                    if ((flags & 0x10) && offset + 4 <= box.size()) {
                        defaultSize = be32(box, offset);
                        hasDefaultSize = true;
                        offset += 4;
                    }
                    if ((flags & 0x20) && offset + 4 <= box.size()) {
                        defaultFlags = be32(box, offset);
                        hasDefaultFlags = true;
                    }
                } else if (type == fourcc("tfdt") && box.size() >= 8) {
                    baseDecodeTime = box[0] == 1 && box.size() >= 12 ? be64(box, 4) : be32(box, 4);
                } else if (type == fourcc("trun") && current && box.size() >= 8) {
                    auto& track = *current;
                    uint32_t flags = be32(box, 0) & 0xffffff;
                    bool v1 = box[0] == 1;
                    uint32_t count = be32(box, 4);
                    size_t offset = 8;
                    if (flags & 0x1)
                        offset += 4;
                    std::optional<uint32_t> firstFlags;
                    if (flags & 0x4) {
                        if (offset + 4 > box.size())
                            return false;
                        firstFlags = be32(box, offset);
                        offset += 4;
                    }
                    uint64_t decodeTime = baseDecodeTime.value_or(track.nextDecodeTime);
                    baseDecodeTime = std::nullopt; // weitere trun machen weiter
                    for (uint32_t i = 0; i < count; ++i) {
                        uint32_t duration = hasDefaultDuration ? defaultDuration : track.defaultDuration;
                        uint32_t size = hasDefaultSize ? defaultSize : track.defaultSize;
                        uint32_t sampleFlags = hasDefaultFlags ? defaultFlags : track.defaultFlags;
                        int64_t compositionOffset = 0;
                        auto read = [&](uint32_t& value) {
                            if (offset + 4 > box.size())
                                return false;
                            value = be32(box, offset);
                            offset += 4;
                            return true;
                        };
                        if ((flags & 0x100) && !read(duration))
                            return false;
                        if ((flags & 0x200) && !read(size))
                            return false;
                        if ((flags & 0x400) && !read(sampleFlags))
                            return false;
                        if (!i && firstFlags)
                            sampleFlags = *firstFlags;
                        if (flags & 0x800) {
                            uint32_t value;
                            if (!read(value))
                                return false;
                            compositionOffset = v1 ? static_cast<int64_t>(static_cast<int32_t>(value)) : static_cast<int64_t>(value);
                        }
                        ParsedSample sample;
                        sample.trackId = track.info.id;
                        sample.decodeTime = MediaTime(static_cast<int64_t>(decodeTime), track.timescale);
                        sample.presentationTime = MediaTime(static_cast<int64_t>(decodeTime) + compositionOffset, track.timescale);
                        sample.duration = MediaTime(duration, track.timescale);
                        sample.size = size;
                        // sample_is_non_sync_sample (Bit 16); Ton ist immer sync
                        sample.isSync = track.info.isAudio || !(sampleFlags & 0x10000);
                        if (track.info.isVideo || track.info.isAudio)
                            client.sample(WTF::move(sample));
                        decodeTime += duration;
                    }
                    track.nextDecodeTime = decodeTime;
                }
                return true;
            });
        });
    }

    InputBuffer m_input;
    uint64_t m_skip { 0 };
    Vector<Track> m_tracks;
};

// ------------------------------------------------------------------ WebM

constexpr uint32_t idSegment = 0x18538067;
constexpr uint32_t idInfo = 0x1549A966;
constexpr uint32_t idTimecodeScale = 0x2AD7B1;
constexpr uint32_t idDuration = 0x4489;
constexpr uint32_t idTracks = 0x1654AE6B;
constexpr uint32_t idTrackEntry = 0xAE;
constexpr uint32_t idTrackNumber = 0xD7;
constexpr uint32_t idTrackType = 0x83;
constexpr uint32_t idCodecID = 0x86;
constexpr uint32_t idDefaultDuration = 0x23E383;
constexpr uint32_t idVideo = 0xE0;
constexpr uint32_t idPixelWidth = 0xB0;
constexpr uint32_t idPixelHeight = 0xBA;
constexpr uint32_t idCluster = 0x1F43B675;
constexpr uint32_t idTimecode = 0xE7;
constexpr uint32_t idSimpleBlock = 0xA3;
constexpr uint32_t idBlockGroup = 0xA0;
constexpr uint32_t idBlock = 0xA1;
constexpr uint32_t idBlockDuration = 0x9B;
constexpr uint32_t idReferenceBlock = 0xFB;

class WebMParser final : public ContainerParser {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(WebMParser);
public:
    bool append(std::span<const uint8_t> data, Client& client) final
    {
        m_input.append(data);
        bool ok = parse(client);
        // Am Ende jedes Stuecks: Init-Segment melden und gesammelte Samples abgeben
        emitInitIfNeeded(client);
        if (m_group.active && m_position >= m_group.end)
            finishGroup(client);
        for (auto& track : m_tracks)
            flushPending(track, client, std::nullopt);
        return ok;
    }

    void reset() final
    {
        m_input.clear();
        m_skip = 0;
        m_group = { };
    }

private:
    struct Track {
        ParsedTrack info;
        MediaTime defaultDuration { MediaTime::invalidTime() };
        MediaTime lastDelta { MediaTime::invalidTime() };
        std::optional<ParsedSample> pending;
        bool pendingHasDuration { false };
    };

    struct Group {
        bool active { false };
        uint64_t end { 0 };
        Vector<uint8_t> block;
        std::optional<uint64_t> duration;
        bool hasReference { false };
    };

    // EBML-Zahl mit Laengen-Markierung. keepMarker: fuer IDs
    static std::optional<std::pair<uint64_t, size_t>> readVint(std::span<const uint8_t> data, size_t offset, bool keepMarker, size_t maxLength)
    {
        if (offset >= data.size())
            return std::nullopt;
        uint8_t first = data[offset];
        size_t length = 1;
        while (length <= maxLength && !(first & (0x80 >> (length - 1))))
            ++length;
        if (length > maxLength || offset + length > data.size())
            return std::nullopt;
        uint64_t value = keepMarker ? first : (first & ((0x80 >> (length - 1)) - 1));
        bool allOnes = value == ((0x80u >> (length - 1)) - 1);
        for (size_t i = 1; i < length; ++i) {
            value = (value << 8) | data[offset + i];
            allOnes = allOnes && data[offset + i] == 0xff;
        }
        if (!keepMarker && allOnes)
            value = std::numeric_limits<uint64_t>::max(); // unbekannte Groesse
        return std::make_pair(value, length);
    }

    static uint64_t readUnsigned(std::span<const uint8_t> data)
    {
        uint64_t value = 0;
        for (auto byte : data.first(std::min<size_t>(data.size(), 8)))
            value = (value << 8) | byte;
        return value;
    }

    static double readFloat(std::span<const uint8_t> data)
    {
        if (data.size() == 4) {
            uint32_t bits = static_cast<uint32_t>(readUnsigned(data));
            float value;
            memcpy(&value, &bits, 4);
            return value;
        }
        if (data.size() == 8) {
            uint64_t bits = readUnsigned(data);
            double value;
            memcpy(&value, &bits, 8);
            return value;
        }
        return 0;
    }

    static bool isMaster(uint32_t id)
    {
        return id == idSegment || id == idInfo || id == idTracks || id == idTrackEntry || id == idVideo || id == idCluster || id == idBlockGroup;
    }

    static bool isLeafWeNeed(uint32_t id)
    {
        switch (id) {
        case idTimecodeScale: case idDuration: case idTrackNumber: case idTrackType: case idCodecID:
        case idDefaultDuration: case idPixelWidth: case idPixelHeight: case idTimecode: case idSimpleBlock:
        case idBlock: case idBlockDuration: case idReferenceBlock:
            return true;
        default:
            return false;
        }
    }

    bool parse(Client& client)
    {
        while (true) {
            if (m_skip) {
                auto count = std::min<uint64_t>(m_skip, m_input.size());
                m_input.consume(count);
                m_position += count;
                m_skip -= count;
                if (m_skip)
                    return true;
            }
            if (m_group.active && m_position >= m_group.end)
                finishGroup(client);

            auto input = m_input.span();
            auto id = readVint(input, 0, true, 4);
            if (!id)
                return true;
            auto size = readVint(input, id->second, false, 8);
            if (!size)
                return true;
            uint32_t elementId = static_cast<uint32_t>(id->first);
            size_t header = id->second + size->second;
            uint64_t elementSize = size->first;

            if (isMaster(elementId)) {
                m_input.consume(header);
                m_position += header;
                startMaster(elementId, elementSize, client);
                continue;
            }
            if (elementSize == std::numeric_limits<uint64_t>::max())
                return false;
            if (!isLeafWeNeed(elementId)) {
                m_input.consume(header);
                m_position += header;
                m_skip = elementSize;
                continue;
            }
            if (elementSize > 64 * 1024 * 1024)
                return false;
            if (input.size() < header + elementSize)
                return true;
            leaf(elementId, input.subspan(header, elementSize), client);
            m_input.consume(header + elementSize);
            m_position += header + elementSize;
        }
    }

    void startMaster(uint32_t id, uint64_t size, Client& client)
    {
        switch (id) {
        case idTracks:
            m_newTracks.clear();
            m_tracksDirty = true;
            m_tracksEnd = size == std::numeric_limits<uint64_t>::max() ? 0 : m_position + size;
            break;
        case idTrackEntry:
            m_newTracks.append({ });
            break;
        case idCluster:
            m_tracksEnd = 0;
            emitInitIfNeeded(client);
            break;
        case idBlockGroup:
            if (m_group.active)
                finishGroup(client);
            m_group = { };
            m_group.active = true;
            m_group.end = size == std::numeric_limits<uint64_t>::max() ? std::numeric_limits<uint64_t>::max() : m_position + size;
            break;
        default:
            break;
        }
    }

    void leaf(uint32_t id, std::span<const uint8_t> data, Client& client)
    {
        Track* entry = m_newTracks.isEmpty() ? nullptr : &m_newTracks.last();
        switch (id) {
        case idTimecodeScale:
            m_timecodeScale = std::max<uint64_t>(1, readUnsigned(data));
            break;
        case idDuration:
            m_duration = readFloat(data);
            break;
        case idTrackNumber:
            if (entry)
                entry->info.id = readUnsigned(data);
            break;
        case idTrackType:
            if (entry) {
                auto type = readUnsigned(data);
                entry->info.isVideo = type == 1;
                entry->info.isAudio = type == 2;
            }
            break;
        case idCodecID:
            if (entry)
                entry->info.codec = codecName(String { std::span<const char> { reinterpret_cast<const char*>(data.data()), data.size() } });
            break;
        case idDefaultDuration:
            if (entry)
                entry->defaultDuration = MediaTime(static_cast<int64_t>(readUnsigned(data)), 1000000000);
            break;
        case idPixelWidth:
            if (entry)
                entry->info.width = readUnsigned(data);
            break;
        case idPixelHeight:
            if (entry)
                entry->info.height = readUnsigned(data);
            break;
        case idTimecode:
            m_clusterTimecode = readUnsigned(data);
            break;
        case idSimpleBlock:
            block(data, (data.size() > 3 && blockFlags(data) & 0x80), std::nullopt, client);
            break;
        case idBlock:
            if (m_group.active)
                m_group.block = Vector<uint8_t> { data };
            break;
        case idBlockDuration:
            if (m_group.active)
                m_group.duration = readUnsigned(data);
            break;
        case idReferenceBlock:
            if (m_group.active)
                m_group.hasReference = true;
            break;
        default:
            break;
        }
    }

    static String codecName(const String& codecId)
    {
        if (codecId == "V_VP8"_s)
            return "vp8"_s;
        if (codecId == "V_VP9"_s)
            return "vp9"_s;
        if (codecId == "V_AV1"_s)
            return "av01"_s;
        if (codecId == "V_MPEG4/ISO/AVC"_s)
            return "avc1"_s;
        if (codecId == "A_OPUS"_s)
            return "opus"_s;
        if (codecId == "A_VORBIS"_s)
            return "vorbis"_s;
        if (codecId.startsWith("A_AAC"_s))
            return "mp4a"_s;
        return codecId.convertToASCIILowercase();
    }

    static uint8_t blockFlags(std::span<const uint8_t> data)
    {
        auto track = readVint(data, 0, false, 8);
        size_t offset = track ? track->second + 2 : 3;
        return offset < data.size() ? data[offset] : 0;
    }

    void finishGroup(Client& client)
    {
        auto group = std::exchange(m_group, { });
        if (group.block.isEmpty())
            return;
        block(group.block.span(), !group.hasReference, group.duration, client);
    }

    void emitInitIfNeeded(Client& client)
    {
        // Erst wenn alle Spuren da sind
        if (!m_tracksDirty || m_newTracks.isEmpty() || m_position < m_tracksEnd)
            return;
        m_tracksDirty = false;
        // Alte Zustaende (ausstehende Samples) zu gleicher Spur behalten
        for (auto& track : m_tracks)
            flushPending(track, client, std::nullopt);
        m_tracks = m_newTracks;
        ParsedInitSegment segment;
        if (m_duration > 0)
            segment.duration = MediaTime::createWithDouble(m_duration * m_timecodeScale / 1e9);
        for (auto& track : m_tracks) {
            if (track.info.isVideo || track.info.isAudio)
                segment.tracks.append(track.info);
        }
        client.initSegment(WTF::move(segment));
    }

    Track* track(uint64_t id)
    {
        for (auto& track : m_tracks) {
            if (track.info.id == id)
                return &track;
        }
        return nullptr;
    }

    void block(std::span<const uint8_t> data, bool keyframe, std::optional<uint64_t> duration, Client& client)
    {
        auto number = readVint(data, 0, false, 8);
        if (!number || data.size() < number->second + 3)
            return;
        auto* track = this->track(number->first);
        if (!track || !(track->info.isVideo || track->info.isAudio))
            return;
        size_t offset = number->second;
        int16_t relative = static_cast<int16_t>((data[offset] << 8) | data[offset + 1]);
        int64_t timecode = static_cast<int64_t>(m_clusterTimecode) + relative;
        auto time = MediaTime(timecode * static_cast<int64_t>(m_timecodeScale), 1000000000);

        ParsedSample sample;
        sample.trackId = track->info.id;
        sample.presentationTime = time;
        sample.decodeTime = time;
        sample.size = data.size();
        sample.isSync = track->info.isAudio || keyframe;
        bool hasDuration = duration.has_value();
        if (hasDuration)
            sample.duration = MediaTime(static_cast<int64_t>(*duration * m_timecodeScale), 1000000000);

        flushPending(*track, client, time);
        track->pending = WTF::move(sample);
        track->pendingHasDuration = hasDuration;
    }

    // Ausstehendes Sample abgeben. Dauer = Abstand zum naechsten Sample
    // (WebM speichert sie meist nicht), sonst eine Schaetzung.
    void flushPending(Track& track, Client& client, std::optional<MediaTime> nextTime)
    {
        if (!track.pending)
            return;
        auto sample = *std::exchange(track.pending, std::nullopt);
        if (!track.pendingHasDuration) {
            if (nextTime && *nextTime > sample.presentationTime)
                sample.duration = *nextTime - sample.presentationTime;
            else if (track.defaultDuration.isValid())
                sample.duration = track.defaultDuration;
            else if (track.lastDelta.isValid())
                sample.duration = track.lastDelta;
            else
                sample.duration = track.info.isAudio ? MediaTime(20, 1000) : MediaTime(1, 30);
            if (nextTime && *nextTime > sample.presentationTime)
                track.lastDelta = sample.duration;
        }
        client.sample(WTF::move(sample));
    }

    InputBuffer m_input;
    uint64_t m_position { 0 };
    uint64_t m_skip { 0 };
    uint64_t m_timecodeScale { 1000000 };
    double m_duration { 0 };
    uint64_t m_clusterTimecode { 0 };
    bool m_tracksDirty { false };
    uint64_t m_tracksEnd { 0 };
    Vector<Track> m_newTracks;
    Vector<Track> m_tracks;
    Group m_group;
};

} // namespace

std::unique_ptr<ContainerParser> ContainerParser::create(const String& mimeType)
{
    auto type = mimeType.convertToASCIILowercase();
    if (type == "video/mp4"_s || type == "audio/mp4"_s)
        return makeUnique<Mp4Parser>();
    if (type == "video/webm"_s || type == "audio/webm"_s)
        return makeUnique<WebMParser>();
    return nullptr;
}

} // namespace BrowserLite
