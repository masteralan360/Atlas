import { afterEach, describe, expect, it } from 'vitest'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import type { PaymentTransaction } from './models'
import {
  persistLocalDirectTransactionWithVoucher,
  setLocalModeSqliteConnectionForTests,
  type SqliteConnection
} from './localModeSqlite'

const workspaceId = '00000000-0000-4000-8000-000000000673'

class VoucherSqliteConnection implements SqliteConnection {
  counters = new Map<string, number>()
  entities = new Map<string, string>()
  failPersist = false

  async transaction<T>(task: (connection: SqliteConnection) => Promise<T>): Promise<T> {
    const counters = new Map(this.counters)
    const entities = new Map(this.entities)
    try { return await task(this) }
    catch (error) {
      this.counters = counters
      this.entities = entities
      throw error
    }
  }

  async execute(query: string, values: unknown[] = []) {
    if (/INSERT INTO local_entities/i.test(query)) {
      if (this.failPersist) throw new Error('SQLite write failed')
      this.entities.set(String(values[1]), String(values[4]))
    }
    return { rowsAffected: 1 }
  }

  async select<T>(query: string, values: unknown[] = []): Promise<T> {
    if (/INSERT INTO direct_transaction_voucher_counters/i.test(query)) {
      const key = String(values[0])
      const next = (this.counters.get(key) || 0) + 1
      this.counters.set(key, next)
      return [{ last_number: next }] as T
    }
    throw new Error(`Unexpected SQLite query: ${query}`)
  }
}

const transaction = (id: string): PaymentTransaction => ({
  id, workspaceId, sourceModule: 'payments', sourceType: 'direct_transaction',
  sourceRecordId: id, sourceSubrecordId: null, direction: 'incoming', amount: 10,
  currency: 'usd', paymentMethod: 'cash', paidAt: '2026-09-23T00:00:00.000Z',
  counterpartyName: 'Alice', referenceLabel: 'Receipt', note: null, createdBy: null,
  reversalOfTransactionId: null, metadata: null, createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z', syncStatus: 'synced',
  lastSyncedAt: '2026-09-23T00:00:00.000Z', version: 1, isDeleted: false
})

describe('Local SQLite voucher authority', () => {
  afterEach(() => {
    setLocalModeSqliteConnectionForTests()
    clearWorkspaceModeSnapshot(workspaceId)
  })

  it('allocates and persists consecutive numbers in SQLite', async () => {
    writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'local' })
    const connection = new VoucherSqliteConnection()
    setLocalModeSqliteConnectionForTests(connection)
    const first = transaction('first')
    const second = transaction('second')
    expect(await persistLocalDirectTransactionWithVoucher({} as never, first)).toBe(1)
    expect(await persistLocalDirectTransactionWithVoucher({} as never, second)).toBe(2)
    expect(JSON.parse(connection.entities.get('first') || '{}').voucherNumber).toBe(1)
    expect(JSON.parse(connection.entities.get('second') || '{}').voucherNumber).toBe(2)
  })

  it('rolls the counter back when persisting the payment row fails', async () => {
    writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'local' })
    const connection = new VoucherSqliteConnection()
    setLocalModeSqliteConnectionForTests(connection)
    await persistLocalDirectTransactionWithVoucher({} as never, transaction('first'))
    connection.failPersist = true
    await expect(persistLocalDirectTransactionWithVoucher({} as never, transaction('failed'))).rejects.toThrow('SQLite write failed')
    connection.failPersist = false
    expect(await persistLocalDirectTransactionWithVoucher({} as never, transaction('second'))).toBe(2)
    expect(connection.entities.has('failed')).toBe(false)
  })
})
