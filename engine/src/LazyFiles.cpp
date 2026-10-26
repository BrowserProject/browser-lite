// Read-only files of the engine folder that load on first read: the ICU data beyond the core
// linked into the engine (tools/icu-data.mjs). Sizes come from an index, so stat() and the
// directory listing need no request. The first read of a file fetches it whole with a
// synchronous XMLHttpRequest on the thread that reads (every engine thread is a worker), in node
// (engine tests) from the file system. The host's HTTP cache keeps the files like the other
// engine files. A WasmFS backend: its classes come from Emscripten's system/lib/wasmfs.
#include "config.h"
#include "LazyFiles.h"

#include "Engine.h"

#include <algorithm>
#include <backend.h>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <emscripten/emscripten.h>
#include <memory_backend.h>
#include <string>
#include <vector>
#include <wasmfs.h>

// Fetches <engine folder>/<path> into buffer (size bytes); returns false when the file is
// missing or has another size
EM_JS(bool, bl_lazy_fetch, (const char* path, uint8_t* buffer, size_t size), {
    var url = locateFile(UTF8ToString(path));
    var data;
    try {
        if (ENVIRONMENT_IS_NODE) {
            data = require('fs').readFileSync(url);
        } else {
            var request = new XMLHttpRequest();
            request.open('GET', url, false);
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

namespace BrowserLite {

using wasmfs::DataFile;
using wasmfs::Directory;
using wasmfs::File;
using wasmfs::MemoryDirectory;
using wasmfs::Symlink;
using wasmfs::backend_t;
using wasmfs::oflags_t;

namespace {

class LazyFile final : public DataFile {
public:
    LazyFile(backend_t backend, std::string url, off_t size)
        : DataFile(S_IRUGO, backend)
        , m_url(std::move(url))
        , m_size(size)
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
    LazyBackend(const char* urlFolder, const char* index)
        : m_urlFolder(urlFolder)
        , m_index(index)
    {
    }

    std::shared_ptr<DataFile> createFile(mode_t) final { return nullptr; }
    std::shared_ptr<Symlink> createSymlink(std::string) final { return nullptr; }
    std::shared_ptr<Directory> createDirectory(mode_t) final
    {
        auto root = std::make_shared<LazyDirectory>(this);
        for (const char* line = m_index; *line;) {
            const char* end = strchr(line, '\n');
            if (!end)
                end = line + strlen(line);
            std::string entry(line, end);
            line = *end ? end + 1 : end;
            auto space = entry.rfind(' ');
            if (space == std::string::npos)
                continue;
            std::string path = entry.substr(0, space);
            off_t size = strtoll(entry.c_str() + space + 1, nullptr, 10);
            auto directory = root;
            size_t start = 0;
            for (size_t slash; (slash = path.find('/', start)) != std::string::npos; start = slash + 1)
                directory = directory->directory(path.substr(start, slash - start));
            directory->add(path.substr(start), std::make_shared<LazyFile>(this, m_urlFolder + '/' + path, size));
        }
        return root;
    }

private:
    std::string m_urlFolder;
    const char* m_index;
};

} // namespace

bool mountLazyFiles(const char* mountPoint, const char* urlFolder, const char* index)
{
    backend_t backend = wasmfs::wasmFS.addBackend(std::make_unique<LazyBackend>(urlFolder, index));
    return !wasmfs_create_directory(mountPoint, S_IRUGO | S_IXUGO, backend);
}

} // namespace BrowserLite
