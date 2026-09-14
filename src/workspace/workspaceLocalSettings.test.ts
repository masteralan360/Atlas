import { describe, expect, it } from 'vitest'

import {
  resolveFetchedWorkspaceName,
  resolveFetchedWorkspaceSettings,
  resolvePersistedLocallyOwnedSettings,
} from './workspaceLocalSettings'

describe('Local Mode workspace settings', () => {
  it('keeps the durable local A4 template / print language over a stale remote row', () => {
    expect(resolveFetchedWorkspaceSettings({
      workspaceMode: 'local',
      persistedMode: 'local',
      remote: { a4_template: 'professional', print_lang: 'auto' },
      persisted: { a4_template: 'modern', print_lang: 'ku' },
      current: { a4_template: 'modern', print_lang: 'ku' },
    })).toEqual({
      a4_template: 'modern',
      print_lang: 'ku',
    })
  })

  it('prefers the cached snapshot when no persisted record exists yet', () => {
    expect(resolveFetchedWorkspaceSettings({
      workspaceMode: 'local',
      persistedMode: 'local',
      remote: { receipt_template: 'primary', print_qr: false },
      cached: { receipt_template: 'modern', print_qr: true },
      current: {},
    })).toEqual({
      receipt_template: 'modern',
      print_qr: true,
    })
  })

  it('keeps the remote row authoritative in Cloud Sync mode', () => {
    expect(resolveFetchedWorkspaceSettings({
      workspaceMode: 'hybrid',
      persistedMode: 'hybrid',
      remote: { a4_template: 'professional', print_lang: 'auto' },
      persisted: { a4_template: 'modern', print_lang: 'ku' },
      current: { a4_template: 'modern', print_lang: 'ku' },
    })).toEqual({})
  })

  it('keeps legacy cloud values remote-authoritative during compatibility', () => {
    expect(resolveFetchedWorkspaceSettings({
      workspaceMode: 'cloud',
      persistedMode: 'cloud',
      remote: { a4_template: 'professional' },
      persisted: { a4_template: 'modern' },
      current: {},
    })).toEqual({})
  })

  it('does not overwrite a local setting with a null refresh', () => {
    expect(resolvePersistedLocallyOwnedSettings({
      nextMode: 'local',
      existingMode: 'local',
      next: { coordination: null },
      existing: { coordination: 'Erbil, Iraq' },
    })).toEqual({ coordination: 'Erbil, Iraq' })
  })

  it('keeps the durable local workspace name in local mode', () => {
    expect(resolveFetchedWorkspaceName({
      workspaceMode: 'local',
      persistedMode: 'local',
      remoteName: 'Old Remote Name',
      persistedName: 'My Local Shop',
    })).toBe('My Local Shop')
  })

  it('prefers the remote workspace name for a legacy cloud value', () => {
    expect(resolveFetchedWorkspaceName({
      workspaceMode: 'cloud',
      persistedMode: 'cloud',
      remoteName: 'Remote Name',
      persistedName: 'My Local Shop',
    })).toBe('Remote Name')
  })

  it('prefers the remote workspace name in Cloud Sync mode', () => {
    expect(resolveFetchedWorkspaceName({
      workspaceMode: 'hybrid',
      persistedMode: 'hybrid',
      remoteName: 'Remote Name',
      persistedName: 'My Local Shop',
    })).toBe('Remote Name')
  })
})
