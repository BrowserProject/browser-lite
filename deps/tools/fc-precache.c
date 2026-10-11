// Erzeugt den fontconfig-Cache fuer das WASM-Dateisystem der Engine.
//
// fontconfig liest beim ersten Gebrauch alle Schriften mit FreeType ein, um
// seinen Cache aufzubauen. In der Engine dauert das ueber 5 Sekunden (jeder
// Dateizugriff geht ueber den Haupt-Thread). Darum bauen wir den Cache schon
// beim Build, mit genau denselben Pfaden wie in der Engine und mit der
// gleichen Architektur (wasm32), und legen ihn ins Datenpaket.
//
// fontconfig haelt einen Cache fuer gueltig, wenn das Verzeichnis die mtime 0
// hat. Das setzen wir hier und in der Engine (engine/src/main.cpp).
//
//   node fc-precache.js <host-ordner-fuer-den-cache> [-v]
#include <dirent.h>
#include <errno.h>
#include <emscripten/emscripten.h>
#include <fontconfig/fontconfig.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <utime.h>

// Emscriptens link() meldet EMLINK, dann gibt fontconfig beim Sperren auf und
// schreibt keinen Cache. Mit EPERM nimmt es den Ersatzweg (mkdir als Sperre).
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
        fprintf(stderr, "Aufruf: fc-precache.js <cache-ordner>\n");
        return 2;
    }
    EM_ASM({ FS.mkdirTree('/var/cache/fontconfig'); });
    zeroMtimes("/usr/share/fonts");
    if (argc > 2 && !strcmp(argv[2], "-v"))
        setenv("FC_DEBUG", "16", 1);

    if (!FcInit()) {
        fprintf(stderr, "FcInit fehlgeschlagen\n");
        return 1;
    }
    FcPattern* pattern = FcPatternCreate();
    FcObjectSet* objects = FcObjectSetBuild(FC_FAMILY, FC_STYLE, FC_FILE, (char*)0);
    FcFontSet* fonts = FcFontList(NULL, pattern, objects);
    int count = fonts ? fonts->nfont : 0;
    printf("fontconfig: %d Schriften im Cache\n", count);
    if (fonts)
        FcFontSetDestroy(fonts);
    FcObjectSetDestroy(objects);
    FcPatternDestroy(pattern);
    FcFini();

    // fontconfig schreibt in /var/cache/fontconfig (im Speicher). In einen
    // eingehaengten NODEFS-Ordner schreibt es nichts (atomares Umbenennen
    // klappt dort nicht), darum die fertigen Dateien von Hand kopieren.
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
    printf("fontconfig: %d Cache-Dateien geschrieben\n", count);
    return count > 0 ? 0 : 1;
}
