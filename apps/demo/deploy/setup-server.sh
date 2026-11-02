#!/usr/bin/env bash
# Sets up browser-lite on a public Ubuntu or Debian server (repeatable, needs root there):
# Docker, the user deploy for the deploy workflow (SSH key only, login shell deploy-shell.sh),
# server.env with the domain and a generated relay token, SSH with keys only, fail2ban, a
# firewall with only 22, 80 and 443 open, automatic security updates.
#
#   DOMAIN=browser-lite.example.com DEPLOY_KEY_FILE=<public key> apps/demo/deploy/setup-server.sh root@<host>
#
# DEPLOY_KEY_FILE: the public half of the key of the deploy workflow (its private half is the
# repository secret DEPLOY_SSH_KEY). The relay token stays on the server (/opt/browser-lite/server.env).
set -euo pipefail
here="$(dirname "$0")"

target="${1:?Usage: DOMAIN=... DEPLOY_KEY_FILE=... apps/demo/deploy/setup-server.sh root@<host>}"
: "${DOMAIN:?DOMAIN missing}" "${DEPLOY_KEY_FILE:?DEPLOY_KEY_FILE missing}"
[[ "$DOMAIN" =~ ^[a-z0-9.-]+$ ]] || { echo "invalid DOMAIN" >&2; exit 2; }
key="$(cat "$DEPLOY_KEY_FILE")"
[[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9@._\ -]+)?$ ]] || { echo "DEPLOY_KEY_FILE: one ssh-ed25519 key" >&2; exit 2; }

scp -q "$here/deploy-shell.sh" "$target:/tmp/browser-lite-deploy-shell"

# shellcheck disable=SC2087 # the values are meant to be expanded locally
ssh "$target" bash -s <<EOF
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
command -v docker >/dev/null || apt-get install -y -q docker.io
docker compose version >/dev/null 2>&1 || apt-get install -y -q docker-compose-v2
apt-get install -y -q curl ca-certificates fail2ban ufw unattended-upgrades

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
    printf 'DOMAIN=%s\nRELAY_TOKEN=%s\n' '$DOMAIN' "\$(openssl rand -hex 24)" > "\$env"
fi
sed -i 's/^DOMAIN=.*/DOMAIN=$DOMAIN/' "\$env"
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
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null

echo 'APT::Periodic::Update-Package-Lists "1";' > /etc/apt/apt.conf.d/20auto-upgrades
echo 'APT::Periodic::Unattended-Upgrade "1";' >> /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable -q --now unattended-upgrades
echo "browser-lite: server ready for $DOMAIN"
EOF
