# AGENTS.md

browser-lite: WebKit compiled to WebAssembly, a full browser engine inside a web page. The repo
is a core for integrations into other websites; `apps/demo` is a full browser built on it for
testing. Overview in [README.md](README.md), background in [docs/](docs/), every folder has a
short README.

## main and deploy

The project is a test and not in production yet. Work happens directly on `main`: commit and
push at any time without asking, also just to try something. That is the normal way and should
be done. Never force-push.

Every push to `main` runs through CI and then through *Deploy*, which brings the demo server to
exactly that state ([deploy/README.md](deploy/README.md)). After a push wait
for both runs (`gh run watch`), fix and push again if red. Do not push again while a deploy is
pending. Green only means it builds and starts: if behaviour changes, check in a real browser.

Changes to `toolchain/`, `deps/` or `engine/patches/` rebuild large parts of WebKit (hours).
Keep the paths of `build/`, `sysroot/`, `third_party/`, `toolchain/` and `deps/` stable, they
are part of cache keys.

## Code and docs

Simple, understandable, durable code. Build features cleanly into the architecture instead of
bolting them on, even if that is more work. Anything needed in several places exists once as a
reusable module. Respect the layering in [docs/architektur.md](docs/architektur.md): only
`packages/core` talks to the engine (`_bl_*`, `Module`), apps and examples use the public
package APIs only (checked by `tests/contract`).

The project is a test and not in production, so no backwards compatibility: no migration of old
stored data, no old build variants, no old names or formats, always switch over cleanly. Before
removing a feature that was not clearly asked to be removed: ask.

Docs short, only what is needed, and kept current (README of the folder, matching chapter in
`docs/`, `docs/status.md`). Comments sparse, only for the non-obvious, never for intermediate
states or migrations. Everything in English: code, comments, docs, commit messages and texts
users see. Comments and docs are ASCII only, no dash punctuation (` - `, en/em dashes). User
facing texts are English defaults that integrators can override.

Versions live in `versions.env` (toolchain, images, Node), dependencies with SHA256 in
`deps/sources.txt`, npm packages exact in the root `package-lock.json`. Dockerfiles and downloads
are pinned, downloads with checksum. Shell scripts: `set -euo pipefail`, shellcheck clean.
Changes to WebKit only as patches ([docs/build.md](docs/build.md)).

The public API of the packages is semver. Changing it means updating the API snapshot
(`npm run api:update`) on purpose. The internal engine contract is `engine/abi.json`.

## Secrets and security

The repo is public: never commit secrets, tokens, server IPs or names from the home network.
Never log tokens. The demo server runs internally without a relay token; never expose it
publicly (for example Tailscale Funnel) without setting `RELAY_TOKEN` first.

The self-hosted runner (label `browser-lite-deploy`) is in the LAN. Only the job `deploy` in
`deploy.yml` may use it, never a job that runs for pull requests or forks.

## Checks

Before pushing, depending on the change:

```bash
npm ci
npm run check        # style, shellcheck, biome, types, contract tests
npm test             # unit tests without engine build
```

Engine, JSC and end-to-end suites need the WebKit build and run in CI; locally see
[tests/README.md](tests/README.md).
