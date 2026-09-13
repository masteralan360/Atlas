#!/usr/bin/env bash
# Creates a consistent full logical PostgreSQL snapshot, encrypts it locally,
# and stores only the encrypted archive and checksum in a private R2 bucket.
# This intentionally uses the native pg_dump binary, not Docker or the
# Supabase CLI (whose db dump command runs pg_dump in a container).

set -euo pipefail
umask 077

fail() {
  echo "::error::$*" >&2
  exit 1
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "Required backup configuration '$name' is not set."
}

for required in \
  SUPABASE_BACKUP_DATABASE_URL \
  R2_BACKUP_ACCESS_KEY_ID \
  R2_BACKUP_SECRET_ACCESS_KEY \
  R2_BACKUP_ACCOUNT_ID \
  R2_BACKUP_BUCKET \
  BACKUP_AGE_RECIPIENT; do
  require_env "$required"
done

case "$SUPABASE_BACKUP_DATABASE_URL" in
  postgres://*|postgresql://*) ;;
  *) fail 'SUPABASE_BACKUP_DATABASE_URL must be a PostgreSQL connection URL.' ;;
esac

# PGDG installs versioned client binaries here. Prefer PostgreSQL 17 explicitly
# because GitHub's image also has an older PostgreSQL client on its default PATH.
postgres17_bin='/usr/lib/postgresql/17/bin'
if [[ -x "$postgres17_bin/pg_dump" ]]; then
  export PATH="$postgres17_bin:$PATH"
fi

command -v pg_dump >/dev/null || fail 'pg_dump is not installed.'
command -v pg_restore >/dev/null || fail 'pg_restore is not installed.'
command -v age >/dev/null || fail 'age is not installed.'
command -v aws >/dev/null || fail 'aws is not installed.'
pg_dump --version | grep --fixed-strings --quiet 'pg_dump (PostgreSQL) 17.' \
  || fail 'PostgreSQL 17 pg_dump is required for this PostgreSQL 17 Supabase project.'

runner_temp="${RUNNER_TEMP:-/tmp}"
work_dir="$(mktemp --directory "${runner_temp%/}/atlas-db-backup.XXXXXXXXXX")"
cleanup() {
  # work_dir is created by mktemp using this exact, runner-local prefix.
  if [[ "$work_dir" == "${runner_temp%/}/atlas-db-backup."* ]]; then
    rm --recursive --force -- "$work_dir"
  fi
}
trap cleanup EXIT

timestamp="$(date --utc +'%Y%m%dT%H%M%SZ')"
run_id="${GITHUB_RUN_ID:-manual}"
archive_base="atlas-supabase-${timestamp}-${run_id}.dump"
plain_archive="$work_dir/$archive_base"
encrypted_archive="$plain_archive.age"
checksum_file="$encrypted_archive.sha256"
downloaded_archive="$work_dir/verified-$(basename "$encrypted_archive")"
object_prefix="daily"
object_key="$object_prefix/$(basename "$encrypted_archive")"
checksum_key="$object_prefix/$(basename "$checksum_file")"
r2_endpoint="https://${R2_BACKUP_ACCOUNT_ID}.r2.cloudflarestorage.com"

export AWS_ACCESS_KEY_ID="$R2_BACKUP_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_BACKUP_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION='auto'
export AWS_EC2_METADATA_DISABLED='true'

echo 'Creating consistent PostgreSQL custom-format archive…'
pg_dump \
  --dbname="$SUPABASE_BACKUP_DATABASE_URL" \
  --format=custom \
  --file="$plain_archive"

[[ -s "$plain_archive" ]] || fail 'pg_dump completed without creating an archive.'

echo 'Validating PostgreSQL archive structure…'
pg_restore --list "$plain_archive" > /dev/null
# Render every archive entry without connecting to a database. This forces
# pg_restore to read and decompress the archive before we encrypt it.
pg_restore --file=/dev/null "$plain_archive"

echo 'Encrypting archive before it leaves the runner…'
age --recipient "$BACKUP_AGE_RECIPIENT" --output "$encrypted_archive" "$plain_archive"
rm --force -- "$plain_archive"
[[ -s "$encrypted_archive" ]] || fail 'Encryption completed without creating an archive.'

checksum="$(sha256sum "$encrypted_archive" | awk '{print $1}')"
printf '%s  %s\n' "$checksum" "$(basename "$encrypted_archive")" > "$checksum_file"
local_size="$(wc --bytes < "$encrypted_archive" | tr --delete '[:space:]')"

echo 'Uploading encrypted archive to private R2 storage…'
aws s3 cp "$encrypted_archive" "s3://${R2_BACKUP_BUCKET}/${object_key}" \
  --endpoint-url "$r2_endpoint" \
  --only-show-errors \
  --metadata "sha256=${checksum},source=supabase,format=pg_dump-custom-age"
aws s3 cp "$checksum_file" "s3://${R2_BACKUP_BUCKET}/${checksum_key}" \
  --endpoint-url "$r2_endpoint" \
  --only-show-errors \
  --content-type 'text/plain'

echo 'Verifying uploaded archive metadata and length…'
remote_size="$(aws s3api head-object \
  --bucket "$R2_BACKUP_BUCKET" \
  --key "$object_key" \
  --endpoint-url "$r2_endpoint" \
  --query 'ContentLength' \
  --output text)"
[[ "$remote_size" =~ ^[0-9]+$ ]] || fail 'R2 did not return a valid uploaded archive length.'
[[ "$remote_size" -eq "$local_size" ]] || fail 'R2 archive length does not match the encrypted local archive.'

echo 'Downloading the encrypted archive once to verify its checksum…'
aws s3 cp "s3://${R2_BACKUP_BUCKET}/${object_key}" "$downloaded_archive" \
  --endpoint-url "$r2_endpoint" \
  --only-show-errors
downloaded_checksum="$(sha256sum "$downloaded_archive" | awk '{print $1}')"
[[ "$downloaded_checksum" == "$checksum" ]] \
  || fail 'Downloaded R2 archive checksum does not match the uploaded archive.'

{
  echo '## Supabase database backup complete'
  echo
  echo "- Object: \`$object_key\`"
  echo "- Encrypted size: \`$local_size\` bytes"
  echo "- SHA-256: \`$checksum\`"
  echo '- Archive format: `pg_dump` custom archive, encrypted with age'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

echo 'Encrypted database backup uploaded and verified.'
