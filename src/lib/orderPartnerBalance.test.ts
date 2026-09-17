import { describe, expect, it } from 'vitest'

import { deriveOrderPartnerBalanceAtPosting } from '@/lib/orderPartnerBalance'
import {
  hasOrderPartnerBalancePrintDemand,
  resolveOrderPartnerBalancePrintDemand
} from '@/lib/orderPartnerBalancePrintDemand'
import type { PartnerAccountStatementData } from '@/lib/partnerAccountStatement'
import type { Loan, PaymentTransaction, SalesOrder } from '@/local-db'

const TIMESTAMP = '2026-09-11T10:00:00.000Z'

function salesOrder(id: string, total: number): SalesOrder {
  return {
    id,
    workspaceId: 'workspace-1',
    orderNumber: id.toUpperCase(),
    businessPartnerId: 'partner-1',
    customerId: 'partner-1',
    customerName: 'Partner',
    items: [],
    subtotal: total,
    discount: 0,
    tax: 0,
    total,
    currency: 'iqd',
    exchangeRate: null,
    exchangeRateSource: null,
    exchangeRateTimestamp: null,
    status: 'pending',
    isPaid: false,
    paymentStatus: 'unpaid',
    paidAmount: 0,
    balanceAmount: total,
    initialPaymentAmount: 0,
    isInstallmentBased: false,
    installmentCount: 0,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    syncStatus: 'synced',
    lastSyncedAt: TIMESTAMP,
    version: 1,
    isDeleted: false
  }
}

function statementData(overrides: Partial<PartnerAccountStatementData> = {}): PartnerAccountStatementData {
  return {
    partnerId: 'partner-1',
    period: { type: 'allTime' },
    salesOrders: [],
    purchaseOrders: [],
    ...overrides
  }
}

describe('order partner balances at posting', () => {
  it('reconstructs the order position without including later activity for that order', () => {
    const earlier = {
      ...salesOrder('earlier', 100),
      createdAt: '2026-09-11T08:00:00.000Z',
      updatedAt: '2026-09-11T08:00:00.000Z'
    }
    const order = {
      ...salesOrder('order', 50),
      createdAt: '2026-09-11T09:00:00.000Z',
      updatedAt: '2026-09-11T09:00:00.000Z'
    }
    const later = {
      ...salesOrder('later', 30),
      createdAt: '2026-09-11T11:00:00.000Z',
      updatedAt: '2026-09-11T11:00:00.000Z'
    }
    const earlierPayment = {
      id: 'earlier-payment',
      workspaceId: 'workspace-1',
      sourceModule: 'orders',
      sourceType: 'sales_order',
      sourceRecordId: earlier.id,
      sourceSubrecordId: null,
      direction: 'incoming',
      amount: 20,
      currency: 'iqd',
      paymentMethod: 'cash',
      paidAt: '2026-09-11T08:30:00.000Z',
      counterpartyName: 'Partner',
      referenceLabel: earlier.orderNumber,
      createdAt: '2026-09-11T08:30:00.000Z',
      updatedAt: '2026-09-11T08:30:00.000Z',
      syncStatus: 'synced',
      lastSyncedAt: TIMESTAMP,
      version: 1,
      isDeleted: false
    } as PaymentTransaction
    const laterPaymentForOrder = {
      ...earlierPayment,
      id: 'order-later-payment',
      sourceRecordId: order.id,
      referenceLabel: order.orderNumber,
      amount: 50,
      paidAt: '2026-09-11T10:00:00.000Z',
      createdAt: '2026-09-11T10:00:00.000Z',
      updatedAt: '2026-09-11T10:00:00.000Z'
    }

    expect(deriveOrderPartnerBalanceAtPosting(
      statementData({
        salesOrders: [earlier, order, later],
        settlementTransactions: [earlierPayment, laterPaymentForOrder]
      }),
      order
    )).toEqual({
      balances: [{ currency: 'iqd', before: 80, after: 130 }]
    })
  })

  it('returns no balance when the account statement has no original order posting', () => {
    expect(deriveOrderPartnerBalanceAtPosting(statementData(), salesOrder('missing', 50))).toBeNull()
  })

  it('reconstructs an order-financing loan that is presented as a sales-order ledger entry', () => {
    const earlier = {
      ...salesOrder('earlier-financed', 100),
      createdAt: '2026-09-11T08:00:00.000Z',
      updatedAt: '2026-09-11T08:00:00.000Z'
    }
    const order = {
      ...salesOrder('financed-order', 50),
      paymentMethod: 'loan' as const,
      linkedLoanId: 'loan-1',
      createdAt: '2026-09-11T09:00:00.000Z',
      updatedAt: '2026-09-11T09:00:00.000Z'
    }
    const loan: Loan = {
      id: 'loan-1',
      workspaceId: 'workspace-1',
      orderId: order.id,
      orderType: 'sales',
      loanNo: 'SL-1',
      source: 'order',
      loanCategory: 'simple',
      direction: 'lent',
      linkedPartyType: 'business_partner',
      linkedPartyId: 'partner-1',
      linkedPartyName: 'Partner',
      borrowerName: 'Partner',
      borrowerPhone: '',
      borrowerAddress: '',
      borrowerNationalId: '',
      principalAmount: 50,
      totalPaidAmount: 0,
      balanceAmount: 50,
      settlementCurrency: 'iqd',
      installmentCount: 1,
      installmentFrequency: 'monthly',
      firstDueDate: null,
      nextDueDate: null,
      status: 'active',
      createdAt: '2026-09-11T09:10:00.000Z',
      updatedAt: '2026-09-11T09:10:00.000Z',
      syncStatus: 'synced',
      lastSyncedAt: TIMESTAMP,
      version: 1,
      isDeleted: false
    }

    expect(deriveOrderPartnerBalanceAtPosting(
      statementData({ salesOrders: [earlier, order], loans: [loan] }),
      order
    )).toEqual({
      balances: [{ currency: 'iqd', before: 100, after: 150 }]
    })
  })

  it('rounds each reconstructed balance to the statement precision', () => {
    const earlier = {
      ...salesOrder('rounded-earlier', 12.3456789),
      createdAt: '2026-09-11T08:00:00.000Z',
      updatedAt: '2026-09-11T08:00:00.000Z'
    }
    const order = {
      ...salesOrder('rounded-order', 0.0000013),
      createdAt: '2026-09-11T09:00:00.000Z',
      updatedAt: '2026-09-11T09:00:00.000Z'
    }

    expect(deriveOrderPartnerBalanceAtPosting(
      statementData({ salesOrders: [earlier, order] }),
      order
    )?.balances).toEqual([
      { currency: 'iqd', before: 12.345679, after: 12.34568 }
    ])
  })

  it('calculates only the requested pre- or post-order balance', () => {
    const earlier = {
      ...salesOrder('selective-earlier', 100),
      createdAt: '2026-09-11T08:00:00.000Z',
      updatedAt: '2026-09-11T08:00:00.000Z'
    }
    const order = {
      ...salesOrder('selective-order', 50),
      createdAt: '2026-09-11T09:00:00.000Z',
      updatedAt: '2026-09-11T09:00:00.000Z'
    }

    expect(deriveOrderPartnerBalanceAtPosting(
      statementData({ salesOrders: [earlier, order] }),
      order,
      { before: true, after: false }
    )).toEqual({
      balances: [{ currency: 'iqd', before: 100 }]
    })
    expect(deriveOrderPartnerBalanceAtPosting(
      statementData({ salesOrders: [earlier, order] }),
      order,
      { before: false, after: false }
    )).toBeNull()
  })
})

describe('order partner-balance print demand', () => {
  const fieldKeys = {
    before: 'balance-before',
    after: 'balance-after',
    current: 'balance-current'
  }

  it('requests only the values that the print currently exposes', () => {
    expect(resolveOrderPartnerBalancePrintDemand(fieldKeys, {
      'balance-before': true,
      'balance-current': true
    })).toEqual({ before: false, after: true, current: false })
  })

  it('does not request account-statement data when every partner-balance field is hidden', () => {
    const demand = resolveOrderPartnerBalancePrintDemand(fieldKeys, {
      'balance-before': true,
      'balance-after': true,
      'balance-current': true
    })

    expect(demand).toEqual({ before: false, after: false, current: false })
    expect(hasOrderPartnerBalancePrintDemand(demand)).toBe(false)
  })
})
