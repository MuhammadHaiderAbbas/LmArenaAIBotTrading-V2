#!/usr/bin/env bash
# Poll the deployed Edge health function until the database probe is healthy.
# Tolerates a cold start / restore after a Supabase free-tier pause.
set -euo pipefail

if [[ -n "${AUREX_EDGE_URL:-}" ]]; then
  base="${AUREX_EDGE_URL%/}"
elif [[ -n "${SUPABASE_PROJECT_REF:-}" ]]; then
  base="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1"
else
  echo "set AUREX_EDGE_URL or SUPABASE_PROJECT_REF" >&2
  exit 2
fi

expected="${AUREX_EXPECTED_VERSION:-phase-}"
body=""

for attempt in $(seq 1 30); do
  body="$(curl -fsS --max-time 10 "$base/health" 2>/dev/null || true)"
  if [[ -n "$body" ]] && echo "$body" | jq -e --arg v "$expected" \
      '.database == "ok" and (.version | startswith($v))' >/dev/null 2>&1; then
    echo "$body" | jq -c '{version, environment, database, cors_allowlist: .guards.cors_allowlist}'
    exit 0
  fi
  sleep 10
done

echo "Edge health check failed after 5 minutes" >&2
[[ -n "$body" ]] && echo "$body" >&2
exit 1
