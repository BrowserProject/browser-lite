# apps/demo/deploy/

The public demo: `browser-lite-server` ([packages/server](../../../packages/server/README.md)) with
the packaged demo (target `demo` of the `Dockerfile` in the repository root) behind Caddy, which
gets the certificate from Let's Encrypt and serves HTTPS and HTTP/3 (`compose.yml`, `Caddyfile`).
The browser profile lies in `/data` (named volume `profile`, kept across deploys). The server is
public, so relay and profile need the relay token: `RELAY_TOKEN` in `/opt/browser-lite/server.env`
on the server (never in the repository). Open the demo once with `?token=<token>`; it stays in
localStorage of that browser. The profile (cookies, so sign-ins) lies unencrypted on the server
([docs/security.md](../../../docs/security.md)).

The container of the demo publishes no port: only Caddy reaches it, so `RELAY_TRUST_PROXY=1`
takes the client address from `X-Forwarded-For`. Against DNS rebinding relay and `/profile/`
answer only under the domain of `server.env` (`ALLOWED_HOSTS`), otherwise 403.

## On every push to main

1. *CI* builds and tests the engine and packages it (artifact `engine-dist`).
2. *Deploy* (`.github/workflows/deploy.yml`, only after a green CI):
   - packages the demo site from `engine-dist` (`tools/package-demo.sh`), with the engine of
     the image deployed so far: it stays for open tabs, and the new engine gets deltas against
     it, which Chrome loads instead of the whole files after the update (#244)
   - builds the images and tests them read-only (`tools/build-images.sh`: headers, Brotli,
     relay, profile, clean exit on SIGTERM)
   - pushes the demo image to `DEMO_IMAGE` of `versions.env` (tags `<commit>` and `main`)
   - restarts it on the server: the job `deploy` (GitHub-hosted) logs in over SSH as `deploy`
     with its own key (repository secrets `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`).
     The login shell of `deploy` (`deploy-shell.sh`) takes only image digest, commit and the
     GitHub token on stdin, gets `compose.yml`, `Caddyfile` and `versions.env` of that commit,
     starts the image by digest with Caddy of `CADDY_IMAGE` and checks `https://<domain>/healthz`

When the CI is red, the last green state stays online. By hand: *Actions -> Deploy -> Run
workflow* with the ID of a green push run of the CI on main (without ID: the latest). The deploy
refuses other runs (red, pull request, another workflow).

Build locally: `npm ci && npm run build && tools/package-demo.sh <engine-dir> build/demo`, then
`tools/build-images.sh build/demo local` (images `<DEMO_IMAGE>:local` and `<SERVER_IMAGE>:local`).

## Set up the server

An Ubuntu or Debian server with a DNS name pointing to it (DNS only, no proxy in front):

```bash
ssh-keygen -t ed25519 -N '' -f deploy_ed25519        # the key of the deploy workflow
DOMAIN=<domain> DEPLOY_KEY_FILE=deploy_ed25519.pub apps/demo/deploy/setup-server.sh root@<host>
gh secret set DEPLOY_HOST --body <host>
gh secret set DEPLOY_SSH_KEY < deploy_ed25519
ssh-keyscan -t ed25519 <host> | gh secret set DEPLOY_KNOWN_HOSTS
```

`setup-server.sh` is repeatable: Docker, the user `deploy` (login shell `deploy-shell.sh`, its key
with `restrict`: no terminal, no forwarding), `/opt/browser-lite/server.env` with the domain and a
generated relay token (kept when it exists), SSH with keys only and at most 3 tries, fail2ban on
SSH, a firewall with only 22, 80 and 443 (TCP, and UDP for HTTP/3) open, automatic security
updates. The first deploy starts Caddy, which then gets the certificate.

## Security

The repository is public. Therefore:
- Workflows from forks run only after approval (repository setting: all outside collaborators).
- All jobs run on GitHub-hosted runners.
- Only the job `deploy` gets the `DEPLOY_` secrets (pushes to `main` of this repository, never a
  job of `pull_request`). Its key logs in only as `deploy`, whose login shell can do nothing but
  restart the demo with an image of `ghcr.io` by digest.
- The lint of the CI (`tools/check-style.sh`) checks the runners, that only that job uses the
  `DEPLOY_` secrets, and that all actions are pinned by commit.
- The container runs read-only, without capabilities, as user `node`. It can write only to the
  volume `/data` (profile). Caddy keeps only `NET_BIND_SERVICE`.
