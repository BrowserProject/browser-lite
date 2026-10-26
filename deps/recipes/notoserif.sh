# shellcheck shell=bash
# Font NotoSerif (OFL), static unhinted styles (small, good enough on HiDPI), loaded on demand
# (lazy/fonts, see lazyfonts.sh)
build() {
    local dest="$BL_SYSROOT/runtime/usr/share/fonts/noto"
    local lazy="$BL_SYSROOT/lazy/fonts/noto"
    mkdir -p "$dest" "$lazy"
    rm -f "$dest"/NotoSerif-* "$lazy"/NotoSerif-*
    find "$SRC" -path '*/unhinted/ttf/*' -name 'NotoSerif-*.ttf' \
        \( -name '*-Regular.ttf' -o -name '*-Bold.ttf' -o -name '*-Italic.ttf' -o -name '*-BoldItalic.ttf' \) \
        -exec cp {} "$lazy/" \;
    find "$SRC" -name 'OFL.txt' -exec cp {} "$dest/NotoSerif-OFL.txt" \; -quit
    ls "$lazy"/NotoSerif-*.ttf >/dev/null || bl_die "notoserif: no fonts found"
}
