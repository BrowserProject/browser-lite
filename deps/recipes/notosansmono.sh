# shellcheck shell=bash
# Font NotoSansMono (OFL), statische Schnitte ohne Hinting (klein, auf HiDPI gut genug)
build() {
    local dest="$BL_SYSROOT/runtime/usr/share/fonts/noto"
    mkdir -p "$dest"
    find "$SRC" -path '*/unhinted/ttf/*' -name 'NotoSansMono-*.ttf' \
        \( -name '*-Regular.ttf' -o -name '*-Bold.ttf' -o -name '*-Italic.ttf' -o -name '*-BoldItalic.ttf' \) \
        -exec cp {} "$dest/" \;
    find "$SRC" -name 'OFL.txt' -exec cp {} "$dest/NotoSansMono-OFL.txt" \; -quit
    ls "$dest"/NotoSansMono-*.ttf >/dev/null || bl_die "notosansmono: keine Fonts gefunden"
}
