import { readWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'
import type { WorkspaceDataModeInput } from './models'

type ReconciliationMode = WorkspaceDataModeInput | null | undefined

/**
 * Remote reconciliation may remove local rows. It must therefore be enabled
 * only by a positive, durable indication that this workspace uses Cloud Sync.
 * An absent browser snapshot is intentionally *not* treated as Cloud Sync: that is
 * the startup state that previously let an empty remote response erase Local
 * Mode records.
 */
export function hasConfirmedCloudReconciliationAuthority(
  snapshotMode: ReconciliationMode,
  persistedMode: ReconciliationMode,
) {
  const modes = [snapshotMode, persistedMode]

  if (modes.some((mode) => mode === 'local' || mode === 'demo')) {
    return false
  }

  return modes.some((mode) => mode === 'cloud' || mode === 'hybrid')
}

export async function canReconcileCloudWorkspaceData(
  workspaceId?: string | null,
) {
  if (!workspaceId) {
    return false
  }

  const snapshotMode = readWorkspaceModeSnapshot(workspaceId)?.dataMode
  const persistedMode = (await db.workspaces.get(workspaceId))?.data_mode

  return hasConfirmedCloudReconciliationAuthority(snapshotMode, persistedMode)
}
