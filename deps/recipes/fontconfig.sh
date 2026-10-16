# shellcheck shell=bash
# fontconfig: Font-Auswahl. Skia/WebCore (FontCacheSkia) rufen es direkt auf.
# Die Konfig-Dateien liegen zur Laufzeit im virtuellen Dateisystem unter /etc/fonts,
# die Fonts unter /usr/share/fonts. Beim Installieren landen diese Dateien in
# sysroot/runtime/ und kommen beim Linken der Engine ins WASM-Dateisystem (engine.data).
build() {
    local build="$BL_DEPS_BUILD/$DEP_NAME/build"
    local stage="$BL_DEPS_BUILD/$DEP_NAME/stage"
    rm -rf "$build" "$stage"
    meson setup "$build" "$SRC" \
        --cross-file "$(dep_meson_cross_file)" \
        --prefix "$BL_SYSROOT" \
        --libdir lib \
        --sysconfdir /etc \
        --localstatedir /var \
        --buildtype release \
        --default-library static \
        --wrap-mode nodownload \
        -Ddoc=disabled \
        -Dnls=disabled \
        -Dtests=disabled \
        -Dtools=disabled \
        -Dcache-build=disabled \
        -Dxml-backend=expat \
        -Ddefault-fonts-dirs=/usr/share/fonts \
        -Dadditional-fonts-dirs= \
        -Dcache-dir=/var/cache/fontconfig \
        -Dbaseconfig-dir=/etc/fonts \
        -Dconfig-dir=/etc/fonts/conf.d \
        -Dtemplate-dir=/usr/share/fontconfig/conf.avail \
        -Dxml-dir=/usr/share/xml/fontconfig
    ninja -C "$build" -j "$BL_JOBS"
    DESTDIR="$stage" meson install -C "$build" --no-rebuild

    cp -a "$stage$BL_SYSROOT/." "$BL_SYSROOT/"
    mkdir -p "$BL_SYSROOT/runtime"
    for d in etc usr; do
        if [ -d "$stage/$d" ]; then
            cp -a "$stage/$d" "$BL_SYSROOT/runtime/"
        fi
    done
}
