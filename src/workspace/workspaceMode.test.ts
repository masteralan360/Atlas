import { beforeEach, describe, expect, it } from 'vitest'

import {
  getWorkspaceDataMode,
  isCloudSyncWorkspaceMode,
  isDemoWorkspaceMode,
  isLocalWorkspaceMode,
  normalizeWorkspaceDataMode,
  shouldMirrorToSqlite,
  USER_SELECTABLE_WORKSPACE_DATA_MODES,
  writeWorkspaceModeSnapshot,
} from './workspaceMode'

function installBrowserStorage() {
  const rows = new Map<string, string>()
  const storage = {
    get length() {
      return rows.size
    },
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
    removeItem: (key: string) => rows.delete(key),
    clear: () => rows.clear(),
    key: (index: number) => Array.from(rows.keys())[index] ?? null,
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
}

describe('workspace data modes', () => {
  beforeEach(() => {
    installBrowserStorage()
  })

  it('offers only Cloud Sync and Local to users', () => {
    expect(USER_SELECTABLE_WORKSPACE_DATA_MODES).toEqual(['hybrid', 'local'])
    expect(USER_SELECTABLE_WORKSPACE_DATA_MODES).not.toContain('demo')
    expect(USER_SELECTABLE_WORKSPACE_DATA_MODES).not.toContain('cloud')
  })

  it('normalizes missing, unknown, and legacy cloud modes to Cloud Sync', () => {
    expect(normalizeWorkspaceDataMode()).toBe('hybrid')
    expect(normalizeWorkspaceDataMode('cloud')).toBe('hybrid')
    expect(normalizeWorkspaceDataMode('unexpected')).toBe('hybrid')
  })

  it('preserves canonical local, Cloud Sync, and demo modes', () => {
    expect(normalizeWorkspaceDataMode('local')).toBe('local')
    expect(normalizeWorkspaceDataMode('hybrid')).toBe('hybrid')
    expect(normalizeWorkspaceDataMode('demo')).toBe('demo')
  })

  it('rewrites a legacy cloud browser snapshot as canonical hybrid', () => {
    localStorage.setItem('atlas_workspace_mode:legacy-workspace', JSON.stringify({
      workspaceId: 'legacy-workspace',
      dataMode: 'cloud',
    }))

    expect(getWorkspaceDataMode('legacy-workspace')).toBe('hybrid')
    expect(isCloudSyncWorkspaceMode('legacy-workspace')).toBe(true)
    expect(JSON.parse(localStorage.getItem('atlas_workspace_mode:legacy-workspace') ?? '{}')).toEqual({
      workspaceId: 'legacy-workspace',
      dataMode: 'hybrid',
    })
  })

  it('uses demo as local business storage without enabling SQLite mirroring', () => {
    writeWorkspaceModeSnapshot({
      workspaceId: 'demo-workspace',
      dataMode: 'demo',
    })

    expect(getWorkspaceDataMode('demo-workspace')).toBe('demo')
    expect(isDemoWorkspaceMode('demo-workspace')).toBe(true)
    expect(isLocalWorkspaceMode('demo-workspace')).toBe(true)
    expect(shouldMirrorToSqlite('demo-workspace')).toBe(false)
  })
})
