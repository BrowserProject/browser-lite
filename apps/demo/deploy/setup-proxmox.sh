#!/usr/bin/env bash
# Sets up browser-lite on a Proxmox host (repeatable): LXC with Docker and Tailscale, the user
# deploy for the deploy workflow (Tailscale SSH, login shell deploy-shell.sh), HTTPS through
# Tailscale on the host.
#
#   CT_IP=10.0.0.5/24 CT_GW=10.0.0.1 TS_AUTHKEY_FILE=<file> apps/demo/deploy/setup-proxmox.sh root@<proxmox-host>
#
# TS_AUTHKEY_FILE: file with a Tailscale auth key for tag:browser-lite (only needed until the
# container is in the tailnet). Optional: CT_ID (105), CT_STORAGE (local-lvm), CT_DNS (CT_GW),
# TS_SERVE (1, 0 = off).
set -euo pipefail
here="$(dirname "$0")"
# shellcheck source=versions.env
source "$here/../../../versions.env"

target="${1:?Usage: CT_IP=... CT_GW=... TS_AUTHKEY_FILE=... apps/demo/deploy/setup-proxmox.sh root@<proxmox-host>}"
: "${CT_IP:?CT_IP missing (for example 10.0.0.5/24)}" "${CT_GW:?CT_GW missing}"
ct="${CT_ID:-105}"
authkey=""
[ -n "${TS_AUTHKEY_FILE:-}" ] && authkey="$(cat "$TS_AUTHKEY_FILE")"

# The login shell of deploy goes to the host first, the key only through stdin
scp -q "$here/deploy-shell.sh" "$target:/tmp/browser-lite-deploy-shell"

# shellcheck disable=SC2087 # the values are meant to be expanded locally
ssh "$target" bash -s <<EOF
set -euo pipefail
ct="$ct"
if ! pct status "\$ct" >/dev/null 2>&1; then
    template="\$(pveam list local | awk '/debian-13-standard/ {print \$1}' | sort | tail -1)"
    if [ -z "\$template" ]; then
        pveam update >/dev/null
        name="\$(pveam available --section system | awk '/debian-13-standard/ {print \$2}' | sort | tail -1)"
        pveam download local "\$name"
        template="local:vztmpl/\$name"
    fi
    pct create "\$ct" "\$template" --hostname browser-lite \
        --description "browser-lite: Docker + Tailscale SSH for deploys (apps/demo/deploy/setup-proxmox.sh)" \
        --unprivileged 1 --features nesting=1,keyctl=1 --onboot 1 --timezone host \
        --cores 2 --memory 2048 --swap 512 --rootfs "${CT_STORAGE:-local-lvm}:16" \
        --net0 "name=eth0,bridge=vmbr0,ip=$CT_IP,gw=$CT_GW" --nameserver "${CT_DNS:-$CT_GW}"
fi
[ "\$(pct status "\$ct")" = "status: running" ] || pct start "\$ct"
pct exec "\$ct" -- timeout 60 sh -c 'until getent hosts deb.debian.org >/dev/null; do sleep 1; done'
pct push "\$ct" /tmp/browser-lite-deploy-shell /usr/local/bin/browser-lite-deploy-shell --perms 755
rm /tmp/browser-lite-deploy-shell

pct exec "\$ct" -- bash -s <<'CT'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io docker-compose curl ca-certificates unattended-upgrades

# Tailscale from its signed repository, the key checked against versions.env
keyring=/usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL -o "\$keyring.new" https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg
echo "$TAILSCALE_KEYRING_SHA256  \$keyring.new" | sha256sum -c -
mv "\$keyring.new" "\$keyring"
echo "deb [signed-by=\$keyring] https://pkgs.tailscale.com/stable/debian trixie main" > /etc/apt/sources.list.d/tailscale.list
apt-get update -q
apt-get install -y -q tailscale
# Unprivileged container without /dev/net/tun: Tailscale SSH works in userspace networking
echo 'FLAGS="--tun=userspace-networking"' > /etc/default/tailscaled
systemctl restart tailscaled

# The deploy workflow logs in as deploy and can only run deploy-shell.sh
grep -qx /usr/local/bin/browser-lite-deploy-shell /etc/shells || echo /usr/local/bin/browser-lite-deploy-shell >> /etc/shells
id deploy >/dev/null 2>&1 || useradd -m -s /usr/local/bin/browser-lite-deploy-shell -G docker deploy
usermod -s /usr/local/bin/browser-lite-deploy-shell -G docker deploy
install -d -o deploy -g deploy -m 750 /opt/browser-lite
chown -R deploy:deploy /opt/browser-lite

# The GitHub runner of earlier setups
if [ -d /home/runner/actions-runner ]; then
    if [ -f /home/runner/actions-runner/.service ]; then (cd /home/runner/actions-runner && ./svc.sh stop && ./svc.sh uninstall); fi
    userdel -r runner 2>/dev/null || true
fi
CT

if [ -n '$authkey' ]; then
    printf '%s' '$authkey' | pct exec "\$ct" -- sh -c 'umask 077; cat > /root/ts-authkey'
fi
pct exec "\$ct" -- sh -c 'if [ -f /root/ts-authkey ]; then tailscale up --ssh --hostname browser-lite --advertise-tags tag:browser-lite --auth-key file:/root/ts-authkey; rm /root/ts-authkey; else tailscale set --ssh; fi; tailscale status --self --peers=false'

if [ "${TS_SERVE:-1}" = 1 ]; then
    tailscale serve --bg --yes "http://${CT_IP%/*}:8080"
    tailscale serve status
fi
EOF
