# Encrypted Supabase database backups

`.github/workflows/database-backup.yml` makes an encrypted, full logical backup of the Atlas Supabase PostgreSQL database every day at **04:17 Asia/Baghdad** (01:17 UTC). It uses native PostgreSQL 17 `pg_dump`; Docker, the Supabase CLI, and PITR are not used.

The archive contains the database objects and row content visible to the database role in `SUPABASE_BACKUP_DATABASE_URL`, including the schema needed to restore those rows. It is a logical database snapshot, not a full Supabase-project export. Supabase Storage file objects, Edge Function deployments/configuration, Auth provider configuration, project secrets, and global database roles/tablespaces are outside its scope.

## One-time configuration

1. In Cloudflare R2, create a **private** bucket named `atlas-database-backups`. Do not attach a public domain or Worker route. Configure an object lifecycle rule for the `daily/` prefix to delete objects after the retention period you choose (35 days is a reasonable start). Optional: use an R2 bucket lock only if the selected retention period is appropriate for your recovery policy.
2. Create an R2 API token scoped only to that bucket with **Object Read & Write** permission. Do not reuse the R2 credential used for release files.
3. Generate an age key pair on a trusted administrator computer:

   ```bash
   age-keygen -o atlas-supabase-backup-key.txt
   age-keygen -y atlas-supabase-backup-key.txt
   ```

   Store `atlas-supabase-backup-key.txt` offline in a password manager or other secure recovery location. It is the only key that can decrypt the backups. Never commit it, upload it to R2, or add it to GitHub. The `age1...` value printed by the second command is a public recipient and is safe to use as a GitHub variable.

4. In the GitHub repository, create an environment named `database-backup`. Restrict it to the protected `main` branch. Do not add required reviewers, since that would stop unattended daily backups. Limit who can edit workflows and environment configuration.
5. Add these values to the `database-backup` environment:

   | Type     | Name                           | Value                                                                                                                                                                                               |
   | -------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Secret   | `SUPABASE_BACKUP_DATABASE_URL` | The complete **Session pooler** connection string from Supabase Dashboard → Connect, using port 5432 and `sslmode=require`. GitHub-hosted runners are IPv4-only, so do not use the IPv6 direct URL. |
   | Secret   | `R2_BACKUP_ACCESS_KEY_ID`      | Access key ID from the dedicated, bucket-scoped R2 API token.                                                                                                                                       |
   | Secret   | `R2_BACKUP_SECRET_ACCESS_KEY`  | Secret access key from that token.                                                                                                                                                                  |
   | Variable | `R2_BACKUP_ACCOUNT_ID`         | Cloudflare account ID for the R2 bucket.                                                                                                                                                            |
   | Variable | `R2_BACKUP_BUCKET`             | `atlas-database-backups` (or the private bucket name you chose).                                                                                                                                    |
   | Variable | `BACKUP_AGE_RECIPIENT`         | The `age1...` public recipient generated above.                                                                                                                                                     |

Never put a Supabase service-role key, anon key, personal access token, database password by itself, or the private age key in this workflow. The database connection URL is the only Supabase credential it needs.

## First backup and restore drill

After configuration, open **Actions → Back up Supabase database → Run workflow**. A successful job reports the R2 object name, encrypted size, and SHA-256 in its job summary.

At least once, restore a copy into a disposable Supabase project before relying on this backup policy:

```bash
age --decrypt --identity /secure/atlas-supabase-backup-key.txt \
  --output atlas.dump atlas-supabase-YYYYMMDDTHHMMSSZ-RUN_ID.dump.age

pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges \
  --dbname "$DESTINATION_DATABASE_URL" atlas.dump
```

Use a destination database URL from the target project's **Session pooler** and include `sslmode=require`. Verify important row counts and an Atlas sign-in/use-case. Keep the private age key and a copy of the restore instructions in a recovery location separate from GitHub and R2.
