#!/usr/bin/env bash
# Backup scheduler for the `ops` container: a daily backup at BACKUP_AT (UTC, HH:MM) and a
# restore drill after the backup on DRILL_WEEKDAY (1 = Monday ... 7 = Sunday). Each run is
# recorded in the application, so a missed or failed run shows up in readiness and alerts.
set -uo pipefail
BACKUP_AT="${BACKUP_AT:-02:15}"
DRILL_WEEKDAY="${DRILL_WEEKDAY:-7}"
here="$(cd "$(dirname "$0")" && pwd)"
cd /app 2>/dev/null || true                    # app.cli lives here in the image

while true; do
  now=$(date -u +%s)
  next=$(date -u -d "today $BACKUP_AT" +%s)
  (( next <= now )) && next=$(date -u -d "tomorrow $BACKUP_AT" +%s)
  echo "next backup at $(date -u -d "@$next" '+%Y-%m-%d %H:%M UTC')"
  sleep $(( next - now ))
  if "$here/backup.sh"; then
    "$here/offsite.sh" || echo "off-site copy failed (recorded)" >&2
    if [[ "$(date -u +%u)" == "$DRILL_WEEKDAY" ]]; then "$here/restore-drill.sh" || echo "restore drill failed (recorded)"; fi
  else
    echo "backup failed" >&2
  fi
done
