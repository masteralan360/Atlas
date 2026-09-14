import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() { return values.size },
  })
})

import { getR2BackupPath, getScopedBackupBaseName } from './sqliteBackup'

describe('scoped workspace backup paths', () => {
  const scope = {
    workspaceId: '10000000-0000-0000-0000-000000000001',
    userId: '20000000-0000-0000-0000-000000000002',
  }

  it('isolates filenames by workspace and user', () => {
    expect(getScopedBackupBaseName(scope)).toBe(
      'atlas-10000000-0000-0000-0000-000000000001-20000000-0000-0000-0000-000000000002',
    )
    expect(getScopedBackupBaseName({ ...scope, userId: 'another-user' }))
      .not.toBe(getScopedBackupBaseName(scope))
  })

  it('keeps the workspace in the R2 gateway authorization segment', () => {
    expect(getR2BackupPath(scope)).toBe(
      `local-backup/${scope.workspaceId}/${scope.userId}/v2/latest.atlasbackup`,
    )
  })
})
