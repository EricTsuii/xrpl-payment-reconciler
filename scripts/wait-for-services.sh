#!/usr/bin/env bash
# Waits until the compose postgres and redis services report healthy.
set -euo pipefail

TIMEOUT_SECONDS="${1:-60}"
deadline=$((SECONDS + TIMEOUT_SECONDS))

for service in postgres redis; do
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q "$service")" 2>/dev/null || true)" = "healthy" ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "FAIL: $service is not healthy after ${TIMEOUT_SECONDS}s" >&2
      docker compose ps >&2 || true
      exit 1
    fi
    sleep 1
  done
  echo "$service healthy"
done
