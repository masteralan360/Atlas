# Plaintext Supabase database backups

.github/workflows/database-backup.yml creates a full logical backup of the
Atlas Supabase PostgreSQL database every day at 04:17 Asia/Baghdad (01:17 UTC).
It uses the native PostgreSQL 17 client: Docker, the Supabase CLI, and PITR are
not used.

Each run creates a virtual R2 folder named after its UTC start time and GitHub
run ID, then uploads two unencrypted files to it:

- daily/YYYY-MM-DDTHH-MM-SSZ-GITHUB_RUN_ID/atlas-supabase.dump: PostgreSQL
  custom-format archive.
  This is the preferred file for a restore and for archive inspection.
- daily/YYYY-MM-DDTHH-MM-SSZ-GITHUB_RUN_ID/atlas-supabase.sql: readable SQL script generated from
  that exact custom archive with pg_restore.

For example, a GitHub run ID of `34783839315` starting at 01:17 UTC on
September 14, 2026 stores its files under
`daily/2026-09-14T01-17-00Z-34783839315/`. R2 folders are key prefixes, so
the folder disappears automatically after both objects expire.

The job does not generate or upload .age or .sha256 files. It validates the
custom archive before upload, then downloads both R2 objects and compares their
bytes with the files made on the runner.

The archive contains database objects and row content visible to the role in
SUPABASE_BACKUP_DATABASE_URL, including the schema needed to restore those
rows. It is a logical database snapshot, not a full Supabase-project export.
Supabase Storage file objects, Edge Function deployments and configuration,
Auth provider configuration, project secrets, and global database roles and
tablespaces are outside its scope.

## Security

Both files contain full database content in plaintext. Keep the R2 bucket
private: do not attach a public domain or Worker route. Restrict the dedicated
R2 API token to this single bucket with Object Read and Write only, and limit
who can read the bucket or edit the GitHub database-backup environment.

Configure the R2 lifecycle rule below after committing this change. The GitHub
R2 token deliberately has Object Read and Write only, so it cannot modify
bucket-level retention settings.

### Thirty-day R2 retention

In Cloudflare: **R2 Object Storage** → **atlas-database-backups** →
**Settings** → **Object Lifecycle Rules** → **Add rule**. Create an enabled
rule named `Expire daily database backups after 30 days` with:

| Setting | Value |
| --- | --- |
| Prefix | `daily/` |
| Action | Delete objects |
| Age | 30 days |

This is an age-based retention policy, not a deletion command run by GitHub
Actions: each file expires 30 days after it was uploaded. Because each folder's
two files share the same upload time, their virtual folder disappears together.
Cloudflare normally removes expired objects within 24 hours of their expiry.
The rule also covers any older `.age` or `.sha256` objects already under
`daily/`; move those to another prefix first if you need to keep them longer.

## One-time configuration

1. In Cloudflare R2, create or keep a private bucket named
   atlas-database-backups. Do not attach a public domain or Worker route.
2. Create an R2 API token scoped only to that bucket with Object Read and Write
   permission. Do not reuse the R2 credential used for release files.
3. In GitHub, create an environment named database-backup and restrict it to
   the protected main branch. Do not add required reviewers, since that would
   stop unattended daily backups.
4. Add these values to the database-backup environment:

   | Type | Name | Value |
   | --- | --- | --- |
   | Secret | SUPABASE_BACKUP_DATABASE_URL | Complete Supabase Session pooler connection string, port 5432, with sslmode=require. |
   | Secret | R2_BACKUP_ACCESS_KEY_ID | Access key ID from the dedicated bucket-scoped R2 token. |
   | Secret | R2_BACKUP_SECRET_ACCESS_KEY | Secret access key from that token. |
   | Variable | R2_BACKUP_ACCOUNT_ID | Cloudflare account ID containing the R2 bucket. |
   | Variable | R2_BACKUP_BUCKET | atlas-database-backups, or the private bucket name selected above. |

BACKUP_AGE_RECIPIENT is no longer used. It can be removed from the GitHub
environment after the workflow change is committed, but leaving the unused
variable does not affect the job.

Never put a Supabase service-role key, anon key, personal access token, or
database password by itself in this workflow. The complete database connection
URL is the only Supabase credential it needs.

## First backup and restore drill

Open Actions, select Back up Supabase database, and choose Run workflow. A
successful job summary reports the two R2 object names and their sizes.

Restore a copy into a disposable Supabase project before relying on this backup
policy. The custom archive is recommended:

    pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges \
      --dbname "$DESTINATION_DATABASE_URL" atlas-supabase-TIMESTAMP-RUN_ID.dump

Use a destination Session pooler URL from the target project and include
sslmode=require. Do not run a restore against the live Atlas database.

The SQL file is for inspection or restoring into an empty disposable target:

    psql --set ON_ERROR_STOP=1 --dbname "$DESTINATION_DATABASE_URL" \
      --file atlas-supabase-TIMESTAMP-RUN_ID.sql

Verify important row counts and a real Atlas sign-in or business workflow after
the restore. A local PostgreSQL server may not have the Supabase extensions and
roles needed for a full restore, so a disposable Supabase project is the most
representative restore target.
