#!/usr/bin/env bash
# Creates ./secrets with random keys (mode 600). Database URLs must be filled in by hand.
# Existing files are never overwritten.
set -euo pipefail
cd "$(dirname "$0")"
umask 077
mkdir -p secrets
rand() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }
for f in jwt_secret data_key artifact_key metrics_token grafana_admin_password redis_password; do
  [[ -s "secrets/$f" ]] || rand > "secrets/$f"
done
[[ -s secrets/redis_url ]] || echo "redis://:$(cat secrets/redis_password)@redis:6379/0" > secrets/redis_url
# Licensed feed keys are operator-supplied: create empty placeholders and print a reminder.
for f in finnhub_api_key oanda_api_key claude_api_key; do
  [[ -e "secrets/$f" ]] || { : > "secrets/$f"; echo "edit secrets/$f with your licensed feed key"; }
done
# Off-site copies need an rclone remote config in this file; OFFSITE_REMOTE names the remote/path.
[[ -e secrets/rclone_conf ]] || { : > secrets/rclone_conf; echo "edit secrets/rclone_conf with the off-site remote (or leave OFFSITE_REMOTE empty to keep the gate blocked)"; }
for f in database_url drill_admin_url; do
  [[ -s "secrets/$f" ]] || { echo "postgresql+asyncpg://USER:PASSWORD@HOST:5432/aurex" > "secrets/$f"; echo "edit secrets/$f"; }  # pragma: allowlist secret
done
echo "secrets ready in $(pwd)/secrets (never commit this directory)"
