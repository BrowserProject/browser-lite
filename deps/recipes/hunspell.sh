# shellcheck shell=bash
# Hunspell: the spell checker of text fields (engine/src/Spelling.cpp), the same library Chrome
# uses on Linux. Only the library (its sources need no configuration; the configure script of the
# release does not know Emscripten) and a hunspell.pc, without the command line tools.
build() {
    local build="$BL_DEPS_BUILD/$DEP_NAME/build"
    local version source pids=() pid
    version="$(dep_version hunspell)"
    rm -rf "$build"
    mkdir -p "$build" "$BL_SYSROOT/include/hunspell" "$BL_SYSROOT/lib/pkgconfig"
    for source in "$SRC"/src/hunspell/*.cxx; do
        # shellcheck disable=SC2086
        em++ $BL_CXXFLAGS -DHUNSPELL_STATIC -c "$source" -o "$build/$(basename "${source%.cxx}").o" &
        pids+=("$!")
    done
    for pid in "${pids[@]}"; do
        wait "$pid"
    done
    rm -f "$BL_SYSROOT/lib/libhunspell.a"
    emar rcs "$BL_SYSROOT/lib/libhunspell.a" "$build"/*.o
    cp "$SRC"/src/hunspell/{hunspell.hxx,hunspell.h,hunvisapi.h,w_char.hxx,atypes.hxx} "$BL_SYSROOT/include/hunspell/"
    cat > "$BL_SYSROOT/lib/pkgconfig/hunspell.pc" <<PC
prefix=$BL_SYSROOT
includedir=\${prefix}/include
libdir=\${prefix}/lib

Name: hunspell
Description: Hunspell spellchecking library
Version: $version
Libs: -L\${libdir} -lhunspell
Cflags: -I\${includedir}/hunspell -DHUNSPELL_STATIC
PC
}
