#!/usr/bin/env bash
# Sets up browser-lite on an Ubuntu or Debian server (repeatable, needs root there): Docker,
# Tailscale (the demo is reachable only inside the tailnet: `tailscale serve` gives HTTPS with the
# tailnet's certificate, the domain is the node's MagicDNS name), the user deploy for the deploy
# workflow (SSH key only, login shell deploy-shell.sh), server.env with the domain and a generated
# relay token, SSH with keys only, fail2ban, a firewall with only SSH and Tailscale open,
# automatic security updates.
#
#   TAILSCALE_HOSTNAME=browser-lite DEPLOY_KEY_FILE=<public key> TAILSCALE_AUTHKEY_FILE=<file> \
#     [TAILSCALE_PORT=41700] apps/demo/deploy/setup-server.sh root@<host>
#
# DEPLOY_KEY_FILE: the public half of the key of the deploy workflow (its private half is the
# repository secret DEPLOY_SSH_KEY). TAILSCALE_PORT: the UDP port of tailscaled (default 41641;
# some hosters' DDoS filters drop WireGuard on 41641). The relay token stays on the server
# (/opt/browser-lite/server.env).
set -euo pipefail
here="$(dirname "$0")"

target="${1:?Usage: TAILSCALE_HOSTNAME=... DEPLOY_KEY_FILE=... TAILSCALE_AUTHKEY_FILE=... [TAILSCALE_PORT=...] apps/demo/deploy/setup-server.sh root@<host>}"
: "${DEPLOY_KEY_FILE:?DEPLOY_KEY_FILE missing}"
: "${TAILSCALE_AUTHKEY_FILE:?TAILSCALE_AUTHKEY_FILE missing}"
: "${TAILSCALE_HOSTNAME:?TAILSCALE_HOSTNAME missing}"
port="${TAILSCALE_PORT:-41641}"
key="$(cat "$DEPLOY_KEY_FILE")"
[[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9@._\ -]+)?$ ]] || { echo "DEPLOY_KEY_FILE: one ssh-ed25519 key" >&2; exit 2; }
[[ "$TAILSCALE_HOSTNAME" =~ ^[a-z0-9-]+$ ]] || { echo "invalid TAILSCALE_HOSTNAME" >&2; exit 2; }
[[ "$port" =~ ^[0-9]{4,5}$ ]] || { echo "invalid TAILSCALE_PORT" >&2; exit 2; }
secret="$(cat "$TAILSCALE_AUTHKEY_FILE")"
[[ "$secret" =~ ^tskey-[A-Za-z0-9-]+$ ]] || { echo "TAILSCALE_AUTHKEY_FILE: one auth key" >&2; exit 2; }
# shellcheck source=versions.env
source "$here/../../../versions.env"

scp -q "$here/deploy-shell.sh" "$target:/tmp/browser-lite-deploy-shell"

# shellcheck disable=SC2087 # the values are meant to be expanded locally
ssh "$target" bash -s <<EOF
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
command -v docker >/dev/null || apt-get install -y -q docker.io
docker compose version >/dev/null 2>&1 || apt-get install -y -q docker-compose-v2
apt-get install -y -q curl ca-certificates jq fail2ban ufw unattended-upgrades

# Tailscale of versions.env from its apt repository (signing key checked against its SHA256)
. /etc/os-release
ring=/usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL -o "\$ring" "https://pkgs.tailscale.com/stable/\$ID/\$VERSION_CODENAME.noarmor.gpg"
echo '$TAILSCALE_KEYRING_SHA256  '"\$ring" | sha256sum -c --quiet
echo "deb [signed-by=\$ring] https://pkgs.tailscale.com/stable/\$ID \$VERSION_CODENAME main" > /etc/apt/sources.list.d/tailscale.list
apt-get update -q
apt-get install -y -q --allow-downgrades 'tailscale=$TAILSCALE_VERSION'
sed -i 's/^PORT=.*/PORT="$port"/' /etc/default/tailscaled
grep -qx 'PORT="$port"' /etc/default/tailscaled || echo 'PORT="$port"' >> /etc/default/tailscaled
systemctl enable -q tailscaled
systemctl restart tailscaled
# The auth key is needed only to join; a node already in the tailnet keeps its identity
if ! tailscale status >/dev/null 2>&1; then
    (umask 077 && printf '%s' '$secret' > /root/browser-lite-tskey)
    tailscale up --auth-key=file:/root/browser-lite-tskey --hostname='$TAILSCALE_HOSTNAME'
    rm /root/browser-lite-tskey
fi
domain="\$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')"
[[ "\$domain" =~ ^[a-z0-9.-]+\.ts\.net\$ ]] || { echo "no MagicDNS name" >&2; exit 1; }
# HTTPS on 443 of the tailnet address with the tailnet's certificate, never public (no Funnel)
tailscale serve --bg --yes --https=443 http://127.0.0.1:8080 >/dev/null

install -m 755 /tmp/browser-lite-deploy-shell /usr/local/bin/browser-lite-deploy-shell
rm /tmp/browser-lite-deploy-shell
grep -qx /usr/local/bin/browser-lite-deploy-shell /etc/shells || echo /usr/local/bin/browser-lite-deploy-shell >> /etc/shells
id deploy >/dev/null 2>&1 || useradd -m -s /usr/local/bin/browser-lite-deploy-shell deploy
usermod -s /usr/local/bin/browser-lite-deploy-shell -G docker deploy
install -d -o deploy -g deploy -m 700 /home/deploy/.ssh
# restrict: no terminal, no forwarding; the login shell runs nothing but the deploy
printf 'restrict %s\n' '$key' > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

install -d -o deploy -g deploy -m 750 /opt/browser-lite
env=/opt/browser-lite/server.env
if [ ! -f "\$env" ]; then
    printf 'DOMAIN=%s\nRELAY_TOKEN=%s\n' "\$domain" "\$(openssl rand -hex 24)" > "\$env"
fi
sed -i "s/^DOMAIN=.*/DOMAIN=\$domain/" "\$env"
chown deploy:deploy "\$env"
chmod 600 "\$env"

# SSH: keys only, few tries (first value wins, so the file sorts first)
cat > /etc/ssh/sshd_config.d/00-browser-lite.conf <<'SSHD'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PermitEmptyPasswords no
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
Match User deploy
    AllowTcpForwarding no
    PermitTTY no
SSHD
sshd -t
systemctl reload ssh

cat > /etc/fail2ban/jail.d/browser-lite.conf <<'JAIL'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
bantime.increment = true
JAIL
systemctl enable -q --now fail2ban
systemctl restart fail2ban

ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow in on tailscale0 >/dev/null
ufw allow '$port'/udp >/dev/null
ufw --force enable >/dev/null

echo 'APT::Periodic::Update-Package-Lists "1";' > /etc/apt/apt.conf.d/20auto-upgrades
echo 'APT::Periodic::Unattended-Upgrade "1";' >> /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable -q --now unattended-upgrades
echo "browser-lite: server ready for \$domain"
EOF
