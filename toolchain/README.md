# toolchain/

Docker image with Emscripten and all build tools (cmake, ninja, meson, autotools, ccache, Perl,
Python, Ruby), the same locally and in CI.

- `Dockerfile`: all build args are required and come from `versions.env` (base image by digest,
  emsdk tag with a checked commit ID, Meson wheel with SHA256). Build locally with
  `tools/build-toolchain.sh`. The apt packages come from the Ubuntu archive at build time; the
  image is built once and then reused by its tag.
- `warm.cpp`: small program that puts the Emscripten system libraries (plain and with pthreads)
  into the cache while the image is built.

The CI builds the image only when the tag `TOOLCHAIN_IMAGE:emsdk-<version>-<hash>` does not
exist yet (hash over all files here except this README and over the pins in `versions.env`).
Build and check: [docs/build.md](../docs/build.md).
