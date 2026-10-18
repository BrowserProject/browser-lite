#!/usr/bin/env bash
# Shared helpers for the dependency recipes in deps/recipes/.
# Sourced by deps/build-all.sh, do not run directly.

# shellcheck source=tools/env.sh
source "$(dirname "${BASH_SOURCE[0]}")/../tools/env.sh"

export BL_DEPS_DIR="$BL_ROOT/deps"
export BL_DOWNLOADS="${BL_DOWNLOADS:-$BL_THIRD_PARTY/downloads}"
export BL_DEPS_BUILD="${BL_DEPS_BUILD:-$BL_BUILD_DIR/deps}"
export BL_JOBS="${BL_JOBS:-$(nproc)}"

# Flags for everything built for WASM. -pthread everywhere, otherwise the object
# files do not link together (atomics/bulk-memory must match everywhere).
export BL_CFLAGS="-O3 -pthread -msimd128"
export BL_CXXFLAGS="$BL_CFLAGS"
export BL_LDFLAGS="-pthread"

bl_sysroot_pkg_config

# Line from sources.txt for a name: "name type version url hash"
dep_source_line() {
    awk -v n="$1" '$1 == n { print; found = 1 } END { if (!found) exit 1 }' "$BL_DEPS_DIR/sources.txt" \
        || bl_die "$1 is not in deps/sources.txt"
}

dep_version() {
    dep_source_line "$1" | awk '{ print $3 }'
}

# Fetches the sources into $BL_DEPS_BUILD/<name>/src (always freshly unpacked).
dep_fetch() {
    local name="$1" type version url hash
    read -r _ type version url hash <<< "$(dep_source_line "$name")"
    local src="$BL_DEPS_BUILD/$name/src"
    rm -rf "$src"
    mkdir -p "$src" "$BL_DOWNLOADS"

    case "$type" in
    tar|zip|file)
        local file
        file="$BL_DOWNLOADS/$(basename "$url")"
        if [ ! -f "$file" ] || ! echo "$hash  $file" | sha256sum -c --status; then
            bl_log "$name: downloading $url"
            curl -sSfL --retry 4 --retry-delay 2 -o "$file.part" "$url"
            mv "$file.part" "$file"
        fi
        echo "$hash  $file" | sha256sum -c --status || bl_die "$name: SHA256 mismatch ($file)"
        case "$type" in
        tar) tar -xf "$file" -C "$src" --strip-components=1 ;;
        zip) unzip -q "$file" -d "$src" ;;
        file) cp "$file" "$src/" ;;
        esac
        ;;
    git)
        bl_log "$name: git $version"
        git -C "$src" init -q
        bl_retry git -C "$src" fetch -q --depth 1 "$url" "refs/tags/$version"
        git -C "$src" -c advice.detachedHead=false checkout -q FETCH_HEAD
        local actual
        actual="$(git -C "$src" rev-parse HEAD)"
        [ "$actual" = "$hash" ] || bl_die "$name: commit $actual instead of $hash"
        ;;
    none)
        # No sources, the recipe generates everything itself
        ;;
    *)
        bl_die "$name: unknown type $type"
        ;;
    esac

    # Own patches for the lib (deps/patches/<name>/*.patch)
    local p
    for p in "$BL_DEPS_DIR/patches/$name"/*.patch; do
        [ -e "$p" ] || continue
        bl_log "$name: patch $(basename "$p")"
        patch -d "$src" -p1 --quiet < "$p"
    done
}

# Builds and installs a CMake project.  dep_cmake <srcdir> [cmake-options...]
dep_cmake() {
    local src="$1"
    shift
    local build="$BL_DEPS_BUILD/$DEP_NAME/build"
    rm -rf "$build"
    emcmake cmake -S "$src" -B "$build" -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$BL_SYSROOT" \
        -DCMAKE_INSTALL_LIBDIR=lib \
        -DCMAKE_PREFIX_PATH="$BL_SYSROOT" \
        -DCMAKE_FIND_ROOT_PATH="$BL_SYSROOT" \
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
        -DBUILD_SHARED_LIBS=OFF \
        -DCMAKE_C_FLAGS="$BL_CFLAGS" \
        -DCMAKE_CXX_FLAGS="$BL_CXXFLAGS" \
        -DCMAKE_EXE_LINKER_FLAGS="$BL_LDFLAGS" \
        "$@"
    cmake --build "$build" -j "$BL_JOBS"
    cmake --install "$build"
}

# Meson cross file for Emscripten (generated once per build).
dep_meson_cross_file() {
    local f="$BL_DEPS_BUILD/emscripten.meson"
    local q_cflags q_ldflags
    # shellcheck disable=SC2086 # flags are meant to be split here
    q_cflags="$(printf "'%s', " $BL_CFLAGS)"
    # shellcheck disable=SC2086
    q_ldflags="$(printf "'%s', " $BL_LDFLAGS)"
    cat > "$f" <<MESON
[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
ranlib = 'emranlib'
strip = 'emstrip'
pkg-config = 'pkg-config'
exe_wrapper = 'node'

[built-in options]
c_args = [${q_cflags%, }]
cpp_args = [${q_cflags%, }]
c_link_args = [${q_ldflags%, }]
cpp_link_args = [${q_ldflags%, }]

[properties]
needs_exe_wrapper = true

[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
MESON
    echo "$f"
}

# Builds and installs a Meson project.  dep_meson <srcdir> [meson-options...]
dep_meson() {
    local src="$1"
    shift
    local build="$BL_DEPS_BUILD/$DEP_NAME/build"
    rm -rf "$build"
    meson setup "$build" "$src" \
        --cross-file "$(dep_meson_cross_file)" \
        --prefix "$BL_SYSROOT" \
        --libdir lib \
        --buildtype release \
        --default-library static \
        --wrap-mode nodownload \
        "$@"
    ninja -C "$build" -j "$BL_JOBS"
    meson install -C "$build" --no-rebuild
}

# Builds and installs an autotools project.  dep_autotools <srcdir> [configure-options...]
dep_autotools() {
    local src="$1"
    shift
    local build="$BL_DEPS_BUILD/$DEP_NAME/build"
    rm -rf "$build"
    mkdir -p "$build"
    (
        cd "$build" || exit 1
        CFLAGS="$BL_CFLAGS" CXXFLAGS="$BL_CXXFLAGS" LDFLAGS="$BL_LDFLAGS" \
            emconfigure "$src/configure" \
            --host=wasm32-unknown-emscripten \
            --prefix="$BL_SYSROOT" \
            --libdir="$BL_SYSROOT/lib" \
            --enable-static --disable-shared \
            "$@"
        emmake make -j "$BL_JOBS"
        emmake make install
    )
}
