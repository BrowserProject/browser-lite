# apps/demo/deploy/

The demo server: `browser-lite-server` ([packages/server](../../../packages/server/README.md)) with
the packaged demo (target `demo` of the `Dockerfile` in the repository root), reachable only inside
the owner's tailnet: `tailscale serve` on the server terminates HTTPS on its tailnet address with
the tailnet's certificate (no Funnel) and forwards to the container (`compose.yml`). There is no
public demo. SSH stays on the public address for the deploy (Tailscale in CI would need secrets
and ACLs of the tailnet, decision 307).
The browser profile lies in `/data` (named volume `profile`, kept across deploys). Relay and
profile need the relay token: `RELAY_TOKEN` in `/opt/browser-lite/server.env` on the server (never
in the repository). Open the demo once with `?token=<token>`; it stays in localStorage of that
browser. The profile (cookies, so sign-ins) lies unencrypted on the server
([docs/security.md](../../../docs/security.md)).

The container publishes its port on the loopback interface only: just `tailscale serve` reaches
it and puts the client address last in `X-Forwarded-For`, so `RELAY_TRUST_PROXY=1`. Against DNS
rebinding relay and `/profile/` answer only under the domain of `server.env` (`ALLOWED_HOSTS`, the
node's MagicDNS name), otherwise 403.

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
     with its own key. Repository secrets `DEPLOY_HOST` (the server's public address),
     `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS`. The login shell of `deploy`
     (`deploy-shell.sh`) takes only image digest, commit and the GitHub token on stdin, gets
     `compose.yml` of that commit, starts the image by digest and checks `https://<domain>/healthz`

When the CI is red, the last green state stays online. By hand: *Actions -> Deploy -> Run
workflow* with the ID of a green push run of the CI on main (without ID: the latest). The deploy
refuses other runs (red, pull request, another workflow).

Build locally: `npm ci && npm run build && tools/package-demo.sh <engine-dir> build/demo`, then
`tools/build-images.sh build/demo local` (images `<DEMO_IMAGE>:local` and `<SERVER_IMAGE>:local`).

## Set up the server

An Ubuntu or Debian server (a VM or container with Docker is enough) and an auth key of the
tailnet (one-off, not ephemeral):

```bash
ssh-keygen -t ed25519 -N '' -f deploy_ed25519        # the key of the deploy workflow
TAILSCALE_HOSTNAME=browserlite DEPLOY_KEY_FILE=deploy_ed25519.pub TAILSCALE_AUTHKEY_FILE=<file> \
  TAILSCALE_PORT=41700 apps/demo/deploy/setup-server.sh root@<address>
gh secret set DEPLOY_HOST --body <address>
gh secret set DEPLOY_SSH_KEY < deploy_ed25519
ssh-keyscan -t ed25519 <address> | gh secret set DEPLOY_KNOWN_HOSTS
```

`setup-server.sh` is repeatable: Docker, Tailscale of `versions.env` (joins the tailnet as
`TAILSCALE_HOSTNAME`, `tailscale serve` on 443), the user `deploy` (login shell `deploy-shell.sh`,
its key with `restrict`: no terminal, no forwarding), `/opt/browser-lite/server.env` with the
node's MagicDNS name as domain and a generated relay token (kept when it exists), SSH with keys
only and at most 3 tries, fail2ban on SSH, a firewall with only 22, all of `tailscale0` and the
UDP port of tailscaled open, automatic security updates. `TAILSCALE_PORT` (default 41641) moves
tailscaled off 41641 for hosters whose DDoS filter drops WireGuard there (ZAP-Hosting).

## Security

The repository is public. Therefore:
- Workflows from forks run only after approval (repository setting: all outside collaborators).
- All jobs run on GitHub-hosted runners.
- Only the job `deploy` gets the `DEPLOY_` secrets (pushes to `main` of this repository, never a
  job of `pull_request`). Its key logs in only as `deploy`, whose login shell can do nothing but
  restart the demo with an image of `ghcr.io` by digest.
- The lint of the CI (`tools/check-style.sh`) checks the runners, that only that job uses the
  `DEPLOY_` secrets, and that all actions are pinned by commit.
- SSH takes keys only (fail2ban, at most 3 tries); the deploy's key logs in only as `deploy`.
- The container runs read-only, without capabilities, as user `node`. It can write only to the
  volume `/data` (profile).
