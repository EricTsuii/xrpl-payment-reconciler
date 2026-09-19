#!/usr/bin/env bash
# Checks the local toolchain. Reads nothing secret, installs nothing.
set -uo pipefail

EXPECTED_NODE="v22.23.2"
EXPECTED_PNPM="12.4.1"
problems=0

ok() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; problems=$((problems + 1)); }

node_version="$(node --version 2>/dev/null)"
if [ "$node_version" = "$EXPECTED_NODE" ]; then ok "node $node_version"; else bad "node ${node_version:-missing}, expected $EXPECTED_NODE"; fi

pnpm_version="$(pnpm --version 2>/dev/null)"
if [ "$pnpm_version" = "$EXPECTED_PNPM" ]; then ok "pnpm $pnpm_version"; else bad "pnpm ${pnpm_version:-missing}, expected $EXPECTED_PNPM"; fi

if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  ok "docker $(docker version --format '{{.Server.Version}}')"
else
  bad "docker daemon not reachable"
fi

if docker compose version >/dev/null 2>&1; then ok "$(docker compose version | head -n 1)"; else bad "docker compose plugin missing"; fi

for tool in curl jq; do
  if command -v "$tool" >/dev/null 2>&1; then ok "$tool"; else bad "$tool missing"; fi
done

if [ "$problems" -gt 0 ]; then
  echo "$problems problem(s) found"
  exit 1
fi
echo "all good"
