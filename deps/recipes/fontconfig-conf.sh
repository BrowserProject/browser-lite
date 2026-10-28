# shellcheck shell=bash
# fontconfig configuration for the WASM file system.
# Emscripten's --preload-file cannot handle symlinks, so the wanted rules are
# copied from conf.avail into conf.d as regular files, plus own rules (Noto as
# default, substitutes for Arial/Helvetica/Times). Not 49-sansserif: it appends
# sans-serif to unknown families, which our strong alias makes Noto Sans, so a
# stack like "SFMono-Regular, Menlo, monospace" never got past its first name.
build() {
    local root="$BL_SYSROOT/runtime"
    local avail="$root/usr/share/fontconfig/conf.avail"
    local confd="$root/etc/fonts/conf.d"
    [ -d "$avail" ] || bl_die "fontconfig-conf: $avail missing (build fontconfig first)"
    mkdir -p "$confd" "$root/var/cache/fontconfig"
    find "$confd" -maxdepth 1 -name '*.conf' -delete

    local rule
    for rule in 10-hinting-slight 10-yes-antialias 10-sub-pixel-none 11-lcdfilter-default \
                30-metric-aliases 40-nonlatin 45-generic 45-latin 48-spacing \
                60-generic 60-latin 65-nonlatin 90-synthetic; do
        cp "$avail/$rule.conf" "$confd/"
    done

    cat > "$confd/99-browser-lite.conf" <<'XML'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <!-- browser-lite: fonts the engine loads on demand (deps/recipes/lazyfonts.sh) -->
  <dir>/lazy/fonts</dir>
  <!-- browser-lite: Noto as default fonts -->
  <alias binding="strong">
    <family>sans-serif</family>
    <prefer><family>Noto Sans</family></prefer>
  </alias>
  <alias binding="strong">
    <family>serif</family>
    <prefer><family>Noto Serif</family></prefer>
  </alias>
  <alias binding="strong">
    <family>monospace</family>
    <prefer><family>Noto Sans Mono</family></prefer>
  </alias>
  <alias binding="same"><family>system-ui</family><prefer><family>Noto Sans</family></prefer></alias>
  <alias binding="same"><family>Arial</family><accept><family>Noto Sans</family></accept></alias>
  <alias binding="same"><family>Helvetica</family><accept><family>Noto Sans</family></accept></alias>
  <alias binding="same"><family>Helvetica Neue</family><accept><family>Noto Sans</family></accept></alias>
  <alias binding="same"><family>Segoe UI</family><accept><family>Noto Sans</family></accept></alias>
  <alias binding="same"><family>Roboto</family><accept><family>Noto Sans</family></accept></alias>
  <alias binding="same"><family>Times</family><accept><family>Noto Serif</family></accept></alias>
  <alias binding="same"><family>Times New Roman</family><accept><family>Noto Serif</family></accept></alias>
  <alias binding="same"><family>Georgia</family><accept><family>Noto Serif</family></accept></alias>
  <alias binding="same"><family>Courier</family><accept><family>Noto Sans Mono</family></accept></alias>
  <alias binding="same"><family>Courier New</family><accept><family>Noto Sans Mono</family></accept></alias>
  <alias binding="same"><family>Menlo</family><accept><family>Noto Sans Mono</family></accept></alias>
  <alias binding="same"><family>Consolas</family><accept><family>Noto Sans Mono</family></accept></alias>
  <!-- browser-lite: names of Apple and other system fonts that stacks list before a generic -->
  <alias binding="same"><family>ui-monospace</family><accept><family>Noto Sans Mono</family></accept></alias>
  <alias binding="same"><family>SFMono-Regular</family><accept><family>Noto Sans Mono</family></accept></alias>
  <alias binding="same"><family>SF Mono</family><accept><family>Noto Sans Mono</family></accept></alias>
  <alias binding="same"><family>Monaco</family><accept><family>Noto Sans Mono</family></accept></alias>
  <alias binding="same"><family>Lucida Console</family><accept><family>Noto Sans Mono</family></accept></alias>
  <alias binding="same"><family>ui-sans-serif</family><accept><family>Noto Sans</family></accept></alias>
  <alias binding="same"><family>ui-rounded</family><accept><family>Noto Sans</family></accept></alias>
  <alias binding="same"><family>-apple-system</family><accept><family>Noto Sans</family></accept></alias>
  <alias binding="same"><family>BlinkMacSystemFont</family><accept><family>Noto Sans</family></accept></alias>
  <alias binding="same"><family>SF Pro Text</family><accept><family>Noto Sans</family></accept></alias>
  <alias binding="same"><family>ui-serif</family><accept><family>Noto Serif</family></accept></alias>
</fontconfig>
XML
}
