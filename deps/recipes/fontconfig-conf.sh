# shellcheck shell=bash
# fontconfig-Konfiguration fuer das WASM-Dateisystem.
# Emscriptens --preload-file kann keine Symlinks, darum kopieren wir die
# gewuenschten Regeln aus conf.avail als normale Dateien nach conf.d und
# ergaenzen eigene Regeln (Noto als Standard, Arial/Helvetica/Times-Ersatz).
build() {
    local root="$BL_SYSROOT/runtime"
    local avail="$root/usr/share/fontconfig/conf.avail"
    local confd="$root/etc/fonts/conf.d"
    [ -d "$avail" ] || bl_die "fontconfig-conf: $avail fehlt (fontconfig zuerst bauen)"
    mkdir -p "$confd" "$root/var/cache/fontconfig"
    find "$confd" -maxdepth 1 -name '*.conf' -delete

    local rule
    for rule in 10-hinting-slight 10-yes-antialias 10-sub-pixel-none 11-lcdfilter-default \
                30-metric-aliases 40-nonlatin 45-generic 45-latin 48-spacing 49-sansserif \
                60-generic 60-latin 65-nonlatin 90-synthetic; do
        cp "$avail/$rule.conf" "$confd/"
    done

    cat > "$confd/99-browser-lite.conf" <<'XML'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <!-- browser-lite: Noto als Standardschriften -->
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
</fontconfig>
XML
}
