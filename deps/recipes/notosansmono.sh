# shellcheck shell=bash
# Font NotoSansMono (OFL), static unhinted styles (small, good enough on HiDPI), loaded on demand
# (lazy/fonts, see lazyfonts.sh)
build() {
    local dest="$BL_SYSROOT/runtime/usr/share/fonts/noto"
    local lazy="$BL_SYSROOT/lazy/fonts/noto"
    mkdir -p "$dest" "$lazy"
    rm -f "$dest"/NotoSansMono-* "$lazy"/NotoSansMono-*
    find "$SRC" -path '*/unhinted/ttf/*' -name 'NotoSansMono-*.ttf' \
        \( -name '*-Regular.ttf' -o -name '*-Bold.ttf' -o -name '*-Italic.ttf' -o -name '*-BoldItalic.ttf' \) \
        -exec cp {} "$lazy/" \;
    find "$SRC" -name 'OFL.txt' -exec cp {} "$dest/NotoSansMono-OFL.txt" \; -quit
    ls "$lazy"/NotoSansMono-*.ttf >/dev/null || bl_die "notosansmono: no fonts found"
}
