#!/usr/bin/env bash
# MediCore HMS — deploy or update the running stack.
set -Eeuo pipefail

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

APP_DIR="${APP_DIR:-/opt/medicore}"
CONFIG="${CONFIG:-/etc/medicore/.env}"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file $CONFIG"

cd "$APP_DIR" || die "$APP_DIR not found"
[[ -f "$CONFIG" ]] || die "$CONFIG not found — run vps-setup.sh first"

log "Fetching the latest revision"
git fetch --all --prune
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
PREVIOUS="$(git rev-parse HEAD)"
git reset --hard "origin/${BRANCH}"
echo "  ${PREVIOUS:0:8} → $(git rev-parse --short HEAD) on ${BRANCH}"

log "Validating the compose file"
$COMPOSE config --quiet || die "docker-compose.prod.yml is invalid"

log "Building images"
$COMPOSE build --parallel

log "Starting the stack"
$COMPOSE up -d --remove-orphans

log "Waiting for health checks"
deadline=$((SECONDS + 300))
while (( SECONDS < deadline )); do
    unhealthy="$($COMPOSE ps --format json 2>/dev/null \
        | grep -c '"Health":"starting"' || true)"
    failing="$($COMPOSE ps --format json 2>/dev/null \
        | grep -c '"Health":"unhealthy"' || true)"
    if [[ "$unhealthy" == "0" && "$failing" == "0" ]]; then
        echo "  All services healthy"
        break
    fi
    sleep 5
done

if (( SECONDS >= deadline )); then
    echo "  Health checks did not settle within 300s — current state:"
    $COMPOSE ps
    log "Rolling back to ${PREVIOUS:0:8}"
    git reset --hard "$PREVIOUS"
    $COMPOSE build --parallel
    $COMPOSE up -d --remove-orphans
    die "Deployment rolled back"
fi

log "Pruning unused images"
docker system prune -af --filter "until=72h"

log "Deployment complete"
$COMPOSE ps
