// Read-only files of the engine folder that load on first read: the ICU data beyond the core
// linked into the engine (tools/icu-data.mjs) and the fonts of deps/recipes/lazyfonts.sh. Sizes come from an index, so stat() and the
// directory listing need no request. The first read of a file fetches it whole with a
// synchronous XMLHttpRequest on the thread that reads (every engine thread is a worker), in node
// (engine tests) from the file system. The host's HTTP cache keeps the files like the other
// engine files. A WasmFS backend: its classes come from Emscripten's system/lib/wasmfs.
#include "config.h"
#include "LazyFiles.h"

#include "Engine.h"

#include <algorithm>
#include <atomic>
#include <backend.h>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <emscripten/emscripten.h>
#include <memory_backend.h>
#include <string>
#include <sys/stat.h>
#include <vector>
#include <wasmfs.h>

// Fetches <engine folder>/<path> into buffer (size bytes); returns false when the file is
// missing, has another size or did not arrive within 8 s, before the core reports the engine as
// unresponsive after 10 s (the read fails, ICU falls back to the root locale and text to other
// fonts; the next read tries again)
EM_JS(bool, bl_lazy_fetch, (const char* path, uint8_t* buffer, size_t size), {
    var url = locateFile(UTF8ToString(path));
    var data;
    try {
        if (ENVIRONMENT_IS_NODE) {
            data = require('fs').readFileSync(url);
        } else {
            var request = new XMLHttpRequest();
            request.open('GET', url, false);
            request.timeout = 8000;
            request.responseType = 'arraybuffer';
            request.send();
            if (request.status != 200)
                return false;
            data = new Uint8Array(request.response);
        }
    } catch (e) {
        return false;
    }
    if (data.length != size)
        return false;
    HEAPU8.set(data, buffer);
    return true;
});

// From emscripten/wasmfs.h, which declares backend_t as another type than the classes here
extern "C" int wasmfs_create_directory(const char* path, mode_t, wasmfs::backend_t);

// Starts fetching files (paths separated by newlines) without waiting, so the requests of the
// reads that follow find them in the HTTP cache or already on the way. On the page main thread:
// the thread that reads waits in its synchronous request right after, and the fetches of a worker
// went out only once it ran its event loop again (bbc.com: 0.55 s later)
static void bl_lazy_prefetch(const char* paths)
{
    MAIN_THREAD_ASYNC_EM_ASM({
        var paths = UTF8ToString($0);
        _free($0);
        if (ENVIRONMENT_IS_NODE)
            return;
        for (var path of paths.split('\n'))
            fetch(locateFile(path)).then((response) => response.arrayBuffer()).catch(() => {});
    }, strdup(paths));
}

namespace BrowserLite {

using wasmfs::DataFile;
using wasmfs::Directory;
using wasmfs::File;
using wasmfs::MemoryDirectory;
using wasmfs::Symlink;
using wasmfs::backend_t;
using wasmfs::oflags_t;

namespace {

// Files that are usually needed together (the most frequent slices of a CJK font, the data of an
// ICU locale): the first read of one fetches the others in parallel
struct Group {
    std::atomic<bool> started { false };
    std::string paths;

    void prefetch()
    {
        if (!started.exchange(true))
            bl_lazy_prefetch(paths.c_str());
    }
};

// The groups of all mounted indexes by name, for prefetchLazyGroup
struct GroupRegistry {
    std::mutex lock;
    std::map<std::string, std::shared_ptr<Group>> groups;
};

GroupRegistry& groupRegistry()
{
    static auto* registry = new GroupRegistry;
    return *registry;
}

using MissHandler = void (*)(const char* path);

class LazyFile final : public DataFile {
public:
    LazyFile(backend_t backend, std::string url, off_t size, std::shared_ptr<Group> group, MissHandler* miss)
        : DataFile(S_IRUGO, backend)
        , m_url(std::move(url))
        , m_size(size)
        , m_group(std::move(group))
        , m_miss(miss)
    {
    }

private:
    int open(oflags_t) final { return 0; }
    int close() final { return 0; }
    int flush() final { return 0; }
    off_t getSize() final { return m_size; }
    ssize_t write(const uint8_t*, size_t, off_t) final { return -EACCES; }
    int setSize(off_t) final { return -EACCES; }

    // WasmFS holds the lock of this file while it reads
    ssize_t read(uint8_t* buffer, size_t length, off_t offset) final
    {
        if (m_data.empty() && m_size) {
            if (m_group)
                m_group->prefetch();
            if (*m_miss)
                (*m_miss)(m_url.c_str());
            double start = emscripten_get_now();
            m_data.resize(m_size);
            if (!bl_lazy_fetch(m_url.c_str(), m_data.data(), m_size)) {
                log("[lazy] %s could not be loaded", m_url.c_str());
                m_data.clear();
                return -EIO;
            }
            log("[lazy] %s %lld bytes in %.0f ms", m_url.c_str(), static_cast<long long>(m_size), emscripten_get_now() - start);
        }
        if (offset >= m_size)
            return 0;
        size_t count = std::min<size_t>(length, m_size - offset);
        memcpy(buffer, m_data.data() + offset, count);
        return count;
    }

    std::string m_url;
    off_t m_size;
    std::shared_ptr<Group> m_group;
    MissHandler* m_miss;
    std::vector<uint8_t> m_data;
};

class LazyDirectory final : public MemoryDirectory {
public:
    LazyDirectory(backend_t backend)
        : MemoryDirectory(S_IRUGO | S_IXUGO, backend)
    {
    }

    std::shared_ptr<LazyDirectory> directory(const std::string& name)
    {
        if (auto child = getChild(name))
            return std::static_pointer_cast<LazyDirectory>(child);
        auto child = std::make_shared<LazyDirectory>(getBackend());
        insertChild(name, child);
        return child;
    }

    void add(const std::string& name, std::shared_ptr<File> file) { insertChild(name, std::move(file)); }

private:
    // Read only
    std::shared_ptr<DataFile> insertDataFile(const std::string&, mode_t) final { return nullptr; }
    std::shared_ptr<Directory> insertDirectory(const std::string&, mode_t) final { return nullptr; }
    std::shared_ptr<Symlink> insertSymlink(const std::string&, const std::string&) final { return nullptr; }
    int removeChild(const std::string&) final { return -EACCES; }
    int insertMove(const std::string&, std::shared_ptr<File>) final { return -EACCES; }
};

// Its only directory is the mount point, built from the index
class LazyBackend final : public wasmfs::Backend {
public:
    LazyBackend(const char* urlFolder, std::string index)
        : m_urlFolder(urlFolder)
        , m_index(std::move(index))
    {
    }

    std::shared_ptr<DataFile> createFile(mode_t) final { return nullptr; }
    std::shared_ptr<Symlink> createSymlink(std::string) final { return nullptr; }
    std::shared_ptr<Directory> createDirectory(mode_t) final
    {
        auto root = std::make_shared<LazyDirectory>(this);
        std::map<std::string, std::shared_ptr<Group>> groups;
        for (const char* line = m_index.c_str(); *line;) {
            const char* end = strchr(line, '\n');
            if (!end)
                end = line + strlen(line);
            std::string entry(line, end);
            line = *end ? end + 1 : end;
            // "<path> <size>" or "<path> <size> <group>"
            char path[512];
            char groupName[128] = "";
            long long size;
            if (sscanf(entry.c_str(), "%511s %lld %127s", path, &size, groupName) < 2)
                continue;
            std::string url = m_urlFolder + '/' + path;
            std::shared_ptr<Group> group;
            if (*groupName) {
                auto& found = groups[groupName];
                if (!found) {
                    found = std::make_shared<Group>();
                    auto& registry = groupRegistry();
                    std::lock_guard lock(registry.lock);
                    registry.groups[groupName] = found;
                }
                group = found;
                group->paths += (group->paths.empty() ? "" : "\n") + url;
            }
            std::string relative(path);
            auto directory = root;
            size_t start = 0;
            for (size_t slash; (slash = relative.find('/', start)) != std::string::npos; start = slash + 1)
                directory = directory->directory(relative.substr(start, slash - start));
            directory->add(relative.substr(start), std::make_shared<LazyFile>(this, url, size, group, &m_miss));
        }
        return root;
    }

    MissHandler m_miss { nullptr };

private:
    std::string m_urlFolder;
    std::string m_index;
};

// The backend of each mount point, for setLazyMissHandler
std::map<std::string, LazyBackend*>& backends()
{
    static auto* backends = new std::map<std::string, LazyBackend*>;
    return *backends;
}

} // namespace

void prefetchLazyGroup(const char* name)
{
    std::shared_ptr<Group> group;
    {
        auto& registry = groupRegistry();
        std::lock_guard lock(registry.lock);
        auto found = registry.groups.find(name);
        if (found == registry.groups.end())
            return;
        group = found->second;
    }
    group->prefetch();
}

void prefetchLazyFiles(const char* paths)
{
    bl_lazy_prefetch(paths);
}

bool mountLazyFiles(const char* mountPoint, const char* urlFolder, const char* index)
{
    std::string parent(mountPoint, strrchr(mountPoint, '/') - mountPoint);
    if (!parent.empty() && mkdir(parent.c_str(), 0755) && errno != EEXIST)
        return false;
    auto lazy = std::make_unique<LazyBackend>(urlFolder, index);
    backends()[mountPoint] = lazy.get();
    backend_t backend = wasmfs::wasmFS.addBackend(std::move(lazy));
    return !wasmfs_create_directory(mountPoint, S_IRUGO | S_IXUGO, backend);
}

void setLazyMissHandler(const char* mountPoint, void (*handler)(const char* path))
{
    auto found = backends().find(mountPoint);
    if (found != backends().end())
        found->second->m_miss = handler;
}

} // namespace BrowserLite
