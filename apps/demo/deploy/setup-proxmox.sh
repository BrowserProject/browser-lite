#!/usr/bin/env bash
# Sets up browser-lite on a Proxmox host (repeatable): LXC with Docker, GitHub runner for the
# deploy workflow, HTTPS through Tailscale on the host.
#
#   CT_IP=10.0.0.5/24 CT_GW=10.0.0.1 apps/demo/deploy/setup-proxmox.sh root@<proxmox-host>
#
# Optional: CT_ID (105), CT_STORAGE (local-lvm), CT_DNS (CT_GW), TS_SERVE (1, 0 = off).
# RUNNER_TOKEN: registration token of the repository, else gh fetches it (needs admin rights).
set -euo pipefail
# shellcheck source=versions.env
source "$(dirname "$0")/../../../versions.env"

target="${1:?Usage: CT_IP=... CT_GW=... apps/demo/deploy/setup-proxmox.sh root@<proxmox-host>}"
: "${CT_IP:?CT_IP missing (for example 10.0.0.5/24)}" "${CT_GW:?CT_GW missing}"
repo="${GITHUB_REPOSITORY:-BrowserProject/browser-lite}"
token="${RUNNER_TOKEN:-$(gh api -X POST "repos/$repo/actions/runners/registration-token" --jq .token)}"

# shellcheck disable=SC2087 # the values are meant to be expanded locally
ssh "$target" bash -s <<EOF
set -euo pipefail
ct="${CT_ID:-105}"
if ! pct status "\$ct" >/dev/null 2>&1; then
    template="\$(pveam list local | awk '/debian-13-standard/ {print \$1}' | sort | tail -1)"
    if [ -z "\$template" ]; then
        pveam update >/dev/null
        name="\$(pveam available --section system | awk '/debian-13-standard/ {print \$2}' | sort | tail -1)"
        pveam download local "\$name"
        template="local:vztmpl/\$name"
    fi
    pct create "\$ct" "\$template" --hostname browser-lite \
        --description "browser-lite: Docker + GitHub runner (apps/demo/deploy/setup-proxmox.sh)" \
        --unprivileged 1 --features nesting=1,keyctl=1 --onboot 1 --timezone host \
        --cores 2 --memory 2048 --swap 512 --rootfs "${CT_STORAGE:-local-lvm}:16" \
        --net0 "name=eth0,bridge=vmbr0,ip=$CT_IP,gw=$CT_GW" --nameserver "${CT_DNS:-$CT_GW}"
fi
[ "\$(pct status "\$ct")" = "status: running" ] || pct start "\$ct"
pct exec "\$ct" -- timeout 60 sh -c 'until getent hosts deb.debian.org >/dev/null; do sleep 1; done'

pct exec "\$ct" -- env PVE_HOST="\$(hostname)" bash -s <<'CT'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io docker-compose curl ca-certificates unattended-upgrades
id runner >/dev/null 2>&1 || useradd -m -s /bin/bash -G docker runner
install -d -o runner -g runner -m 750 /opt/browser-lite

dir=/home/runner/actions-runner
# The runner does not update itself (--disableupdate). A new RUNNER_VERSION installs it here
# from scratch and registers it again under the same name.
if [ "\$(cat "\$dir/.bl-version" 2>/dev/null || true)" != "$RUNNER_VERSION" ]; then
    if [ -f "\$dir/.service" ]; then (cd "\$dir" && ./svc.sh stop && ./svc.sh uninstall); fi
    rm -rf "\$dir"
    curl -fsSL -o /tmp/runner.tgz "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz"
    echo "$RUNNER_SHA256  /tmp/runner.tgz" | sha256sum -c -
    install -d -o runner -g runner "\$dir"
    tar xzf /tmp/runner.tgz -C "\$dir" && rm /tmp/runner.tgz
    chown -R runner:runner "\$dir"
    "\$dir/bin/installdependencies.sh" >/dev/null
    # Token through the environment (su keeps it); on the command line every process would see it
    ACTIONS_RUNNER_INPUT_TOKEN='$token' su runner -c "cd \$dir && ./config.sh --unattended --replace --disableupdate --url https://github.com/$repo --name browser-lite-\$PVE_HOST --no-default-labels --labels browser-lite-deploy"
    (cd "\$dir" && ./svc.sh install runner && ./svc.sh start)
    echo "$RUNNER_VERSION" > "\$dir/.bl-version"
fi
CT

if [ "${TS_SERVE:-1}" = 1 ]; then
    tailscale serve --bg --yes "http://${CT_IP%/*}:8080"
    tailscale serve status
fi
EOF
