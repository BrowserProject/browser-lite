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
   - packages the demo site from `engine-dist` (`tools/package-demo.sh`), with the engine of
     the image deployed so far: it stays for open tabs, and the new engine gets deltas against
     it, which Chrome loads instead of the whole files after the update (#244)
   - builds the images and tests them read-only (`tools/build-images.sh`: headers, Brotli,
     relay, profile, clean exit on SIGTERM)
   - pushes the demo image to `DEMO_IMAGE` of `versions.env` (tags `<commit>` and `main`)
   - restarts it on the server: the job `deploy` (GitHub-hosted) joins the tailnet as an
     ephemeral node and logs in through Tailscale SSH as `deploy`, whose login shell
     (`deploy-shell.sh`) takes only image digest, commit and the token on stdin, gets
     `compose.yml` of that commit, starts the image and checks `/healthz`

When the CI is red, the last green state stays online. By hand: *Actions -> Deploy -> Run
workflow* with the ID of a green push run of the CI on main (without ID: the latest). The deploy
refuses other runs (red, pull request, another workflow).

Build locally: `npm ci && npm run build && tools/package-demo.sh <engine-dir> build/demo`, then
`tools/build-images.sh build/demo local` (images `<DEMO_IMAGE>:local` and `<SERVER_IMAGE>:local`).

## Set up the server (Proxmox)

```bash
CT_IP=<ip>/<net> CT_GW=<gateway> CT_STORAGE=<storage> TS_AUTHKEY_FILE=<file> apps/demo/deploy/setup-proxmox.sh root@<proxmox-host>
```

Creates an unprivileged LXC with Docker and Tailscale (userspace networking, Tailscale SSH,
host name `browser-lite`, tag `tag:browser-lite`), the user `deploy` and makes the demo reachable
with HTTPS in the tailnet through `tailscale serve` of the host. Repeatable, existing parts stay;
a GitHub runner of earlier setups is removed. `TS_AUTHKEY_FILE` (an auth key for
`tag:browser-lite`) is only needed the first time; the key goes over stdin, never a command line.

Once in Tailscale:
- Tags `tag:browser-lite` and `tag:browser-lite-ci` (owner: admins).
- Access: `tag:browser-lite-ci` may reach `tag:browser-lite` on `tcp:22`, and an `ssh` rule
  lets it log in there as `deploy` only (`"action": "accept"`).
- A trust credential (OIDC) for GitHub Actions with the subject
  `repo:BrowserProject/browser-lite:ref:refs/heads/main`, scope `auth_keys`, tag
  `tag:browser-lite-ci`. Its client ID and audience go into the repository secrets
  `TS_OIDC_CLIENT_ID` and `TS_OIDC_AUDIENCE`; there is no long-lived key.

Afterwards the demo is reachable in the tailnet under `https://<host>/`.

## Security

The repository is public and the server is in the LAN. Therefore:
- Workflows from forks run only after approval (repository setting: all outside collaborators).
- All jobs run on GitHub-hosted runners, nothing of GitHub runs in the LAN.
- Only the job `deploy` joins the tailnet (OIDC token for pushes to `main` of this repository,
  ephemeral node), never a job of `pull_request`. Its tag reaches only port 22 of the server and
  only as `deploy`, whose login shell can do nothing but restart the demo with an image of
  `ghcr.io` by digest.
- The lint of the CI (`tools/check-style.sh`) checks the runners, that only that job uses the
  tailnet, and that all actions are pinned by commit; Tailscale itself by version and SHA256
  (`versions.env`).
- The container runs read-only, without capabilities, as user `node`. It can write only to the
  volume `/data` (profile).
