# shellcheck shell=bash
# Fonts the engine loads on demand (engine/src/LazyFiles.cpp): Noto for more scripts as they
# are, the symbol fonts cut into Unicode blocks, Chinese, Japanese and Korean cut into the slices
# of Google Fonts, emoji (COLRv1) cut by Unicode emoji group (deps/tools/slice-fonts.py with
# fonttools). Everything goes to
# sysroot/lazy/fonts, which the engine build copies to lazy/fonts next to the engine; the index of
# all of lazy/fonts (also Serif, Mono and the italics of the noto* recipes) goes into the data
# package as /usr/share/browser-lite/lazy-fonts.txt ("<path> <size> [<group>]" per line).
# The sources are the font-* lines, fonttools and emoji-test of sources.txt.
# shellcheck disable=SC2034 # read by deps/build-all.sh
DEP_FILES=(sources.txt tools/slice-fonts.py)

build() {
    local lazy="$BL_SYSROOT/lazy/fonts"
    local name
    rm -rf "$lazy/scripts" "$lazy/cjk" "$lazy/emoji"
    mkdir -p "$lazy/scripts" "$lazy/cjk" "$lazy/emoji"
    fetched() { dep_fetch "$1" >&2 && find "$BL_DEPS_BUILD/$1/src" -type f | head -n 1; }

    dep_fetch fonttools >&2
    local slice=(env PYTHONPATH="$BL_DEPS_BUILD/fonttools/src" python3 "$BL_DEPS_DIR/tools/slice-fonts.py")
    local scripts cleanup
    mapfile -t scripts < <(awk '$1 ~ /^font-/ && $1 !~ /^font-(cjk|slices|emoji)/ { print $1 }' "$BL_DEPS_DIR/sources.txt")
    for name in "${scripts[@]}"; do
        case "$name" in
            font-symbols*) "${slice[@]}" blocks "$(fetched "$name")" "$lazy/scripts" ;;
            *) cp "$(fetched "$name")" "$lazy/scripts/" ;;
        esac
    done
    local lang
    for lang in sc tc jp kr; do
        "${slice[@]}" cjk "$(fetched "font-cjk-$lang")" "$(fetched "font-slices-$lang")" "$lazy/cjk"
    done
    "${slice[@]}" emoji "$(fetched font-emoji)" "$(fetched emoji-test)" "$lazy/emoji"

    local index="$BL_SYSROOT/runtime/usr/share/browser-lite/lazy-fonts.txt"
    mkdir -p "$(dirname "$index")"
    # The 20 frequency slices of a CJK font (about 3900 characters) form a group the engine fetches
    # together once a page needs one of them
    (cd "$lazy" && find . -type f -printf '%P %s\n' | LC_ALL=C sort) |
        sed -E 's#^(cjk/(.*)\.0[01][0-9]\.otf [0-9]+)$#\1 \2#' > "$index"
    bl_log "lazyfonts: $(wc -l < "$index") files, $(du -sh "$lazy" | cut -f1)"
    mapfile -t cleanup < <(awk '$1 ~ /^font-|^fonttools$|^emoji-test$/ { print $1 }' "$BL_DEPS_DIR/sources.txt")
    for name in "${cleanup[@]}"; do
        rm -rf "${BL_DEPS_BUILD:?}/$name"
    done
}
