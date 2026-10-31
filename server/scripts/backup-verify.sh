#!/usr/bin/env bash
# Proves a backup restores: backup.sh -> restore.sh into a scratch database -> exact row counts compared per table.
#
#   DATABASE_URL=postgres://... BACKUP_ENCRYPTION_KEY=... npm --prefix server run backup:verify
#
# SCRATCH_DATABASE_URL defaults to the same server with database "<name>_restore_verify", which is created and
# dropped by this script (the role needs CREATEDB). Exit code 0 only when every table's count matches.
set -euo pipefail
umask 077
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
DIR="$(cd "$(dirname "$0")" && pwd)"
PSQL="${PG_BIN:+$PG_BIN/}psql"

DBNAME="$(node -e 'const u=new URL(process.argv[1]);process.stdout.write(decodeURIComponent(u.pathname.slice(1)))' "$DATABASE_URL")"
CREATED=0
if [ -z "${SCRATCH_DATABASE_URL:-}" ]; then
  SCRATCH_NAME="${DBNAME}_restore_verify"
  ADMIN_URL="$(node -e 'const u=new URL(process.argv[1]);u.pathname="/postgres";process.stdout.write(u.toString())' "$DATABASE_URL")"
  SCRATCH_DATABASE_URL="$(node -e 'const u=new URL(process.argv[1]);u.pathname="/"+process.argv[2];process.stdout.write(u.toString())' "$DATABASE_URL" "$SCRATCH_NAME")"
  "$PSQL" "$ADMIN_URL" -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS \"$SCRATCH_NAME\"" -c "CREATE DATABASE \"$SCRATCH_NAME\""
  CREATED=1
fi
WORK="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK"
  if [ "$CREATED" = 1 ]; then "$PSQL" "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS \"$SCRATCH_NAME\"" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

START=$(date +%s)
ENC="$(BACKUP_S3_BUCKET="" "$DIR/backup.sh" "$WORK" | tail -n 1)"
T_BACKUP=$(( $(date +%s) - START ))
START=$(date +%s)
TARGET_DATABASE_URL="$SCRATCH_DATABASE_URL" "$DIR/restore.sh" "$ENC"
T_RESTORE=$(( $(date +%s) - START ))

COUNT_SQL="SELECT string_agg(format('SELECT %L AS t, count(*) AS n FROM public.%I', tablename, tablename), ' UNION ALL ' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public'"
counts() {
  local q
  q="$("$PSQL" "$1" -Atqc "$COUNT_SQL")"
  "$PSQL" "$1" -AtqF ' ' -c "SELECT t, n FROM ($q) c ORDER BY t"
}
counts "$DATABASE_URL" > "$WORK/source.txt"
counts "$SCRATCH_DATABASE_URL" > "$WORK/restored.txt"

TABLES=$(wc -l < "$WORK/source.txt" | tr -d ' ')
ROWS=$(awk '{s+=$2} END {print s+0}' "$WORK/source.txt")
echo "backup:verify: $(basename "$ENC") $(wc -c < "$ENC" | tr -d ' ') bytes; backup ${T_BACKUP}s, restore ${T_RESTORE}s"
if diff -u "$WORK/source.txt" "$WORK/restored.txt"; then
  echo "backup:verify: OK - $TABLES tables, $ROWS rows, every table count matches"
  printf '%-32s %10s\n' table rows
  awk '{printf "%-32s %10s\n", $1, $2}' "$WORK/source.txt"
else
  echo "backup:verify: FAILED - row counts differ (diff above)" >&2
  exit 1
fi
