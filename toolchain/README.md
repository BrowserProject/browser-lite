# toolchain/

Docker-Image mit Emscripten und allen Build-Tools (cmake, ninja, meson, autotools, ccache,
Perl, Python, Ruby), lokal und in der CI das gleiche.

- `Dockerfile`: alle Build-Args sind Pflicht und kommen aus `versions.env` (Basis-Image per
  Digest, emsdk-Tag mit gepruefter Commit-Id, Meson-Wheel mit SHA256). Lokal bauen mit
  `tools/build-toolchain.sh`. Die apt-Pakete kommen aus dem Ubuntu-Archiv beim Bauen; das
  Image wird einmal gebaut und danach ueber seinen Tag wiederverwendet.
- `warm.cpp`: kleines Programm, das beim Bauen des Images die System-Libs von Emscripten
  (normal und mit pthreads) schon in den Cache bringt.

Die CI baut das Image nur, wenn es den Tag `TOOLCHAIN_IMAGE:emsdk-<version>-<hash>` noch nicht
gibt (Hash ueber alle Dateien hier ausser dieser README und ueber die Pins in `versions.env`).
Bauen und pruefen: [docs/build.md](../docs/build.md).
