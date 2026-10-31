#!/usr/bin/env bash
# Restores an encrypted backup made by backup.sh into a TARGET database.
#
#   BACKUP_ENCRYPTION_KEY=... TARGET_DATABASE_URL=postgres://.../due_restore server/scripts/restore.sh due-YYYYMMDDTHHMMSSZ.dump.enc
#
# Verifies the HMAC tag first (wrong key or tampered file -> exit 3, nothing restored), decrypts to a private temp
# file and runs pg_restore --clean --if-exists --no-owner --single-transaction into TARGET_DATABASE_URL.
# Never point TARGET_DATABASE_URL at production unless you are deliberately recovering it (see ROLLBACK.md).
set -euo pipefail
umask 077

ENC="${1:?usage: restore.sh <file.dump.enc>}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
PG_RESTORE="${PG_BIN:+$PG_BIN/}pg_restore"

if [ -f "$ENC.hmac" ]; then
  EXPECTED="$(tr -d ' \n' < "$ENC.hmac")"
  ACTUAL="$(openssl dgst -sha256 -hmac "$BACKUP_ENCRYPTION_KEY" -r "$ENC" | cut -d' ' -f1)"
  if [ "$EXPECTED" != "$ACTUAL" ]; then echo "restore: HMAC mismatch (wrong key or tampered file); aborting" >&2; exit 3; fi
  echo "restore: integrity tag verified" >&2
else
  echo "restore: WARNING no .hmac file next to the backup; integrity not verified" >&2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass env:BACKUP_ENCRYPTION_KEY -in "$ENC" -out "$TMP/restore.dump"
echo "restore: decrypted; restoring into target" >&2
"$PG_RESTORE" --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error --dbname="$TARGET_DATABASE_URL" "$TMP/restore.dump"
echo "restore: done" >&2
