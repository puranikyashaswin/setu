#!/usr/bin/env bash
# Copy the live SQLite DB to a timestamped backup (safe with WAL).
# Usage:
#   DB_PATH=/data/setu.db BACKUP_DIR=/data/backups ./scripts/backup_sqlite.sh
set -euo pipefail

DB_PATH="${DB_PATH:-./api/cache/setu.db}"
BACKUP_DIR="${BACKUP_DIR:-./api/cache/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_PATH" ]]; then
  echo "error: DB_PATH not found: $DB_PATH" >&2
  exit 1
fi

DEST="$BACKUP_DIR/setu-${STAMP}.db"
# Use sqlite3 .backup when available (consistent under WAL); else file copy.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".backup '$DEST'"
else
  cp "$DB_PATH" "$DEST"
  # Best-effort WAL sidecars
  [[ -f "${DB_PATH}-wal" ]] && cp "${DB_PATH}-wal" "${DEST}-wal" || true
  [[ -f "${DB_PATH}-shm" ]] && cp "${DB_PATH}-shm" "${DEST}-shm" || true
fi

echo "backup_ok path=$DEST bytes=$(wc -c < "$DEST" | tr -d ' ')"
