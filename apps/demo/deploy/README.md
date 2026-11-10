# apps/demo/deploy/

The public demo: `browser-lite-server` ([packages/server](../../../packages/server/README.md)) with
the packaged demo (target `demo` of the `Dockerfile` in the repository root) behind a Cloudflare
Tunnel: `cloudflared` on the server connects outwards to Cloudflare, which serves HTTPS and HTTP/3
for the domain and forwards it to the container (`compose.yml`). The server needs no public
address and no open port besides SSH in its own network.
The browser profile lies in `/data` (named volume `profile`, kept across deploys). The server is
public, so relay and profile need the relay token: `RELAY_TOKEN` in `/opt/browser-lite/server.env`
on the server (never in the repository). Open the demo once with `?token=<token>`; it stays in
localStorage of that browser. The profile (cookies, so sign-ins) lies unencrypted on the server
([docs/security.md](../../../docs/security.md)).

The container publishes its port on the loopback interface only: just `cloudflared` reaches it,
and Cloudflare puts the client address last in `X-Forwarded-For`, so `RELAY_TRUST_PROXY=1`.
Against DNS rebinding relay and `/profile/` answer only under the domain of `server.env`
(`ALLOWED_HOSTS`), otherwise 403.

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
     with its own key, through the tunnel (`cloudflared access ssh` of `CLOUDFLARED_VERSION`;
     Cloudflare Access lets only the deploy's service token through). Repository secrets
     `DEPLOY_HOST` (the SSH host name of the tunnel), `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`,
     `DEPLOY_ACCESS_ID` and `DEPLOY_ACCESS_SECRET`. The login shell of `deploy`
     (`deploy-shell.sh`) takes only image digest, commit and the GitHub token on stdin, gets
     `compose.yml` of that commit, starts the image by digest and checks `https://<domain>/healthz`

When the CI is red, the last green state stays online. By hand: *Actions -> Deploy -> Run
workflow* with the ID of a green push run of the CI on main (without ID: the latest). The deploy
refuses other runs (red, pull request, another workflow).

Build locally: `npm ci && npm run build && tools/package-demo.sh <engine-dir> build/demo`, then
`tools/build-images.sh build/demo local` (images `<DEMO_IMAGE>:local` and `<SERVER_IMAGE>:local`).

## Set up the server

An Ubuntu or Debian server (a VM or container with Docker is enough, for example an LXC
container with nesting) and a domain in Cloudflare:

1. In Cloudflare a tunnel (remotely managed) with two public host names: `<domain>` to
   `http://127.0.0.1:8080` and `<ssh-name>` (for example `<name>-deploy.<zone>`, covered by the
   zone's certificate) to `ssh://127.0.0.1:22`; the DNS records are CNAMEs to the tunnel. A
   Cloudflare Access application for `<ssh-name>` with a service token as its only policy
   (decision "Service Auth"). Save the tunnel's token in a file.
2. Then:

```bash
ssh-keygen -t ed25519 -N '' -f deploy_ed25519        # the key of the deploy workflow
DOMAIN=<domain> DEPLOY_KEY_FILE=deploy_ed25519.pub TUNNEL_TOKEN_FILE=<file> \
  apps/demo/deploy/setup-server.sh root@<host>
gh secret set DEPLOY_HOST --body <ssh-name>
gh secret set DEPLOY_SSH_KEY < deploy_ed25519
ssh-keyscan -t ed25519 <host> | sed 's/^[^ ]*/<ssh-name>/' | gh secret set DEPLOY_KNOWN_HOSTS
gh secret set DEPLOY_ACCESS_ID --body <service token client id>
gh secret set DEPLOY_ACCESS_SECRET --body <service token client secret>
```

`setup-server.sh` is repeatable: Docker, `cloudflared` of `versions.env` as a service with the
tunnel's token, the user `deploy` (login shell `deploy-shell.sh`, its key with `restrict`: no
terminal, no forwarding), `/opt/browser-lite/server.env` with the domain and a generated relay
token (kept when it exists), SSH with keys only and at most 3 tries, fail2ban on SSH, a firewall
with only 22 open, automatic security updates.

## Security

The repository is public. Therefore:
- Workflows from forks run only after approval (repository setting: all outside collaborators).
- All jobs run on GitHub-hosted runners.
- Only the job `deploy` gets the `DEPLOY_` secrets (pushes to `main` of this repository, never a
  job of `pull_request`). Its key logs in only as `deploy`, whose login shell can do nothing but
  restart the demo with an image of `ghcr.io` by digest.
- The lint of the CI (`tools/check-style.sh`) checks the runners, that only that job uses the
  `DEPLOY_` secrets, and that all actions are pinned by commit.
- The deploy's SSH host name is reachable only with the Cloudflare Access service token of the
  secrets `DEPLOY_ACCESS_ID`/`DEPLOY_ACCESS_SECRET`; behind it the key still logs in only as
  `deploy`.
- The container runs read-only, without capabilities, as user `node`. It can write only to the
  volume `/data` (profile).
