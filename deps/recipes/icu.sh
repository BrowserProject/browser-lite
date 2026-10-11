# shellcheck shell=bash
# ICU: Unicode, Zeichensaetze, Textumbruch, Collation. WebKit braucht >= 70.1.
# Cross-Build: zuerst ICU fuer den Host bauen (die Tools erzeugen die Daten),
# dann fuer WASM mit --with-cross-build. Daten werden statisch eingelinkt:
# Der WASM-Build baut nur Stub-Daten (das data/ Verzeichnis braucht die Tools),
# darum machen wir libicudata.a selber aus dem .dat Archiv vom Host-Build.
build() {
    local host="$BL_DEPS_BUILD/$DEP_NAME/host"
    local out="$BL_DEPS_BUILD/$DEP_NAME/build"
    local cfg="$SRC/source/config"

    bl_log "icu: Host-Build (fuer die Daten-Tools)"
    mkdir -p "$host"
    (
        cd "$host" || exit 1
        CC=gcc CXX=g++ CFLAGS="-O2" CXXFLAGS="-O2" "$SRC/source/configure" \
            --disable-shared --enable-static \
            --disable-tests --disable-samples --disable-extras --disable-icuio --disable-layoutex \
            --with-data-packaging=archive
        make -j "$BL_JOBS"
    )

    # ICU kennt Emscripten nicht und nimmt dann config/mh-unknown. Wir nehmen die
    # Linux-Einstellungen, aber ohne GENCCODE_ASSEMBLY: sonst erzeugt genccode
    # x86-Assembler fuer die Daten, den emcc nicht versteht. So wird es C-Code.
    sed '/^GENCCODE_ASSEMBLY/d' "$cfg/mh-linux" > "$cfg/mh-unknown"

    bl_log "icu: WASM-Build"
    mkdir -p "$out"
    (
        cd "$out" || exit 1
        CFLAGS="$BL_CFLAGS" CXXFLAGS="$BL_CXXFLAGS" LDFLAGS="$BL_LDFLAGS" \
            emconfigure "$SRC/source/configure" \
            --host=wasm32-unknown-emscripten \
            --with-cross-build="$host" \
            --prefix="$BL_SYSROOT" \
            --libdir="$BL_SYSROOT/lib" \
            --enable-static --disable-shared \
            --disable-tools --disable-tests --disable-samples --disable-extras \
            --disable-icuio --disable-layoutex \
            --with-data-packaging=static
        emmake make -j "$BL_JOBS"
        emmake make install
    )

    bl_log "icu: Daten als statische Lib"
    local dat
    dat="$(find "$host/data/out" -maxdepth 1 -name 'icudt*l.dat' | head -n 1)"
    [ -n "$dat" ] || bl_die "icu: kein .dat Archiv im Host-Build gefunden"
    local gen="$BL_DEPS_BUILD/$DEP_NAME/data"
    mkdir -p "$gen"
    # genccode macht aus dem Archiv eine .c Datei mit dem Symbol icudtNN_dat
    LD_LIBRARY_PATH="$host/lib" "$host/bin/genccode" -d "$gen" "$dat"
    local csrc
    csrc="$(find "$gen" -name '*.c' | head -n 1)"
    # shellcheck disable=SC2086
    emcc $BL_CFLAGS -I"$BL_SYSROOT/include" -c "$csrc" -o "$gen/icudata.o"
    rm -f "$BL_SYSROOT/lib/libicudata.a"
    emar rcs "$BL_SYSROOT/lib/libicudata.a" "$gen/icudata.o"
    bl_log "icu: libicudata.a $(du -h "$BL_SYSROOT/lib/libicudata.a" | cut -f1)"
}
