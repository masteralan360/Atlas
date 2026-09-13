#!/usr/bin/env bash
# Creates a consistent full logical PostgreSQL snapshot and stores a native
# custom archive plus a readable SQL rendering in a private R2 bucket.
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
  R2_BACKUP_BUCKET; do
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

timestamp="$(date --utc +'%Y-%m-%dT%H-%M-%SZ')"
run_id="${GITHUB_RUN_ID:-manual}"
backup_id="${timestamp}-${run_id}"
archive_base="atlas-supabase-${backup_id}.dump"
plain_archive="$work_dir/$archive_base"
sql_export="$work_dir/${archive_base%.dump}.sql"
downloaded_archive="$work_dir/verified-$(basename "$plain_archive")"
downloaded_sql="$work_dir/verified-$(basename "$sql_export")"
backup_prefix="daily/${backup_id}"
archive_key="$backup_prefix/atlas-supabase.dump"
sql_key="$backup_prefix/atlas-supabase.sql"
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
# pg_restore to read and decompress the archive before it leaves the runner.
pg_restore --file=/dev/null "$plain_archive"

echo 'Rendering readable SQL from the validated PostgreSQL archive…'
pg_restore --file="$sql_export" "$plain_archive"
[[ -s "$sql_export" ]] || fail 'pg_restore completed without creating a SQL export.'

archive_size="$(wc --bytes < "$plain_archive" | tr --delete '[:space:]')"
sql_size="$(wc --bytes < "$sql_export" | tr --delete '[:space:]')"

echo 'Uploading plaintext database backups to private R2 storage…'
aws s3 cp "$plain_archive" "s3://${R2_BACKUP_BUCKET}/${archive_key}" \
  --endpoint-url "$r2_endpoint" \
  --only-show-errors \
  --content-type 'application/octet-stream' \
  --metadata 'source=supabase,format=pg_dump-custom'
aws s3 cp "$sql_export" "s3://${R2_BACKUP_BUCKET}/${sql_key}" \
  --endpoint-url "$r2_endpoint" \
  --only-show-errors \
  --content-type 'application/sql; charset=utf-8' \
  --metadata 'source=supabase,format=pg_restore-sql'

echo 'Verifying uploaded backup lengths…'
remote_archive_size="$(aws s3api head-object \
  --bucket "$R2_BACKUP_BUCKET" \
  --key "$archive_key" \
  --endpoint-url "$r2_endpoint" \
  --query 'ContentLength' \
  --output text)"
remote_sql_size="$(aws s3api head-object \
  --bucket "$R2_BACKUP_BUCKET" \
  --key "$sql_key" \
  --endpoint-url "$r2_endpoint" \
  --query 'ContentLength' \
  --output text)"
[[ "$remote_archive_size" =~ ^[0-9]+$ ]] || fail 'R2 did not return a valid uploaded archive length.'
[[ "$remote_sql_size" =~ ^[0-9]+$ ]] || fail 'R2 did not return a valid uploaded SQL export length.'
[[ "$remote_archive_size" -eq "$archive_size" ]] || fail 'R2 archive length does not match the local archive.'
[[ "$remote_sql_size" -eq "$sql_size" ]] || fail 'R2 SQL export length does not match the local SQL export.'

echo 'Downloading both R2 objects once to verify their contents…'
aws s3 cp "s3://${R2_BACKUP_BUCKET}/${archive_key}" "$downloaded_archive" \
  --endpoint-url "$r2_endpoint" \
  --only-show-errors
aws s3 cp "s3://${R2_BACKUP_BUCKET}/${sql_key}" "$downloaded_sql" \
  --endpoint-url "$r2_endpoint" \
  --only-show-errors
cmp --silent "$plain_archive" "$downloaded_archive" \
  || fail 'Downloaded R2 archive does not match the uploaded archive.'
cmp --silent "$sql_export" "$downloaded_sql" \
  || fail 'Downloaded R2 SQL export does not match the uploaded SQL export.'

{
  echo '## Supabase database backup complete'
  echo
  echo "- Backup folder: $backup_prefix/"
  echo "- Custom archive: $archive_key ($archive_size bytes)"
  echo "- SQL export: $sql_key ($sql_size bytes)"
  echo '- Formats: plaintext PostgreSQL custom archive and plaintext SQL'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

echo 'Plaintext database backups uploaded and verified.'
