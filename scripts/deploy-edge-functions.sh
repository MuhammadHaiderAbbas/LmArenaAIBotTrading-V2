#!/usr/bin/env bash
# Deploy the exact local TypeScript bodies to Supabase Edge Functions via the Management API.
# No CLI working-directory assumptions, and no secret values are printed.
set -euo pipefail

: "${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF}"
: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN}"

api="https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/functions"
auth=("Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}")
response="$(mktemp)"
trap 'rm -f "$response"' EXIT

for slug in health profile accounts deposit quote candles; do
  file="edge-functions/${slug}/index.ts"
  [[ -f "$file" ]] || { echo "missing $file" >&2; exit 1; }
  verify=true
  [[ "$slug" == "health" ]] && verify=false

  patch_payload="$(jq -n --argjson verify "$verify" --rawfile body "$file" \
    '{body: $body, verify_jwt: $verify}')"
  create_payload="$(jq -n --arg slug "$slug" --argjson verify "$verify" --rawfile body "$file" \
    '{slug: $slug, name: $slug, body: $body, verify_jwt: $verify}')"

  code="$(curl -sS -o "$response" -w '%{http_code}' -X PATCH \
    -H "${auth[0]}" -H 'Content-Type: application/json' \
    -d "$patch_payload" "${api}/${slug}")"

  if [[ "$code" == "404" ]]; then
    code="$(curl -sS -o "$response" -w '%{http_code}' -X POST \
      -H "${auth[0]}" -H 'Content-Type: application/json' \
      -d "$create_payload" "$api")"
  fi

  if [[ ! "$code" =~ ^2 ]]; then
    echo "deploy of $slug failed (HTTP $code)" >&2
    head -c 500 "$response" >&2
    exit 1
  fi
  echo "deployed $slug (verify_jwt=$verify)"
done
