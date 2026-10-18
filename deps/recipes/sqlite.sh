# shellcheck shell=bash
# sqlite: cookies, IndexedDB, localStorage. Builds the amalgamation (one .c file)
# directly, simpler than the autosetup build system.
build() {
    local out="$BL_DEPS_BUILD/$DEP_NAME/build"
    mkdir -p "$out" "$BL_SYSROOT/include" "$BL_SYSROOT/lib/pkgconfig"
    # shellcheck disable=SC2086
    emcc $BL_CFLAGS -c "$SRC/sqlite3.c" -o "$out/sqlite3.o" \
        -DSQLITE_THREADSAFE=1 \
        -DSQLITE_OMIT_LOAD_EXTENSION=1 \
        -DSQLITE_DEFAULT_MEMSTATUS=0 \
        -DSQLITE_ENABLE_FTS3=1 \
        -DSQLITE_ENABLE_FTS3_PARENTHESIS=1 \
        -DSQLITE_HAVE_ISNAN=1
    rm -f "$BL_SYSROOT/lib/libsqlite3.a"
    emar rcs "$BL_SYSROOT/lib/libsqlite3.a" "$out/sqlite3.o"
    cp "$SRC/sqlite3.h" "$SRC/sqlite3ext.h" "$BL_SYSROOT/include/"
    cat > "$BL_SYSROOT/lib/pkgconfig/sqlite3.pc" <<PC
prefix=$BL_SYSROOT
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: SQLite
Description: SQL database engine
Version: $(dep_version sqlite)
Libs: -L\${libdir} -lsqlite3
Cflags: -I\${includedir}
PC
}
