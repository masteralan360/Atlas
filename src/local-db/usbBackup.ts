import { getActiveBusinessUserId, getActiveBusinessWorkspaceId } from '@/lib/network'
import { isDesktop } from '@/lib/platform'
import { ATLAS_BACKUP_EXTENSION, readAtlasBackupBundle } from './hybridBackupBundle'
import type { LocalModeSqliteScope } from './localModeSqlite'
import {
  captureWorkspaceBackupBundle,
  getScopedBackupBaseName,
  isWorkspaceBackupCaptureInProgress,
} from './sqliteBackup'
import { getUsbBackupDestination, isUsbBackupEnabled, setUsbBackupDestination } from './usbBackupSettings'

const LAST_BACKUP_KEY = 'atlas_usb_last_backup_time'
const USB_STAGING_DIR = 'db-backup/usb-staging'
const COPY_DEBOUNCE_MS = 5000
const lastCopyTimes = new Map<string, number>()
const pendingCopyTimers = new Map<string, ReturnType<typeof setTimeout>>()

function resolveScope(
  workspaceId?: string | null,
  userId?: string | null,
): LocalModeSqliteScope | null {
  const resolvedWorkspaceId = workspaceId ?? getActiveBusinessWorkspaceId()
  const resolvedUserId = userId ?? getActiveBusinessUserId()
  return resolvedWorkspaceId && resolvedUserId
    ? { workspaceId: resolvedWorkspaceId, userId: resolvedUserId }
    : null
}

function lastBackupKey(scope: LocalModeSqliteScope) {
  return `${LAST_BACKUP_KEY}:${scope.workspaceId}:${scope.userId}`
}

function scopeKey(scope: LocalModeSqliteScope) {
  return `${scope.workspaceId}:${scope.userId}`
}

export function getLastBackupTime(
  workspaceId?: string | null,
  userId?: string | null,
): number | null {
  const scope = resolveScope(workspaceId, userId)
  if (!scope) return null
  try {
    const value = localStorage.getItem(lastBackupKey(scope))
    return value ? Number(value) : null
  } catch {
    return null
  }
}

function setLastBackupTime(scope: LocalModeSqliteScope): void {
  try {
    localStorage.setItem(lastBackupKey(scope), String(Date.now()))
  } catch {
    // The copied archive remains authoritative.
  }
}

export async function pickUsbBackupDestination(): Promise<string | null> {
  if (!isDesktop()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    multiple: false,
    directory: true,
    title: 'Select USB Backup Destination',
  })
  if (selected && typeof selected === 'string') {
    setUsbBackupDestination(selected)
    return selected
  }
  return null
}

export async function checkUsbDestinationValid(path: string): Promise<boolean> {
  if (!isDesktop()) return false
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    return await invoke<boolean>('check_path_exists', { path })
  } catch {
    return false
  }
}

function joinExternalPath(directory: string, filename: string) {
  const separator = directory.includes('/') ? '/' : '\\'
  const normalized = directory.endsWith('/') || directory.endsWith('\\')
    ? directory.slice(0, -1)
    : directory
  return `${normalized}${separator}${filename}`
}

export async function copyDbToUsb(
  destDir: string,
  workspaceId?: string | null,
  userId?: string | null,
): Promise<boolean> {
  if (!isDesktop()) return false
  const scope = resolveScope(workspaceId, userId)
  if (!scope) return false

  const { invoke } = await import('@tauri-apps/api/core')
  const { mkdir, writeFile, readFile, remove, BaseDirectory } = await import('@tauri-apps/plugin-fs')
  const filename = `${getScopedBackupBaseName(scope)}.${ATLAS_BACKUP_EXTENSION}`
  const stagingPath = `${USB_STAGING_DIR}/${filename}`
  const destinationPath = joinExternalPath(destDir, filename)
  try {
    const bundle = await captureWorkspaceBackupBundle(scope)
    await mkdir(USB_STAGING_DIR, { baseDir: BaseDirectory.AppData, recursive: true })
    await writeFile(stagingPath, bundle.bytes, { baseDir: BaseDirectory.AppData })
    await readAtlasBackupBundle(
      await readFile(stagingPath, { baseDir: BaseDirectory.AppData }),
      scope,
    )

    const copied = await invoke<number>('backup_db_to_usb', {
      dbFilename: stagingPath,
      destPath: destinationPath,
    })
    const destinationSize = await invoke<number>('get_file_size', { path: destinationPath })
    if (copied !== bundle.bytes.byteLength || destinationSize !== bundle.bytes.byteLength) {
      throw new Error('USB backup verification failed because the copied size does not match.')
    }
    setLastBackupTime(scope)
    return true
  } catch (error) {
    console.warn('[UsbBackup] Failed to copy workspace backup to USB:', error)
    return false
  } finally {
    await remove(stagingPath, { baseDir: BaseDirectory.AppData }).catch(() => undefined)
  }
}

export async function runUsbBackupIfNeeded(
  workspaceId?: string | null,
  userId?: string | null,
): Promise<void> {
  if (!isDesktop()) return
  // Checkpointing is itself serialized as a SQLite write. Do not let the
  // post-write USB hook recursively start another backup for that checkpoint.
  if (isWorkspaceBackupCaptureInProgress()) return
  const dest = getUsbBackupDestination()
  if (!dest || !isUsbBackupEnabled()) return

  const scope = resolveScope(workspaceId, userId)
  if (!scope) return
  const key = scopeKey(scope)
  const now = Date.now()
  if (now - (lastCopyTimes.get(key) ?? 0) < COPY_DEBOUNCE_MS) {
    if (pendingCopyTimers.has(key)) return
    pendingCopyTimers.set(key, setTimeout(() => {
      pendingCopyTimers.delete(key)
      lastCopyTimes.set(key, 0)
      void runUsbBackupIfNeeded(scope.workspaceId, scope.userId)
    }, COPY_DEBOUNCE_MS))
    return
  }

  lastCopyTimes.set(key, now)
  await copyDbToUsb(dest, scope.workspaceId, scope.userId)
}

export async function validateUsbBackupOnStartup(): Promise<{
  valid: boolean
  destination: string | null
  reason?: string
}> {
  if (!isDesktop()) return { valid: true, destination: null }
  const dest = getUsbBackupDestination()
  if (!dest || !isUsbBackupEnabled()) return { valid: true, destination: null }
  if (!(await checkUsbDestinationValid(dest))) {
    return {
      valid: false,
      destination: dest,
      reason: 'The USB backup destination is no longer available. The drive may have been disconnected, renamed, or is inaccessible.',
    }
  }
  return { valid: true, destination: dest }
}
