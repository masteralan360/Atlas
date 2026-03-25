import { isTauri } from '@/lib/platform'
import { shouldMirrorToSqlite } from '@/workspace/workspaceMode'

const DB_FILENAME = 'atlas-local-mode.db'
const BACKUP_DIR = 'db-backup'
const MAX_BACKUP_DAYS = 7
const BACKUP_DONE_KEY = 'atlas_db_backup_date'

function getTodayDateString() {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function isBackupAlreadyDoneToday() {
    try {
        return localStorage.getItem(BACKUP_DONE_KEY) === getTodayDateString()
    } catch {
        return false
    }
}

function markBackupDone() {
    try {
        localStorage.setItem(BACKUP_DONE_KEY, getTodayDateString())
    } catch {
        // noop
    }
}

async function pruneOldBackups() {
    const { readDir, remove, BaseDirectory } = await import('@tauri-apps/plugin-fs')

    let entries: Array<{ name?: string | null; isFile?: boolean }>
    try {
        entries = await readDir(BACKUP_DIR, { baseDir: BaseDirectory.AppData })
    } catch {
        return
    }

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - MAX_BACKUP_DAYS)

    for (const entry of entries) {
        if (!entry.name || !entry.isFile) continue

        // Expected format: atlas-local-mode-YYYY-MM-DD.db
        const match = entry.name.match(/atlas-local-mode-(\d{4}-\d{2}-\d{2})\.db$/)
        if (!match) continue

        const backupDate = new Date(match[1])
        if (isNaN(backupDate.getTime())) continue

        if (backupDate < cutoff) {
            try {
                await remove(`${BACKUP_DIR}/${entry.name}`, { baseDir: BaseDirectory.AppData })
                console.log(`[DBBackup] Pruned old backup: ${entry.name}`)
            } catch (err) {
                console.warn(`[DBBackup] Failed to prune ${entry.name}:`, err)
            }
        }
    }
}

export async function runDailyBackupIfNeeded(workspaceId?: string | null) {
    if (!isTauri()) return
    if (!workspaceId || !shouldMirrorToSqlite(workspaceId)) return
    if (isBackupAlreadyDoneToday()) return

    try {
        const { exists, mkdir, copyFile, BaseDirectory } = await import('@tauri-apps/plugin-fs')

        // Check if the source .db file exists
        const dbExists = await exists(DB_FILENAME, { baseDir: BaseDirectory.AppData })
        if (!dbExists) {
            console.log('[DBBackup] No SQLite database file found, skipping backup')
            return
        }

        // Ensure backup directory exists
        try {
            await mkdir(BACKUP_DIR, { baseDir: BaseDirectory.AppData, recursive: true })
        } catch {
            // directory may already exist
        }

        const today = getTodayDateString()
        const backupFilename = `${BACKUP_DIR}/atlas-local-mode-${today}.db`

        // Check if today's backup already exists on disk
        const backupExists = await exists(backupFilename, { baseDir: BaseDirectory.AppData })
        if (backupExists) {
            markBackupDone()
            return
        }

        // Copy the database file
        await copyFile(DB_FILENAME, backupFilename, {
            fromPathBaseDir: BaseDirectory.AppData,
            toPathBaseDir: BaseDirectory.AppData
        })

        console.log(`[DBBackup] Daily backup created: ${backupFilename}`)
        markBackupDone()

        // Prune old backups in the background
        void pruneOldBackups()
    } catch (err) {
        console.error('[DBBackup] Failed to create daily backup:', err)
    }
}
