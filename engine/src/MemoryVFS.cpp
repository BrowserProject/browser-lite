// SQLite-Datenbanken unter /data im WASM-Speicher.
//
// SQLite schreibt jede WAL-Seite einzeln, mit seek davor: beim Laden von CNN
// waren das ca. 7000 Dateizugriffe nur fuer die Cookie-Datenbank. /data liegt im
// OPFS, jeder Zugriff ist ein Umweg ueber den Worker von WasmFS.
//
// Darum liegen Datenbank, -journal und -wal hier im Speicher (in Bloecken,
// Content), ebenso der gemeinsame Speicher (shm) fuer den WAL-Modus. Auf die
// Platte kommt nur die Datenbank, als Ganzes und mit allen bestaetigten Seiten
// aus dem WAL wie nach einem Checkpoint (writeFamily), ueber eine Kopie und ein
// rename (FileReplacement in Storage.h). Datenbank und WAL getrennt zu
// ersetzen waere nicht atomar: bricht es dazwischen ab, spielt SQLite ein
// altes WAL in eine neue Datenbank ein.
//
// Geschrieben wird, wenn gerade keine Schreib-Transaktion laeuft:
// - kurz nach einer Aenderung (flushDelay, eine grosse Datenbank seltener),
// - auf Anstoss der Oberflaeche (bl_storage_flush; beim Schliessen des Tabs
//   wartet sie darauf),
// - wenn die letzte Verbindung zu einer Datenbank schliesst. Danach wird alles
//   wieder von der Platte gelesen, so stimmt es auch, wenn WebKit die Dateien
//   selber loescht (z.B. indexedDB.deleteDatabase).
//
// Regel gegen Deadlocks: Dateizugriffe unter dem Lock einer Datenbank nur mit
// ioMutex.

#include "config.h"
#include "MemoryVFS.h"

#include "Engine.h"
#include "Storage.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <climits>
#include <cstdlib>
#include <cstring>
#include <emscripten/threading.h>
#include <fcntl.h>
#include <memory>
#include <mutex>
#include <optional>
#include <sqlite3.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <unordered_map>
#include <vector>
#include <wtf/FileSystem.h>
#include <wtf/MonotonicTime.h>
#include <wtf/RunLoop.h>
#include <wtf/text/WTFString.h>

namespace BrowserLite {

namespace {

constexpr char rootPrefix[] = "/data/";

// Groesste Datei im Speicher (BL_DATABASE_MAX_MB, Standard 512 MB). Groessere
// oeffnet das VFS nicht, statt sie zu laden: der WASM-Speicher hat hoechstens
// 4 GB fuer alles. IndexedDB hat eine kleinere Grenze pro Ursprung nur fuers
// Schreiben (Storage.cpp), das hier gilt auch beim Oeffnen und fuer alle anderen.
uint64_t maximumFileSize()
{
    static const uint64_t size = [] {
        const char* value = getenv("BL_DATABASE_MAX_MB");
        return (value && *value ? strtoull(value, nullptr, 10) : 512) << 20;
    }();
    return size;
}

// Inhalt einer Datei in Bloecken fester Groesse. Wachsen kopiert nichts um
// (ein std::vector braucht dabei alten und neuen Platz, mit der Verdoppelung
// bis zum Dreifachen der Datei), und fehlt Speicher, bekommt SQLite
// SQLITE_FULL statt die Engine einen Absturz.
class Content {
public:
    Content() = default;
    Content(Content&& other)
        : m_blocks(std::exchange(other.m_blocks, { }))
        , m_size(std::exchange(other.m_size, 0))
    {
    }
    Content& operator=(Content&& other)
    {
        resize(0);
        m_blocks = std::exchange(other.m_blocks, { });
        m_size = std::exchange(other.m_size, 0);
        return *this;
    }
    ~Content() { resize(0); }

    uint64_t size() const { return m_size; }

    // false: zu gross oder kein Speicher, dann bleibt alles wie es war
    bool resize(uint64_t size)
    {
        if (size > maximumFileSize())
            return false;
        size_t count = (size + blockSize - 1) / blockSize;
        size_t before = m_blocks.size();
        while (m_blocks.size() < count) {
            auto* block = static_cast<uint8_t*>(calloc(1, blockSize));
            if (!block) {
                while (m_blocks.size() > before) {
                    free(m_blocks.back());
                    m_blocks.pop_back();
                }
                return false;
            }
            m_blocks.push_back(block);
        }
        while (m_blocks.size() > count) {
            free(m_blocks.back());
            m_blocks.pop_back();
        }
        // Hinter dem Ende stehen immer Nullen: waechst die Datei wieder, liest
        // SQLite dort nichts Altes
        if (size < m_size && size % blockSize)
            memset(m_blocks.back() + size % blockSize, 0, blockSize - size % blockSize);
        m_size = size;
        return true;
    }

    bool write(const uint8_t* data, size_t length, uint64_t offset)
    {
        if (offset + length > m_size && !resize(offset + length))
            return false;
        forEach(offset, length, [&](uint8_t* block, size_t part) {
            memcpy(block, data, part);
            data += part;
        });
        return true;
    }

    // Liest hoechstens bis zum Ende, gibt die gelesene Laenge zurueck
    size_t read(uint8_t* data, size_t length, uint64_t offset) const
    {
        if (offset >= m_size)
            return 0;
        length = std::min<uint64_t>(length, m_size - offset);
        forEach(offset, length, [&](const uint8_t* block, size_t part) {
            memcpy(data, block, part);
            data += part;
        });
        return length;
    }

    // Die Stuecke von [offset, offset + length) der Reihe nach (innerhalb von
    // size()). Sie beginnen und enden an Vielfachen von 8, wenn offset und
    // length das tun
    template<typename Function>
    void forEach(uint64_t offset, uint64_t length, Function&& function) const
    {
        while (length) {
            size_t start = offset % blockSize;
            size_t part = std::min<uint64_t>(length, blockSize - start);
            function(m_blocks[offset / blockSize] + start, part);
            offset += part;
            length -= part;
        }
    }

private:
    static constexpr size_t blockSize = 64 << 10;
    std::vector<uint8_t*> m_blocks;
    uint64_t m_size { 0 };
};

struct Node {
    std::string path;
    Content content;
    bool loaded { false }; // Inhalt (bzw. "gibt es nicht") ist bekannt
    bool exists { false };
};

struct Family {
    std::string name; // Pfad der Datenbank
    std::mutex mutex;
    std::vector<std::unique_ptr<Node>> nodes; // Datenbank, -journal, -wal
    int openCount { 0 };
    bool dirty { false }; // seit dem letzten Schreiben geaendert
    // Eine grosse Datenbank nicht dauernd ganz neu schreiben (flushFamily)
    MonotonicTime nextWrite;
    // Locks auf der Datenbank (Rollback-Journal)
    int sharedCount { 0 };
    bool reserved { false };
    bool pending { false };
    bool exclusive { false };
    // Gemeinsamer Speicher fuer den WAL-Index
    std::vector<uint8_t*> shmRegions;
    int shmRefs { 0 };
    uint16_t shmShared[SQLITE_SHM_NLOCK] { };
    bool shmExclusive[SQLITE_SHM_NLOCK] { };

    Node* find(const std::string& path)
    {
        for (auto& node : nodes) {
            if (node->path == path)
                return node.get();
        }
        return nullptr;
    }

    Node& findOrCreate(const std::string& path)
    {
        if (auto* node = find(path))
            return *node;
        nodes.push_back(std::make_unique<Node>());
        nodes.back()->path = path;
        return *nodes.back();
    }

    bool writeLocked() const
    {
        if (reserved || pending || exclusive)
            return true;
        for (bool locked : shmExclusive) {
            if (locked)
                return true;
        }
        return false;
    }
};

struct MemoryFile {
    sqlite3_file base;
    Family* family;
    Node* node;
    int lockLevel;
    uint16_t shmSharedMask;
    uint16_t shmExclusiveMask;
    bool shmMapped;
};

sqlite3_vfs* baseVFS;
sqlite3_vfs memoryVFS;
std::mutex registryMutex;
std::unordered_map<std::string, std::shared_ptr<Family>>* families;
// Nur einer schreibt gleichzeitig ins Dateisystem
std::mutex ioMutex;

bool inMemoryDomain(const char* path)
{
    return path && !strncmp(path, rootPrefix, sizeof(rootPrefix) - 1);
}

bool endsWith(const std::string& text, const char* suffix)
{
    size_t length = strlen(suffix);
    return text.size() > length && !text.compare(text.size() - length, length, suffix);
}

// "x-journal" und "x-wal" gehoeren zur Datenbank "x"
std::string familyName(const std::string& path)
{
    if (endsWith(path, "-journal"))
        return path.substr(0, path.size() - 8);
    if (endsWith(path, "-wal"))
        return path.substr(0, path.size() - 4);
    return path;
}

std::shared_ptr<Family> findFamily(const std::string& name)
{
    std::lock_guard registryLock(registryMutex);
    auto it = families->find(name);
    return it == families->end() ? nullptr : it->second;
}

// ---------------------------------------------------------------- Schreiben

// Format des WAL: https://www.sqlite.org/fileformat2.html#walformat
constexpr uint64_t walHeaderSize = 32;
constexpr uint64_t walFrameHeaderSize = 24;

uint32_t get32(const uint8_t* data)
{
    return static_cast<uint32_t>(data[0]) << 24 | data[1] << 16 | data[2] << 8 | data[3];
}

// walChecksumBytes in wal.c, length ist ein Vielfaches von 8
void walChecksum(bool bigEndian, const uint8_t* data, size_t length, uint32_t sum[2])
{
    for (size_t i = 0; i < length; i += 8) {
        uint32_t first;
        uint32_t second;
        memcpy(&first, data + i, 4);
        memcpy(&second, data + i + 4, 4);
        if (bigEndian) {
            first = __builtin_bswap32(first);
            second = __builtin_bswap32(second);
        }
        sum[0] += first + sum[1];
        sum[1] += second + sum[0];
    }
}

struct WalFrames {
    uint32_t pageSize { 0 };
    uint32_t count { 0 }; // Frames bis zum letzten Commit
    uint32_t databasePages { 0 }; // Seiten der Datenbank nach diesem Commit
};

// Wie die Wiederherstellung in SQLite (walIndexRecover in wal.c): gueltig sind
// Frames mit dem Salz aus dem Kopf und verketteter Pruefsumme, bestaetigt ist
// alles bis zum letzten Frame mit Commit
WalFrames committedFrames(const Content& wal)
{
    uint8_t header[walHeaderSize];
    if (wal.read(header, sizeof(header), 0) < sizeof(header))
        return { };
    uint32_t magic = get32(header);
    uint32_t pageSize = get32(header + 8);
    if ((magic & ~1u) != 0x377f0682 || get32(header + 4) != 3007000 || pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)))
        return { };
    bool bigEndian = magic & 1;
    uint32_t sum[2] = { 0, 0 };
    walChecksum(bigEndian, header, 24, sum);
    if (sum[0] != get32(header + 24) || sum[1] != get32(header + 28))
        return { };

    WalFrames result { pageSize };
    uint64_t frameSize = walFrameHeaderSize + pageSize;
    for (uint64_t index = 0; walHeaderSize + (index + 1) * frameSize <= wal.size(); ++index) {
        uint64_t offset = walHeaderSize + index * frameSize;
        uint8_t frame[walFrameHeaderSize];
        wal.read(frame, sizeof(frame), offset);
        if (memcmp(frame + 8, header + 16, 8) || !get32(frame))
            break;
        walChecksum(bigEndian, frame, 8, sum);
        wal.forEach(offset + walFrameHeaderSize, pageSize, [&](const uint8_t* data, size_t length) {
            walChecksum(bigEndian, data, length, sum);
        });
        if (sum[0] != get32(frame + 16) || sum[1] != get32(frame + 20))
            break;
        if (uint32_t pages = get32(frame + 4)) {
            result.count = index + 1;
            result.databasePages = pages;
        }
    }
    return result;
}

// Die Datenbank, wie SQLite sie nach einem vollen Checkpoint haette: erst der
// Inhalt der Datei, darueber die bestaetigten Seiten aus dem WAL der Reihe nach
// (eine spaetere Fassung einer Seite ueberschreibt die fruehere)
void writeDatabase(FileReplacement& file, const Content& database, const Content* wal)
{
    auto frames = wal ? committedFrames(*wal) : WalFrames { };
    uint64_t size = frames.count ? static_cast<uint64_t>(frames.databasePages) * frames.pageSize : database.size();
    uint64_t offset = 0;
    database.forEach(0, std::min(size, database.size()), [&](const uint8_t* data, size_t length) {
        file.write({ data, length }, offset);
        offset += length;
    });
    for (uint64_t index = 0; index < frames.count; ++index) {
        uint64_t frame = walHeaderSize + index * (walFrameHeaderSize + frames.pageSize);
        uint8_t header[walFrameHeaderSize];
        wal->read(header, sizeof(header), frame);
        uint32_t page = get32(header);
        if (page > frames.databasePages)
            continue;
        uint64_t target = static_cast<uint64_t>(page - 1) * frames.pageSize;
        wal->forEach(frame + walFrameHeaderSize, frames.pageSize, [&](const uint8_t* data, size_t length) {
            file.write({ data, length }, target);
            target += length;
        });
    }
    file.truncate(size);
}

// Unter dem Lock der Familie und ioMutex. Die Kopie ersetzt die Datenbank in
// einem Schritt
bool writeFamily(Family& family)
{
    Node* database = nullptr;
    Node* wal = nullptr;
    for (auto& node : family.nodes) {
        if (node->path == family.name)
            database = node.get();
        else if (endsWith(node->path, "-wal") && node->exists)
            wal = node.get();
    }
    std::optional<FileReplacement> file;
    if (database && database->exists) {
        file.emplace();
        writeDatabase(*file, database->content, wal ? &wal->content : nullptr);
        if (!file->ok())
            return false;
    }
    if (file)
        return file->commit(family.name.c_str());
    return !unlink(family.name.c_str()) || errno == ENOENT;
}

enum class Flush : uint8_t { Scheduled, Now };

// Eine Datenbank auf die Platte. false: noch nicht (Schreib-Transaktion,
// ioMutex belegt, zu frueh oder Fehler)
bool flushFamily(Family& family, Flush mode)
{
    std::lock_guard ioLock(ioMutex);
    // Unter dem Lock ohne Kopie: solange schreibt niemand in die Datenbank
    std::lock_guard lock(family.mutex);
    if (!family.dirty)
        return true;
    if (family.writeLocked())
        return false;
    auto start = MonotonicTime::now();
    if (mode == Flush::Scheduled && start < family.nextWrite)
        return false;
    bool written = writeFamily(family);
    // Hoechstens ein Fuenftel der Zeit mit Schreiben verbringen, auch wenn es
    // immer wieder fehlschlaegt (z.B. OPFS voll)
    auto end = MonotonicTime::now();
    family.nextWrite = end + (end - start) * 4;
    if (written)
        family.dirty = false;
    return written;
}

std::vector<std::shared_ptr<Family>> listFamilies()
{
    std::lock_guard registryLock(registryMutex);
    std::vector<std::shared_ptr<Family>> all;
    all.reserve(families->size());
    for (auto& [name, family] : *families)
        all.push_back(family);
    return all;
}

// false: nicht alles geschrieben
bool flushAll(Flush mode)
{
    if (!families)
        return true;
    bool complete = true;
    for (auto& family : listFamilies())
        complete = flushFamily(*family, mode) && complete;
    return complete;
}

// Kurz nach einer Aenderung schreiben, im Engine-Thread
constexpr Seconds flushDelay = 1_s;
std::atomic<bool> flushScheduled;

void scheduleFlush()
{
    if (flushScheduled.exchange(true))
        return;
    runOnEngineThread([] {
        RunLoop::mainSingleton().dispatchAfter(flushDelay, [] {
            flushScheduled = false;
            if (!flushAll(Flush::Scheduled))
                scheduleFlush();
        });
    });
}

// Unter dem Lock der Familie
void markDirty(Family& family)
{
    if (!std::exchange(family.dirty, true))
        scheduleFlush();
}

// ---------------------------------------------------------------- Dateien

std::shared_ptr<Family> familyFor(Family* family)
{
    std::lock_guard registryLock(registryMutex);
    for (auto& [name, candidate] : *families) {
        if (candidate.get() == family)
            return candidate;
    }
    return nullptr;
}

// Keine offene Verbindung mehr und alles geschrieben: vergessen, beim
// naechsten Oeffnen wieder von der Platte lesen
void dropIfUnused(Family* family)
{
    std::lock_guard registryLock(registryMutex);
    std::lock_guard lock(family->mutex);
    if (family->openCount || family->dirty)
        return;
    for (auto it = families->begin(); it != families->end(); ++it) {
        if (it->second.get() == family) {
            families->erase(it);
            return;
        }
    }
}

int memoryClose(sqlite3_file* file)
{
    auto* memory = reinterpret_cast<MemoryFile*>(file);
    auto family = familyFor(memory->family);
    bool last;
    {
        std::lock_guard lock(family->mutex);
        if (memory->lockLevel >= SQLITE_LOCK_SHARED)
            family->sharedCount--;
        if (memory->lockLevel >= SQLITE_LOCK_RESERVED)
            family->reserved = false;
        if (memory->lockLevel >= SQLITE_LOCK_PENDING)
            family->pending = false;
        if (memory->lockLevel >= SQLITE_LOCK_EXCLUSIVE)
            family->exclusive = false;
        memory->lockLevel = SQLITE_LOCK_NONE;
        last = !--family->openCount;
    }
    file->pMethods = nullptr;
    if (last) {
        // Letzte Verbindung: jetzt schreiben (WebKit loescht die Dateien danach
        // vielleicht selber, z.B. bei indexedDB.deleteDatabase)
        flushFamily(*family, Flush::Now);
        dropIfUnused(family.get());
    }
    return SQLITE_OK;
}

int memoryRead(sqlite3_file* file, void* buffer, int amount, sqlite3_int64 offset)
{
    auto* memory = reinterpret_cast<MemoryFile*>(file);
    std::lock_guard lock(memory->family->mutex);
    auto* data = static_cast<uint8_t*>(buffer);
    size_t available = memory->node->content.read(data, amount, offset);
    if (available < static_cast<size_t>(amount)) {
        memset(data + available, 0, amount - available);
        return SQLITE_IOERR_SHORT_READ;
    }
    return SQLITE_OK;
}

int memoryWrite(sqlite3_file* file, const void* buffer, int amount, sqlite3_int64 offset)
{
    auto* memory = reinterpret_cast<MemoryFile*>(file);
    std::lock_guard lock(memory->family->mutex);
    auto& node = *memory->node;
    if (!node.content.write(static_cast<const uint8_t*>(buffer), amount, offset))
        return SQLITE_FULL;
    node.exists = true;
    markDirty(*memory->family);
    return SQLITE_OK;
}

int memoryTruncate(sqlite3_file* file, sqlite3_int64 size)
{
    auto* memory = reinterpret_cast<MemoryFile*>(file);
    std::lock_guard lock(memory->family->mutex);
    if (!memory->node->content.resize(size))
        return SQLITE_FULL;
    markDirty(*memory->family);
    return SQLITE_OK;
}

int memorySync(sqlite3_file*, int)
{
    return SQLITE_OK;
}

int memoryFileSize(sqlite3_file* file, sqlite3_int64* size)
{
    auto* memory = reinterpret_cast<MemoryFile*>(file);
    std::lock_guard lock(memory->family->mutex);
    *size = memory->node->content.size();
    return SQLITE_OK;
}

// Locks wie bei os_unix.c, aber nur innerhalb des Prozesses
int memoryLock(sqlite3_file* file, int level)
{
    auto* memory = reinterpret_cast<MemoryFile*>(file);
    auto& family = *memory->family;
    std::lock_guard lock(family.mutex);
    if (memory->lockLevel >= level)
        return SQLITE_OK;
    if (level == SQLITE_LOCK_SHARED) {
        if (family.pending || family.exclusive)
            return SQLITE_BUSY;
        family.sharedCount++;
        memory->lockLevel = SQLITE_LOCK_SHARED;
        return SQLITE_OK;
    }
    if (level == SQLITE_LOCK_RESERVED || memory->lockLevel < SQLITE_LOCK_RESERVED) {
        if (family.reserved)
            return SQLITE_BUSY;
        family.reserved = true;
        memory->lockLevel = SQLITE_LOCK_RESERVED;
        if (level == SQLITE_LOCK_RESERVED)
            return SQLITE_OK;
    }
    // EXCLUSIVE (ueber PENDING): warten, bis alle anderen Leser weg sind
    family.pending = true;
    memory->lockLevel = SQLITE_LOCK_PENDING;
    if (family.sharedCount > 1)
        return SQLITE_BUSY;
    family.exclusive = true;
    memory->lockLevel = SQLITE_LOCK_EXCLUSIVE;
    return SQLITE_OK;
}

int memoryUnlock(sqlite3_file* file, int level)
{
    auto* memory = reinterpret_cast<MemoryFile*>(file);
    auto& family = *memory->family;
    std::lock_guard lock(family.mutex);
    if (memory->lockLevel <= level)
        return SQLITE_OK;
    if (memory->lockLevel >= SQLITE_LOCK_EXCLUSIVE)
        family.exclusive = false;
    if (memory->lockLevel >= SQLITE_LOCK_PENDING)
        family.pending = false;
    if (memory->lockLevel >= SQLITE_LOCK_RESERVED)
        family.reserved = false;
    if (level == SQLITE_LOCK_NONE)
        family.sharedCount--;
    memory->lockLevel = level;
    return SQLITE_OK;
}

int memoryCheckReservedLock(sqlite3_file* file, int* result)
{
    auto* memory = reinterpret_cast<MemoryFile*>(file);
    std::lock_guard lock(memory->family->mutex);
    *result = memory->family->reserved || memory->family->pending || memory->family->exclusive;
    return SQLITE_OK;
}

int memoryFileControl(sqlite3_file*, int, void*)
{
    return SQLITE_NOTFOUND;
}

int memorySectorSize(sqlite3_file*)
{
    return 4096;
}

int memoryDeviceCharacteristics(sqlite3_file*)
{
    return SQLITE_IOCAP_POWERSAFE_OVERWRITE | SQLITE_IOCAP_SAFE_APPEND | SQLITE_IOCAP_SEQUENTIAL;
}

void releaseShmLocks(MemoryFile& memory, uint16_t mask)
{
    auto& family = *memory.family;
    for (int i = 0; i < SQLITE_SHM_NLOCK; ++i) {
        uint16_t bit = 1 << i;
        if (!(mask & bit))
            continue;
        if (memory.shmExclusiveMask & bit)
            family.shmExclusive[i] = false;
        if (memory.shmSharedMask & bit)
            family.shmShared[i]--;
    }
    memory.shmExclusiveMask &= ~mask;
    memory.shmSharedMask &= ~mask;
}

int memoryShmMap(sqlite3_file* file, int region, int regionSize, int extend, void volatile** pointer)
{
    auto* memory = reinterpret_cast<MemoryFile*>(file);
    auto& family = *memory->family;
    std::lock_guard lock(family.mutex);
    if (!memory->shmMapped) {
        memory->shmMapped = true;
        family.shmRefs++;
    }
    while (static_cast<int>(family.shmRegions.size()) <= region) {
        if (!extend) {
            *pointer = nullptr;
            return SQLITE_OK;
        }
        auto* data = static_cast<uint8_t*>(calloc(1, regionSize));
        if (!data)
            return SQLITE_NOMEM;
        family.shmRegions.push_back(data);
    }
    *pointer = family.shmRegions[region];
    return SQLITE_OK;
}

int memoryShmLock(sqlite3_file* file, int offset, int count, int flags)
{
    auto* memory = reinterpret_cast<MemoryFile*>(file);
    auto& family = *memory->family;
    uint16_t mask = (1 << (offset + count)) - (1 << offset);
    std::lock_guard lock(family.mutex);
    if (flags & SQLITE_SHM_UNLOCK) {
        releaseShmLocks(*memory, mask);
        return SQLITE_OK;
    }
    if (flags & SQLITE_SHM_SHARED) {
        if (memory->shmSharedMask & mask)
            return SQLITE_OK;
        if (family.shmExclusive[offset])
            return SQLITE_BUSY;
        family.shmShared[offset]++;
        memory->shmSharedMask |= mask;
        return SQLITE_OK;
    }
    for (int i = offset; i < offset + count; ++i) {
        uint16_t bit = 1 << i;
        int otherShared = family.shmShared[i] - ((memory->shmSharedMask & bit) ? 1 : 0);
        if ((family.shmExclusive[i] && !(memory->shmExclusiveMask & bit)) || otherShared > 0)
            return SQLITE_BUSY;
    }
    for (int i = offset; i < offset + count; ++i)
        family.shmExclusive[i] = true;
    memory->shmExclusiveMask |= mask;
    return SQLITE_OK;
}

void memoryShmBarrier(sqlite3_file*)
{
    std::atomic_thread_fence(std::memory_order_seq_cst);
}

int memoryShmUnmap(sqlite3_file* file, int)
{
    auto* memory = reinterpret_cast<MemoryFile*>(file);
    auto& family = *memory->family;
    std::lock_guard lock(family.mutex);
    releaseShmLocks(*memory, 0xffff);
    if (!memory->shmMapped)
        return SQLITE_OK;
    memory->shmMapped = false;
    if (!--family.shmRefs) {
        for (auto* region : family.shmRegions)
            free(region);
        family.shmRegions.clear();
    }
    return SQLITE_OK;
}

const sqlite3_io_methods memoryMethods = {
    2,
    memoryClose,
    memoryRead,
    memoryWrite,
    memoryTruncate,
    memorySync,
    memoryFileSize,
    memoryLock,
    memoryUnlock,
    memoryCheckReservedLock,
    memoryFileControl,
    memorySectorSize,
    memoryDeviceCharacteristics,
    memoryShmMap,
    memoryShmLock,
    memoryShmBarrier,
    memoryShmUnmap,
    nullptr,
    nullptr,
};

// ---------------------------------------------------------------- VFS

int memoryOpen(sqlite3_vfs*, const char* name, sqlite3_file* file, int flags, int* outFlags)
{
    if (!inMemoryDomain(name) || !(flags & (SQLITE_OPEN_MAIN_DB | SQLITE_OPEN_MAIN_JOURNAL | SQLITE_OPEN_WAL)))
        return baseVFS->xOpen(baseVFS, name, file, flags, outFlags);

    file->pMethods = nullptr;
    std::string path(name);
    std::shared_ptr<Family> family;
    {
        std::lock_guard registryLock(registryMutex);
        auto& slot = (*families)[familyName(path)];
        if (!slot) {
            slot = std::make_shared<Family>();
            slot->name = familyName(path);
        }
        family = slot;
        std::lock_guard lock(family->mutex);
        family->openCount++; // haelt die Familie in der Liste
        family->findOrCreate(path);
    }

    auto release = [&] {
        {
            std::lock_guard lock(family->mutex);
            family->openCount--;
        }
        dropIfUnused(family.get());
    };

    bool loaded;
    {
        std::lock_guard lock(family->mutex);
        loaded = family->find(path)->loaded;
    }
    if (!loaded && path != family->name) {
        // -journal und -wal liegen nur im Speicher (writeFamily)
        std::lock_guard lock(family->mutex);
        auto* node = family->find(path);
        node->loaded = true;
    } else if (!loaded) {
        // Ohne Lock von der Platte lesen. Bei einem Lesefehler (auch zu wenig
        // Speicher) nicht oeffnen: sonst wuerde eine leere Datenbank die echte
        // ueberschreiben
        struct stat info;
        if (!stat(path.c_str(), &info) && static_cast<uint64_t>(info.st_size) > maximumFileSize()) {
            log("Speicher: %s hat %llu MB, zu gross fuer den Speicher, nicht geoeffnet", path.c_str(), static_cast<unsigned long long>(info.st_size >> 20));
            release();
            return SQLITE_CANTOPEN;
        }
        Content content;
        auto result = readWholeFile(path.c_str(), scopedLambda<bool(std::span<const uint8_t>)>([&](std::span<const uint8_t> chunk) {
            return content.write(chunk.data(), chunk.size(), content.size());
        }));
        if (result == ReadResult::Failed) {
            release();
            return SQLITE_IOERR;
        }
        std::lock_guard lock(family->mutex);
        auto* node = family->find(path);
        if (!node->loaded) {
            node->content = WTF::move(content);
            node->exists = result == ReadResult::Done;
            node->loaded = true;
        }
    }

    Node* node;
    {
        std::lock_guard lock(family->mutex);
        node = family->find(path);
        if (!node->exists) {
            if (!(flags & SQLITE_OPEN_CREATE)) {
                node = nullptr;
            } else {
                node->exists = true;
                node->content.resize(0);
                // Ein leeres -journal oder -wal aendert nichts auf der Platte
                if (path == family->name)
                    markDirty(*family);
            }
        }
    }
    if (!node) {
        release();
        return SQLITE_CANTOPEN;
    }

    auto* memory = reinterpret_cast<MemoryFile*>(file);
    memory->family = family.get();
    memory->node = node;
    memory->lockLevel = SQLITE_LOCK_NONE;
    memory->shmSharedMask = 0;
    memory->shmExclusiveMask = 0;
    memory->shmMapped = false;
    file->pMethods = &memoryMethods;
    if (outFlags)
        *outFlags = flags;
    return SQLITE_OK;
}

int memoryDelete(sqlite3_vfs*, const char* name, int syncDirectory)
{
    if (!inMemoryDomain(name))
        return baseVFS->xDelete(baseVFS, name, syncDirectory);
    std::string path(name);
    if (auto family = findFamily(familyName(path))) {
        std::lock_guard lock(family->mutex);
        if (family->openCount) {
            auto& node = family->findOrCreate(path);
            node.loaded = true;
            node.exists = false;
            node.content = { };
            markDirty(*family);
            return SQLITE_OK;
        }
    }
    int result = baseVFS->xDelete(baseVFS, name, syncDirectory);
    return result == SQLITE_IOERR_DELETE_NOENT ? SQLITE_OK : result;
}

int memoryAccess(sqlite3_vfs*, const char* name, int flags, int* result)
{
    if (!inMemoryDomain(name))
        return baseVFS->xAccess(baseVFS, name, flags, result);
    std::string path(name);
    auto databaseName = familyName(path);
    if (auto family = findFamily(databaseName)) {
        std::lock_guard lock(family->mutex);
        if (auto* node = family->find(path); node && node->loaded) {
            *result = node->exists;
            return SQLITE_OK;
        }
    }
    // -journal und -wal liegen nur im Speicher (writeFamily)
    if (path != databaseName) {
        *result = 0;
        return SQLITE_OK;
    }
    return baseVFS->xAccess(baseVFS, name, flags, result);
}

int memoryFullPathname(sqlite3_vfs*, const char* name, int size, char* out)
{
    return baseVFS->xFullPathname(baseVFS, name, size, out);
}

int memoryRandomness(sqlite3_vfs*, int size, char* out)
{
    return baseVFS->xRandomness(baseVFS, size, out);
}

int memorySleep(sqlite3_vfs*, int microseconds)
{
    return baseVFS->xSleep(baseVFS, microseconds);
}

int memoryCurrentTime(sqlite3_vfs*, double* time)
{
    return baseVFS->xCurrentTime(baseVFS, time);
}

int memoryGetLastError(sqlite3_vfs*, int size, char* out)
{
    return baseVFS->xGetLastError(baseVFS, size, out);
}

int memoryCurrentTimeInt64(sqlite3_vfs*, sqlite3_int64* time)
{
    return baseVFS->xCurrentTimeInt64(baseVFS, time);
}

// Kopf einer Datenbank: https://www.sqlite.org/fileformat2.html#database_header
constexpr size_t databaseHeaderSize = 100;

// Belegte Seiten laut Kopf (Seite 1). Freie Seiten zaehlen nicht: SQLite gibt
// sie nie an die Datei zurueck (IndexedDB macht kein VACUUM), Platz von
// geloeschten Daten waere sonst nie wieder frei. pages 0: Zahl aus dem Kopf.
// Kein Kopf von SQLite: fileSize
uint64_t usedDatabaseSize(const uint8_t* header, uint64_t fileSize, uint32_t pages)
{
    if (memcmp(header, "SQLite format 3", 16))
        return fileSize;
    uint32_t pageSize = header[16] << 8 | header[17];
    if (pageSize == 1)
        pageSize = 65536;
    if (pageSize < 512 || (pageSize & (pageSize - 1)))
        return fileSize;
    if (!pages && get32(header + 24) == get32(header + 92))
        pages = get32(header + 28);
    if (!pages)
        return fileSize;
    return static_cast<uint64_t>(pages - std::min(get32(header + 36), pages)) * pageSize;
}

// Eine offene Datenbank, wie sie nach einem Checkpoint waere: Seite 1 aus dem
// letzten bestaetigten Frame des WAL, sonst aus der Datei
uint64_t usedDatabaseSize(const Content& database, const Content* wal)
{
    uint8_t header[databaseHeaderSize] = { };
    database.read(header, sizeof(header), 0);
    auto frames = wal ? committedFrames(*wal) : WalFrames { };
    for (uint64_t index = frames.count; index-- > 0;) {
        uint64_t frame = walHeaderSize + index * (walFrameHeaderSize + frames.pageSize);
        uint8_t frameHeader[walFrameHeaderSize];
        wal->read(frameHeader, sizeof(frameHeader), frame);
        if (get32(frameHeader) == 1) {
            wal->read(header, sizeof(header), frame + walFrameHeaderSize);
            break;
        }
    }
    uint64_t size = frames.count ? static_cast<uint64_t>(frames.databasePages) * frames.pageSize : database.size();
    return usedDatabaseSize(header, size, frames.databasePages);
}

// Dateien direkt in directory auf der Platte, ohne die in skip
uint64_t diskSize(const String& directory, const std::vector<std::string>& skip)
{
    uint64_t total = 0;
    for (auto& name : FileSystem::listDirectory(directory)) {
        auto path = FileSystem::pathByAppendingComponent(directory, name).utf8();
        if (std::find(skip.begin(), skip.end(), path.data()) != skip.end())
            continue;
        int fd = open(path.data(), O_RDONLY);
        if (fd < 0)
            continue;
        struct stat info;
        uint8_t header[databaseHeaderSize] = { };
        if (!fstat(fd, &info) && S_ISREG(info.st_mode)) {
            ssize_t length = pread(fd, header, sizeof(header), 0);
            total += length == sizeof(header) ? usedDatabaseSize(header, info.st_size, 0) : info.st_size;
        }
        close(fd);
    }
    return total;
}

} // namespace

void registerMemoryVFS()
{
    if (baseVFS)
        return;
    baseVFS = sqlite3_vfs_find(nullptr);
    if (!baseVFS)
        return;
    families = new std::unordered_map<std::string, std::shared_ptr<Family>>;
    memoryVFS = { };
    memoryVFS.iVersion = 2;
    memoryVFS.szOsFile = std::max<int>(sizeof(MemoryFile), baseVFS->szOsFile);
    memoryVFS.mxPathname = baseVFS->mxPathname;
    memoryVFS.zName = "bl-memory";
    memoryVFS.xOpen = memoryOpen;
    memoryVFS.xDelete = memoryDelete;
    memoryVFS.xAccess = memoryAccess;
    memoryVFS.xFullPathname = memoryFullPathname;
    memoryVFS.xRandomness = memoryRandomness;
    memoryVFS.xSleep = memorySleep;
    memoryVFS.xCurrentTime = memoryCurrentTime;
    memoryVFS.xGetLastError = memoryGetLastError;
    memoryVFS.xCurrentTimeInt64 = memoryCurrentTimeInt64;
    sqlite3_vfs_register(&memoryVFS, 1);
}

void flushMemoryVFS()
{
    flushAll(Flush::Now);
}

bool flushMemoryVFSAndWait(Seconds timeout)
{
    auto done = std::make_shared<std::atomic<uint32_t>>(0);
    runOnEngineThread([done] {
        flushAll(Flush::Now);
        done->store(1);
        emscripten_futex_wake(done.get(), INT_MAX);
    });
    auto deadline = MonotonicTime::now() + timeout;
    while (!done->load()) {
        auto left = deadline - MonotonicTime::now();
        if (left <= 0_s)
            return false;
        emscripten_futex_wait(done.get(), 0, left.milliseconds());
    }
    return true;
}

uint64_t memoryVFSDirectorySize(const String& directory)
{
    std::string prefix = directory.utf8().data();
    prefix += '/';
    uint64_t total = 0;
    std::vector<std::string> inMemory;
    std::vector<std::shared_ptr<Family>> all;
    if (families)
        all = listFamilies();
    for (auto& family : all) {
        if (!family->name.starts_with(prefix) || family->name.find('/', prefix.size()) != std::string::npos)
            continue;
        std::lock_guard lock(family->mutex);
        Node* database = nullptr;
        Node* wal = nullptr;
        for (auto& node : family->nodes) {
            if (!node->loaded)
                continue;
            inMemory.push_back(node->path);
            if (!node->exists)
                continue;
            if (node->path == family->name)
                database = node.get();
            else if (endsWith(node->path, "-wal"))
                wal = node.get();
            else
                total += node->content.size();
        }
        if (database)
            total += usedDatabaseSize(database->content, wal ? &wal->content : nullptr);
    }
    // Der Rest liegt auf der Platte: Datenbanken, die gerade nicht offen sind,
    // und andere Dateien (z.B. Blobs von IndexedDB)
    return total + diskSize(directory, inMemory);
}

} // namespace BrowserLite
