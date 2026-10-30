#!/usr/bin/env bash
# Login shell of the user deploy on the server (setup-proxmox.sh). The job deploy of
# .github/workflows/deploy.yml reaches it through Tailscale SSH and can only run this:
#
#   deploy-shell -c '<image digest> <commit> <user>'    (the GitHub token on stdin)
#
# Gets compose.yml of that commit from the GitHub API, starts the image by digest and checks
# /healthz. Anything else is refused.
set -euo pipefail

repo=BrowserProject/browser-lite
dir=/opt/browser-lite

if [ "$#" != 2 ] || [ "$1" != -c ]; then
    echo "deploy-shell: only -c '<image> <commit> <user>'" >&2
    exit 2
fi
read -r image sha user extra <<<"$2"
if [[ ! "$image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ || ! "$sha" =~ ^[0-9a-f]{40}$ ||
    ! "$user" =~ ^[A-Za-z0-9-]+(\[bot\])?$ || -n "${extra:-}" ]]; then
    echo "deploy-shell: invalid arguments" >&2
    exit 2
fi
IFS= read -r token
[ -n "$token" ] || { echo "deploy-shell: no token on stdin" >&2; exit 2; }

cd "$dir"
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -fsSL --retry 3 --config - \
    -H 'Accept: application/vnd.github.raw' -o compose.yml.new \
    "https://api.github.com/repos/$repo/contents/apps/demo/deploy/compose.yml?ref=$sha"
mv compose.yml.new compose.yml
printf '%s' "$token" | docker login ghcr.io -u "$user" --password-stdin >/dev/null
printf 'IMAGE=%s\n' "$image" > image.env
docker compose -p browser-lite --env-file image.env pull -q
docker compose -p browser-lite --env-file image.env up -d --wait --wait-timeout 60
curl -fsS http://127.0.0.1:8080/healthz
running="$(docker inspect --format '{{.Image}}' browser-lite-browser-lite-1)"
[ "$running" = "$(docker image inspect --format '{{.Id}}' "$image")" ] || { echo "deploy-shell: wrong image running" >&2; exit 1; }
docker image prune -af >/dev/null
