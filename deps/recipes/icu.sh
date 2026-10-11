# shellcheck shell=bash
# ICU: Unicode, Zeichensaetze, Textumbruch, Collation. WebKit braucht >= 70.1.
# Cross-Build: zuerst ICU fuer den Host bauen (die Tools erzeugen die Daten),
# dann fuer WASM mit --with-cross-build. Daten werden statisch eingelinkt:
# Der WASM-Build baut nur Stub-Daten (das data/ Verzeichnis braucht die Tools),
# darum machen wir libicudata.a selber aus dem .dat Archiv vom Host-Build.
# ---- Datenfilter: macht das ICU-Datenarchiv kleiner (33 MB -> 19 MB).
#
#   icu_filter_list < liste-aller-items   gibt die Items aus, die weg koennen
#
# Behalten wird:
#  - alles Grundlegende (Normalisierung, Umbruch, Locale-Hauptdaten aller Sprachen)
#  - nur die Zeichensatz-Konverter, die WebKit braucht (TextCodecICU, EncodingTables)
#  - Anzeigenamen, Waehrungen, Einheiten, Zeitzonen, Collation, Zahlwoerter nur
#    fuer die Sprachen in ICU_KEEP_LANGS (andere fallen auf root zurueck)
# Entfernt: Transliteration (braucht WebKit nicht).

ICU_KEEP_CONVERTERS="ibm-912_P100-1995 ibm-914_P100-1995 ibm-915_P100-1995 iso-8859_10-1998
ibm-921_P100-1995 iso-8859_14-1998 ibm-923_P100-1998 ibm-878_P100-1996 macos-0_2-10.2
ibm-5346_P100-1998 ibm-5347_P100-1998 ibm-5350_P100-1998 ibm-9448_X100-2005 ibm-5354_P100-1998
macos-7_3-10.2 macos-6_2-10.4 macos-29-10.2 macos-35-10.2 euc-tw-2014 euc-jp-2007
windows-950-2000 windows-949-2000 gb18030-2022
ibm-1363_P11B-1998 ibm-1373_P100-2002"

ICU_KEEP_LANGS="en de fr it rm es pt nl pl ru uk tr ar he iw ja zh ko sv da nb no nn fi cs sk
hu ro el hi id in th vi sq sr sh hr bs sl bg lt lv et ca gl eu fa ms fil tl bn ta ur sw"

icu_filter_list() {
    local item base tree lang
    while read -r item; do
        base="${item##*/}"
        tree="${item%/*}"
        [ "$tree" = "$item" ] && tree=""
        case "$tree" in
            "")
                if [[ "$base" == *.cnv ]] && ! grep -qw -- "${base%.cnv}" <<< "$ICU_KEEP_CONVERTERS"; then
                    echo "$item"
                fi
                ;;
            translit)
                echo "$item"
                ;;
            lang|region|curr|unit|zone|coll|rbnf)
                [[ "$base" == *.res ]] || continue
                case "${base%.res}" in root|pool|res_index) continue ;; esac
                lang="${base%.res}"
                lang="${lang%%_*}"
                grep -qw -- "$lang" <<< "$ICU_KEEP_LANGS" || echo "$item"
                ;;
        esac
    done
}

# icu_filter_dat <icupkg> <in.dat> <out.dat>
# Entfernt die Items aus icu_filter_list. Braucht ein behaltenes Item ein
# entferntes (z.B. zh_Hant_HK -> yue), bleibt dieses drin (neuer Versuch).
icu_filter_dat() {
    local icupkg="$1" in="$2" out="$3"
    local work
    work="$(dirname "$out")/icu-filter"
    mkdir -p "$work"
    "$icupkg" -l "$in" > "$work/items.txt"
    icu_filter_list < "$work/items.txt" > "$work/remove.txt"
    local try missing
    for try in $(seq 1 50); do
        rm -f "$out"
        if "$icupkg" -r "$work/remove.txt" "$in" "$out" 2> "$work/log.txt"; then
            bl_log "icu: $(wc -l < "$work/remove.txt") von $(wc -l < "$work/items.txt") Daten-Items entfernt (Versuch $try)"
            return 0
        fi
        missing="$(sed -n 's/.*depends on missing item \(.*\)$/\1/p' "$work/log.txt" | sort -u)"
        [ -n "$missing" ] || { cat "$work/log.txt" >&2; bl_die "icu: icupkg -r fehlgeschlagen"; }
        grep -vxF -f <(printf '%s\n' "$missing") "$work/remove.txt" > "$work/remove.new" || true
        mv "$work/remove.new" "$work/remove.txt"
    done
    bl_die "icu: Abhaengigkeiten beim Filtern nicht aufgeloest"
}

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
    mkdir -p "$gen/filtered"
    LD_LIBRARY_PATH="$host/lib" icu_filter_dat "$host/bin/icupkg" "$dat" "$gen/filtered/$(basename "$dat")"
    dat="$gen/filtered/$(basename "$dat")"
    # genccode macht aus dem Archiv eine .c Datei mit dem Symbol icudtNN_dat
    # -e: Name des Einstiegspunkts ohne Endianness-Buchstaben (icudt78l.dat -> icudt78),
    # so wie ICU ihn beim Laden sucht (Symbol icudt78_dat).
    local entry
    entry="$(basename "$dat" .dat)"
    entry="${entry%l}"
    LD_LIBRARY_PATH="$host/lib" "$host/bin/genccode" -e "$entry" -d "$gen" "$dat"
    local csrc
    csrc="$(find "$gen" -name '*.c' | head -n 1)"
    # shellcheck disable=SC2086
    emcc $BL_CFLAGS -I"$BL_SYSROOT/include" -c "$csrc" -o "$gen/icudata.o"
    rm -f "$BL_SYSROOT/lib/libicudata.a"
    emar rcs "$BL_SYSROOT/lib/libicudata.a" "$gen/icudata.o"
    bl_log "icu: libicudata.a $(du -h "$BL_SYSROOT/lib/libicudata.a" | cut -f1)"
}
