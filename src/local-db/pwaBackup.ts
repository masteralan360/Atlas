import {
  exportPwaDatabase,
  type PwaSqliteScope,
} from "./pwaSqlite";
import { getActiveBusinessUserId, getActiveBusinessWorkspaceId } from "@/lib/network";
import {
  ATLAS_BACKUP_EXTENSION,
  ATLAS_BACKUP_MIME_TYPE,
  collectPwaWorkspaceBackupAssets,
  createAtlasBackupBundle,
  readAtlasBackupBundle,
} from "./hybridBackupBundle";

const BACKUP_DIR = "db-backup";
const MAX_BACKUP_DAYS = 7;
const BACKUP_DONE_KEY = "atlas_db_backup_date";

function resolveScope(scope?: PwaSqliteScope): PwaSqliteScope | null {
  if (scope?.workspaceId && scope.userId) return scope;
  const workspaceId = getActiveBusinessWorkspaceId();
  const userId = getActiveBusinessUserId();
  return workspaceId && userId ? { workspaceId, userId } : null;
}

function safeName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
}

function backupBaseName(scope: PwaSqliteScope) {
  return `atlas-${safeName(scope.workspaceId)}-${safeName(scope.userId)}`;
}

function backupDoneKey(scope: PwaSqliteScope) {
  return `${BACKUP_DONE_KEY}:${scope.workspaceId}:${scope.userId}`;
}

function getTodayDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function isBackupAlreadyDoneToday(scope: PwaSqliteScope) {
  try {
    return localStorage.getItem(backupDoneKey(scope)) === getTodayDateString();
  } catch {
    return false;
  }
}

function markBackupDone(scope: PwaSqliteScope) {
  try {
    localStorage.setItem(backupDoneKey(scope), getTodayDateString());
  } catch {
    // noop
  }
}

async function getOrCreateBackupDir(scope: PwaSqliteScope): Promise<FileSystemDirectoryHandle | null> {
  try {
    let directory: FileSystemDirectoryHandle = await navigator.storage.getDirectory();
    for (const segment of [BACKUP_DIR, encodeURIComponent(scope.workspaceId), encodeURIComponent(scope.userId)]) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
    return directory;
  } catch {
    return null;
  }
}

async function pruneOldBackups(scope: PwaSqliteScope): Promise<void> {
  try {
    const dir = await getOrCreateBackupDir(scope);
    if (!dir) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_BACKUP_DAYS);

    for await (const [name] of (dir as any).entries()) {
      const match = name.match(new RegExp(`^${backupBaseName(scope)}-(\\d{4}-\\d{2}-\\d{2})\\.${ATLAS_BACKUP_EXTENSION}$`));
      if (!match) continue;

      const backupDate = new Date(match[1]);
      if (isNaN(backupDate.getTime())) continue;

      if (backupDate < cutoff) {
        await dir.removeEntry(name);
      }
    }
  } catch (error) {
    console.warn("[PwaBackup] Failed to prune old backups:", error);
  }
}

export async function runPwaDailyBackupIfNeeded(requestedScope?: PwaSqliteScope): Promise<void> {
  const scope = resolveScope(requestedScope);
  if (!scope || isBackupAlreadyDoneToday(scope)) return;
  if (!("storage" in navigator && typeof (navigator.storage as any).getDirectory === "function")) return;

  try {
    const data = await exportPwaDatabase(scope, { openIfNeeded: false });
    if (!data) return;
    const bundle = await createAtlasBackupBundle({
      scope,
      database: data,
      assets: await collectPwaWorkspaceBackupAssets(scope),
    });

    const dir = await getOrCreateBackupDir(scope);
    if (!dir) return;

    const today = getTodayDateString();
    const backupName = `${backupBaseName(scope)}-${today}.${ATLAS_BACKUP_EXTENSION}`;

    try {
      await dir.getFileHandle(backupName);
      markBackupDone(scope);
      return;
    } catch {
      // File doesn't exist yet, continue
    }

    const handle = await dir.getFileHandle(backupName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bundle.bytes);
    await writable.close();

    const saved = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    await readAtlasBackupBundle(saved, scope);
    markBackupDone(scope);
    void pruneOldBackups(scope);
  } catch (error) {
    console.error("[PwaBackup] Daily backup failed:", error);
  }
}

export async function downloadPwaBackup(requestedScope?: PwaSqliteScope): Promise<void> {
  const scope = resolveScope(requestedScope);
  if (!scope) throw new Error("A workspace and user are required to export a backup.");
  const database = await exportPwaDatabase(scope);
  if (!database) return;
  const bundle = await createAtlasBackupBundle({
    scope,
    database,
    assets: await collectPwaWorkspaceBackupAssets(scope),
  });

  const today = getTodayDateString();
  const backupName = `${backupBaseName(scope)}-${today}.${ATLAS_BACKUP_EXTENSION}`;
  const blob = new Blob([bundle.bytes], { type: ATLAS_BACKUP_MIME_TYPE });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = backupName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function exportPwaStoreFile(requestedScope?: PwaSqliteScope): Promise<void> {
  const scope = resolveScope(requestedScope);
  if (!scope) throw new Error("A workspace and user are required to export the database.");
  const data = await exportPwaDatabase(scope);
  if (!data) return;

  const blob = new Blob([data], { type: "application/x-sqlite3" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${backupBaseName(scope)}.db`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function restorePwaBackup(file: File, requestedScope?: PwaSqliteScope): Promise<boolean> {
  try {
    const scope = resolveScope(requestedScope);
    if (!scope) throw new Error("A workspace and user are required to restore a backup.");
    const arrayBuffer = await file.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    // Use the same staged asset + rollback-safe database transaction as the
    // desktop settings restore flow. The dynamic import avoids the daily
    // backup module cycle during application startup.
    const { restoreWorkspaceBackup } = await import("./sqliteBackup");
    await restoreWorkspaceBackup(data, scope.workspaceId, scope.userId);

    return true;
  } catch (error) {
    console.error("[PwaBackup] Restore failed:", error);
    return false;
  }
}
