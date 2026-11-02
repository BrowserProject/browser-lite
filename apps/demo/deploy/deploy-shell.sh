#!/usr/bin/env bash
# Login shell of the user deploy on the server (setup-server.sh). The job deploy of
# .github/workflows/deploy.yml logs in over SSH with its own key and can only run this:
#
#   deploy-shell -c '<image digest> <commit> <user>'    (the GitHub token on stdin)
#
# Gets compose.yml, Caddyfile and versions.env of that commit from the GitHub API, starts the
# image by digest behind Caddy and checks /healthz. Anything else is refused.
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
for path in apps/demo/deploy/compose.yml apps/demo/deploy/Caddyfile versions.env; do
    printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -fsSL --retry 3 --config - \
        -H 'Accept: application/vnd.github.raw' -o "$(basename "$path").new" \
        "https://api.github.com/repos/$repo/contents/$path?ref=$sha"
done
for file in compose.yml Caddyfile versions.env; do mv "$file.new" "$file"; done
caddy="$(sed -n 's/^CADDY_IMAGE=//p' versions.env)"
[[ "$caddy" =~ ^[a-z0-9._/-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$ ]] || { echo "deploy-shell: no CADDY_IMAGE" >&2; exit 1; }
printf '%s' "$token" | docker login ghcr.io -u "$user" --password-stdin >/dev/null
printf 'IMAGE=%s\nCADDY_IMAGE=%s\n' "$image" "$caddy" > image.env
compose=(docker compose -p browser-lite --env-file server.env --env-file image.env)
"${compose[@]}" pull -q
"${compose[@]}" up -d --wait --wait-timeout 90 --remove-orphans
domain="$(sed -n 's/^DOMAIN=//p' server.env)"
curl -fsS --retry 10 --retry-all-errors --retry-delay 3 "https://$domain/healthz"
running="$(docker inspect --format '{{.Image}}' browser-lite-browser-lite-1)"
[ "$running" = "$(docker image inspect --format '{{.Id}}' "$image")" ] || { echo "deploy-shell: wrong image running" >&2; exit 1; }
docker image prune -af >/dev/null
