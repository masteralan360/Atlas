import { describe, expect, it } from 'vitest'
import { buildPartnerAccountStatementLedger, type PartnerAccountStatementData } from './partnerAccountStatement'

const agentId = 'sales-agent-1'

function statementOrder(id: string, customerId: string, salesAccountAgentId: string | null, total = 100) {
  return {
    id,
    orderNumber: `SO-${id}`,
    customerId,
    businessPartnerId: customerId,
    salesAccountAgentId,
    total,
    currency: 'usd',
    status: 'completed',
    createdAt: '2026-01-04T10:00:00.000Z',
    isDeleted: false,
    linkedLoanId: null
  } as any
}

function payment(id: string, input: Record<string, unknown>) {
  return {
    id,
    sourceModule: 'orders',
    sourceType: 'sales_order',
    sourceRecordId: 'agent-order',
    direction: 'incoming',
    amount: -100,
    currency: 'usd',
    paymentMethod: 'cash',
    paidAt: '2026-01-05T10:00:00.000Z',
    createdAt: '2026-01-05T10:00:00.000Z',
    isDeleted: false,
    ...input
  } as any
}

function ledgerData(overrides: Partial<PartnerAccountStatementData> = {}): PartnerAccountStatementData {
  const order = statementOrder('agent-order', 'agent-partner', agentId)
  const purchaseOrder = {
    id: 'purchase-order',
    orderNumber: 'PO-1',
    supplierId: 'agent-partner',
    total: 70,
    currency: 'usd',
    status: 'received',
    createdAt: '2026-01-04T10:00:00.000Z',
    isDeleted: false,
    linkedLoanId: null
  } as any

  return {
    partnerId: 'agent-partner',
    period: { type: 'allTime' },
    salesOrders: [order],
    purchaseOrders: [purchaseOrder],
    statementOrders: [order, purchaseOrder],
    salesAccountAgentIds: [agentId],
    settlementTransactions: [
      payment('agent-return-refund', {
        reversalOfTransactionId: 'agent-original-receipt',
        metadata: { orderReturnId: 'return-agent-1', returnReason: 'customer_returned' }
      }),
      payment('agent-correction-reversal', {
        amount: -20,
        reversalOfTransactionId: 'agent-original-receipt',
        note: 'Cash correction'
      }),
      payment('supplier-refund', {
        sourceType: 'purchase_order',
        sourceRecordId: purchaseOrder.id,
        direction: 'incoming',
        amount: 50
      })
    ] as any,
    ...overrides
  }
}

describe('sales-account agent return refunds in partner statements', () => {
  it('omits only linked agent return-reversal debits and keeps corrections and supplier refunds', () => {
    const [ledger] = buildPartnerAccountStatementLedger(ledgerData())

    expect(ledger.entries.map((entry) => entry.id)).toEqual([
      'purchase-order:purchase-order',
      'sales-order:agent-order',
      'payment:agent-correction-reversal',
      'payment:supplier-refund'
    ])
    expect(ledger.entries.find((entry) => entry.id === 'payment:agent-correction-reversal')?.delta).toBe(20)
    expect(ledger.entries.find((entry) => entry.id === 'payment:supplier-refund')?.delta).toBe(-50)
    expect(ledger.closingBalance).toBe(0)
  })

  it('keeps the same refund reversal on a regular customer statement', () => {
    const customerOrder = statementOrder('customer-order', 'customer-1', agentId)
    const [ledger] = buildPartnerAccountStatementLedger({
      partnerId: 'customer-1',
      period: { type: 'allTime' },
      salesOrders: [customerOrder],
      purchaseOrders: [],
      settlementTransactions: [
        payment('customer-original-receipt', {
          sourceRecordId: customerOrder.id,
          amount: 100,
          reversalOfTransactionId: null
        }),
        payment('customer-return-refund', {
          sourceRecordId: customerOrder.id,
          amount: -40,
          reversalOfTransactionId: 'customer-original-receipt',
          metadata: { orderReturnId: 'return-customer-1', returnReason: 'customer_returned' }
        })
      ] as any
    })

    expect(ledger.entries.map((entry) => entry.id)).toEqual([
      'sales-order:customer-order',
      'payment:customer-original-receipt',
      'payment:customer-return-refund'
    ])
    expect(ledger.closingBalance).toBe(40)
  })
})
