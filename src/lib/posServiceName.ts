export interface PosServiceNameSnapshot {
  baseNameSnapshot: string
  suffix: string
  displayNameSnapshot: string
}

export interface PosLineMetadata extends Record<string, unknown> {
  posServiceName?: PosServiceNameSnapshot
}

export function normalizePosServiceNameSuffix(value: string | null | undefined) {
  return typeof value === 'string' ? value.trim() : ''
}

export function formatPosServiceName(baseName: string, suffix?: string | null) {
  const base = baseName.trim()
  const addition = normalizePosServiceNameSuffix(suffix)
  if (!addition) return base
  if (!base) return addition
  return `${base} - ${addition}`
}

export function createPosServiceNameMetadata(
  baseName: string,
  suffix?: string | null,
): PosLineMetadata | undefined {
  const baseNameSnapshot = baseName.trim()
  const normalizedSuffix = normalizePosServiceNameSuffix(suffix)
  if (!baseNameSnapshot || !normalizedSuffix) return undefined

  return {
    posServiceName: {
      baseNameSnapshot,
      suffix: normalizedSuffix,
      displayNameSnapshot: formatPosServiceName(baseNameSnapshot, normalizedSuffix),
    },
  }
}

export function readPosServiceNameSnapshot(
  metadata: Record<string, unknown> | null | undefined,
): PosServiceNameSnapshot | null {
  const value = metadata?.posServiceName
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const snapshot = value as Record<string, unknown>
  if (typeof snapshot.baseNameSnapshot !== 'string' || typeof snapshot.suffix !== 'string') {
    return null
  }

  const baseNameSnapshot = snapshot.baseNameSnapshot.trim()
  const suffix = normalizePosServiceNameSuffix(snapshot.suffix)
  if (!baseNameSnapshot || !suffix) return null

  const displayNameSnapshot = typeof snapshot.displayNameSnapshot === 'string'
    ? snapshot.displayNameSnapshot.trim()
    : formatPosServiceName(baseNameSnapshot, suffix)
  if (displayNameSnapshot !== formatPosServiceName(baseNameSnapshot, suffix)) return null

  return { baseNameSnapshot, suffix, displayNameSnapshot }
}

export function getPosServiceDisplayName(
  baseName: string,
  metadata: Record<string, unknown> | null | undefined,
) {
  const snapshot = readPosServiceNameSnapshot(metadata)
  return snapshot
    ? snapshot.displayNameSnapshot
    : baseName
}
