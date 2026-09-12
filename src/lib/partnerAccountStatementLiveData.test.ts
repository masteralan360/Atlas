import { describe, expect, it, vi } from 'vitest'

import {
  PARTNER_ACCOUNT_STATEMENT_FRESHNESS_TABLE_NAMES,
  PARTNER_ACCOUNT_STATEMENT_LIVE_TABLE_NAMES,
  refreshPartnerAccountStatementLiveData
} from './partnerAccountStatementLiveData'

describe('partner account statement live data', () => {
  it('refreshes every statement source, including loan payments', async () => {
    const refreshTable = vi.fn(async () => undefined)
    const refreshSales = vi.fn(async () => undefined)

    await refreshPartnerAccountStatementLiveData('workspace-1', {
      refreshTable,
      refreshSales
    })

    expect(PARTNER_ACCOUNT_STATEMENT_LIVE_TABLE_NAMES).toContain('loan_payments')
    expect(refreshTable).toHaveBeenCalledTimes(PARTNER_ACCOUNT_STATEMENT_LIVE_TABLE_NAMES.length)
    expect(refreshTable).toHaveBeenCalledWith('loan_payments', 'workspace-1')
    expect(refreshSales).toHaveBeenCalledOnce()
    expect(refreshSales).toHaveBeenCalledWith('workspace-1')
    expect(PARTNER_ACCOUNT_STATEMENT_FRESHNESS_TABLE_NAMES).toContain('sales')
  })

  it('rejects the refresh when a required source fails', async () => {
    const refreshTable = vi.fn(async (tableName: string) => {
      if (tableName === 'loan_payments') throw new Error('loan payments unavailable')
    })

    await expect(refreshPartnerAccountStatementLiveData('workspace-1', {
      refreshTable,
      refreshSales: vi.fn(async () => undefined)
    })).rejects.toThrow('loan payments unavailable')
  })
})
