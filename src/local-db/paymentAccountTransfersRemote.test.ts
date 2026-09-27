import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { setNetworkStatus } from '@/lib/network'
import { db } from './database'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000621'
const USER_ID = '00000000-0000-4000-8000-000000000622'
const FROM_ID = '00000000-0000-4000-8000-000000000623'
const TO_ID = '00000000-0000-4000-8000-000000000624'
const { getClient, fetchTable } = vi.hoisted(() => ({
  getClient: vi.fn(),
  fetchTable: vi.fn(),
}))

vi.mock('@/lib/supabaseSchema', () => ({
  getSupabaseClientForTable: getClient,
  getSupabaseRemoteTableName: (tableName: string) => tableName === 'payment_account_transfers' ? 'transfers' : tableName,
}))

vi.mock('@/hooks/useNetworkStatus', () => ({ useNetworkStatus: () => true }))

vi.mock('@/lib/supabaseRequest', () => ({
  isRetriableWebRequestError: () => false,
  normalizeSupabaseActionError: (error: unknown) => error instanceof Error ? error : new Error(String(error)),
  runSupabaseAction: (_label: string, promiseFactory: () => PromiseLike<unknown>) => promiseFactory(),
}))

vi.mock('./hooks', () => ({
  addToOfflineMutations: vi.fn(),
  fetchTableFromSupabase: fetchTable,
}))

function account(id: string, name: string) {
  const now = '2026-09-27T09:00:00.000Z'
  return {
    id,
    workspaceId: WORKSPACE_ID,
    name,
    accountType: 'cash_drawer' as const,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    syncStatus: 'synced' as const,
    lastSyncedAt: now,
  }
}

function balance(accountId: string, balanceAmount: number) {
  const now = '2026-09-27T09:00:00.000Z'
  return {
    id: `balance-${accountId}`,
    workspaceId: WORKSPACE_ID,
    accountId,
    currency: 'iqd' as const,
    balanceAmount,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    syncStatus: 'synced' as const,
    lastSyncedAt: now,
  }
}

function remoteTransfer(id: string, amount: number) {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    from_account_id: FROM_ID,
    from_account_name_snapshot: 'Remote source',
    to_account_id: TO_ID,
    to_account_name_snapshot: 'Remote destination',
    amount,
    currency: 'iqd',
    occurred_at: '2026-09-27T09:30:00.000Z',
    reason: 'Bank run',
    created_by: USER_ID,
    outgoing_movement_id: '00000000-0000-4000-8000-000000000625',
    incoming_movement_id: '00000000-0000-4000-8000-000000000626',
    created_at: '2026-09-27T09:30:00.000Z',
    updated_at: '2026-09-27T09:30:00.000Z',
    version: 1,
    is_deleted: false,
  }
}

describe('payment-account transfer remote contract', () => {
  let recordPaymentAccountTransfer: typeof import('./paymentAccounts').recordPaymentAccountTransfer

  beforeEach(async () => {
    await db.delete()
    await db.open()
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
    setNetworkStatus(true)
    fetchTable.mockResolvedValue(true)
    const { recordPaymentAccountTransfer: record } = await import('./paymentAccounts')
    recordPaymentAccountTransfer = record
    await db.payment_accounts.bulkPut([account(FROM_ID, 'Source'), account(TO_ID, 'Destination')])
    await db.payment_account_balances.put(balance(FROM_ID, 800_000))
  })

  afterEach(() => {
    clearWorkspaceModeSnapshot(WORKSPACE_ID)
    setNetworkStatus(false)
    vi.clearAllMocks()
  })

  afterAll(async () => { await db.delete() })

  it('sends one idempotent transfer request and mirrors both account effects without payment transactions', async () => {
    const id = '00000000-0000-4000-8000-000000000627'
    const query = {
      upsert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: remoteTransfer(id, 300_000), error: null }),
    }
    const client = { from: vi.fn().mockReturnValue(query) }
    getClient.mockReturnValue(client)

    const transfer = await recordPaymentAccountTransfer(WORKSPACE_ID, {
      transferId: id,
      fromAccountId: FROM_ID,
      toAccountId: TO_ID,
      currency: 'iqd',
      amount: 300_000,
      occurredAt: '2026-09-27T09:30:00.000Z',
      reason: 'Bank run',
      createdBy: USER_ID,
      canPost: true,
    })

    expect(client.from).toHaveBeenCalledWith('transfers')
    expect(query.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id,
      from_account_id: FROM_ID,
      to_account_id: TO_ID,
      amount: 300_000,
      currency: 'iqd',
      reason: 'Bank run',
      created_by: USER_ID,
    }), { onConflict: 'id' })
    expect(transfer).toMatchObject({ id, amount: 300_000, syncStatus: 'synced' })
    expect(await db.payment_account_movements.where('transferId').equals(id).count()).toBe(2)
    expect((await db.payment_account_balances.where('[accountId+currency]').equals([FROM_ID, 'iqd']).first())?.balanceAmount).toBe(500_000)
    expect((await db.payment_account_balances.where('[accountId+currency]').equals([TO_ID, 'iqd']).first())?.balanceAmount).toBe(300_000)
    expect(await db.payment_transactions.where('workspaceId').equals(WORKSPACE_ID).count()).toBe(0)
    expect(fetchTable).toHaveBeenCalledTimes(3)
  })

  it('turns server insufficient-funds rejection into a friendly message and leaves no local effects', async () => {
    const id = '00000000-0000-4000-8000-000000000628'
    const query = {
      upsert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { code: '23514', message: 'payment_account_transfer_insufficient_funds' } }),
    }
    getClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) })

    await expect(recordPaymentAccountTransfer(WORKSPACE_ID, {
      transferId: id,
      fromAccountId: FROM_ID,
      toAccountId: TO_ID,
      currency: 'iqd',
      amount: 900_000,
      occurredAt: '2026-09-27T09:30:00.000Z',
      reason: 'Bank run',
      createdBy: USER_ID,
      canPost: true,
    })).rejects.toThrow('not enough available funds')

    expect(await db.payment_account_transfers.count()).toBe(0)
    expect(await db.payment_account_movements.count()).toBe(0)
    expect((await db.payment_account_balances.where('[accountId+currency]').equals([FROM_ID, 'iqd']).first())?.balanceAmount).toBe(800_000)
    expect(fetchTable).not.toHaveBeenCalled()
  })
})
