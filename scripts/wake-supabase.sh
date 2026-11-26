#!/usr/bin/env bash
# Wake a paused Supabase free project before a deploy/scheduler run.
# Requires SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN (Management API token).
set -euo pipefail

: "${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF}"

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "::notice::SUPABASE_ACCESS_TOKEN not set; cannot wake a paused Supabase project"
  exit 0
fi

api="https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}"
auth=("Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}")

for attempt in $(seq 1 60); do
  status="$(curl -fsS -H "${auth[0]}" "$api" | jq -r '.status // empty' | tr '[:upper:]' '[:lower:]')"
  case "$status" in
    active_healthy|active_optimized)
      echo "Supabase status: $status"
      exit 0
      ;;
    paused|inactive)
      echo "Supabase is $status; requesting restore"
      curl -fsS -X POST -H "${auth[0]}" "$api/restore" >/dev/null
      ;;
    restoring|pausing)
      echo "Supabase status: $status; waiting"
      ;;
    *)
      echo "Supabase status: ${status:-unknown}; waiting"
      ;;
  esac
  sleep 10
done

echo "Supabase did not become active after 10 minutes" >&2
exit 1
