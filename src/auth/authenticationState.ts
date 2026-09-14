import type { WorkspaceDataMode, WorkspaceDataModeInput } from '@/local-db/models'
import { normalizeWorkspaceDataMode } from '@/workspace/workspaceMode'

interface AuthenticationState {
  hasSession: boolean
  hasUser: boolean
  canRestoreWithoutSession: boolean
}

interface CachedProfileAssignment {
  id: string
  workspaceId: string
  currentWorkspaceId?: string
}

interface RecoveredWorkspaceAssignment {
  id: string
  workspaceId: string
  sourceWorkspaceId?: string
  workspaceCode?: string
  workspaceName?: string
  isConfigured?: boolean
  workspaceMode?: WorkspaceDataModeInput
}

export interface CachedWorkspaceAssignment {
  sourceWorkspaceId: string
  currentWorkspaceId: string
  workspaceCode?: string
  workspaceName?: string
  isConfigured?: boolean
  workspaceMode?: WorkspaceDataMode
}

export function canRestoreWorkspaceRecoveryWithoutSession(
  recovered: Pick<RecoveredWorkspaceAssignment, 'workspaceId' | 'workspaceMode'> | null | undefined,
  browserOffline: boolean
) {
  if (!recovered?.workspaceId) return false

  const mode = normalizeWorkspaceDataMode(recovered.workspaceMode)
  return mode === 'local' || mode === 'demo' || browserOffline
}

export function isAuthenticatedState({
  hasSession,
  hasUser,
  canRestoreWithoutSession
}: AuthenticationState) {
  return hasUser && (hasSession || canRestoreWithoutSession)
}

/**
 * Resolve only previously verified local state. Callers must use this solely
 * when the online profile bootstrap failed, never when Supabase successfully
 * reports that the user has no current workspace.
 */
export function resolveCachedWorkspaceAssignment(options: {
  authenticatedUserId: string
  recoveredUser?: RecoveredWorkspaceAssignment | null
  cachedProfile?: CachedProfileAssignment | null
  recoveredUserIsActiveLocalAccount?: boolean
}): CachedWorkspaceAssignment | null {
  const {
    authenticatedUserId,
    recoveredUser,
    cachedProfile,
    recoveredUserIsActiveLocalAccount = false
  } = options

  if (
    recoveredUser?.workspaceId
    && (recoveredUser.id === authenticatedUserId || recoveredUserIsActiveLocalAccount)
  ) {
    return {
      sourceWorkspaceId: recoveredUser.sourceWorkspaceId || recoveredUser.workspaceId,
      currentWorkspaceId: recoveredUser.workspaceId,
      workspaceCode: recoveredUser.workspaceCode,
      workspaceName: recoveredUser.workspaceName,
      isConfigured: recoveredUser.isConfigured,
      workspaceMode: recoveredUser.workspaceMode === undefined
        ? undefined
        : normalizeWorkspaceDataMode(recoveredUser.workspaceMode)
    }
  }

  if (cachedProfile?.id === authenticatedUserId && cachedProfile.workspaceId) {
    return {
      sourceWorkspaceId: cachedProfile.workspaceId,
      currentWorkspaceId: cachedProfile.currentWorkspaceId || cachedProfile.workspaceId
    }
  }

  return null
}
