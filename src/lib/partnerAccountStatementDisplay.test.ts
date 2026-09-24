import { describe, expect, it } from 'vitest'

import {
  buildPartnerAccountStatementLedger,
  type PartnerAccountStatementData
} from '@/lib/partnerAccountStatement'
import { buildPartnerAccountStatementDisplayEntries } from '@/lib/partnerAccountStatementDisplay'

function orderData(): PartnerAccountStatementData {
  return {
    period: { type: 'allTime' },
    salesOrders: [],
    purchaseOrders: [],
    statementOrders: [
      {
        id: 'sale-1', orderNumber: 'SO-1', customerId: 'partner-1', total: 1000,
        currency: 'usd', status: 'completed', createdAt: '2026-01-04T10:00:00',
        isDeleted: false, linkedLoanId: null
      },
      {
        id: 'purchase-1', orderNumber: 'PO-1', supplierId: 'partner-1', total: 800,
        currency: 'usd', status: 'received', createdAt: '2026-01-06T10:00:00',
        isDeleted: false, linkedLoanId: null
      }
    ] as any,
    settlementTransactions: [
      {
        id: 'sale-payment-1', sourceType: 'sales_order', sourceRecordId: 'sale-1',
        direction: 'incoming', amount: 200, currency: 'usd',
        paidAt: '2026-01-04T11:00:00', createdAt: '2026-01-04T11:00:00', isDeleted: false
      },
      {
        id: 'sale-payment-2', sourceType: 'sales_order', sourceRecordId: 'sale-1',
        direction: 'incoming', amount: 400, currency: 'usd',
        paidAt: '2026-01-04T15:00:00', createdAt: '2026-01-04T15:00:00', isDeleted: false
      },
      {
        id: 'sale-later-payment', sourceType: 'sales_order', sourceRecordId: 'sale-1',
        direction: 'incoming', amount: 100, currency: 'usd',
        paidAt: '2026-01-05T11:00:00', createdAt: '2026-01-05T11:00:00', isDeleted: false
      },
      {
        id: 'purchase-payment', sourceType: 'purchase_order', sourceRecordId: 'purchase-1',
        direction: 'outgoing', amount: 300, currency: 'usd',
        paidAt: '2026-01-06T11:00:00', createdAt: '2026-01-06T11:00:00', isDeleted: false
      },
      {
        id: 'purchase-later-payment', sourceType: 'purchase_order', sourceRecordId: 'purchase-1',
        direction: 'outgoing', amount: 100, currency: 'usd',
        paidAt: '2026-01-07T11:00:00', createdAt: '2026-01-07T11:00:00', isDeleted: false
      }
    ] as any
  }
}

describe('partner account statement display entries', () => {
  it('shows same-day sale and purchase settlements in their order rows while preserving later payments and ledger totals', () => {
    const [ledger] = buildPartnerAccountStatementLedger(orderData())
    const originalIds = ledger.entries.map((entry) => entry.id)
    const rows = buildPartnerAccountStatementDisplayEntries(ledger)

    expect(rows.map((row) => row.id)).toEqual([
      'sales-order:sale-1', 'payment:sale-later-payment',
      'purchase-order:purchase-1', 'payment:purchase-later-payment'
    ])
    expect(rows[0]).toMatchObject({
      debit: 1000, credit: 600, delta: 400, runningBalance: 400,
      sourceEntryIds: ['sales-order:sale-1', 'payment:sale-payment-1', 'payment:sale-payment-2']
    })
    expect(rows[1]).toMatchObject({ debit: 0, credit: 100, runningBalance: 300 })
    expect(rows[2]).toMatchObject({
      debit: 300, credit: 800, delta: -500, runningBalance: -200,
      sourceEntryIds: ['purchase-order:purchase-1', 'payment:purchase-payment']
    })
    expect(rows[3]).toMatchObject({ debit: 100, credit: 0, runningBalance: -100 })
    expect(ledger.entries.map((entry) => entry.id)).toEqual(originalIds)
    expect([ledger.debitTotal, ledger.creditTotal, ledger.closingBalance]).toEqual([1400, 1500, -100])
    expect(rows.at(-1)?.runningBalance).toBe(ledger.closingBalance)
    expect(rows.reduce((sum, row) => sum + row.debit, 0)).toBe(ledger.debitTotal)
    expect(rows.reduce((sum, row) => sum + row.credit, 0)).toBe(ledger.creditTotal)
  })

  it('leaves reversals, refunds, other currencies, and out-of-period payments as their own movements', () => {
    const data = orderData()
    data.period = { type: 'custom', start: '2026-01-04', end: '2026-01-04' }
    data.statementOrders = data.statementOrders?.slice(0, 1)
    data.settlementTransactions = [
      ...data.settlementTransactions!.slice(0, 3),
      {
        id: 'reversal', sourceType: 'sales_order', sourceRecordId: 'sale-1',
        direction: 'incoming', amount: -50, currency: 'usd',
        paidAt: '2026-01-04T16:00:00', createdAt: '2026-01-04T16:00:00',
        reversalOfTransactionId: 'sale-payment-1', isDeleted: false
      },
      {
        id: 'refund', sourceType: 'sales_order', sourceRecordId: 'sale-1',
        direction: 'outgoing', amount: 25, currency: 'usd',
        paidAt: '2026-01-04T17:00:00', createdAt: '2026-01-04T17:00:00',
        metadata: { fullSaleReturn: true }, isDeleted: false
      },
      {
        id: 'other-currency', sourceType: 'sales_order', sourceRecordId: 'sale-1',
        direction: 'incoming', amount: 10, currency: 'iqd',
        paidAt: '2026-01-04T18:00:00', createdAt: '2026-01-04T18:00:00', isDeleted: false
      }
    ] as any

    const ledgers = buildPartnerAccountStatementLedger(data)
    const usd = ledgers.find((ledger) => ledger.currency === 'usd')!
    const rows = buildPartnerAccountStatementDisplayEntries(usd)
    expect(rows.map((row) => row.id)).toEqual([
      'sales-order:sale-1', 'payment:reversal', 'payment:refund'
    ])
    expect(rows[0]).toMatchObject({ debit: 1000, credit: 600, runningBalance: 400 })
    expect(rows[1]).toMatchObject({ debit: 50, credit: 0, runningBalance: 450 })
    expect(rows[2]).toMatchObject({ debit: 25, credit: 0, runningBalance: 475 })
    expect(buildPartnerAccountStatementDisplayEntries(ledgers.find((ledger) => ledger.currency === 'iqd')!))
      .toMatchObject([{ id: 'payment:other-currency', debit: 0, credit: 10 }])
    expect(usd.closingBalance).toBe(475)
  })

  it('matches payments by their actual order rather than date or reference alone', () => {
    const data = orderData()
    data.statementOrders = data.statementOrders?.slice(0, 1)
    data.settlementTransactions = [
      data.settlementTransactions![0],
      {
        id: 'unrelated-receipt', sourceType: 'sales_order', sourceRecordId: 'other-sale',
        referenceLabel: 'SO-1', direction: 'incoming', amount: 75, currency: 'usd',
        paidAt: '2026-01-04T12:00:00', createdAt: '2026-01-04T12:00:00', isDeleted: false
      }
    ] as any

    const [ledger] = buildPartnerAccountStatementLedger(data)
    const rows = buildPartnerAccountStatementDisplayEntries(ledger)
    expect(rows.map((row) => row.id)).toEqual(['sales-order:sale-1', 'payment:unrelated-receipt'])
    expect(rows[0]).toMatchObject({ debit: 1000, credit: 200, runningBalance: 800 })
    expect(rows[1]).toMatchObject({ debit: 0, credit: 75, runningBalance: 725 })
  })

  it('keeps itemized sales payments separate and preserves fractional totals', () => {
    const data = orderData()
    data.itemizeSalesOrders = true
    data.statementOrders = [{
      id: 'sale-1', orderNumber: 'SO-1', customerId: 'partner-1', total: 0.3,
      currency: 'usd', status: 'completed', createdAt: '2026-01-04T10:00:00',
      isDeleted: false, linkedLoanId: null,
      items: [{ id: 'item-1', productName: 'Item', quantity: 1, lineTotal: 0.3 }]
    }] as any
    data.settlementTransactions = [
      { id: 'fraction-1', sourceType: 'sales_order', sourceRecordId: 'sale-1',
        direction: 'incoming', amount: 0.1, currency: 'usd',
        paidAt: '2026-01-04T11:00:00', createdAt: '2026-01-04T11:00:00', isDeleted: false },
      { id: 'fraction-2', sourceType: 'sales_order', sourceRecordId: 'sale-1',
        direction: 'incoming', amount: 0.2, currency: 'usd',
        paidAt: '2026-01-04T12:00:00', createdAt: '2026-01-04T12:00:00', isDeleted: false }
    ] as any

    const [itemizedLedger] = buildPartnerAccountStatementLedger(data)
    expect(buildPartnerAccountStatementDisplayEntries(itemizedLedger).map((row) => row.id)).toEqual([
      'sales-order:sale-1:item:item-1', 'payment:fraction-1', 'payment:fraction-2'
    ])

    data.itemizeSalesOrders = false
    const [documentLedger] = buildPartnerAccountStatementLedger(data)
    const [row] = buildPartnerAccountStatementDisplayEntries(documentLedger)
    expect(row.debit).toBeCloseTo(0.3)
    expect(row.credit).toBeCloseTo(0.3)
    expect(row.runningBalance).toBeCloseTo(0)
    expect(documentLedger.closingBalance).toBeCloseTo(0)
  })
})
