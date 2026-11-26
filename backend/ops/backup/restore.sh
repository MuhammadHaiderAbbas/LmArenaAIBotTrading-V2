#!/usr/bin/env bash
# Restore a backup into a database. DESTRUCTIVE for the target: existing objects are dropped.
#
#   DATABASE_URL=postgresql://... ./restore.sh /backups/aurex-20261124T020000Z.dump --yes
set -euo pipefail

file="${1:?usage: restore.sh <backup file> --yes}"
[[ "${2:-}" == "--yes" ]] || { echo "refusing to restore without --yes (the target database is overwritten)" >&2; exit 2; }
DB_URL="${DATABASE_URL:-${AUREX_DATABASE_URL:-}}"
: "${DB_URL:?set DATABASE_URL}"
DB_URL="${DB_URL/postgresql+asyncpg:/postgresql:}"

if [[ -f "$file.sha256" ]]; then
  (cd "$(dirname "$file")" && sha256sum --check --quiet "$(basename "$file").sha256") || { echo "checksum mismatch" >&2; exit 1; }
fi
src="$file"
if [[ "$file" == *.gpg ]]; then
  src="$(mktemp)"; trap 'rm -f "$src"' EXIT
  gpg --batch --yes --output "$src" --decrypt "$file"
fi
pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --dbname="$DB_URL" "$src"
echo "restored $file"
