# shellcheck shell=bash
# Font NotoSans (OFL), static unhinted styles (small, good enough on HiDPI). Regular and Bold go
# into the data package, the italics load on demand (lazy/fonts, see lazyfonts.sh).
build() {
    local dest="$BL_SYSROOT/runtime/usr/share/fonts/noto"
    local lazy="$BL_SYSROOT/lazy/fonts/noto"
    mkdir -p "$dest" "$lazy"
    rm -f "$dest"/NotoSans-* "$lazy"/NotoSans-*
    find "$SRC" -path '*/unhinted/ttf/*' \( -name 'NotoSans-Regular.ttf' -o -name 'NotoSans-Bold.ttf' \) \
        -exec cp {} "$dest/" \;
    find "$SRC" -path '*/unhinted/ttf/*' \( -name 'NotoSans-Italic.ttf' -o -name 'NotoSans-BoldItalic.ttf' \) \
        -exec cp {} "$lazy/" \;
    find "$SRC" -name 'OFL.txt' -exec cp {} "$dest/NotoSans-OFL.txt" \; -quit
    ls "$dest"/NotoSans-Regular.ttf "$lazy"/NotoSans-Italic.ttf >/dev/null || bl_die "notosans: no fonts found"
}
