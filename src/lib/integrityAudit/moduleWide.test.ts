import { describe, expect, it, vi } from 'vitest'
import { runModuleWideIntegrityAudit, type ModuleWideIntegrityAuditAdapter } from './moduleWide'

type Transaction = { id: string; reference: string }
type AuditResult = { summary: { passed: number; warnings: number; failed: number }; checks: string[] }

function adapterFor(results: Record<string, AuditResult>): ModuleWideIntegrityAuditAdapter<Transaction, AuditResult> {
  return {
    getTransactionId: transaction => transaction.id,
    getTransactionReference: transaction => transaction.reference,
    auditTransaction: async transaction => results[transaction.id],
    getSummary: result => result.summary
  }
}

describe('module-wide transaction integrity audit orchestration', () => {
  it('runs each existing transaction audit and returns only summaries in source order', async () => {
    const transactions = [
      { id: 'order-1', reference: 'SO-0001' },
      { id: 'order-2', reference: 'SO-0002' },
      { id: 'order-3', reference: 'SO-0003' }
    ]
    const results = {
      'order-1': { summary: { passed: 200, warnings: 0, failed: 0 }, checks: ['details not retained'] },
      'order-2': { summary: { passed: 199, warnings: 1, failed: 0 }, checks: ['details not retained'] },
      'order-3': { summary: { passed: 197, warnings: 2, failed: 1 }, checks: ['details not retained'] }
    }
    const auditedIds: string[] = []
    const adapter = adapterFor(results)
    const auditTransaction = vi.spyOn(adapter, 'auditTransaction').mockImplementation(async transaction => {
      auditedIds.push(transaction.id)
      return results[transaction.id]
    })
    const progress: Array<{ completed: number; total: number }> = []

    const rows = await runModuleWideIntegrityAudit(transactions, adapter, value => progress.push(value), 1)

    expect(auditTransaction).toHaveBeenCalledTimes(3)
    expect(auditedIds).toEqual(['order-1', 'order-2', 'order-3'])
    expect(rows).toEqual([
      { transactionId: 'order-1', transactionReference: 'SO-0001', passed: 200, warnings: 0, failed: 0, status: 'PASS' },
      { transactionId: 'order-2', transactionReference: 'SO-0002', passed: 199, warnings: 1, failed: 0, status: 'WARNING' },
      { transactionId: 'order-3', transactionReference: 'SO-0003', passed: 197, warnings: 2, failed: 1, status: 'FAIL' }
    ])
    expect(progress).toEqual([
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 }
    ])
    expect(rows[0]).not.toHaveProperty('checks')
  })

  it('stops scheduling more transactions and surfaces an individual audit read failure', async () => {
    const transactions = Array.from({ length: 5 }, (_, index) => ({ id: `order-${index}`, reference: `SO-${index}` }))
    const auditTransaction = vi.fn(async (transaction: Transaction) => {
      if (transaction.id === 'order-1') throw new Error('read failed')
      return { summary: { passed: 1, warnings: 0, failed: 0 }, checks: [] }
    })
    const adapter = { ...adapterFor({}), auditTransaction }

    await expect(runModuleWideIntegrityAudit(transactions, adapter, undefined, 1)).rejects.toThrow('read failed')
    expect(auditTransaction.mock.calls.map(([transaction]) => transaction.id)).toEqual(['order-0', 'order-1'])
  })

  it('returns an empty summary without auditing when the active module filters match no transactions', async () => {
    const auditTransaction = vi.fn()
    const adapter = { ...adapterFor({}), auditTransaction }
    const onProgress = vi.fn()

    await expect(runModuleWideIntegrityAudit([], adapter, onProgress)).resolves.toEqual([])
    expect(auditTransaction).not.toHaveBeenCalled()
    expect(onProgress).not.toHaveBeenCalled()
  })
})
