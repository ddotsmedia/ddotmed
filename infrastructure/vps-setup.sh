#!/usr/bin/env bash
# MediCore HMS — one-time VPS provisioning for Ubuntu 24.04 LTS.
# Run as root:  bash infrastructure/vps-setup.sh
set -Eeuo pipefail

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "This script must run as root"
. /etc/os-release
[[ "${VERSION_ID:-}" == "24.04" ]] || echo "WARNING: expected Ubuntu 24.04, found ${VERSION_ID:-unknown}"

APP_DIR=/opt/medicore
CONFIG_DIR=/etc/medicore
APP_USER=medicore

log "Updating the base system"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y

log "Installing base packages"
apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git ufw fail2ban \
    certbot python3-certbot-nginx \
    unattended-upgrades apt-listchanges

log "Installing Docker Engine and the Compose plugin"
if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

log "Creating the ${APP_USER} service account"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
    useradd --system --create-home --shell /bin/bash "$APP_USER"
fi
usermod -aG docker "$APP_USER"

log "Creating directories"
mkdir -p "$APP_DIR" "$CONFIG_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chown root:"$APP_USER" "$CONFIG_DIR"
chmod 750 "$CONFIG_DIR"

log "Seeding ${CONFIG_DIR}/.env"
if [[ -f "$CONFIG_DIR/.env" ]]; then
    echo "  ${CONFIG_DIR}/.env already exists — leaving it untouched"
else
    TEMPLATE="$(dirname "$(readlink -f "$0")")/../.env.template"
    [[ -f "$TEMPLATE" ]] || die "Cannot find .env.template next to this script"
    cp "$TEMPLATE" "$CONFIG_DIR/.env"

    # Generate the secrets that have no reason to be chosen by a human.
    POSTGRES_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"
    REDIS_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"
    COOKIE_SECRET="$(openssl rand -hex 32)"
    JWT_SECRET="$(openssl rand -hex 32)"
    JWT_REFRESH_SECRET="$(openssl rand -hex 32)"
    MINIO_ACCESS_KEY="$(openssl rand -hex 12)"
    MINIO_SECRET_KEY="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"

    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /tmp/jwt_private.pem 2>/dev/null
    openssl rsa -pubout -in /tmp/jwt_private.pem -out /tmp/jwt_public.pem 2>/dev/null
    JWT_PRIVATE_KEY="$(awk '{printf "%s\\n", $0}' /tmp/jwt_private.pem)"
    JWT_PUBLIC_KEY="$(awk '{printf "%s\\n", $0}' /tmp/jwt_public.pem)"
    shred -u /tmp/jwt_private.pem /tmp/jwt_public.pem

    set_env() {
        local key="$1" value="$2"
        python3 - "$CONFIG_DIR/.env" "$key" "$value" <<'PY'
import sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().splitlines()
out, replaced = [], False
for line in lines:
    if line.startswith(f"{key}="):
        out.append(f"{key}={value}")
        replaced = True
    else:
        out.append(line)
if not replaced:
    out.append(f"{key}={value}")
open(path, "w").write("\n".join(out) + "\n")
PY
    }

    set_env POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
    set_env DATABASE_URL "postgresql://medicore:${POSTGRES_PASSWORD}@postgres:5432/medicore?schema=public"
    set_env REDIS_PASSWORD "$REDIS_PASSWORD"
    set_env REDIS_URL "redis://:${REDIS_PASSWORD}@redis:6379"
    set_env COOKIE_SECRET "$COOKIE_SECRET"
    set_env JWT_SECRET "$JWT_SECRET"
    set_env JWT_REFRESH_SECRET "$JWT_REFRESH_SECRET"
    set_env JWT_PRIVATE_KEY "$JWT_PRIVATE_KEY"
    set_env JWT_PUBLIC_KEY "$JWT_PUBLIC_KEY"
    set_env MINIO_ACCESS_KEY "$MINIO_ACCESS_KEY"
    set_env MINIO_SECRET_KEY "$MINIO_SECRET_KEY"

    echo "  Generated database, Redis, MinIO and RS256 JWT secrets"
fi
chown root:"$APP_USER" "$CONFIG_DIR/.env"
chmod 640 "$CONFIG_DIR/.env"

log "Configuring UFW (22, 80, 443 only)"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable
ufw status verbose

log "Configuring fail2ban SSH jail"
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled  = true
port     = ssh
maxretry = 4
bantime  = 24h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

log "Hardening SSH"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sshd -t && systemctl reload ssh

log "Enabling unattended security upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades

log "Configuring Docker log rotation"
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
EOF
systemctl restart docker

cat <<EOF

────────────────────────────────────────────────────────────────────────────
 VPS provisioning complete.

 Next steps:
   1. Clone the repository into ${APP_DIR}:
        sudo -u ${APP_USER} git clone <repo-url> ${APP_DIR}
   2. Fill in the remaining values in ${CONFIG_DIR}/.env
      (DOMAIN_PLACEHOLDER, LETSENCRYPT_EMAIL, AI provider keys, Twilio, SMTP)
   3. Deploy:
        cd ${APP_DIR} && sudo -u ${APP_USER} bash infrastructure/deploy.sh
   4. Once DNS points at this server, issue certificates:
        sudo bash infrastructure/certbot-setup.sh
────────────────────────────────────────────────────────────────────────────
EOF
