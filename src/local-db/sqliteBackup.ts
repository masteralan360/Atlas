import { getActiveBusinessUserId } from '@/lib/network'
import { isTauri } from '@/lib/platform'
import { r2Service } from '@/services/r2Service'
import { isStrictLocalWorkspaceMode, shouldMirrorToSqlite } from '@/workspace/workspaceMode'
import {
    ATLAS_BACKUP_EXTENSION,
    ATLAS_BACKUP_MIME_TYPE,
    collectPwaWorkspaceBackupAssets,
    collectTauriWorkspaceBackupAssets,
    createAtlasBackupBundle,
    looksLikeAtlasBackupBundle,
    readAtlasBackupBundle,
    stagePwaWorkspaceBackupAssets,
    stageTauriWorkspaceBackupAssets,
    type CreatedAtlasBackupBundle,
} from './hybridBackupBundle'
import {
    captureLocalModeSqliteDatabaseForBackup,
    type LocalModeSqliteScope,
} from './localModeSqlite'
import { runPwaDailyBackupIfNeeded } from './pwaBackup'

const BACKUP_DIR = 'db-backup'
const MAX_BACKUP_DAYS = 7
const BACKUP_DONE_KEY = 'atlas_db_backup_date'
const R2_BACKUP_INTERVAL_MS = 5 * 60 * 60 * 1000
const R2_BACKUP_TIME_KEY = 'atlas_db_r2_backup_time'

export type UpdateSafetyBackupResult =
    | { created: false }
    | { created: true; path: string }

function safeName(value: string) {
    return value.trim().replace(/[^a-zA-Z0-9_-]/g, '-')
}

function resolveBackupScope(
    workspaceId?: string | null,
    userId?: string | null,
): LocalModeSqliteScope | null {
    const resolvedUserId = userId ?? getActiveBusinessUserId()
    return workspaceId && resolvedUserId ? { workspaceId, userId: resolvedUserId } : null
}

export function getScopedBackupBaseName(scope: LocalModeSqliteScope) {
    return `atlas-${safeName(scope.workspaceId)}-${safeName(scope.userId)}`
}

function getScopedBackupDirectory(scope: LocalModeSqliteScope) {
    return `${BACKUP_DIR}/${safeName(scope.workspaceId)}/${safeName(scope.userId)}`
}

function getTodayDateString() {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function scopedStorageKey(prefix: string, scope: LocalModeSqliteScope) {
    return `${prefix}:${scope.workspaceId}:${scope.userId}`
}

function isBackupAlreadyDoneToday(scope: LocalModeSqliteScope) {
    try {
        return localStorage.getItem(scopedStorageKey(BACKUP_DONE_KEY, scope)) === getTodayDateString()
    } catch {
        return false
    }
}

function markBackupDone(scope: LocalModeSqliteScope) {
    try {
        localStorage.setItem(scopedStorageKey(BACKUP_DONE_KEY, scope), getTodayDateString())
    } catch {
        // Optional scheduling metadata; the verified archive is authoritative.
    }
}

async function pruneOldBackups(scope: LocalModeSqliteScope) {
    const { readDir, remove, BaseDirectory } = await import('@tauri-apps/plugin-fs')
    const directory = getScopedBackupDirectory(scope)
    let entries: Array<{ name?: string | null; isFile?: boolean }>
    try {
        entries = await readDir(directory, { baseDir: BaseDirectory.AppData })
    } catch {
        return
    }

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - MAX_BACKUP_DAYS)
    const baseName = getScopedBackupBaseName(scope).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`^${baseName}-(\\d{4}-\\d{2}-\\d{2})\\.${ATLAS_BACKUP_EXTENSION}$`)

    for (const entry of entries) {
        if (!entry.name || !entry.isFile) continue
        const match = entry.name.match(pattern)
        if (!match) continue
        const backupDate = new Date(match[1])
        if (!Number.isFinite(backupDate.getTime()) || backupDate >= cutoff) continue
        try {
            await remove(`${directory}/${entry.name}`, { baseDir: BaseDirectory.AppData })
        } catch (error) {
            console.warn(`[DBBackup] Failed to prune ${entry.name}:`, error)
        }
    }
}

function isBackupMirrorEnabled(workspaceId?: string | null) {
    return isTauri()
        ? shouldMirrorToSqlite(workspaceId)
        : isStrictLocalWorkspaceMode(workspaceId) || shouldMirrorToSqlite(workspaceId)
}

let captureQueue: Promise<unknown> = Promise.resolve()
let captureDepth = 0

export function isWorkspaceBackupCaptureInProgress() {
    return captureDepth > 0
}

/**
 * Capture one consistent, portable workspace/user backup. The archive is not
 * encrypted by design. It contains a SHA-256 manifest, the SQLite database,
 * and a deduplicated content-addressed asset sidecar.
 */
export function captureWorkspaceBackupBundle(
    scope: LocalModeSqliteScope,
): Promise<CreatedAtlasBackupBundle> {
    const capture = captureQueue.catch(() => undefined).then(async () => {
        captureDepth += 1
        try {
            const database = await captureLocalModeSqliteDatabaseForBackup(scope)
            return createAtlasBackupBundle({
                scope,
                database,
                assets: isTauri()
                    ? await collectTauriWorkspaceBackupAssets(scope)
                    : await collectPwaWorkspaceBackupAssets(scope),
            })
        } finally {
            captureDepth -= 1
        }
    })
    captureQueue = capture
    return capture
}

export async function downloadWorkspaceBackup(
    workspaceId?: string | null,
    userId?: string | null,
) {
    const scope = resolveBackupScope(workspaceId, userId)
    if (!scope) throw new Error('A workspace and user are required to export a backup.')
    const bundle = await captureWorkspaceBackupBundle(scope)
    const filename = `${getScopedBackupBaseName(scope)}-${getTodayDateString()}.${ATLAS_BACKUP_EXTENSION}`

    if (isTauri()) {
        const [{ save }, { writeFile }] = await Promise.all([
            import('@tauri-apps/plugin-dialog'),
            import('@tauri-apps/plugin-fs'),
        ])
        const destination = await save({
            defaultPath: filename,
            filters: [{ name: 'Atlas Workspace Backup', extensions: [ATLAS_BACKUP_EXTENSION] }],
        })
        if (!destination) return false
        await writeFile(destination, bundle.bytes)
        return true
    }

    const blob = new Blob([bundle.bytes], { type: ATLAS_BACKUP_MIME_TYPE })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    return true
}

export async function restoreWorkspaceBackup(
    bytes: Uint8Array,
    workspaceId?: string | null,
    userId?: string | null,
) {
    const scope = resolveBackupScope(workspaceId, userId)
    if (!scope) throw new Error('A workspace and user are required to restore a backup.')
    const { injectLocalModeDatabaseFile } = await import('./localModeSqlite')

    if (!looksLikeAtlasBackupBundle(bytes)) {
        // Read compatibility for raw SQLite exports created before bundle v1.
        await injectLocalModeDatabaseFile(bytes, scope)
        return { legacy: true, assetCount: 0 }
    }

    // Verify the entire archive before mutating any persisted state.
    const bundle = await readAtlasBackupBundle(bytes, scope)
    const assetPlan = isTauri()
        ? await stageTauriWorkspaceBackupAssets(scope, bundle.assets)
        : await stagePwaWorkspaceBackupAssets(scope, bundle.assets)
    try {
        await injectLocalModeDatabaseFile(bundle.database, scope, {
            requireScopedIdentity: true,
            commitExternalState: assetPlan.commit,
            rollbackExternalState: assetPlan.rollback,
        })
        await assetPlan.finalize()
    } finally {
        await assetPlan.cleanup()
    }
    return { legacy: false, assetCount: bundle.assets.length }
}

export async function runDailyBackupIfNeeded(
    workspaceId?: string | null,
    userId?: string | null,
) {
    const scope = resolveBackupScope(workspaceId, userId)
    if (!scope || !isBackupMirrorEnabled(scope.workspaceId) || isBackupAlreadyDoneToday(scope)) return

    if (!isTauri()) {
        await runPwaDailyBackupIfNeeded(scope)
        return
    }

    try {
        const { exists, mkdir, writeFile, readFile, BaseDirectory } = await import('@tauri-apps/plugin-fs')
        const directory = getScopedBackupDirectory(scope)
        await mkdir(directory, { baseDir: BaseDirectory.AppData, recursive: true })
        const backupPath = `${directory}/${getScopedBackupBaseName(scope)}-${getTodayDateString()}.${ATLAS_BACKUP_EXTENSION}`
        if (await exists(backupPath, { baseDir: BaseDirectory.AppData })) {
            markBackupDone(scope)
            return
        }

        const bundle = await captureWorkspaceBackupBundle(scope)
        await writeFile(backupPath, bundle.bytes, { baseDir: BaseDirectory.AppData })
        await readAtlasBackupBundle(
            await readFile(backupPath, { baseDir: BaseDirectory.AppData }),
            scope,
        )
        markBackupDone(scope)
        void pruneOldBackups(scope)
    } catch (error) {
        console.error('[DBBackup] Failed to create daily workspace backup:', error)
    }
}

/**
 * Make a verified recovery archive immediately before a desktop update starts.
 * A failed capture deliberately prevents installation.
 */
export async function createUpdateSafetyBackupIfNeeded(
    workspaceId?: string | null,
    userId?: string | null,
): Promise<UpdateSafetyBackupResult> {
    const scope = resolveBackupScope(workspaceId, userId)
    if (!scope || !isTauri() || !shouldMirrorToSqlite(scope.workspaceId)) return { created: false }

    const { mkdir, writeFile, readFile, BaseDirectory } = await import('@tauri-apps/plugin-fs')
    const directory = getScopedBackupDirectory(scope)
    await mkdir(directory, { baseDir: BaseDirectory.AppData, recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${directory}/${getScopedBackupBaseName(scope)}-before-update-${timestamp}.${ATLAS_BACKUP_EXTENSION}`
    const bundle = await captureWorkspaceBackupBundle(scope)
    await writeFile(backupPath, bundle.bytes, { baseDir: BaseDirectory.AppData })
    await readAtlasBackupBundle(
        await readFile(backupPath, { baseDir: BaseDirectory.AppData }),
        scope,
    )
    return { created: true, path: backupPath }
}

function isR2BackupDue(scope: LocalModeSqliteScope) {
    try {
        const lastTime = localStorage.getItem(scopedStorageKey(R2_BACKUP_TIME_KEY, scope))
        return !lastTime || Date.now() - Number(lastTime) >= R2_BACKUP_INTERVAL_MS
    } catch {
        return true
    }
}

function markR2BackupDone(scope: LocalModeSqliteScope) {
    try {
        localStorage.setItem(scopedStorageKey(R2_BACKUP_TIME_KEY, scope), String(Date.now()))
    } catch {
        // Optional scheduling metadata.
    }
}

export function getR2BackupPath(scope: LocalModeSqliteScope) {
    // Keep the workspace as the second path segment: the authenticated R2
    // gateway uses local-backup/{workspaceId}/... for authorization/metering.
    return `local-backup/${encodeURIComponent(scope.workspaceId)}/${encodeURIComponent(scope.userId)}/v2/latest.${ATLAS_BACKUP_EXTENSION}`
}

export async function runR2BackupIfNeeded(
    workspaceId: string | undefined | null,
    userId?: string | null,
): Promise<void> {
    const scope = resolveBackupScope(workspaceId, userId)
    if (!scope || !isBackupMirrorEnabled(scope.workspaceId) || !isR2BackupDue(scope)) return

    try {
        const bundle = await captureWorkspaceBackupBundle(scope)
        const uploadedUrl = await r2Service.upload(
            getR2BackupPath(scope),
            new Blob([bundle.bytes], { type: ATLAS_BACKUP_MIME_TYPE }),
            ATLAS_BACKUP_MIME_TYPE,
            true,
        )
        if (!uploadedUrl) throw new Error('The R2 backup upload did not return a stored object URL.')
        markR2BackupDone(scope)
    } catch (error) {
        console.warn('[R2Backup] Failed to upload workspace backup:', error)
    }
}

let r2BackupInterval: ReturnType<typeof setInterval> | null = null

export function startR2BackupInterval(
    workspaceId: string | undefined | null,
    userId?: string | null,
): void {
    if (r2BackupInterval) clearInterval(r2BackupInterval)
    void runR2BackupIfNeeded(workspaceId, userId)
    r2BackupInterval = setInterval(() => {
        void runR2BackupIfNeeded(workspaceId, userId)
    }, R2_BACKUP_INTERVAL_MS)
}

export function stopR2BackupInterval(): void {
    if (r2BackupInterval) {
        clearInterval(r2BackupInterval)
        r2BackupInterval = null
    }
}
