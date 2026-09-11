import { describe, expect, it } from 'vitest'

import {
  canCaptureInitialOrderPartnerBalanceSnapshot,
  createOrderPartnerBalanceSnapshot,
  createPartnerBalanceSnapshotForPostedOrder,
  deriveLegacyOrderPartnerBalanceSnapshot
} from '@/lib/orderPartnerBalanceSnapshot'
import type { PartnerAccountStatementData } from '@/lib/partnerAccountStatement'
import type { PaymentTransaction, SalesOrder } from '@/local-db'

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

describe('order partner-balance snapshots', () => {
  it('captures the ledger balance before and after an order together with its initial payment', () => {
    const existingOrder = salesOrder('existing', 100)
    const newOrder = salesOrder('new-order', 80)
    const payment = {
      id: 'initial-payment',
      workspaceId: 'workspace-1',
      sourceModule: 'orders',
      sourceType: 'sales_order',
      sourceRecordId: newOrder.id,
      sourceSubrecordId: null,
      direction: 'incoming',
      amount: 25,
      currency: 'iqd',
      paymentMethod: 'cash',
      paidAt: TIMESTAMP,
      counterpartyName: 'Partner',
      referenceLabel: newOrder.orderNumber,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      syncStatus: 'synced',
      lastSyncedAt: TIMESTAMP,
      version: 1,
      isDeleted: false
    } as PaymentTransaction

    const snapshot = createPartnerBalanceSnapshotForPostedOrder(
      statementData({ salesOrders: [existingOrder, newOrder], settlementTransactions: [payment] }),
      newOrder,
      TIMESTAMP
    )

    expect(snapshot).toEqual({
      version: 1,
      capturedAt: TIMESTAMP,
      balances: [{ currency: 'iqd', before: 100, after: 155 }]
    })
  })

  it('rounds snapshot amounts to ledger precision without collapsing currencies', () => {
    const before = statementData({ salesOrders: [salesOrder('before', 12.3456789)] })
    const after = statementData({
      salesOrders: [salesOrder('before', 12.3456789), salesOrder('after', 0.0000013)]
    })

    expect(createOrderPartnerBalanceSnapshot(before, after, TIMESTAMP)).toMatchObject({
      balances: [{ currency: 'iqd', before: 12.345679, after: 12.34568 }]
    })
  })

  it('retains a zero-valued order currency when a fully paid first order nets to zero', () => {
    const empty = statementData()

    expect(createOrderPartnerBalanceSnapshot(empty, empty, TIMESTAMP, ['iqd'])).toMatchObject({
      balances: [{ currency: 'iqd', before: 0, after: 0 }]
    })
  })

  it('reconstructs a legacy order from the statement position without including later order activity', () => {
    const earlier = {
      ...salesOrder('earlier', 100),
      createdAt: '2026-09-11T08:00:00.000Z',
      updatedAt: '2026-09-11T08:00:00.000Z'
    }
    const legacyOrder = {
      ...salesOrder('legacy', 50),
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
    const laterPaymentForLegacyOrder = {
      ...earlierPayment,
      id: 'legacy-later-payment',
      sourceRecordId: legacyOrder.id,
      referenceLabel: legacyOrder.orderNumber,
      amount: 50,
      paidAt: '2026-09-11T10:00:00.000Z',
      createdAt: '2026-09-11T10:00:00.000Z',
      updatedAt: '2026-09-11T10:00:00.000Z'
    }

    expect(deriveLegacyOrderPartnerBalanceSnapshot(
      statementData({
        salesOrders: [earlier, legacyOrder, later],
        settlementTransactions: [earlierPayment, laterPaymentForLegacyOrder]
      }),
      legacyOrder
    )).toEqual({
      version: 1,
      capturedAt: legacyOrder.createdAt,
      balances: [{ currency: 'iqd', before: 80, after: 130 }]
    })
    expect(legacyOrder.partnerBalanceSnapshot).toBeUndefined()
  })

  it('returns no legacy reconstruction when the account statement has no original order posting', () => {
    const legacyOrder = salesOrder('legacy-without-statement-row', 50)

    expect(deriveLegacyOrderPartnerBalanceSnapshot(statementData(), legacyOrder)).toBeNull()
  })

  it('rounds reconstructed legacy balances to the statement precision', () => {
    const earlier = {
      ...salesOrder('rounded-earlier', 12.3456789),
      createdAt: '2026-09-11T08:00:00.000Z',
      updatedAt: '2026-09-11T08:00:00.000Z'
    }
    const legacyOrder = {
      ...salesOrder('rounded-legacy', 0.0000013),
      createdAt: '2026-09-11T09:00:00.000Z',
      updatedAt: '2026-09-11T09:00:00.000Z'
    }

    expect(deriveLegacyOrderPartnerBalanceSnapshot(
      statementData({ salesOrders: [earlier, legacyOrder] }),
      legacyOrder
    )?.balances).toEqual([
      { currency: 'iqd', before: 12.345679, after: 12.34568 }
    ])
  })

  it('does not create a new snapshot for draft, cancelled, or already snapshotted orders', () => {
    expect(canCaptureInitialOrderPartnerBalanceSnapshot({ status: 'draft', partnerBalanceSnapshot: null })).toBe(false)
    expect(canCaptureInitialOrderPartnerBalanceSnapshot({ status: 'cancelled', partnerBalanceSnapshot: null })).toBe(false)
    expect(canCaptureInitialOrderPartnerBalanceSnapshot({
      status: 'pending',
      partnerBalanceSnapshot: {
        version: 1,
        capturedAt: TIMESTAMP,
        balances: []
      }
    })).toBe(false)
  })
})
