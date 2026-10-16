# toolchain/

Docker-Image mit Emscripten und allen Build-Tools (cmake, ninja, meson, autotools, ccache,
Perl, Python, Ruby), lokal und in der CI das gleiche.

- `Dockerfile`: Build-Args `EMSDK_VERSION` (Pflicht, aus `versions.env`), `BASE_IMAGE`
  (Standard `ubuntu:24.04`, z.B. ein Mirror bei Limits von Docker Hub) und `MESON_VERSION`.
- `warm.cpp`: kleines Programm, das beim Bauen des Images die System-Libs von Emscripten
  (normal und mit pthreads) schon in den Cache bringt.

Die CI baut das Image nur, wenn es den Tag noch nicht gibt (`TOOLCHAIN_IMAGE:emsdk-<version>-<hash>`,
Hash ueber alle Dateien hier ausser dieser README).
Bauen und pruefen: [docs/build.md](../docs/build.md).
