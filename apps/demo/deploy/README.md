# apps/demo/deploy/

One container (target `demo` of the `Dockerfile` in the repository root): `browser-lite-server`
([packages/server](../../../packages/server/README.md)) with the packaged demo and the browser
profile in `/data` (named volume `profile` in `compose.yml`, kept across deploys). Port 8080,
without HTTPS and without a relay token: the server is for internal testing only. The profile
(cookies, so sign-ins) lies unencrypted on the server and without a token anyone who reaches the
server can read it ([docs/security.md](../../../docs/security.md)). For a public server always set
`RELAY_TOKEN` (at least 16 characters) and open the demo once with `?token=...`. Browsers grant
SharedArrayBuffer only in a secure context, so an HTTPS proxy belongs in front (here
`tailscale serve`, otherwise for example Caddy). `RELAY_TRUST_PROXY` stays unset: port 8080 is
reachable in the LAN without the proxy, so `X-Forwarded-For` could be forged there.

Against DNS rebinding relay and `/profile/` answer only under IP addresses, `localhost` and the
names of `ALLOWED_HOSTS` (in `compose.yml` `.ts.net` for `tailscale serve`, changeable with
`ALLOWED_HOSTS` in the environment of `docker compose`), otherwise 403.

## On every push to main

1. *CI* builds and tests the engine and packages it (artifact `engine-dist`).
2. *Deploy* (`.github/workflows/deploy.yml`, only after a green CI):
   - packages the demo site from `engine-dist` (`tools/package-demo.sh`)
   - builds the images and tests them read-only (`tools/build-images.sh`: headers, Brotli,
     relay, profile, clean exit on SIGTERM)
   - pushes the demo image to `DEMO_IMAGE` of `versions.env` (tags `<commit>` and `main`)
   - restarts it on the server (self-hosted runner, label `browser-lite-deploy`) with
     `compose.yml` by digest and checks `/healthz`

When the CI is red, the last green state stays online. By hand: *Actions -> Deploy -> Run
workflow* with the ID of a green push run of the CI on main (without ID: the latest). The deploy
refuses other runs (red, pull request, another workflow).

Build locally: `npm ci && npm run build && tools/package-demo.sh <engine-dir> build/demo`, then
`tools/build-images.sh build/demo local` (images `<DEMO_IMAGE>:local` and `<SERVER_IMAGE>:local`).

## Set up the server (Proxmox)

```bash
CT_IP=<ip>/<net> CT_GW=<gateway> CT_STORAGE=<storage> apps/demo/deploy/setup-proxmox.sh root@<proxmox-host>
```

Creates an unprivileged LXC with Docker, registers the runner and makes the demo reachable with
HTTPS in the tailnet through `tailscale serve` of the host. Repeatable, existing parts stay.

The runner has only the label `browser-lite-deploy` (no default labels like `self-hosted`) and
does not update itself: it stays on `RUNNER_VERSION` of `versions.env`. For a new version change
`RUNNER_VERSION` and `RUNNER_SHA256` and run the script again; it then installs the runner from
scratch. GitHub stops accepting outdated runners after a while, then the deploy waits in the
queue. The registration token never goes over a command line.

Afterwards the demo is reachable in the tailnet under `https://<host>/`.

## Security

The repository is public and the runner runs in the LAN. Therefore:
- Workflows from forks run only after approval (repository setting: all outside collaborators).
- Only the job `deploy` uses the label `browser-lite-deploy`, and only after a push to `main` in
  this repository. Never let another job or `pull_request` run on it.
- No action runs on the runner (no `uses:`), only own commands. The job fetches `compose.yml`
  with `curl` from the GitHub API.
- The lint of the CI (`tools/check-style.sh`) checks both, and that all actions are pinned by
  commit.
- The container runs read-only, without capabilities, as user `node`. It can write only to the
  volume `/data` (profile).
