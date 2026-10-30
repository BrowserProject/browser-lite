// SQLite databases under /data in WASM memory.
//
// SQLite writes every WAL page separately, with a seek before: loading CNN
// caused about 7000 file accesses just for the cookie database. /data is in
// the OPFS, every access is a detour through the WasmFS worker.
//
// So database, -journal and -wal live here in memory (in blocks, Content), as
// does the shared memory (shm) for WAL mode. Only the database goes to disk,
// as a whole and with all committed pages from the WAL like after a checkpoint
// (writeFamily), through a copy and a rename (FileReplacement in Storage.h).
// Replacing database and WAL separately would not be atomic: if it breaks off
// in between, SQLite replays an old WAL into a new database.
//
// Writing happens when no write transaction is running:
// - shortly after a change (flushDelay, a big database less often),
// - when the host asks for it (bl_storage_flush; when the page is hidden it
//   waits for it),
// - when the last connection to a database closes. Afterwards everything is
//   read from disk again, so it is right even when WebKit deletes the files
//   itself (e.g. indexedDB.deleteDatabase).
//
// Rule against deadlocks: file accesses under the lock of a database only
// with ioMutex.

#include "config.h"
#include "MemoryVFS.h"

#include "Engine.h"
#include "EngineConfig.h"
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

// Biggest file in memory (BL_DATABASE_MAX_MB, default 512 MB). The VFS does
// not open bigger ones instead of loading them: WASM memory has at most 4 GB
// for everything. IndexedDB has a smaller limit per origin only for writing
// (Storage.cpp), this one applies when opening too and for all others.
uint64_t maximumFileSize()
{
    return engineConfig().databaseMaxMB << 20;
}

// Content of a file in blocks of fixed size. Growing copies nothing (a
// std::vector needs old and new space for that, with doubling up to three
// times the file), and when memory is missing SQLite gets SQLITE_FULL instead
// of the engine crashing.
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

    // false: too big or no memory, then everything stays as it was
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
        // Behind the end there are always zeros: if the file grows again,
        // SQLite reads nothing old there
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

    // Reads at most up to the end, returns the length read
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

    // The pieces of [offset, offset + length) in order (within size()). They
    // start and end at multiples of 8 if offset and length do
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

// Committed frames of a WAL (committedFrames)
struct WalFrames {
    uint32_t pageSize { 0 };
    uint32_t count { 0 }; // frames up to the last commit
    uint32_t databasePages { 0 }; // pages of the database after this commit
    // To go on from there (commit log): salt of the WAL and the chained checksum after frame count
    uint8_t salt[8] { };
    uint32_t sum[2] { 0, 0 };
};

struct Node {
    std::string path;
    Content content;
    bool loaded { false }; // content (or "does not exist") is known
    bool exists { false };
};

struct Family {
    std::string name; // path of the database
    std::mutex mutex;
    std::vector<std::unique_ptr<Node>> nodes; // database, -journal, -wal
    int openCount { 0 };
    bool dirty { false }; // changed since the last write
    // Do not rewrite a big database completely all the time (flushFamily)
    MonotonicTime nextWrite;
    // Commit log (<name>-bllog): the committed WAL frames already in a record, the records not
    // yet appended (drainLog, in order) and whether the file may exist
    WalFrames loggedFrames;
    std::vector<std::vector<uint8_t>> pendingLog;
    bool logOnDisk { false };
    // Locks on the database (rollback journal)
    int sharedCount { 0 };
    bool reserved { false };
    bool pending { false };
    bool exclusive { false };
    // Shared memory for the WAL index
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
// Only one writes to the file system at a time
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

// "x-journal" and "x-wal" belong to the database "x"
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

// ---------------------------------------------------------------- Writing

// WAL format: https://www.sqlite.org/fileformat2.html#walformat
constexpr uint64_t walHeaderSize = 32;
constexpr uint64_t walFrameHeaderSize = 24;

uint32_t get32(const uint8_t* data)
{
    return static_cast<uint32_t>(data[0]) << 24 | data[1] << 16 | data[2] << 8 | data[3];
}

// walChecksumBytes in wal.c, length is a multiple of 8
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

// Like the recovery in SQLite (walIndexRecover in wal.c): frames with the salt
// from the header and a chained checksum are valid, everything up to the last
// frame with a commit is committed. With from (an earlier result for the same
// WAL) only the frames after it are checked.
WalFrames committedFrames(const Content& wal, const WalFrames& from = { })
{
    uint8_t header[walHeaderSize];
    if (wal.read(header, sizeof(header), 0) < sizeof(header))
        return { };
    uint32_t magic = get32(header);
    uint32_t pageSize = get32(header + 8);
    if ((magic & ~1u) != 0x377f0682 || get32(header + 4) != 3007000 || pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)))
        return { };
    bool bigEndian = magic & 1;
    WalFrames result { pageSize };
    memcpy(result.salt, header + 16, sizeof(result.salt));
    uint32_t sum[2] = { 0, 0 };
    uint64_t index = 0;
    if (from.count && from.pageSize == pageSize && !memcmp(from.salt, result.salt, sizeof(result.salt))) {
        result = from;
        index = from.count;
        memcpy(sum, from.sum, sizeof(sum));
    } else {
        walChecksum(bigEndian, header, 24, sum);
        if (sum[0] != get32(header + 24) || sum[1] != get32(header + 28))
            return { };
        memcpy(result.sum, sum, sizeof(sum));
    }

    uint64_t frameSize = walFrameHeaderSize + pageSize;
    for (; walHeaderSize + (index + 1) * frameSize <= wal.size(); ++index) {
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
            memcpy(result.sum, sum, sizeof(sum));
        }
    }
    return result;
}

// The database as SQLite would have it after a full checkpoint: first the
// content of the file, on top the committed pages from the WAL in order (a
// later version of a page overwrites the earlier one)
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

// ---------------------------------------------------------------- Commit log

// The whole database goes to disk only some time after a change (flushDelay): a tab closed or
// reloaded meanwhile lost the change, in Firefox also because the engine cannot write while the
// page goes away. So every commit appends its new WAL frames as a record to <database>-bllog right
// away (on the committing thread); opening the database applies the valid records, the next full
// write empties the file. Record: "BLL1", page size, frame count, pages of the database after the
// commit (all uint32 little endian), the frames (page number, page), then FNV-1a 64 of all before.
constexpr char logSuffix[] = "-bllog";
constexpr uint8_t logMagic[4] = { 'B', 'L', 'L', '1' };
constexpr size_t logHeaderSize = 16;

std::string logPath(const std::string& database)
{
    return database + logSuffix;
}

uint64_t fnv1a(std::span<const uint8_t> data)
{
    uint64_t hash = 0xcbf29ce484222325ull;
    for (uint8_t byte : data)
        hash = (hash ^ byte) * 0x100000001b3ull;
    return hash;
}

void put32le(uint8_t* target, uint32_t value)
{
    memcpy(target, &value, 4);
}

uint32_t get32le(const uint8_t* data)
{
    uint32_t value;
    memcpy(&value, data, 4);
    return value;
}

// Under the lock of the family, when a connection ends its write transaction (releases the WAL
// write lock): the frames committed since the last record become a record for drainLog
void captureCommit(Family& family)
{
    Node* wal = nullptr;
    for (auto& node : family.nodes) {
        if (endsWith(node->path, "-wal") && node->exists)
            wal = node.get();
    }
    if (!wal)
        return;
    auto frames = committedFrames(wal->content, family.loggedFrames);
    bool sameWal = family.loggedFrames.count && frames.pageSize == family.loggedFrames.pageSize
        && !memcmp(frames.salt, family.loggedFrames.salt, sizeof(frames.salt));
    uint32_t first = sameWal ? family.loggedFrames.count : 0;
    if (frames.count <= first)
        return;
    family.loggedFrames = frames;
    uint64_t frameSize = walFrameHeaderSize + frames.pageSize;
    uint32_t count = frames.count - first;
    std::vector<uint8_t> record(logHeaderSize + static_cast<size_t>(count) * (4 + frames.pageSize) + 8);
    memcpy(record.data(), logMagic, 4);
    put32le(record.data() + 4, frames.pageSize);
    put32le(record.data() + 8, count);
    put32le(record.data() + 12, frames.databasePages);
    uint8_t* target = record.data() + logHeaderSize;
    for (uint32_t index = first; index < frames.count; ++index) {
        uint64_t frame = walHeaderSize + index * frameSize;
        uint8_t header[walFrameHeaderSize];
        wal->content.read(header, sizeof(header), frame);
        put32le(target, get32(header));
        wal->content.read(target + 4, frames.pageSize, frame + walFrameHeaderSize);
        target += 4 + frames.pageSize;
    }
    uint64_t hash = fnv1a({ record.data(), record.size() - 8 });
    memcpy(target, &hash, 8);
    family.pendingLog.push_back(WTF::move(record));
}

// Without the lock of the family: appends its waiting records in the order of the commits. If
// that fails, the full write later still has them (the family stays dirty)
void drainLog(Family& family)
{
    std::lock_guard ioLock(ioMutex);
    std::vector<std::vector<uint8_t>> records;
    {
        std::lock_guard lock(family.mutex);
        records = std::exchange(family.pendingLog, { });
        if (records.empty())
            return;
        family.logOnDisk = true;
    }
    int fd = open(logPath(family.name).c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd < 0)
        return;
    for (auto& record : records) {
        size_t written = 0;
        while (written < record.size()) {
            ssize_t result = ::write(fd, record.data() + written, record.size() - written);
            if (result <= 0)
                break;
            written += result;
        }
        if (written < record.size())
            break;
    }
    close(fd);
}

// The valid records of a log on top of the database content, in order. Stops at the first broken
// one (a write that was cut off). false: no memory
bool applyLog(Content& database, std::span<const uint8_t> log, bool& applied)
{
    applied = false;
    size_t offset = 0;
    while (offset + logHeaderSize + 8 <= log.size()) {
        const uint8_t* header = log.data() + offset;
        uint32_t pageSize = get32le(header + 4);
        uint32_t count = get32le(header + 8);
        uint32_t pages = get32le(header + 12);
        if (memcmp(header, logMagic, 4) || pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)))
            break;
        uint64_t size = logHeaderSize + static_cast<uint64_t>(count) * (4 + pageSize) + 8;
        if (offset + size > log.size())
            break;
        uint64_t hash;
        memcpy(&hash, header + size - 8, 8);
        if (fnv1a({ header, static_cast<size_t>(size - 8) }) != hash)
            break;
        const uint8_t* frame = header + logHeaderSize;
        for (uint32_t index = 0; index < count; ++index, frame += 4 + pageSize) {
            uint32_t page = get32le(frame);
            if (page && page <= pages && !database.write(frame + 4, pageSize, static_cast<uint64_t>(page - 1) * pageSize))
                return false;
        }
        if (!database.resize(static_cast<uint64_t>(pages) * pageSize))
            return false;
        applied = true;
        offset += size;
    }
    return true;
}

// Under the lock of the family and ioMutex. The copy replaces the database in
// one step
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
    bool written = file ? file->commit(family.name.c_str()) : !unlink(family.name.c_str()) || errno == ENOENT;
    if (!written)
        return false;
    // The database now holds every commit of the log: records still waiting are done too. The log
    // is emptied rather than deleted (deleting a file runs code the start otherwise never needs,
    // split engine #238), it goes with its database
    family.pendingLog.clear();
    if (!file)
        unlink(logPath(family.name).c_str());
    else if (std::exchange(family.logOnDisk, false)) {
        int fd = open(logPath(family.name).c_str(), O_WRONLY | O_TRUNC);
        if (fd >= 0)
            close(fd);
    }
    return true;
}

enum class Flush : uint8_t { Scheduled, Now };

// One database to disk. false: not yet (write transaction, ioMutex taken, too
// early or error)
bool flushFamily(Family& family, Flush mode)
{
    std::lock_guard ioLock(ioMutex);
    // Under the lock without a copy: meanwhile nobody writes into the database
    std::lock_guard lock(family.mutex);
    if (!family.dirty)
        return true;
    if (family.writeLocked())
        return false;
    auto start = MonotonicTime::now();
    if (mode == Flush::Scheduled && start < family.nextWrite)
        return false;
    bool written = writeFamily(family);
    // Spend at most a fifth of the time writing, even if it keeps failing
    // (e.g. OPFS full)
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

// false: not everything written
bool flushAll(Flush mode)
{
    if (!families)
        return true;
    bool complete = true;
    for (auto& family : listFamilies())
        complete = flushFamily(*family, mode) && complete;
    return complete;
}

// Write shortly after a change, on the engine thread
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

// Under the lock of the family
void markDirty(Family& family)
{
    if (!std::exchange(family.dirty, true))
        scheduleFlush();
}

// ---------------------------------------------------------------- Files

std::shared_ptr<Family> familyFor(Family* family)
{
    std::lock_guard registryLock(registryMutex);
    for (auto& [name, candidate] : *families) {
        if (candidate.get() == family)
            return candidate;
    }
    return nullptr;
}

// No open connection anymore and everything written: forget it, read it from
// disk again on the next open
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
        // Last connection: write now (WebKit may delete the files itself
        // afterwards, e.g. with indexedDB.deleteDatabase)
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

// Locks like os_unix.c, but only within the process
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
    // EXCLUSIVE (through PENDING): wait until all other readers are gone
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
    if (flags & SQLITE_SHM_UNLOCK) {
        // The end of a write transaction (WAL_WRITE_LOCK, slot 0 in wal.c): log its commit, appended
        // without the lock of the family (file accesses need ioMutex first)
        bool endsWrite;
        {
            std::lock_guard lock(family.mutex);
            endsWrite = mask & memory->shmExclusiveMask & 1;
            releaseShmLocks(*memory, mask);
            if (endsWrite)
                captureCommit(family);
        }
        if (endsWrite)
            drainLog(family);
        return SQLITE_OK;
    }
    std::lock_guard lock(family.mutex);
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
        family->openCount++; // keeps the family in the list
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
        // -journal and -wal only live in memory (writeFamily)
        std::lock_guard lock(family->mutex);
        auto* node = family->find(path);
        node->loaded = true;
    } else if (!loaded) {
        // Read from disk without the lock. On a read error (also too little
        // memory) do not open: otherwise an empty database would overwrite the
        // real one
        struct stat info;
        if (!stat(path.c_str(), &info) && static_cast<uint64_t>(info.st_size) > maximumFileSize()) {
            log("Storage: %s has %llu MB, too big for memory, not opened", path.c_str(), static_cast<unsigned long long>(info.st_size >> 20));
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
        // Commits after the last full write (commit log)
        std::vector<uint8_t> log;
        auto logResult = readWholeFile(logPath(path).c_str(), log);
        bool fromLog = false;
        if (logResult == ReadResult::Failed || (logResult == ReadResult::Done && !applyLog(content, log, fromLog))) {
            release();
            return SQLITE_IOERR;
        }
        std::lock_guard lock(family->mutex);
        auto* node = family->find(path);
        if (!node->loaded) {
            node->content = WTF::move(content);
            node->exists = result == ReadResult::Done || fromLog;
            node->loaded = true;
            family->logOnDisk = logResult == ReadResult::Done && !log.empty();
            // The next full write takes the records into the database and deletes the log
            if (family->logOnDisk)
                markDirty(*family);
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
                // An empty -journal or -wal changes nothing on disk
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
    // Its commit log would bring the database back
    if (path == familyName(path))
        unlink(logPath(path).c_str());
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
    // -journal and -wal only live in memory (writeFamily)
    if (path != databaseName) {
        *result = 0;
        return SQLITE_OK;
    }
    int status = baseVFS->xAccess(baseVFS, name, flags, result);
    // Created and committed, but not yet fully written: only in its commit log
    struct stat log;
    if (status == SQLITE_OK && !*result && flags == SQLITE_ACCESS_EXISTS)
        *result = !stat(logPath(path).c_str(), &log) && log.st_size > 0;
    return status;
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

// Header of a database: https://www.sqlite.org/fileformat2.html#database_header
constexpr size_t databaseHeaderSize = 100;

// Used pages according to the header (page 1). Free pages do not count: SQLite
// never gives them back to the file (IndexedDB does no VACUUM), space of
// deleted data would never be free again otherwise. pages 0: number from the
// header. No SQLite header: fileSize
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

// An open database as it would be after a checkpoint: page 1 from the last
// committed frame of the WAL, otherwise from the file
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

// Files directly in directory on disk, without those in skip
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
    // The rest is on disk: databases that are not open right now, and other
    // files (e.g. IndexedDB blobs)
    return total + diskSize(directory, inMemory);
}

} // namespace BrowserLite
