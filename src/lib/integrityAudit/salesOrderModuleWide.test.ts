import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runSalesOrderIntegrityAudit } = vi.hoisted(() => ({
  runSalesOrderIntegrityAudit: vi.fn()
}))

vi.mock('./salesOrderAudit', () => ({ runSalesOrderIntegrityAudit }))

import { createSalesOrderModuleWideIntegrityAuditAdapter } from './salesOrderModuleWide'

describe('Sales Order module-wide audit adapter', () => {
  beforeEach(() => runSalesOrderIntegrityAudit.mockReset())

  it('delegates each transaction to the existing single-order audit and exposes its summary', async () => {
    const summary = { total: 200, passed: 199, warnings: 1, failed: 0 }
    runSalesOrderIntegrityAudit.mockResolvedValue({ summary, checks: [] })
    const adapter = createSalesOrderModuleWideIntegrityAuditAdapter('workspace-1', 'cloud')
    const order = { id: 'order-1', orderNumber: 'SO-2026-0001' } as any

    const audit = await adapter.auditTransaction(order)

    expect(runSalesOrderIntegrityAudit).toHaveBeenCalledExactlyOnceWith('workspace-1', 'order-1', 'cloud')
    expect(adapter.getTransactionId(order)).toBe('order-1')
    expect(adapter.getTransactionReference(order)).toBe('SO-2026-0001')
    expect(adapter.getSummary(audit)).toEqual({ ...summary, groups: [] })
  })
})
