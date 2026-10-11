# shellcheck shell=bash
# Font NotoSerif (OFL), statische Schnitte ohne Hinting (klein, auf HiDPI gut genug)
build() {
    local dest="$BL_SYSROOT/runtime/usr/share/fonts/noto"
    mkdir -p "$dest"
    find "$SRC" -path '*/unhinted/ttf/*' -name 'NotoSerif-*.ttf' \
        \( -name '*-Regular.ttf' -o -name '*-Bold.ttf' -o -name '*-Italic.ttf' -o -name '*-BoldItalic.ttf' \) \
        -exec cp {} "$dest/" \;
    find "$SRC" -name 'OFL.txt' -exec cp {} "$dest/NotoSerif-OFL.txt" \; -quit
    ls "$dest"/NotoSerif-*.ttf >/dev/null || bl_die "notoserif: keine Fonts gefunden"
}
