import { describe, expect, it } from 'vitest'

import {
  getLedgerFlowSign,
  isLedgerCashFlowDirection,
  summarizeLedgerCashFlow,
} from './ledgerFlow'

describe('ledger flow reporting', () => {
  it('treats opening balances and reconciliation adjustments as neutral ledger entries', () => {
    expect(isLedgerCashFlowDirection('opening')).toBe(false)
    expect(isLedgerCashFlowDirection('adjustment')).toBe(false)
    expect(getLedgerFlowSign('opening')).toBe(0)
    expect(getLedgerFlowSign('adjustment')).toBe(0)
    expect(getLedgerFlowSign('incoming')).toBe(1)
    expect(getLedgerFlowSign('outgoing')).toBe(-1)
  })

  it('excludes opening balances and adjustments from inflow, outflow, and net-flow calculations', () => {
    expect(summarizeLedgerCashFlow([
      { direction: 'opening' as const, amount: 100_000 },
      { direction: 'adjustment' as const, amount: 500 },
      { direction: 'incoming' as const, amount: 250 },
      { direction: 'outgoing' as const, amount: 75 },
    ])).toEqual({ inflow: 250, outflow: 75, net: 175 })
  })

  it('preserves the legacy inflow, outflow, and net-flow equation', () => {
    expect(summarizeLedgerCashFlow([
      { direction: 'incoming' as const, amount: 100 },
      { direction: 'outgoing' as const, amount: 50 },
    ])).toEqual({ inflow: 100, outflow: 50, net: 50 })
  })

  it('keeps decimal cash-flow totals stable and reports zero for opening-only records', () => {
    expect(summarizeLedgerCashFlow([
      { direction: 'incoming' as const, amount: 0.1 },
      { direction: 'incoming' as const, amount: 0.2 },
      { direction: 'outgoing' as const, amount: 0.3 },
    ])).toEqual({ inflow: 0.3, outflow: 0.3, net: 0 })

    expect(summarizeLedgerCashFlow([
      { direction: 'opening' as const, amount: 0 },
      { direction: 'opening' as const, amount: 50 },
    ])).toEqual({ inflow: 0, outflow: 0, net: 0 })
  })
})
