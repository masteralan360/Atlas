import type { CurrencyCode, IQDDisplayPreference, WorkspaceDataModeInput } from '@/local-db/models'

/**
 * Workspace settings that are edited by the user in Settings and stored
 * locally in Local mode (where Supabase sync is skipped). For these keys the
 * durable local workspace record is the source of truth in Local/Demo mode;
 * the remote `workspaces` row must not override it. Cloud Sync (`hybrid`) is
 * Supabase-backed, so the remote row is
 * authoritative there and the resolver leaves it untouched.
 */
export const LOCALLY_OWNED_SETTING_KEYS = [
  'default_currency',
  'pos_convert_to_workspace_currency',
  'iqd_display_preference',
  'allow_whatsapp',
  'coordination',
  'max_discount_percent',
  'print_lang',
  'print_qr',
  'receipt_template',
  'a4_template',
  'thermal_printing',
  'upload_limit_mb'
] as const

export type LocallyOwnedSettingKey = (typeof LOCALLY_OWNED_SETTING_KEYS)[number]

export interface LocallyOwnedSettings {
  default_currency?: CurrencyCode
  pos_convert_to_workspace_currency?: boolean
  iqd_display_preference?: IQDDisplayPreference
  allow_whatsapp?: boolean
  coordination?: string | null
  max_discount_percent?: number
  print_lang?: 'auto' | 'en' | 'ar' | 'ku'
  print_qr?: boolean
  receipt_template?: 'primary' | 'modern'
  a4_template?: 'primary' | 'modern' | 'professional'
  thermal_printing?: boolean
  upload_limit_mb?: number | null
}

type SettingsSource = Partial<Record<LocallyOwnedSettingKey, unknown>> | null

function isLocallyAuthoritativeMode(
  ...modes: Array<WorkspaceDataModeInput | null | undefined>
) {
  return modes.some((mode) => mode === 'local' || mode === 'demo')
}

/**
 * Resolves the locally-owned settings from a remote `workspaces` response.
 * In Local/Demo mode the durable local record wins, so an incomplete or
 * stale remote response cannot overwrite the user's local choices (e.g.
 * A4 template / print language). In Cloud Sync mode the remote row is
 * authoritative and this returns an empty object so existing merge behavior
 * is untouched.
 */
export function resolveFetchedWorkspaceSettings(input: {
  workspaceMode?: WorkspaceDataModeInput | null
  persistedMode?: WorkspaceDataModeInput | null
  remote?: SettingsSource
  persisted?: SettingsSource
  cached?: SettingsSource
  current?: SettingsSource
}): LocallyOwnedSettings {
  if (!isLocallyAuthoritativeMode(input.workspaceMode, input.persistedMode)) {
    return {}
  }

  const resolved: LocallyOwnedSettings = {}
  for (const key of LOCALLY_OWNED_SETTING_KEYS) {
    const sources = [input.persisted, input.cached, input.current, input.remote]
    const source = sources.find((candidate) => candidate && key in candidate)
    if (source) {
      ;(resolved as Record<string, unknown>)[key] = source[key]
    }
  }
  return resolved
}

/**
 * `null` from the next value means an explicit local clear (e.g. removing a
 * coordination location) and must be kept; otherwise prefer the existing
 * durable local value in Local/Demo mode so a remote snapshot can never
 * blank or overwrite a locally-owned setting before the app re-fetches it.
 */
export function resolvePersistedLocallyOwnedSettings(input: {
  nextMode?: WorkspaceDataModeInput | null
  existingMode?: WorkspaceDataModeInput | null
  next: SettingsSource
  existing: SettingsSource
}): LocallyOwnedSettings {
  const resolved: LocallyOwnedSettings = {}
  for (const key of LOCALLY_OWNED_SETTING_KEYS) {
    const nextValue = input.next?.[key]
    const existingValue = input.existing?.[key]

    if (!isLocallyAuthoritativeMode(input.nextMode, input.existingMode)) {
      if (nextValue !== undefined && nextValue !== null) {
        resolved[key] = nextValue as never
      }
      continue
    }

    if (nextValue === null && existingValue !== undefined) {
      resolved[key] = existingValue as never
    } else if (nextValue !== undefined && nextValue !== null) {
      resolved[key] = (nextValue ?? existingValue ?? null) as never
    } else if (existingValue !== undefined) {
      resolved[key] = existingValue as never
    }
  }
  return resolved
}

/**
 * Workspace display name: in Local/Demo mode the durable local name wins
 * even when the remote `workspaces` row still carries an older value.
 */
export function resolveFetchedWorkspaceName(input: {
  workspaceMode?: WorkspaceDataModeInput | null
  persistedMode?: WorkspaceDataModeInput | null
  remoteName?: string | null
  persistedName?: string | null
  cachedName?: string | null
  currentName?: string | null
}): string | null {
  if (!isLocallyAuthoritativeMode(input.workspaceMode, input.persistedMode)) {
    return input.remoteName ?? input.currentName ?? input.persistedName ?? null
  }

  return (
    input.persistedName ??
    input.cachedName ??
    input.currentName ??
    input.remoteName ??
    null
  )
}
