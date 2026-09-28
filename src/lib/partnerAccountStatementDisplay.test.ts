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
  it('shows one settlement row across order and loan repayments and keeps the individual movements expandable', () => {
    const operationId = 'settlement-op-1'
    const operation = {
      id: operationId,
      workspaceId: 'workspace-1',
      partnerId: 'partner-1',
      partnerNameSnapshot: 'Partner 1',
      direction: 'incoming',
      paidAt: '2026-01-04T12:00:00',
      paymentMethod: 'cash',
      note: 'Combined collection',
      status: 'completed',
      createdAt: '2026-01-04T12:00:00',
      updatedAt: '2026-01-04T12:00:00',
      version: 2,
      isDeleted: false,
      syncStatus: 'synced',
      lastSyncedAt: '2026-01-04T12:00:00'
    } as any
    const data: PartnerAccountStatementData = {
      period: { type: 'allTime' },
      salesOrders: [],
      purchaseOrders: [],
      statementOrders: [{
        id: 'sale-1', orderNumber: 'SO-1', customerId: 'partner-1', total: 500,
        currency: 'usd', status: 'completed', createdAt: '2026-01-04T10:00:00',
        isDeleted: false, linkedLoanId: null
      }] as any,
      loans: [{
        id: 'loan-1', workspaceId: 'workspace-1', loanCategory: 'simple', direction: 'lent',
        source: 'manual', borrowerName: 'Partner 1', loanNo: 'LN-1', principalAmount: 300,
        balanceAmount: 250, totalPaidAmount: 50, settlementCurrency: 'usd', installmentCount: 1,
        status: 'active', linkedPartyType: 'business_partner', linkedPartyId: 'partner-1',
        createdAt: '2026-01-03T10:00:00', updatedAt: '2026-01-03T10:00:00',
        version: 1, isDeleted: false, syncStatus: 'synced', lastSyncedAt: null
      }] as any,
      loanPayments: [{
        id: 'loan-payment-1', workspaceId: 'workspace-1', loanId: 'loan-1', amount: 50,
        paidAt: '2026-01-04T12:00:00', createdAt: '2026-01-04T12:00:00',
        paymentTransactionId: 'loan-tx-1', isDeleted: false
      }] as any,
      settlementTransactions: [{
        id: 'sale-tx-1', sourceType: 'sales_order', sourceRecordId: 'sale-1',
        sourceModule: 'orders', direction: 'incoming', amount: 100, currency: 'usd',
        paidAt: '2026-01-04T12:00:00', createdAt: '2026-01-04T12:00:00', isDeleted: false,
        settlementOperationId: operationId
      }] as any,
      loanPaymentTransactions: [{
        id: 'loan-tx-1', sourceType: 'simple_loan', sourceRecordId: 'loan-1',
        sourceModule: 'loans', direction: 'incoming', amount: 50, currency: 'usd',
        paidAt: '2026-01-04T12:00:00', createdAt: '2026-01-04T12:00:00', isDeleted: false,
        settlementOperationId: operationId
      }] as any,
      settlementOperations: [operation]
    }

    const [ledger] = buildPartnerAccountStatementLedger(data)
    const normalRows = buildPartnerAccountStatementDisplayEntries(ledger, { combineOrderPayments: false })
    expect(normalRows).toHaveLength(4)
    expect(normalRows.every((row) => row.kind !== 'partner_settlement')).toBe(true)
    expect(normalRows.map((row) => row.id)).toEqual(expect.arrayContaining([
      'sales-order:sale-1', 'loan:loan-1', 'loan-payment:loan-payment-1', 'payment:sale-tx-1'
    ]))

    const rows = buildPartnerAccountStatementDisplayEntries(ledger, { groupSettlementOperations: true })
    const settlementRows = rows.filter((row) => row.kind === 'partner_settlement')

    expect(settlementRows).toHaveLength(1)
    expect(settlementRows[0]).toMatchObject({
      id: `settlement:${operationId}`,
      reference: 'SET-SETTLEME',
      description: 'Cash Collection',
      descriptionKey: 'cashCollection',
      note: 'Combined collection',
      debit: 0,
      credit: 150,
      delta: -150
    })
    expect(settlementRows[0].childEntries?.map((entry) => entry.id).sort()).toEqual([
      'loan-payment:loan-payment-1', 'payment:sale-tx-1'
    ])
    expect(ledger.entries.filter((entry) => entry.settlementOperationId === operationId)).toHaveLength(2)
    expect(rows.at(-1)?.runningBalance).toBe(ledger.closingBalance)
    expect(rows.reduce((sum, row) => sum + row.debit, 0)).toBe(ledger.debitTotal)
    expect(rows.reduce((sum, row) => sum + row.credit, 0)).toBe(ledger.creditTotal)
  })

  it('labels outgoing settlement rows as cash paid', () => {
    const operationId = 'settlement-out'
    const rows = buildPartnerAccountStatementDisplayEntries({
      currency: 'usd',
      openingBalance: 0,
      productCommissionTotal: 0,
      debitTotal: 25,
      creditTotal: 0,
      closingBalance: 25,
      entries: [{
        id: 'payment:outgoing-payment',
        date: '2026-01-04T12:00:00',
        reference: 'PAYMENT-OUT',
        kind: 'outgoing_payment',
        description: 'Payment made',
        descriptionKey: 'paymentMade',
        currency: 'usd',
        delta: 25,
        runningBalance: 25,
        settlementOperationId: operationId,
        settlementOperation: {
          id: operationId,
          partnerNameSnapshot: 'Partner 1',
          direction: 'outgoing',
          paidAt: '2026-01-04T12:00:00',
          paymentMethod: 'cash',
          note: null,
          status: 'completed'
        }
      }]
    } as any, { groupSettlementOperations: true })

    expect(rows[0]).toMatchObject({ description: 'Cash Paid', descriptionKey: 'cashPaid' })
  })

  it('keeps legacy settlement transactions ungrouped when they have no operation link', () => {
    const data = orderData()
    data.statementOrders = data.statementOrders?.slice(0, 1)
    data.settlementTransactions = [data.settlementTransactions![0], data.settlementTransactions![1]]
    const [ledger] = buildPartnerAccountStatementLedger(data)

    expect(buildPartnerAccountStatementDisplayEntries(ledger, { combineOrderPayments: false }).map((row) => row.id))
      .toEqual(['sales-order:sale-1', 'payment:sale-payment-1', 'payment:sale-payment-2'])
  })

  it('uses the direct transaction voucher as its reference and its reason as the description', () => {
    const data = orderData()
    data.statementOrders = []
    data.settlementTransactions = [{
      id: 'direct-tx-1',
      sourceModule: 'payments',
      sourceType: 'direct_transaction',
      sourceRecordId: 'source-1',
      direction: 'outgoing',
      amount: 25,
      currency: 'usd',
      paymentMethod: 'cash',
      paidAt: '2026-01-04T12:00:00',
      referenceLabel: 'Fuel expense',
      metadata: { reason: 'Fuel expense' },
      createdAt: '2026-01-04T12:00:00',
      isDeleted: false,
      voucherNumber: 23
    }] as any

    const [ledger] = buildPartnerAccountStatementLedger(data)
    const entry = ledger.entries.find((row) => row.id === 'payment:direct-tx-1')

    expect(entry).toMatchObject({
      reference: 'DT-000023',
      description: 'Fuel expense',
      delta: 25
    })
    expect(entry?.descriptionKey).toBeUndefined()
  })

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
