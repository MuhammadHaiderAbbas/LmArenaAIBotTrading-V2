#!/usr/bin/env bash
# Logical backup of the AUREX database (pg_dump custom format) with a SHA-256 manifest,
# optional GPG encryption and retention. Records the backup in the application (readiness,
# metrics, go-live gates) unless RECORD=0.
#
#   DATABASE_URL=postgresql://user:pass@host:5432/aurex BACKUP_DIR=/backups ./backup.sh  # pragma: allowlist secret
set -euo pipefail

DB_URL="${DATABASE_URL:-${AUREX_DATABASE_URL:-}}"
: "${DB_URL:?set DATABASE_URL (postgresql://user:pass@host:port/db)}"  # pragma: allowlist secret
DB_URL="${DB_URL/postgresql+asyncpg:/postgresql:}"          # accept the application's URL form
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
RECORD="${RECORD:-1}"
AUREX_CLI="${AUREX_CLI:-python -m app.cli}"

mkdir -p "$BACKUP_DIR"
umask 077                                                    # backups contain user data
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/aurex-$stamp.dump"

pg_dump --format=custom --compress=9 --no-owner --no-privileges --dbname="$DB_URL" --file="$file.partial"
mv "$file.partial" "$file"                                   # never leave a half-written file under the final name
pg_restore --list "$file" > /dev/null                        # the archive is readable

if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  gpg --batch --yes --trust-model always --recipient "$BACKUP_GPG_RECIPIENT" --output "$file.gpg" --encrypt "$file"
  rm -f "$file"
  file="$file.gpg"
fi

sha="$(sha256sum "$file" | cut -d' ' -f1)"
size="$(stat -c %s "$file")"
echo "$sha  $(basename "$file")" > "$file.sha256"
echo "backup: $file ($size bytes, sha256 $sha)"

find "$BACKUP_DIR" -maxdepth 1 -name 'aurex-*.dump*' -mtime +"$RETENTION_DAYS" -print -delete

if [[ "$RECORD" == "1" ]]; then
  $AUREX_CLI ops-record backup --file "$file" --sha256 "$sha" --size "$size"
fi
