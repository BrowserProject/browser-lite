# shellcheck shell=bash
# Vorgebauter fontconfig-Cache fuer das Datenpaket der Engine
# (siehe deps/tools/fc-precache.c). Spart beim ersten Seitenaufbau mehrere Sekunden.
build() {
    local root="$BL_SYSROOT/runtime"
    local out="$BL_DEPS_BUILD/$DEP_NAME"
    local cache="$root/var/cache/fontconfig"
    [ -f "$root/etc/fonts/fonts.conf" ] || bl_die "fontcache: fonts.conf fehlt (fontconfig-conf zuerst)"
    mkdir -p "$out" "$cache"
    find "$cache" -type f -delete

    # shellcheck disable=SC2046,SC2086
    emcc $BL_CFLAGS -o "$out/fc-precache.js" "$BL_DEPS_DIR/tools/fc-precache.c" \
        $(pkg-config --cflags --static fontconfig) $(pkg-config --libs --static fontconfig) \
        --embed-file "$root/etc/fonts@/etc/fonts" \
        --embed-file "$root/usr/share/fonts@/usr/share/fonts" \
        -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 -sENVIRONMENT=node,worker
    FONTCONFIG_FILE=/etc/fonts/fonts.conf node "$out/fc-precache.js" "$cache"
    local files
    files="$(find "$cache" -type f | wc -l)"
    [ "$files" -gt 0 ] || bl_die "fontcache: kein Cache erzeugt"
    bl_log "fontcache: $files Cache-Dateien in $cache"
}
