# shellcheck shell=bash
# Hunspell dictionaries the engine loads on demand (engine/src/Spelling.cpp, LazyFiles.cpp):
# every dict-* line of sources.txt but the licenses, as <language>.aff and <language>.dic. They go
# to sysroot/lazy/dictionaries, which the engine build copies to lazy/dictionaries next to the
# engine; the index goes into the data package as
# /usr/share/browser-lite/lazy-dictionaries.txt ("<path> <size> <language>" per line, the files
# of a language are one group).
# shellcheck disable=SC2034 # read by deps/build-all.sh
DEP_FILES=(sources.txt)

build() {
    local lazy="$BL_SYSROOT/lazy/dictionaries"
    local names name file
    rm -rf "$lazy"
    mkdir -p "$lazy"
    mapfile -t names < <(awk '$1 ~ /^dict-/ && $1 !~ /-license$/ { print $1 }' "$BL_DEPS_DIR/sources.txt")
    for name in "${names[@]}"; do
        dep_fetch "$name" >&2
        file="$(find "$BL_DEPS_BUILD/$name/src" -type f | head -n 1)"
        case "$file" in
            *.aff | *.dic) cp "$file" "$lazy/" ;;
            *) bl_die "dictionaries: $name is neither .aff nor .dic" ;;
        esac
        rm -rf "${BL_DEPS_BUILD:?}/$name"
    done
    local aff
    for aff in "$lazy"/*.aff; do
        [ -f "${aff%.aff}.dic" ] || bl_die "dictionaries: ${aff%.aff}.dic missing"
    done

    local index="$BL_SYSROOT/runtime/usr/share/browser-lite/lazy-dictionaries.txt"
    mkdir -p "$(dirname "$index")"
    (cd "$lazy" && find . -type f -printf '%P %s\n' | LC_ALL=C sort) |
        sed -E 's#^(([^.]+)\.(aff|dic) [0-9]+)$#\1 \2#' > "$index"
    bl_log "dictionaries: $(wc -l < "$index") files, $(du -sh "$lazy" | cut -f1)"
}
