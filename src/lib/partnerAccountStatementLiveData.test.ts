import { describe, expect, it, vi } from 'vitest'

import {
  PARTNER_ACCOUNT_STATEMENT_FRESHNESS_TABLE_NAMES,
  PARTNER_ACCOUNT_STATEMENT_LIVE_TABLE_NAMES,
  refreshPartnerAccountStatementLiveData
} from './partnerAccountStatementLiveData'

describe('partner account statement live data', () => {
  it('refreshes every statement source concurrently and reports each successful source', async () => {
    let resolveSources!: () => void
    const allSources = new Promise<void>((resolve) => {
      resolveSources = resolve
    })
    const refreshTable = vi.fn(() => allSources)
    const refreshSales = vi.fn(() => allSources)
    const onProgress = vi.fn()

    const refresh = refreshPartnerAccountStatementLiveData('workspace-1', {
      refreshTable,
      refreshSales,
      onProgress
    })

    expect(PARTNER_ACCOUNT_STATEMENT_LIVE_TABLE_NAMES).toContain('loan_payments')
    expect(PARTNER_ACCOUNT_STATEMENT_LIVE_TABLE_NAMES).toContain('sales_order_agent_assignments')
    expect(refreshTable).toHaveBeenCalledTimes(PARTNER_ACCOUNT_STATEMENT_LIVE_TABLE_NAMES.length)
    expect(refreshTable).toHaveBeenCalledWith('loan_payments', 'workspace-1')
    expect(refreshTable).toHaveBeenCalledWith('sales_order_agent_assignments', 'workspace-1')
    expect(refreshSales).toHaveBeenCalledOnce()
    expect(refreshSales).toHaveBeenCalledWith('workspace-1')
    expect(PARTNER_ACCOUNT_STATEMENT_FRESHNESS_TABLE_NAMES).toContain('sales')
    expect(onProgress).not.toHaveBeenCalled()

    resolveSources()
    await refresh

    expect(onProgress).toHaveBeenCalledTimes(PARTNER_ACCOUNT_STATEMENT_FRESHNESS_TABLE_NAMES.length)
    expect(onProgress).toHaveBeenLastCalledWith({
      completedSources: PARTNER_ACCOUNT_STATEMENT_FRESHNESS_TABLE_NAMES.length,
      totalSources: PARTNER_ACCOUNT_STATEMENT_FRESHNESS_TABLE_NAMES.length
    })
  })

  it('rejects the refresh and does not count a failed source as completed', async () => {
    let resolveSuccessfulSources!: () => void
    let rejectFailedSource!: (reason?: unknown) => void
    const successfulSources = new Promise<void>((resolve) => {
      resolveSuccessfulSources = resolve
    })
    const failedSource = new Promise<void>((_resolve, reject) => {
      rejectFailedSource = reject
    })
    const refreshTable = vi.fn((tableName: string) => (
      tableName === 'loan_payments' ? failedSource : successfulSources
    ))
    const onProgress = vi.fn()

    const refresh = refreshPartnerAccountStatementLiveData('workspace-1', {
      refreshTable,
      refreshSales: vi.fn(() => successfulSources),
      onProgress
    })

    resolveSuccessfulSources()
    await Promise.resolve()

    expect(onProgress).toHaveBeenCalledTimes(PARTNER_ACCOUNT_STATEMENT_FRESHNESS_TABLE_NAMES.length - 1)
    expect(onProgress).toHaveBeenLastCalledWith({
      completedSources: PARTNER_ACCOUNT_STATEMENT_FRESHNESS_TABLE_NAMES.length - 1,
      totalSources: PARTNER_ACCOUNT_STATEMENT_FRESHNESS_TABLE_NAMES.length
    })

    rejectFailedSource(new Error('loan payments unavailable'))
    await expect(refresh).rejects.toThrow('loan payments unavailable')
  })
})
