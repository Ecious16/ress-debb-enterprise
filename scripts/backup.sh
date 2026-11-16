#!/usr/bin/env bash
# Dumps the database to a timestamped custom-format file and keeps the newest 30.
# Requires pg_dump with a version >= the server's (Neon defaults to Postgres 17).
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to the database to back up}"
OUT_DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP:-30}"

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/ress-$STAMP.dump"

pg_dump --format=custom --no-owner --no-privileges --file "$FILE" "$DATABASE_URL"
echo "Wrote $FILE ($(du -h "$FILE" | cut -f1))"

# Prune old dumps, newest first.
ls -1t "$OUT_DIR"/ress-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -- "$old"
  echo "Pruned $old"
done