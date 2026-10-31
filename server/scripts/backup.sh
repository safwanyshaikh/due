#!/usr/bin/env bash
# Encrypted logical backup of the Due database.
#
#   DATABASE_URL=postgres://... BACKUP_ENCRYPTION_KEY=... server/scripts/backup.sh [output-dir]
#
# 1. pg_dump --format=custom (compressed, restorable table by table with pg_restore)
# 2. AES-256-CBC encryption with a PBKDF2-derived key (openssl enc -pbkdf2, 200k iterations) and an
#    HMAC-SHA256 tag over the ciphertext (encrypt-then-MAC), so tampering or a wrong key is detected on restore.
# 3. Optional upload to S3-compatible storage when BACKUP_S3_BUCKET is set (AWS S3, Cloudflare R2, Backblaze B2,
#    MinIO ...), using curl's SigV4 signing (no AWS CLI needed).
#
# Env: DATABASE_URL (required), BACKUP_ENCRYPTION_KEY (required, >= 32 chars; store it OUTSIDE the backup bucket),
#      BACKUP_S3_BUCKET, BACKUP_S3_ENDPOINT (e.g. https://s3.ap-south-1.amazonaws.com), BACKUP_S3_REGION (default
#      us-east-1), BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_PREFIX (default due/),
#      PG_BIN (directory with pg_dump matching the server major version).
# Prints the path of the encrypted file on the last line of stdout.
set -euo pipefail
umask 077

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
if [ "${#BACKUP_ENCRYPTION_KEY}" -lt 32 ]; then echo "BACKUP_ENCRYPTION_KEY must be at least 32 characters" >&2; exit 2; fi

PG_DUMP="${PG_BIN:+$PG_BIN/}pg_dump"
OUT_DIR="${1:-${BACKUP_DIR:-./backups}}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="$OUT_DIR/due-$STAMP"
DUMP="$BASE.dump"
ENC="$BASE.dump.enc"

cleanup() { rm -f "$DUMP"; }
trap cleanup EXIT

echo "backup: dumping database (custom format)" >&2
"$PG_DUMP" --format=custom --compress=6 --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$DUMP"

echo "backup: encrypting (AES-256, PBKDF2) and signing (HMAC-SHA256)" >&2
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -md sha256 -pass env:BACKUP_ENCRYPTION_KEY -in "$DUMP" -out "$ENC"
openssl dgst -sha256 -hmac "$BACKUP_ENCRYPTION_KEY" -r "$ENC" | cut -d' ' -f1 > "$ENC.hmac"
SIZE="$(wc -c < "$ENC" | tr -d ' ')"
echo "backup: wrote $ENC ($SIZE bytes)" >&2

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  : "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required with BACKUP_S3_BUCKET}"
  : "${BACKUP_S3_ACCESS_KEY_ID:?BACKUP_S3_ACCESS_KEY_ID is required with BACKUP_S3_BUCKET}"
  : "${BACKUP_S3_SECRET_ACCESS_KEY:?BACKUP_S3_SECRET_ACCESS_KEY is required with BACKUP_S3_BUCKET}"
  REGION="${BACKUP_S3_REGION:-us-east-1}"
  PREFIX="${BACKUP_S3_PREFIX:-due/}"
  for f in "$ENC" "$ENC.hmac"; do
    KEY="$PREFIX$(basename "$f")"
    echo "backup: uploading s3://$BACKUP_S3_BUCKET/$KEY" >&2
    curl --fail --silent --show-error --aws-sigv4 "aws:amz:$REGION:s3" \
      --user "$BACKUP_S3_ACCESS_KEY_ID:$BACKUP_S3_SECRET_ACCESS_KEY" \
      -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
      --upload-file "$f" "${BACKUP_S3_ENDPOINT%/}/$BACKUP_S3_BUCKET/$KEY"
  done
  echo "backup: upload complete" >&2
fi

echo "$ENC"
