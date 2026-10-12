// SQLite-Datenbanken unter /data im WASM-Speicher.
//
// Das Dateisystem von Emscripten (IDBFS ueber MEMFS) lebt im JavaScript des
// Haupt-Threads. Jeder Dateizugriff aus einem anderen Thread (Engine,
// IndexedDB, localStorage) ist ein synchroner Umweg ueber diesen Thread. Beim
// Laden von CNN waren das ca. 7000 Zugriffe nur fuer die Cookie-Datenbank
// (SQLite schreibt jede WAL-Seite einzeln, mit seek davor).
//
// Darum liegen Datenbank, -journal und -wal hier im Speicher, ebenso der
// gemeinsame Speicher (shm) fuer den WAL-Modus. Ins Dateisystem kommen die
// Dateien nur als Ganzes:
// - von der Oberflaeche aus vor jedem Speichern des IDBFS (bl_storage_flush),
// - wenn die letzte Verbindung zu einer Datenbank schliesst. Danach wird alles
//   wieder von der Platte gelesen, so stimmt es auch, wenn WebKit die Dateien
//   selber loescht (z.B. indexedDB.deleteDatabase).
// Geschrieben wird nur, wenn gerade keine Schreib-Transaktion laeuft, damit
// Datenbank und WAL zusammenpassen.
//
// Regeln gegen Deadlocks: in Worker-Threads kein Dateizugriff, waehrend ein
// Lock hier gehalten wird (der wartet auf den Haupt-Thread, der vielleicht
// gerade selber auf dieses Lock wartet). Auf dem Haupt-Thread unter dem Lock
// nichts, was warten kann (auch kein malloc), siehe flushFamily.

#include "config.h"
#include "MemoryVFS.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <mutex>
#include <sqlite3.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <unordered_map>
#include <vector>

namespace BrowserLite {

namespace {

constexpr char rootPrefix[] = "/data/";

struct Node {
    std::string path;
    std::vector<uint8_t> data;
    bool loaded { false }; // Inhalt (bzw. "gibt es nicht") ist bekannt
    bool exists { false };
    bool dirty { false };
};

struct Family {
    std::mutex mutex;
    std::vector<std::unique_ptr<Node>> nodes; // Datenbank, -journal, -wal
    int openCount { 0 };
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

// Ohne Locks aufrufen (Dateizugriff)
bool readFile(const std::string& path, std::vector<uint8_t>& data)
{
    int fd = open(path.c_str(), O_RDONLY);
    if (fd < 0)
        return false;
    struct stat info;
    if (!fstat(fd, &info) && info.st_size > 0)
        data.reserve(info.st_size);
    uint8_t buffer[65536];
    ssize_t length;
    while ((length = read(fd, buffer, sizeof(buffer))) > 0)
        data.insert(data.end(), buffer, buffer + length);
    close(fd);
    return true;
}

bool writeFile(const std::string& path, const std::vector<uint8_t>& data)
{
    int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0)
        return false;
    size_t written = 0;
    while (written < data.size()) {
        ssize_t length = write(fd, data.data() + written, data.size() - written);
        if (length <= 0) {
            close(fd);
            return false;
        }
        written += length;
    }
    close(fd);
    return true;
}

// Geaenderte Dateien einer Datenbank schreiben. false: uebersprungen
bool flushFamily(Family& family, bool fromHostThread)
{
    struct Pending {
        std::string path;
        bool exists;
        std::vector<uint8_t> data;
    };
    std::unique_lock ioLock(ioMutex, std::defer_lock);
    if (fromHostThread) {
        if (!ioLock.try_lock())
            return false;
    } else
        ioLock.lock();

    if (fromHostThread) {
        // Auf dem Haupt-Thread gehen Dateizugriffe direkt (kein Warten), darum
        // ohne Kopie unter dem Lock schreiben. Kopieren hiesse malloc, und
        // waehrend der Haupt-Thread auf malloc wartet, arbeitet Emscripten die
        // Warteschlange ab (siehe Sockets.cpp)
        std::lock_guard lock(family.mutex);
        if (family.writeLocked())
            return false;
        bool ok = true;
        for (auto& node : family.nodes) {
            if (!node->dirty)
                continue;
            bool written = node->exists ? writeFile(node->path, node->data) : (!unlink(node->path.c_str()) || errno == ENOENT);
            if (written)
                node->dirty = false;
            else
                ok = false;
        }
        return ok;
    }

    std::vector<Pending> pending;
    {
        std::lock_guard lock(family.mutex);
        if (family.writeLocked())
            return false;
        for (auto& node : family.nodes) {
            if (!node->dirty)
                continue;
            pending.push_back({ node->path, node->exists, node->exists ? node->data : std::vector<uint8_t> { } });
            node->dirty = false;
        }
    }
    bool ok = true;
    for (auto& file : pending) {
        bool written = file.exists ? writeFile(file.path, file.data) : (!unlink(file.path.c_str()) || errno == ENOENT);
        if (!written) {
            ok = false;
            std::lock_guard lock(family.mutex);
            if (auto* node = family.find(file.path))
                node->dirty = true;
        }
    }
    return ok;
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
    if (family->openCount)
        return;
    for (auto& node : family->nodes) {
        if (node->dirty)
            return;
    }
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
        flushFamily(*family, false);
        dropIfUnused(family.get());
    }
    return SQLITE_OK;
}

int memoryRead(sqlite3_file* file, void* buffer, int amount, sqlite3_int64 offset)
{
    auto* memory = reinterpret_cast<MemoryFile*>(file);
    std::lock_guard lock(memory->family->mutex);
    auto& data = memory->node->data;
    size_t available = offset < static_cast<sqlite3_int64>(data.size()) ? std::min<size_t>(amount, data.size() - offset) : 0;
    if (available)
        memcpy(buffer, data.data() + offset, available);
    if (available < static_cast<size_t>(amount)) {
        memset(static_cast<uint8_t*>(buffer) + available, 0, amount - available);
        return SQLITE_IOERR_SHORT_READ;
    }
    return SQLITE_OK;
}

int memoryWrite(sqlite3_file* file, const void* buffer, int amount, sqlite3_int64 offset)
{
    auto* memory = reinterpret_cast<MemoryFile*>(file);
    std::lock_guard lock(memory->family->mutex);
    auto& node = *memory->node;
    size_t end = offset + amount;
    if (end > node.data.size())
        node.data.resize(end);
    memcpy(node.data.data() + offset, buffer, amount);
    node.exists = true;
    node.dirty = true;
    return SQLITE_OK;
}

int memoryTruncate(sqlite3_file* file, sqlite3_int64 size)
{
    auto* memory = reinterpret_cast<MemoryFile*>(file);
    std::lock_guard lock(memory->family->mutex);
    memory->node->data.resize(size);
    memory->node->dirty = true;
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
    *size = memory->node->data.size();
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
        if (!slot)
            slot = std::make_shared<Family>();
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
    if (!loaded) {
        // Ohne Lock von der Platte lesen
        std::vector<uint8_t> data;
        bool exists = readFile(path, data);
        std::lock_guard lock(family->mutex);
        auto* node = family->find(path);
        if (!node->loaded) {
            node->data = std::move(data);
            node->exists = exists;
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
                node->data.clear();
                node->dirty = true;
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
            node.data = { };
            node.dirty = true;
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
    auto family = findFamily(familyName(path));
    if (family) {
        std::lock_guard lock(family->mutex);
        if (auto* node = family->find(path); node && node->loaded) {
            *result = node->exists;
            return SQLITE_OK;
        }
    }
    int status = baseVFS->xAccess(baseVFS, name, flags, result);
    // "Gibt es nicht" merken, solange die Datenbank offen ist (SQLite fragt
    // bei jeder Transaktion nach -journal bzw. -wal)
    if (status == SQLITE_OK && !*result && family) {
        std::lock_guard lock(family->mutex);
        if (family->openCount) {
            auto& node = family->findOrCreate(path);
            if (!node.loaded) {
                node.loaded = true;
                node.exists = false;
            }
        }
    }
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

void flushMemoryVFS(bool fromHostThread)
{
    if (!families)
        return;
    // Liste ohne malloc unter dem Lock (Haupt-Thread, siehe flushFamily)
    std::vector<std::shared_ptr<Family>> all;
    size_t count;
    {
        std::lock_guard registryLock(registryMutex);
        count = families->size();
    }
    all.reserve(count + 8);
    {
        std::lock_guard registryLock(registryMutex);
        for (auto& [name, family] : *families) {
            if (all.size() == all.capacity())
                break; // der Rest beim naechsten Mal
            all.push_back(family);
        }
    }
    for (auto& family : all)
        flushFamily(*family, fromHostThread);
}

} // namespace BrowserLite
