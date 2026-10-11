# patches/

`webkit/`: unsere Aenderungen am WebKit-Quellcode als `.patch` Dateien.

- Werden von `tools/apply-patches.sh` in Reihenfolge des Dateinamens angewendet.
- Neue Patches mit `tools/export-patch.sh NNNN-beschreibung` erzeugen.
- Ein Thema pro Patch, so klein wie moeglich. Details in [docs/build.md](../docs/build.md).
