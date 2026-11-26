#!/usr/bin/env bash
# Creates the dev and test databases on a locally installed PostgreSQL (no Docker).
set -euo pipefail
PSQL=${PSQL:-"sudo -u postgres psql"}
$PSQL -tc "SELECT 1 FROM pg_roles WHERE rolname='aurex'" | grep -q 1 || \
  $PSQL -c "CREATE USER aurex WITH PASSWORD 'aurex' CREATEDB;"
for db in aurex aurex_test; do
  $PSQL -tc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || \
    $PSQL -c "CREATE DATABASE $db OWNER aurex;"
done
echo "Databases ready: aurex, aurex_test"
