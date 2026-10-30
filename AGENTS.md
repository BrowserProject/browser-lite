# AGENTS.md

browser-lite: WebKit compiled to WebAssembly, a full browser engine inside a web page, packaged
as libraries for other sites; `apps/demo` is a full browser built on them for testing. Overview
in [README.md](README.md), background in [docs/](docs/), every folder has a short README.

## Layout and boundaries

| Folder | |
|---|---|
| `engine/` | WebKit embedder (`src/`, `js/`), WebKit patches (`patches/`), contract `abi.json` |
| `packages/core` | The only code that touches the Emscripten module (`_bl_*`, `Module`, `HEAPU8`) |
| `packages/transport-wisp`, `ui`, `profile` | Import `@browser-lite/core` only as types (exact peer dependency) |
| `packages/server` | Node only: `node:` modules and its own dependencies |
| `apps/demo`, `examples/` | Public package entry points only, never engine internals |
| `tests/` | Suites, see [tests/README.md](tests/README.md) |
| `tools/`, `toolchain/`, `deps/` | Build, packaging and style scripts; toolchain image; WASM libraries |

`tests/contract/deps-test.mjs` checks these boundaries, `tests/contract/abi-test.mjs` checks
`engine/abi.json` against the engine and the core. Architecture: [docs/architecture.md](docs/architecture.md).

## main and deploy

The project is a test and not in production yet. Work happens directly on `main`: commit and
push at any time without asking, also just to try something. That is the normal way and should be
done. Never force-push.

Every push to `main` runs through CI and then through *Deploy*, which brings the demo server to
exactly that state ([apps/demo/deploy/README.md](apps/demo/deploy/README.md)). After a push wait
for both runs (`gh run watch`), fix and push again if red. Do not push again while a deploy is
pending. Green only means it builds and starts: if behaviour changes, check in a real browser.

## Expensive changes

Changes to `toolchain/`, `deps/` or `engine/patches/` rebuild large parts of WebKit (hours; CI
continues a timed-out build on rerun, [docs/build.md](docs/build.md)). Batch them. Keep the paths
of `build/`, `sysroot/`, `third_party/`, `toolchain/` and `deps/` stable: they are part of cache
keys. Changes to WebKit only as patches.

## Code and docs

Simple, understandable, durable code. Build features cleanly into the architecture instead of
bolting them on, even if that is more work. Anything needed in several places exists once as a
reusable module. TypeScript strict, ESM, small modules with one responsibility, TSDoc on every
public export, formatted with Biome.

The project is a test and not in production, so no backwards compatibility: no migration of old
stored data, no old build variants, no old names or formats, always switch over cleanly. Before
removing a feature that was not clearly asked to be removed: ask.

Docs short, only what is needed, one place per topic (link instead of repeating), and kept current:
the folder README, the matching chapter in `docs/`, `docs/status.md`, and a new entry in
`docs/decisions.md` for every decision. Comments sparse, only for the non-obvious, never for
intermediate states or migrations. Everything in English: code, comments, docs, commit messages
and texts users see. Comments and docs are ASCII only, no dash punctuation (` - `, en or em
dashes). User facing texts are English defaults that integrators can override.

## Versions

Versions live in `versions.env` (WebKit, Emscripten, images, Node, runner), dependencies with
SHA256 in `deps/sources.txt`, npm packages exact in the root `package-lock.json`. Dockerfiles and
downloads are pinned, downloads with checksum. Shell scripts: `set -euo pipefail`, shellcheck
clean. All packages share one version.

## Public API

The exports of `packages/*/src/index.ts` and their types are the public API and follow semver.
Changing them is deliberate: update the package README and `docs/` in the same commit. The
internal contract between engine and core is `engine/abi.json` (exports `bl_*` for the host,
`bl__*` internal, hooks, events, features, environment); engine and core are released together
with the same version.

## Secrets and security

The repo is public: never commit secrets, tokens, server IPs or names from the home network.
Never log tokens. The demo server runs internally without a relay token; never expose it
publicly (for example Tailscale Funnel) without setting `RELAY_TOKEN` or `RELAY_SECRET` first.
Threat model: [docs/security.md](docs/security.md).

All jobs run on GitHub-hosted runners, never a self-hosted one. Only the job `deploy` in
`deploy.yml` joins the tailnet (OIDC, Tailscale SSH to the server as `deploy`), never a job that
runs for pull requests or forks. Actions are pinned by commit SHA.

## Checks

Before pushing, depending on the change:

```bash
npm ci
npm run check        # style and links, Biome, types, contract tests
npm test             # unit tests of all packages, no engine needed
git ls-files -z '*.sh' | xargs -0 shellcheck -x
```

Engine, JSC and browser suites need an engine build and run in CI; how to run them locally:
[tests/README.md](tests/README.md).
