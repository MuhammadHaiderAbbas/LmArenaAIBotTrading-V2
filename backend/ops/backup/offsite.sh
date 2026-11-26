#!/usr/bin/env bash
# Verify-and-record off-site copies of the newest database backup and the audit anchor log.
#
#   RCLONE_CONFIG=/run/secrets/rclone_conf OFFSITE_REMOTE=aurex-offsite \
#     ./offsite.sh [backup-file]
#
# Uses `rclone` with an operator-supplied remote (object storage with versioning/retention is
# recommended). It never deletes remote objects, and it records success in the app only after
# reading the remote copy back and comparing its SHA-256 with the local manifest. A missing
# remote is a no-op with a warning: the go-live gate stays red until real off-site copies
# exist, instead of pretending the local Docker volume is off-site.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
ANCHOR_DIR="${ANCHOR_DIR:-/anchors}"
REMOTE="${OFFSITE_REMOTE:-}"
RECORD="${RECORD:-1}"
AUREX_CLI="${AUREX_CLI:-python -m app.cli}"
ANCHOR_FILE="${AUREX_AUDIT_ANCHOR_FILE:-$ANCHOR_DIR/aurex-anchors.jsonl}"

if [[ -z "$REMOTE" ]]; then
  echo "offsite: OFFSITE_REMOTE is not set; skipping (go-live gate remains blocked)" >&2
  exit 0
fi
if ! command -v rclone >/dev/null; then
  echo "offsite: rclone is not installed in this image" >&2
  exit 1
fi
if [[ -n "${RCLONE_CONFIG_FILE:-}" ]]; then
  export RCLONE_CONFIG="$RCLONE_CONFIG_FILE"
fi

record() {  # record(kind, local file, sha, size, ok, detail)
  [[ "$RECORD" == "1" ]] || return 0
  $AUREX_CLI ops-record "$1" --file "$2" --sha256 "$3" --size "$4" ${5:+--failed} --detail "$6" || true
}

file="${1:-}"
if [[ -z "$file" ]]; then
  shopt -s nullglob
  candidates=("$BACKUP_DIR"/aurex-*.dump "$BACKUP_DIR"/aurex-*.dump.gpg)
  shopt -u nullglob
  for c in "${candidates[@]}"; do [[ -z "$file" || "$c" -nt "$file" ]] && file="$c"; done
fi
if [[ -n "$file" && -f "$file" ]]; then
  sha="$(sha256sum "$file" | cut -d' ' -f1)"
  size="$(stat -c %s "$file")"
  name="$(basename "$file")"
  rclone copyto "$file" "$REMOTE/backups/$name"
  rclone copyto "$file.sha256" "$REMOTE/backups/$name.sha256"
  remote_sha="$(rclone cat "$REMOTE/backups/$name" | sha256sum | cut -d' ' -f1)"
  if [[ "$remote_sha" == "$sha" ]]; then
    record offsite-backup "$name" "$sha" "$size" "" "verified $REMOTE/backups/$name"
    echo "offsite: backup $name verified"
  else
    record offsite-backup "$name" "$sha" "$size" failed "remote checksum mismatch"
    echo "offsite: backup checksum mismatch" >&2
    exit 1
  fi
else
  echo "offsite: no local backup found in $BACKUP_DIR" >&2
fi

if [[ -f "$ANCHOR_FILE" ]]; then
  sha="$(sha256sum "$ANCHOR_FILE" | cut -d' ' -f1)"
  size="$(stat -c %s "$ANCHOR_FILE")"
  name="$(basename "$ANCHOR_FILE")"
  rclone copyto "$ANCHOR_FILE" "$REMOTE/anchors/$name"
  remote_sha="$(rclone cat "$REMOTE/anchors/$name" | sha256sum | cut -d' ' -f1)"
  if [[ "$remote_sha" == "$sha" ]]; then
    record offsite-anchor "$name" "$sha" "$size" "" "verified $REMOTE/anchors/$name"
    echo "offsite: anchors $name verified"
  else
    record offsite-anchor "$name" "$sha" "$size" failed "remote checksum mismatch"
    echo "offsite: anchor checksum mismatch" >&2
    exit 1
  fi
else
  echo "offsite: no anchor log at $ANCHOR_FILE yet" >&2
fi
