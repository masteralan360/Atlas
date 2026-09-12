import { describe, expect, it } from 'vitest'

import {
  getCommissionEntryMode,
  getSalesOrderCommissionMode,
  isPayableCommissionEntry,
  isTrackedCommissionEntry,
  normalizeSalesAgentCommissionMode,
} from './commissionMode'

describe('sales-agent commission mode', () => {
  it('keeps legacy records payable', () => {
    expect(normalizeSalesAgentCommissionMode(undefined)).toBe('payable')
    expect(getSalesOrderCommissionMode({ commissionMode: undefined })).toBe('payable')
    expect(getCommissionEntryMode({ commissionMode: undefined })).toBe('payable')
    expect(isPayableCommissionEntry({ commissionMode: undefined })).toBe(true)
  })

  it('recognizes the tracked nonfinancial lane', () => {
    expect(normalizeSalesAgentCommissionMode('tracked')).toBe('tracked')
    expect(getSalesOrderCommissionMode({ commissionMode: 'tracked' })).toBe('tracked')
    expect(isTrackedCommissionEntry({ commissionMode: 'tracked' })).toBe(true)
    expect(isPayableCommissionEntry({ commissionMode: 'tracked' })).toBe(false)
  })
})
