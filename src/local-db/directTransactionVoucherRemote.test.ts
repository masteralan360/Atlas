import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { db } from './database'

const remote = vi.hoisted(() => ({
  inserted: [] as Record<string, unknown>[],
  rows: [] as Record<string, unknown>[],
  filters: [] as Array<[string, unknown]>,
  failRead: false,
  failInsert: false
}))

vi.mock('@/lib/supabaseSchema', () => ({
  getSupabaseClientForTable: () => ({
    from: (table: string) => {
      if (table !== 'payment_transactions') throw new Error(`Unexpected table ${table}`)
      return {
        insert: (payload: Record<string, unknown>) => {
          if (remote.failInsert) return { select: () => ({ single: async () => ({ data: null, error: { message: 'permission denied', code: '42501' } }) }) }
          remote.inserted.push(payload)
          const row = { ...payload, voucher_number: remote.inserted.length }
          remote.rows.push(row)
          return { select: () => ({ single: async () => ({ data: { voucher_number: row.voucher_number }, error: null }) }) }
        },
        select: () => {
          const query = {
            eq: (key: string, value: unknown) => { remote.filters.push([key, value]); return query },
            then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(
              remote.failRead
                ? { data: null, error: { message: 'network unavailable', code: 'NETWORK' } }
                : { data: remote.rows, error: null }
            ).then(resolve, reject)
          }
          return query
        }
      }
    }
  })
}))

const workspaceId = '00000000-0000-4000-8000-000000000672'
let recordDirectTransaction: typeof import('./payments').recordDirectTransaction
let reversePaymentTransaction: typeof import('./payments').reversePaymentTransaction
let loadDirectTransactionVoucher: typeof import('./payments').loadDirectTransactionVoucher

describe('Cloud and Hybrid direct-transaction voucher request contract', () => {
  beforeAll(async () => {
    installTestBrowser()
    ;({ recordDirectTransaction, reversePaymentTransaction, loadDirectTransactionVoucher } = await import('./payments'))
  }, 90_000)
  beforeEach(async () => {
    installTestBrowser()
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
    await db.delete()
    await db.open()
    remote.inserted.length = 0
    remote.rows.length = 0
    remote.filters.length = 0
    remote.failRead = false
    remote.failInsert = false
    setNetworkStatus(true)
    writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'cloud' })
  })
  afterEach(() => {
    clearWorkspaceModeSnapshot(workspaceId)
    setNetworkStatus(true)
  })
  afterAll(async () => { await db.delete() })

  it('returns the server-assigned number and reads the complete workspace-scoped chain', async () => {
    const posted = await recordDirectTransaction(workspaceId, {
      direction: 'incoming', amount: 42, currency: 'usd', paymentMethod: 'cash',
      reason: 'Remote receipt', counterpartyName: 'Alice'
    })
    expect(posted.voucherNumber).toBe(1)
    expect(remote.inserted[0]).toMatchObject({ workspace_id: workspaceId, source_type: 'direct_transaction', amount: 42 })
    const voucher = await loadDirectTransactionVoucher(workspaceId, posted.id)
    expect(voucher.transaction.voucherNumber).toBe(1)
    expect(remote.filters).toEqual(expect.arrayContaining([
      ['workspace_id', workspaceId], ['source_type', 'direct_transaction'],
      ['source_record_id', posted.sourceRecordId]
    ]))
  })

  it('keeps offline Hybrid rows pending until server synchronization and surfaces read failure', async () => {
    writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'hybrid' })
    setNetworkStatus(false)
    const posted = await recordDirectTransaction(workspaceId, {
      direction: 'outgoing', amount: 25, currency: 'usd', paymentMethod: 'cash',
      reason: 'Offline payment', counterpartyName: 'Bob'
    })
    expect(posted.voucherNumber).toBeUndefined()
    expect(remote.inserted).toHaveLength(0)
    expect(await db.offline_mutations.where('workspaceId').equals(workspaceId).count()).toBeGreaterThan(0)
    await expect(loadDirectTransactionVoucher(workspaceId, posted.id)).rejects.toThrow('synchronization')

    setNetworkStatus(true)
    await expect(loadDirectTransactionVoucher(workspaceId, posted.id)).rejects.toThrow('synchronization')
    remote.rows.push({
      id: posted.id, workspace_id: workspaceId, source_module: 'payments',
      source_type: 'direct_transaction', source_record_id: posted.sourceRecordId,
      direction: posted.direction, amount: posted.amount, currency: posted.currency,
      payment_method: posted.paymentMethod, paid_at: posted.paidAt,
      counterparty_name: posted.counterpartyName, reference_label: posted.referenceLabel,
      created_at: posted.createdAt, updated_at: posted.updatedAt, version: 1,
      is_deleted: false, voucher_number: 7
    })
    const voucher = await loadDirectTransactionVoucher(workspaceId, posted.id)
    expect(voucher.transaction.voucherNumber).toBe(7)
    expect((await db.payment_transactions.get(posted.id))?.voucherNumber).toBe(7)

    remote.failRead = true
    await expect(loadDirectTransactionVoucher(workspaceId, posted.id)).rejects.toThrow()
  })

  it('does not post or number a transaction rejected by the source of truth', async () => {
    remote.failInsert = true
    await expect(recordDirectTransaction(workspaceId, {
      direction: 'incoming', amount: 10, currency: 'usd', paymentMethod: 'cash',
      reason: 'Rejected receipt', counterpartyName: 'Alice'
    })).rejects.toThrow()
    expect(await db.payment_transactions.where('workspaceId').equals(workspaceId).count()).toBe(0)
    expect(remote.rows).toHaveLength(0)
  })

  it('waits for a queued reversal before printing the original current status', async () => {
    const posted = await recordDirectTransaction(workspaceId, {
      direction: 'incoming', amount: 40, currency: 'usd', paymentMethod: 'cash',
      reason: 'Receipt', counterpartyName: 'Alice'
    })
    setNetworkStatus(false)
    const reversal = await reversePaymentTransaction(workspaceId, posted.id, { amount: 10 })
    expect(reversal.syncStatus).toBe('pending')
    setNetworkStatus(true)
    await expect(loadDirectTransactionVoucher(workspaceId, posted.id)).rejects.toThrow('synchronization')
  })
})
