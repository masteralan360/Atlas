import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import * as network from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'
import type { PaymentAccount, PaymentAccountMemberRestriction } from './models'

const mocks = vi.hoisted(() => ({
  addToOfflineMutations: vi.fn(async () => undefined),
  fetchTableFromSupabase: vi.fn(async () => true),
}))

vi.mock('./hooks', () => mocks)

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000801'
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000802'
const MEMBER_ID = '00000000-0000-4000-8000-000000000803'
const OTHER_MEMBER_ID = '00000000-0000-4000-8000-000000000804'
const RESTRICTION_ID = '00000000-0000-4000-8000-000000000805'

function installBrowserStorage() {
  const rows = new Map<string, string>()
  const storage = {
    get length() { return rows.size },
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
    removeItem: (key: string) => rows.delete(key),
    clear: () => rows.clear(),
    key: (index: number) => Array.from(rows.keys())[index] ?? null,
  }
  const documentHead = { appendChild: () => undefined }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage, sessionStorage: storage, location: { hash: '', origin: 'http://localhost', pathname: '/' }, URL: globalThis.URL, addEventListener: () => undefined },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      visibilityState: 'visible', dir: 'ltr', documentElement: { lang: 'en', dir: 'ltr', style: {} },
      head: documentHead, getElementsByTagName: () => [documentHead],
      createElement: () => ({ appendChild: () => undefined, setAttribute: () => undefined, style: {} }),
      createTextNode: () => ({}), addEventListener: () => undefined, removeEventListener: () => undefined,
    },
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
}

const remote = vi.hoisted(() => ({
  from: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
  eq: vi.fn(),
}))

function makeAccount(): PaymentAccount {
  const now = '2026-09-27T09:00:00.000Z'
  return {
    id: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    name: 'Cash Drawer',
    accountType: 'cash_drawer',
    isActive: true,
    isDeleted: false,
    isPrimary: true,
    createdAt: now,
    updatedAt: now,
    version: 1,
    syncStatus: 'synced',
    lastSyncedAt: now,
  }
}

function makeRestriction(userId: string, overrides: Partial<PaymentAccountMemberRestriction> = {}): PaymentAccountMemberRestriction {
  const now = '2026-09-27T09:00:00.000Z'
  return {
    id: RESTRICTION_ID,
    workspaceId: WORKSPACE_ID,
    accountId: ACCOUNT_ID,
    userId,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    syncStatus: 'synced',
    lastSyncedAt: now,
    ...overrides,
  }
}

describe('payment-account member visibility', () => {
  let setPaymentAccountMemberAccess: typeof import('./paymentAccounts').setPaymentAccountMemberAccess
  let filterPaymentAccountsForUser: typeof import('./paymentAccounts').filterPaymentAccountsForUser
  let supabaseSchema: typeof import('@/lib/supabaseSchema')
  let offlineSpy: ReturnType<typeof vi.spyOn>
  let clientSpy: ReturnType<typeof vi.spyOn>
  let remoteTableNameSpy: ReturnType<typeof vi.spyOn>

  beforeAll(async () => {
    installBrowserStorage()
    supabaseSchema = await import('@/lib/supabaseSchema')
    ;({ setPaymentAccountMemberAccess, filterPaymentAccountsForUser } = await import('./paymentAccounts'))
  })

  beforeEach(async () => {
    await db.delete()
    await db.open()
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
    mocks.addToOfflineMutations.mockClear()
    mocks.fetchTableFromSupabase.mockClear()
    remote.from.mockReset().mockReturnValue({ upsert: remote.upsert, delete: remote.delete })
    remote.upsert.mockReset().mockResolvedValue({ error: null })
    remote.delete.mockReset().mockReturnValue({ eq: remote.eq })
    remote.eq.mockReset().mockReturnValue({ eq: remote.eq })
    offlineSpy = vi.spyOn(network, 'isOnline').mockReturnValue(true)
    clientSpy = vi.spyOn(supabaseSchema, 'getSupabaseClientForTable').mockReturnValue({ from: remote.from } as never)
    remoteTableNameSpy = vi.spyOn(supabaseSchema, 'getSupabaseRemoteTableName').mockReturnValue('account_member_restrictions')
    await db.payment_accounts.put(makeAccount())
  })

  afterEach(async () => {
    offlineSpy?.mockRestore()
    clientSpy?.mockRestore()
    remoteTableNameSpy?.mockRestore()
    clearWorkspaceModeSnapshot(WORKSPACE_ID)
  })

  afterAll(async () => { await db.delete() })

  it('hides only accounts restricted for the current workspace member', () => {
    const accounts = [makeAccount()]
    const restrictions = [
      makeRestriction(MEMBER_ID),
      makeRestriction(OTHER_MEMBER_ID, { id: 'other-workspace-row', workspaceId: 'other-workspace' }),
      makeRestriction(OTHER_MEMBER_ID, { id: 'deleted-row', isDeleted: true }),
    ]

    expect(filterPaymentAccountsForUser(accounts, restrictions, WORKSPACE_ID, MEMBER_ID)).toEqual([])
    expect(filterPaymentAccountsForUser(accounts, restrictions, WORKSPACE_ID, OTHER_MEMBER_ID)).toHaveLength(1)
    expect(filterPaymentAccountsForUser(accounts, restrictions, 'other-workspace', MEMBER_ID)).toHaveLength(1)
  })

  it('creates a workspace-scoped restriction when access is turned off', async () => {
    const result = await setPaymentAccountMemberAccess(WORKSPACE_ID, ACCOUNT_ID, MEMBER_ID, false)

    expect(result).toEqual({ hasAccess: false, synced: true })
    expect(remote.from).toHaveBeenCalledWith('account_member_restrictions')
    expect(remote.upsert).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: WORKSPACE_ID,
      account_id: ACCOUNT_ID,
      user_id: MEMBER_ID,
      is_deleted: false,
    }))
    expect(await db.payment_account_member_restrictions.where('[workspaceId+accountId+userId]').equals([WORKSPACE_ID, ACCOUNT_ID, MEMBER_ID]).count()).toBe(1)
    expect(mocks.addToOfflineMutations).not.toHaveBeenCalled()
  })

  it('hard-deletes the restriction row when access is turned back on', async () => {
    await db.payment_account_member_restrictions.put(makeRestriction(MEMBER_ID))

    const result = await setPaymentAccountMemberAccess(WORKSPACE_ID, ACCOUNT_ID, MEMBER_ID, true)

    expect(result).toEqual({ hasAccess: true, synced: true })
    expect(remote.delete).toHaveBeenCalledOnce()
    expect(remote.eq).toHaveBeenNthCalledWith(1, 'id', RESTRICTION_ID)
    expect(remote.eq).toHaveBeenNthCalledWith(2, 'workspace_id', WORKSPACE_ID)
    expect(await db.payment_account_member_restrictions.get(RESTRICTION_ID)).toBeUndefined()
  })

  it('queues an offline hard delete when the remote restriction cannot be removed', async () => {
    await db.payment_account_member_restrictions.put(makeRestriction(MEMBER_ID))
    remote.eq
      .mockImplementationOnce(() => ({ eq: remote.eq }))
      .mockImplementationOnce(async () => ({ error: { message: 'remote delete failed' } }))

    const result = await setPaymentAccountMemberAccess(WORKSPACE_ID, ACCOUNT_ID, MEMBER_ID, true)

    expect(result).toEqual({ hasAccess: true, synced: false })
    expect(await db.payment_account_member_restrictions.get(RESTRICTION_ID)).toBeUndefined()
    expect(mocks.addToOfflineMutations).toHaveBeenCalledWith(
      'payment_account_member_restrictions',
      RESTRICTION_ID,
      'delete',
      { id: RESTRICTION_ID, hardDelete: true },
      WORKSPACE_ID,
    )
  })

  it('keeps an offline restriction locally and queues it for Cloud / Hybrid sync after a remote write failure', async () => {
    remote.upsert.mockResolvedValueOnce({ error: { message: 'remote write failed' } })

    const result = await setPaymentAccountMemberAccess(WORKSPACE_ID, ACCOUNT_ID, MEMBER_ID, false)
    const saved = await db.payment_account_member_restrictions.where('[workspaceId+accountId+userId]').equals([WORKSPACE_ID, ACCOUNT_ID, MEMBER_ID]).first()

    expect(result).toEqual({ hasAccess: false, synced: false })
    expect(saved).toMatchObject({ userId: MEMBER_ID, syncStatus: 'pending' })
    expect(mocks.addToOfflineMutations).toHaveBeenCalledWith(
      'payment_account_member_restrictions',
      saved?.id,
      'create',
      expect.objectContaining({ accountId: ACCOUNT_ID, userId: MEMBER_ID }),
      WORKSPACE_ID,
    )
  })
})
