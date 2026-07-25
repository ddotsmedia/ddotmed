#!/usr/bin/env bash
# MediCore HMS — issue Let's Encrypt certificates and activate HTTPS.
# Run as root AFTER DNS for the domain resolves to this server.
set -Eeuo pipefail

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "This script must run as root"

APP_DIR="${APP_DIR:-/opt/medicore}"
CONFIG="${CONFIG:-/etc/medicore/.env}"
NGINX_CONF="$APP_DIR/nginx/nginx.conf"

[[ -f "$CONFIG" ]] || die "$CONFIG not found"
[[ -f "$NGINX_CONF" ]] || die "$NGINX_CONF not found"

# shellcheck disable=SC1090
DOMAIN="$(grep -E '^DOMAIN_PLACEHOLDER=' "$CONFIG" | cut -d= -f2- | tr -d '"'"'"' ')"
EMAIL="$(grep -E '^LETSENCRYPT_EMAIL=' "$CONFIG" | cut -d= -f2- | tr -d '"'"'"' ')"

[[ -n "$DOMAIN" ]] || die "Set DOMAIN_PLACEHOLDER in $CONFIG before running this script"
[[ -n "$EMAIL" ]] || die "Set LETSENCRYPT_EMAIL in $CONFIG before running this script"

log "Domain: $DOMAIN"

resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
public="$(curl -fsS https://api.ipify.org || true)"
if [[ -n "$resolved" && -n "$public" && "$resolved" != "$public" ]]; then
    echo "  WARNING: $DOMAIN resolves to $resolved but this host is $public"
    echo "  Certificate issuance will fail until DNS propagates."
    read -r -p "  Continue anyway? [y/N] " reply
    [[ "$reply" == "y" || "$reply" == "Y" ]] || exit 1
fi

cd "$APP_DIR"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file $CONFIG"

log "Backing up nginx.conf"
cp "$NGINX_CONF" "${NGINX_CONF}.bak.$(date +%Y%m%d%H%M%S)"

# Certbot needs port 80 free and an HTTP-only server block, so temporarily serve a
# minimal config while the challenge runs.
log "Serving a temporary HTTP-only config for the ACME challenge"
cat > /tmp/nginx-acme.conf <<EOF
events { worker_connections 1024; }
http {
    server {
        listen 80;
        server_name $DOMAIN;
        location /.well-known/acme-challenge/ { root /var/www/certbot; }
        location / { return 200 'MediCore provisioning'; add_header Content-Type text/plain; }
    }
}
EOF

$COMPOSE stop nginx || true
docker run --rm -d --name medicore-acme \
    -p 80:80 \
    -v /tmp/nginx-acme.conf:/etc/nginx/nginx.conf:ro \
    -v medicore_certbot-webroot:/var/www/certbot \
    nginx:1.27-alpine

cleanup() { docker rm -f medicore-acme >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "Requesting the certificate"
certbot certonly \
    --webroot -w /var/lib/docker/volumes/medicore_certbot-webroot/_data \
    -d "$DOMAIN" \
    --email "$EMAIL" \
    --agree-tos \
    --non-interactive \
    --no-eff-email \
    --keep-until-expiring \
    || die "Certificate issuance failed"

cleanup
trap - EXIT

log "Substituting DOMAIN_PLACEHOLDER in nginx.conf"
sed -i "s/DOMAIN_PLACEHOLDER/${DOMAIN}/g" "$NGINX_CONF"
grep -q "DOMAIN_PLACEHOLDER" "$NGINX_CONF" && die "Substitution incomplete"

log "Restarting nginx with the TLS configuration"
$COMPOSE up -d nginx
sleep 3
$COMPOSE exec -T nginx nginx -t || die "nginx rejected the new configuration"

log "Installing the renewal hook and cron entry"
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/medicore-reload.sh <<EOF
#!/usr/bin/env bash
cd $APP_DIR && docker compose -f docker-compose.prod.yml --env-file $CONFIG exec -T nginx nginx -s reload
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/medicore-reload.sh

# Twice-daily is the Let's Encrypt recommendation; renewal is a no-op until due.
cat > /etc/cron.d/medicore-certbot <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
0 3,15 * * * root certbot renew --quiet --no-random-sleep-on-renew
EOF
chmod 644 /etc/cron.d/medicore-certbot

log "Verifying HTTPS"
if curl -fsS -o /dev/null "https://${DOMAIN}/api/health"; then
    echo "  https://${DOMAIN} is live"
else
    echo "  WARNING: https://${DOMAIN}/api/health did not respond yet; check 'docker compose logs nginx'"
fi

cat <<EOF

────────────────────────────────────────────────────────────────────────────
 SSL is active for ${DOMAIN}.
 Renewal runs twice daily via /etc/cron.d/medicore-certbot and reloads nginx.
────────────────────────────────────────────────────────────────────────────
EOF
