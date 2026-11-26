#!/usr/bin/env bash
# Static contract check for the Supabase Edge Functions. Runs in CI without project
# credentials; Deno's own type check runs separately in the workflow.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

slugs=(health profile accounts deposit quote candles)

for slug in "${slugs[@]}"; do
  file="edge-functions/${slug}/index.ts"
  [[ -f "$file" ]] || { echo "missing $file" >&2; exit 1; }
  grep -q 'Deno.serve' "$file" || { echo "$slug is not a Supabase Edge Function" >&2; exit 1; }
  grep -q 'AUREX_CORS_ORIGINS' "$file" || { echo "$slug has no exact CORS allowlist" >&2; exit 1; }
  grep -q 'aurex_rate_limit' "$file" || { echo "$slug has no shared Postgres rate limit" >&2; exit 1; }
  if [[ "$slug" == "health" ]]; then
    grep -q 'https_required: true' "$file" || { echo "health does not report HTTPS enforcement" >&2; exit 1; }
  else
    grep -q 'x-forwarded-proto' "$file" || { echo "$slug does not handle Supabase's proxied HTTPS header" >&2; exit 1; }
    grep -q 'aal !== "aal2"' "$file" || { echo "$slug does not require AAL2" >&2; exit 1; }
  fi
done

grep -q 'paper_only: true' edge-functions/health/index.ts
grep -q 'live_trading_enabled: false' edge-functions/health/index.ts
! grep -RIn -E 'service_role|live_trading_enabled: true|eyJ[A-Za-z0-9_-]{20,}' edge-functions

for slug in "${slugs[@]}"; do
  grep -qw "$slug" scripts/deploy-edge-functions.sh || { echo "deploy script skips $slug" >&2; exit 1; }
done
bash -n scripts/deploy-edge-functions.sh scripts/supabase-health.sh scripts/wake-supabase.sh

echo "Supabase Edge Functions OK — ${#slugs[@]} functions, paper-only, AAL2 and shared limits"
