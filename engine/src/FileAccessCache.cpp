// access() fuer die festen Dateien der Engine merken (Schriften, fontconfig,
// CA-Liste).
//
// Skia prueft bei jeder Schriftsuche mit access(), ob die Schriftdatei lesbar
// ist. Ohne WasmFS (BROWSER_LITE_WASMFS=OFF) geht jeder Aufruf ueber den
// Haupt-Thread der Seite (CNN: 1.6 s Warten), auch mit WasmFS spart der Cache
// die vielen Pruefungen. Unter /usr/share und /etc liegt nur, was beim Start aus
// engine.data kommt, das aendert sich nie. Eingebunden mit -Wl,--wrap=access.
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
    // Schluessel: Pfad und Modus, Wert: Rueckgabe und errno
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
