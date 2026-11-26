#!/usr/bin/env bash
# Restore drill: restore the newest (or given) backup into a throw-away database, run the
# application's integrity checks against it, record the result, and drop the scratch database.
# A backup is only trusted once a drill has restored it successfully.
#
#   DATABASE_URL=postgresql://user:pass@host:5432/aurex BACKUP_DIR=/backups ./restore-drill.sh [file]  # pragma: allowlist secret
set -euo pipefail

DB_URL="${DATABASE_URL:-${AUREX_DATABASE_URL:-}}"
: "${DB_URL:?set DATABASE_URL (the live database; used to create the scratch database and record the result)}"
DB_URL="${DB_URL/postgresql+asyncpg:/postgresql:}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
AUREX_CLI="${AUREX_CLI:-python -m app.cli}"
RECORD="${RECORD:-1}"

file="${1:-}"
if [[ -z "$file" ]]; then                                   # newest backup (nullglob: no error if a pattern is empty)
  shopt -s nullglob
  candidates=("$BACKUP_DIR"/aurex-*.dump "$BACKUP_DIR"/aurex-*.dump.gpg)
  shopt -u nullglob
  for c in "${candidates[@]}"; do [[ -z "$file" || "$c" -nt "$file" ]] && file="$c"; done
fi
[[ -n "$file" && -f "$file" ]] || { echo "no backup found in $BACKUP_DIR" >&2; exit 1; }

# Creating databases and the pgvector extension needs more privilege than the application role
# usually has (managed Postgres: the master user). DRILL_ADMIN_URL is that role; it defaults to
# DATABASE_URL for setups where the application role may create them itself.
ADMIN_URL="${DRILL_ADMIN_URL:-$DB_URL}"
ADMIN_URL="${ADMIN_URL/postgresql+asyncpg:/postgresql:}"
EXTENSIONS="${DRILL_EXTENSIONS:-vector}"

scratch="aurex_drill_$(date -u +%Y%m%d%H%M%S)"
base="${DB_URL%/*}"                                         # postgresql://user:pass@host:port  # pragma: allowlist secret
scratch_url="$base/$scratch"
admin_scratch_url="${ADMIN_URL%/*}/$scratch"
started=$(date +%s)
record() {   # record(ok?, detail): every drill outcome is recorded, failures included
  [[ "$RECORD" == "1" ]] || return 0
  local flag=(); [[ "$1" == "1" ]] || flag=(--failed)
  AUREX_DATABASE_URL="${DB_URL/postgresql:/postgresql+asyncpg:}" $AUREX_CLI ops-record restore-drill --file "$file" \
    --sha256 "$(sha256sum "$file" | cut -d' ' -f1)" --size "$(stat -c %s "$file")" --detail "$2" "${flag[@]}" || true
}
fail() { echo "restore drill FAILED: $1" >&2; record 0 "$1"; exit 1; }

owner="$(psql "$DB_URL" -Atc 'SELECT current_user')" || fail "cannot connect to the live database"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $scratch OWNER \"$owner\"" || fail "cannot create the scratch database (set DRILL_ADMIN_URL)"
cleanup() { psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $scratch WITH (FORCE)" >/dev/null 2>&1 || true; }
trap cleanup EXIT
for ext in $EXTENSIONS; do
  psql "$admin_scratch_url" -v ON_ERROR_STOP=1 -qc "CREATE EXTENSION IF NOT EXISTS $ext" || fail "cannot create extension $ext (set DRILL_ADMIN_URL to a role that can)"
done

DATABASE_URL="$scratch_url" "$(dirname "$0")/restore.sh" "$file" --yes || fail "pg_restore failed"
set +e
report="$(AUREX_DATABASE_URL="${scratch_url/postgresql:/postgresql+asyncpg:}" $AUREX_CLI integrity-check)"
status=$?
set -e
echo "$report"
elapsed=$(( $(date +%s) - started ))
passed=$(grep -c '^OK' <<< "$report" || true)
total=$(grep -cE '^(OK|FAIL)' <<< "$report" || true)
if [[ $status -ne 0 ]]; then fail "integrity checks: $passed/$total passed"; fi
record 1 "$passed/$total checks in ${elapsed}s"
echo "restore drill passed: $passed/$total integrity checks in ${elapsed}s"
