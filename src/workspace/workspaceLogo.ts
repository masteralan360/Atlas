import type { WorkspaceDataModeInput } from '@/local-db/models'

function usesLocallyAuthoritativeLogo(
  ...modes: Array<WorkspaceDataModeInput | null | undefined>
) {
  return modes.some((mode) => mode === 'local' || mode === 'hybrid')
}

/**
 * Remote workspace responses do not own the logo for Local/Hybrid workspaces.
 * Prefer the durable local workspace record so an incomplete response cannot
 * blank the logo in memory or overwrite the SQLite source of truth.
 */
export function resolveFetchedWorkspaceLogo(input: {
  workspaceMode?: WorkspaceDataModeInput | null
  persistedWorkspaceMode?: WorkspaceDataModeInput | null
  persistedLogoUrl?: string | null
  cachedLogoUrl?: string | null
  currentLogoUrl?: string | null
  remoteLogoUrl?: string | null
}) {
  if (!usesLocallyAuthoritativeLogo(input.workspaceMode, input.persistedWorkspaceMode)) {
    return input.remoteLogoUrl ?? null
  }

  return input.persistedLogoUrl
    ?? input.cachedLogoUrl
    ?? input.currentLogoUrl
    ?? input.remoteLogoUrl
    ?? null
}

/**
 * `null` from a background refresh means no usable remote value; keep the
 * stored Local/Hybrid logo. An empty string is an explicit user request to
 * clear the logo and must be persisted as-is.
 */
export function resolvePersistedWorkspaceLogo(input: {
  nextWorkspaceMode?: WorkspaceDataModeInput | null
  existingWorkspaceMode?: WorkspaceDataModeInput | null
  nextLogoUrl?: string | null
  existingLogoUrl?: string | null
}) {
  if (!usesLocallyAuthoritativeLogo(input.nextWorkspaceMode, input.existingWorkspaceMode)) {
    return input.nextLogoUrl ?? null
  }

  return input.nextLogoUrl === null
    ? input.existingLogoUrl ?? null
    : input.nextLogoUrl ?? input.existingLogoUrl ?? null
}
