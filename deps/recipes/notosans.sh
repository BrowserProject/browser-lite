# shellcheck shell=bash
# Font NotoSans (OFL), static unhinted Regular and Bold for the data package (small, good enough
# on HiDPI). The italics, Noto Serif and Noto Sans Mono load on demand (lazyfonts.sh).
build() {
    local dest="$BL_SYSROOT/runtime/usr/share/fonts/noto"
    rm -rf "$dest"
    mkdir -p "$dest"
    find "$SRC" -path '*/unhinted/ttf/*' \( -name 'NotoSans-Regular.ttf' -o -name 'NotoSans-Bold.ttf' \) \
        -exec cp {} "$dest/" \;
    find "$SRC" -name 'OFL.txt' -exec cp {} "$dest/NotoSans-OFL.txt" \; -quit
    ls "$dest"/NotoSans-Regular.ttf "$dest"/NotoSans-Bold.ttf >/dev/null || bl_die "notosans: no fonts found"
}
