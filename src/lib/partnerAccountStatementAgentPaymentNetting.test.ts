import { describe, expect, it } from 'vitest'

import type { Loan, PaymentObligation, PaymentTransaction, SalesOrder } from '@/local-db/models'
import { applySalesAgentStatementCreditToOrderLoans } from './partnerAccountStatement'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const PARTNER_ID = '00000000-0000-4000-8000-000000000002'
const AGENT_ID = '00000000-0000-4000-8000-000000000003'

function order(id: string, loanId: string, createdAt: string, salesAccountAgentId: string | null = AGENT_ID): SalesOrder {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    customerId: PARTNER_ID,
    orderNumber: id,
    createdAt,
    updatedAt: createdAt,
    currency: 'iqd',
    total: 0,
    status: 'completed',
    paymentMethod: 'loan',
    isDeleted: false,
    linkedLoanId: loanId,
    salesAccountAgentId
  } as SalesOrder
}

function loan(id: string, orderId: string, principalAmount: number, createdAt: string, currency: Loan['settlementCurrency'] = 'iqd'): Loan {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    loanNo: id,
    source: 'order',
    loanCategory: 'simple',
    direction: 'lent',
    linkedPartyType: 'business_partner',
    linkedPartyId: PARTNER_ID,
    borrowerName: 'Agent partner',
    principalAmount,
    totalPaidAmount: 0,
    balanceAmount: principalAmount,
    settlementCurrency: currency,
    installmentCount: 0,
    installmentFrequency: 'monthly',
    firstDueDate: createdAt,
    nextDueDate: createdAt,
    status: 'active',
    createdAt,
    updatedAt: createdAt,
    isDeleted: false,
    orderId,
    orderType: 'sales'
  } as Loan
}

function obligation(id: string, orderId: string, amount: number, createdAt: string, currency: PaymentObligation['currency'] = 'iqd'): PaymentObligation {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    sourceModule: 'loans',
    sourceType: 'simple_loan',
    sourceRecordId: `loan-${id}`,
    sourceSubrecordId: null,
    direction: 'incoming',
    amount,
    currency,
    dueDate: createdAt.slice(0, 10),
    createdAt,
    counterpartyName: 'Agent partner',
    referenceLabel: id,
    title: 'Agent partner',
    subtitle: 'Order loan balance',
    status: 'open',
    routePath: '/loans',
    metadata: {
      displaySourceLabel: 'order_loan',
      orderType: 'sales',
      orderId,
      businessPartnerId: PARTNER_ID
    }
  }
}

function accountCredit(id: string, amount: number, currency: PaymentTransaction['currency'] = 'iqd'): PaymentTransaction {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    sourceModule: 'payments',
    sourceType: 'direct_transaction',
    sourceRecordId: id,
    sourceSubrecordId: PARTNER_ID,
    direction: 'incoming',
    amount,
    currency,
    paymentMethod: 'cash',
    paidAt: '2026-09-30T12:00:00.000Z',
    counterpartyName: 'Agent partner',
    referenceLabel: 'Account credit',
    note: null,
    createdBy: null,
    reversalOfTransactionId: null,
    metadata: { businessPartnerId: PARTNER_ID, partnerAccountEffect: 'decrease_receivable' },
    createdAt: '2026-09-30T12:00:00.000Z',
    updatedAt: '2026-09-30T12:00:00.000Z',
    syncStatus: 'synced',
    lastSyncedAt: '2026-09-30T12:00:00.000Z',
    version: 1,
    isDeleted: false
  }
}

function statementData(orders: SalesOrder[], loans: Loan[], credits: PaymentTransaction[]) {
  return {
    partnerId: PARTNER_ID,
    period: { type: 'allTime' as const },
    salesOrders: orders,
    purchaseOrders: [],
    loans,
    settlementTransactions: credits
  }
}

describe('sales-account agent order-loan account credit allocation', () => {
  it('nets statement credit against the oldest eligible loans and leaves the total collectible at the statement balance', () => {
    const olderOrder = order('order-old', 'loan-old', '2026-06-01T10:00:00.000Z')
    const newerOrder = order('order-new', 'loan-new', '2026-07-01T10:00:00.000Z')
    const olderLoan = loan('loan-old', olderOrder.id, 200_000, olderOrder.createdAt)
    const newerLoan = loan('loan-new', newerOrder.id, 968_750, newerOrder.createdAt)
    const rows = [
      obligation('newer', newerOrder.id, 968_750, newerOrder.createdAt),
      obligation('older', olderOrder.id, 200_000, olderOrder.createdAt)
    ]

    const adjusted = applySalesAgentStatementCreditToOrderLoans(
      rows,
      statementData([olderOrder, newerOrder], [olderLoan, newerLoan], [accountCredit('credit-430k', 430_000)]),
      [AGENT_ID]
    )

    expect(adjusted.find((row) => row.id === 'older')).toMatchObject({
      amount: 0,
      metadata: { salesAgentAccountCreditApplied: 200_000 }
    })
    expect(adjusted.find((row) => row.id === 'newer')).toMatchObject({
      amount: 738_750,
      metadata: { salesAgentAccountCreditApplied: 230_000 }
    })
    expect(adjusted.reduce((sum, row) => sum + row.amount, 0)).toBe(738_750)
  })

  it('keeps the credit in its own currency and only applies it to linked sales-account-agent orders', () => {
    const agentOrder = order('agent-order', 'agent-loan', '2026-06-01T10:00:00.000Z')
    const ordinaryOrder = order('ordinary-order', 'ordinary-loan', '2026-06-02T10:00:00.000Z', null)
    const usdAgentOrder = { ...order('usd-order', 'usd-loan', '2026-06-03T10:00:00.000Z'), currency: 'usd' as const }
    const loans = [
      loan('agent-loan', agentOrder.id, 100, agentOrder.createdAt),
      loan('usd-loan', usdAgentOrder.id, 50, usdAgentOrder.createdAt, 'usd')
    ]
    const rows = [
      obligation('agent', agentOrder.id, 100, agentOrder.createdAt),
      obligation('ordinary', ordinaryOrder.id, 75, ordinaryOrder.createdAt),
      obligation('usd', usdAgentOrder.id, 50, usdAgentOrder.createdAt, 'usd')
    ]

    const adjusted = applySalesAgentStatementCreditToOrderLoans(
      rows,
      statementData([agentOrder, ordinaryOrder, usdAgentOrder], loans, [accountCredit('credit-iqd', 30)]),
      [AGENT_ID]
    )

    expect(adjusted.find((row) => row.id === 'agent')?.amount).toBe(70)
    expect(adjusted.find((row) => row.id === 'ordinary')?.amount).toBe(75)
    expect(adjusted.find((row) => row.id === 'usd')?.amount).toBe(50)
    expect(adjusted.every((row) => row.amount >= 0)).toBe(true)
  })

  it('does not apply any credit when there is no matching sales-account agent link', () => {
    const unlinkedOrder = order('unlinked-order', 'unlinked-loan', '2026-06-01T10:00:00.000Z', null)
    const row = obligation('unlinked', unlinkedOrder.id, 100, unlinkedOrder.createdAt)

    const adjusted = applySalesAgentStatementCreditToOrderLoans(
      [row],
      statementData([unlinkedOrder], [loan('unlinked-loan', unlinkedOrder.id, 100, unlinkedOrder.createdAt)], [accountCredit('credit', 100)]),
      [AGENT_ID]
    )

    expect(adjusted).toEqual([row])
  })
})
