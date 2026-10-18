// Remembers access() for the fixed files of the engine (fonts, fontconfig, CA
// list).
//
// Skia checks with access() whether the font file is readable on every font
// lookup. The cache saves the many checks. Under /usr/share and /etc there is
// only what comes from engine.data at start, which never changes. Hooked in
// with -Wl,--wrap=access.
#include "config.h"

#include <cstring>
#include <unistd.h>
#include <wtf/HashMap.h>
#include <wtf/Lock.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringHash.h>
#include <wtf/text/WTFString.h>

extern "C" {
int __real_access(const char*, int);
int __wrap_access(const char* path, int mode);
}

static bool isFixedPath(const char* path)
{
    return !strncmp(path, "/usr/share/", 11) || !strncmp(path, "/etc/", 5);
}

int __wrap_access(const char* path, int mode)
{
    if (!path || !isFixedPath(path))
        return __real_access(path, mode);

    static Lock lock;
    static NeverDestroyed<HashMap<String, std::pair<int, int>>> answers;
    // Key: path and mode, value: return value and errno
    String key = makeString(String::fromUTF8(path), ':', mode);
    {
        Locker locker { lock };
        auto it = answers->find(key);
        if (it != answers->end()) {
            if (it->value.first)
                errno = it->value.second;
            return it->value.first;
        }
    }
    int result = __real_access(path, mode);
    int error = result ? errno : 0;
    {
        Locker locker { lock };
        answers->set(key.isolatedCopy(), std::make_pair(result, error));
    }
    if (result)
        errno = error;
    return result;
}
