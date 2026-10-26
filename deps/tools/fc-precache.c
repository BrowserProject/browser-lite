// Generates the fontconfig cache for the engine's WASM file system.
//
// On first use fontconfig reads all fonts with FreeType to build its cache.
// In the engine that takes over 5 seconds (every file access goes through the
// main thread). So the cache is built at build time, with exactly the same
// paths and the same architecture (wasm32) as in the engine, and put into the
// data package.
//
// fontconfig considers a cache valid when the directory has mtime 0. This is
// set here and in the engine (engine/src/main.cpp).
//
//   node fc-precache.js <host-dir-for-the-cache> [-v]
#include <dirent.h>
#include <errno.h>
#include <emscripten/emscripten.h>
#include <fontconfig/fontconfig.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <utime.h>

// Emscripten's link() reports EMLINK, then fontconfig gives up locking and
// writes no cache. With EPERM it takes the fallback (mkdir as lock).
int link(const char* from, const char* to)
{
    (void)from;
    (void)to;
    errno = EPERM;
    return -1;
}

static void zeroMtimes(const char* path)
{
    struct utimbuf times = { 0, 0 };
    utime(path, &times);
    DIR* dir = opendir(path);
    if (!dir)
        return;
    struct dirent* entry;
    while ((entry = readdir(dir))) {
        if (entry->d_name[0] == '.')
            continue;
        char child[1024];
        snprintf(child, sizeof(child), "%s/%s", path, entry->d_name);
        struct stat info;
        if (!stat(child, &info) && S_ISDIR(info.st_mode))
            zeroMtimes(child);
    }
    closedir(dir);
    utime(path, &times);
}

int main(int argc, char** argv)
{
    if (argc < 2) {
        fprintf(stderr, "Usage: fc-precache.js <cache-dir>\n");
        return 2;
    }
    EM_ASM({ FS.mkdirTree('/var/cache/fontconfig'); });
    zeroMtimes("/usr/share/fonts");
    zeroMtimes("/lazy/fonts");
    if (argc > 2 && !strcmp(argv[2], "-v"))
        setenv("FC_DEBUG", "16", 1);

    if (!FcInit()) {
        fprintf(stderr, "FcInit failed\n");
        return 1;
    }
    FcPattern* pattern = FcPatternCreate();
    FcObjectSet* objects = FcObjectSetBuild(FC_FAMILY, FC_STYLE, FC_FILE, (char*)0);
    FcFontSet* fonts = FcFontList(NULL, pattern, objects);
    int count = fonts ? fonts->nfont : 0;
    printf("fontconfig: %d fonts in cache\n", count);
    if (fonts)
        FcFontSetDestroy(fonts);
    FcObjectSetDestroy(objects);
    FcPatternDestroy(pattern);
    FcFini();

    // fontconfig writes to /var/cache/fontconfig (in memory). It writes nothing
    // into a mounted NODEFS folder (atomic rename fails there), so copy the
    // finished files by hand.
    count = EM_ASM_INT({
        var fs = require('fs');
        var path = require('path');
        var target = UTF8ToString($0);
        var copied = 0;
        FS.readdir('/var/cache/fontconfig').forEach(function(name) {
            if (name.indexOf('.cache-') < 0 || name.indexOf('.TMP') >= 0 || name.indexOf('.NEW') >= 0 || name.indexOf('.LCK') >= 0)
                return;
            fs.writeFileSync(path.join(target, name), FS.readFile('/var/cache/fontconfig/' + name));
            copied++;
        });
        return copied;
    }, argv[1]);
    printf("fontconfig: %d cache files written\n", count);
    return count > 0 ? 0 : 1;
}
