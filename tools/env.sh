#!/usr/bin/env bash
# Gemeinsame Pfade und Versionen fuer alle Skripte. Wird mit `source` geladen.

BL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export BL_ROOT

set -a
# shellcheck source=versions.env
source "$BL_ROOT/versions.env"
set +a

export BL_THIRD_PARTY="${BL_THIRD_PARTY:-$BL_ROOT/third_party}"
export BL_WEBKIT_DIR="${BL_WEBKIT_DIR:-$BL_THIRD_PARTY/WebKit}"
export BL_BUILD_DIR="${BL_BUILD_DIR:-$BL_ROOT/build}"
export BL_SYSROOT="${BL_SYSROOT:-$BL_ROOT/sysroot}"

bl_log() {
    printf '==> %s\n' "$*"
}

bl_die() {
    printf 'FEHLER: %s\n' "$*" >&2
    exit 1
}

# Befehl bis zu 5 mal versuchen (Netz), Pause 2, 4, 8, 16 s
bl_retry() {
    local attempt=1 delay=2
    until "$@"; do
        [ "$attempt" -ge 5 ] && bl_die "$* ist $attempt mal fehlgeschlagen"
        bl_log "fehlgeschlagen, neuer Versuch in ${delay}s"
        sleep "$delay"
        attempt=$((attempt + 1))
        delay=$((delay * 2))
    done
}

# pkg-config soll nur unser sysroot sehen, nie die .pc Dateien vom Host
bl_sysroot_pkg_config() {
    export PKG_CONFIG_LIBDIR="$BL_SYSROOT/lib/pkgconfig:$BL_SYSROOT/share/pkgconfig"
    unset PKG_CONFIG_PATH
}

# WebKit nach WASM konfigurieren (jsc und Engine): sysroot, pthreads, SIMD, ccache.
#   bl_webkit_configure <build-ordner> <weitere cmake-Argumente>...
bl_webkit_configure() {
    local out="$1"
    shift
    command -v emcmake >/dev/null || bl_die "emcmake fehlt (im Toolchain-Image ausfuehren)"
    # sysroot kann aus einem anderen Pfad kommen (CI-Artefakt)
    "$BL_ROOT/deps/relocate-pc.sh" "$BL_SYSROOT"
    bl_sysroot_pkg_config
    local launcher=()
    if command -v ccache >/dev/null; then
        launcher=(-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache)
        # WebKit nutzt Precompiled Headers. Ohne diese Einstellung kann ccache
        # 60% der Aufrufe nicht cachen ("Could not use precompiled header").
        export CCACHE_SLOPPINESS="${CCACHE_SLOPPINESS:-pch_defines,time_macros,include_file_mtime,include_file_ctime}"
    fi
    emcmake cmake -S "$BL_WEBKIT_DIR" -B "$out" -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_PREFIX_PATH="$BL_SYSROOT" \
        -DCMAKE_FIND_ROOT_PATH="$BL_SYSROOT" \
        -DCMAKE_C_FLAGS="-pthread -msimd128" \
        -DCMAKE_CXX_FLAGS="-pthread -msimd128" \
        -DCMAKE_EXE_LINKER_FLAGS="-pthread" \
        -DDEVELOPER_MODE=OFF \
        "$@" "${launcher[@]}"
}
