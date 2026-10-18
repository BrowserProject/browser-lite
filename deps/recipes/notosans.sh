# shellcheck shell=bash
# Font NotoSans (OFL), static unhinted styles (small, good enough on HiDPI)
build() {
    local dest="$BL_SYSROOT/runtime/usr/share/fonts/noto"
    mkdir -p "$dest"
    find "$SRC" -path '*/unhinted/ttf/*' -name 'NotoSans-*.ttf' \
        \( -name '*-Regular.ttf' -o -name '*-Bold.ttf' -o -name '*-Italic.ttf' -o -name '*-BoldItalic.ttf' \) \
        -exec cp {} "$dest/" \;
    find "$SRC" -name 'OFL.txt' -exec cp {} "$dest/NotoSans-OFL.txt" \; -quit
    ls "$dest"/NotoSans-*.ttf >/dev/null || bl_die "notosans: no fonts found"
}
