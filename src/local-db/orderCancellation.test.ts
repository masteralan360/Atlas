import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { supabase } from '@/auth/supabase'
import { isOnline } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'
import { cancelFinancedOrder, persistFinancedOrderCancellation } from './orderCancellation'
import { mirrorPaymentAccountTransactionLocally } from './paymentAccounts'
import { recalculateBusinessPartnerSummary } from './businessPartners'
import type { OrderType, PurchaseOrder, SalesOrder } from './models'

vi.mock('@/auth/supabase', () => ({ supabase: { rpc: vi.fn() } }))
vi.mock('@/lib/network', () => ({ isOnline: vi.fn() }))
vi.mock('@/lib/supabaseRequest', () => ({ runSupabaseAction: (_label: string, callback: () => unknown) => callback() }))
vi.mock('./paymentAccounts', () => ({ mirrorPaymentAccountTransactionLocally: vi.fn() }))
vi.mock('./businessPartners', () => ({ recalculateBusinessPartnerSummary: vi.fn() }))

const workspaceId = '00000000-0000-4000-8000-000000000301'
const orderId = '00000000-0000-4000-8000-000000000302'
const loanId = '00000000-0000-4000-8000-000000000303'
const partnerId = '00000000-0000-4000-8000-000000000310'
const accountId = '00000000-0000-4000-8000-000000000311'
const now = '2026-09-24T10:00:00.000Z'

function orderFixture(orderType: OrderType, paymentMethod: 'loan' | 'installments') {
  return {
    id: orderId, workspaceId, orderNumber: 'ORDER-301', status: orderType === 'sales' ? 'pending' : 'ordered',
    paymentMethod, linkedLoanId: loanId, businessPartnerId: partnerId, total: 100,
    currency: 'usd', paidAmount: 20, balanceAmount: 80,
    version: 2, isDeleted: false, syncStatus: 'synced', lastSyncedAt: now,
  } as unknown as SalesOrder | PurchaseOrder
}

function resultFixture(orderType: OrderType, paymentMethod: 'loan' | 'installments') {
  const order = orderFixture(orderType, paymentMethod)
  const sourceType = orderType === 'sales' ? 'sales_order' : 'purchase_order'
  const originalOrderPayment = {
    id: '00000000-0000-4000-8000-000000000304', workspaceId,
    sourceModule: 'orders', sourceType, sourceRecordId: orderId,
    amount: 20, currency: 'usd', accountId, isDeleted: false,
  }
  const originalLoanPayment = {
    id: '00000000-0000-4000-8000-000000000306', workspaceId,
    sourceModule: 'loans', sourceType: paymentMethod === 'loan' ? 'simple_loan' : 'loan_installment',
    sourceRecordId: loanId, amount: 30, currency: 'usd', accountId, isDeleted: false,
  }
  return {
    linked_order: { ...order, status: 'cancelled', linkedLoanId: null, paidAmount: 0, balanceAmount: 100 },
    loan: {
      id: loanId, workspaceId, source: 'order', orderType, orderId,
      loanCategory: paymentMethod === 'loan' ? 'simple' : 'standard',
      isDeleted: true, version: 3,
    },
    installments: paymentMethod === 'installments' ? [{
      id: '00000000-0000-4000-8000-000000000308', workspaceId, loanId, isDeleted: true,
    }] : [],
    payments: [{
      id: '00000000-0000-4000-8000-000000000309', workspaceId, loanId,
      amount: 30, isDeleted: true, reversedAmount: 30,
    }],
    transactions: [originalLoanPayment, {
      ...originalLoanPayment, id: '00000000-0000-4000-8000-000000000307',
      amount: -30, reversalOfTransactionId: originalLoanPayment.id,
    }],
    order_transactions: [originalOrderPayment, {
      ...originalOrderPayment, id: '00000000-0000-4000-8000-000000000305',
      amount: -20, reversalOfTransactionId: originalOrderPayment.id,
    }],
  }
}

beforeEach(async () => {
  writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'hybrid' })
  vi.mocked(isOnline).mockReturnValue(true)
  vi.mocked(supabase.rpc).mockReset()
  vi.mocked(mirrorPaymentAccountTransactionLocally).mockClear()
  vi.mocked(recalculateBusinessPartnerSummary).mockClear()
})

afterEach(async () => {
  await db.transaction('rw', [db.sales_orders, db.purchase_orders, db.loans,
    db.loan_installments, db.loan_payments, db.payment_transactions, db.offline_mutations], async () => {
    await Promise.all([db.sales_orders.clear(), db.purchase_orders.clear(), db.loans.clear(),
      db.loan_installments.clear(), db.loan_payments.clear(), db.payment_transactions.clear(),
      db.offline_mutations.clear()])
  })
  clearWorkspaceModeSnapshot(workspaceId)
})

describe('financed order cancellation Cloud/Hybrid contract', () => {
  for (const orderType of ['sales', 'purchase'] as const) {
    for (const paymentMethod of ['loan', 'installments'] as const) {
      it(`${orderType} ${paymentMethod}: confirms the order, deleted loan, and exact payment counter-entries`, async () => {
        const order = orderFixture(orderType, paymentMethod)
        const table = orderType === 'sales' ? db.sales_orders : db.purchase_orders
        await table.put(order as never)
        vi.mocked(supabase.rpc).mockResolvedValue({ data: resultFixture(orderType, paymentMethod), error: null } as never)

        const result = await cancelFinancedOrder(orderType, order)

        expect(result.queued).toBe(false)
        expect(result.order).toMatchObject({ status: 'cancelled', linkedLoanId: null })
        expect(supabase.rpc).toHaveBeenCalledWith('cancel_order_with_financing', {
          p_order_type: orderType, p_order_id: orderId,
        })
        expect(await table.get(orderId)).toMatchObject({ status: 'cancelled', linkedLoanId: null })
        expect(await db.loans.get(loanId)).toMatchObject({ isDeleted: true })
        expect(await db.loan_payments.where('loanId').equals(loanId).and((row) => !row.isDeleted).count()).toBe(0)
        expect(await db.loan_installments.where('loanId').equals(loanId).and((row) => !row.isDeleted).count()).toBe(0)
        const transactions = await db.payment_transactions.toArray()
        expect(transactions).toHaveLength(4)
        expect(transactions.reduce((sum, row) => sum + row.amount, 0)).toBe(0)
        expect(transactions.filter((row) => !!row.reversalOfTransactionId)).toHaveLength(2)
        expect(transactions.every((row) => row.accountId === accountId)).toBe(true)
        expect(mirrorPaymentAccountTransactionLocally).toHaveBeenCalledTimes(4)
        expect(recalculateBusinessPartnerSummary).toHaveBeenCalledWith(workspaceId, partnerId)
      })
    }
  }

  for (const orderType of ['sales', 'purchase'] as const) {
    it(`${orderType} draft financing cancels without inventing a loan`, async () => {
      const order = {
        ...orderFixture(orderType, 'installments'), status: 'draft', linkedLoanId: null, paidAmount: 0,
      } as SalesOrder | PurchaseOrder
      const table = orderType === 'sales' ? db.sales_orders : db.purchase_orders
      await table.put(order as never)
      vi.mocked(supabase.rpc).mockResolvedValue({
        data: {
          linked_order: { ...order, status: 'cancelled' }, loan: null,
          installments: [], payments: [], transactions: [], order_transactions: [],
        },
        error: null,
      } as never)

      const result = await cancelFinancedOrder(orderType, order)

      expect(result.order.status).toBe('cancelled')
      expect(await table.get(orderId)).toMatchObject({ status: 'cancelled', linkedLoanId: null })
      expect(await db.loans.count()).toBe(0)
    })
  }

  it('keeps both local records active and queues one command when offline', async () => {
    const order = orderFixture('sales', 'loan')
    await db.sales_orders.put(order as SalesOrder)
    await db.loans.put({ ...resultFixture('sales', 'loan').loan, isDeleted: false } as never)
    vi.mocked(isOnline).mockReturnValue(false)

    const result = await cancelFinancedOrder('sales', order)
    await cancelFinancedOrder('sales', order)

    expect(result.queued).toBe(true)
    expect(await db.sales_orders.get(orderId)).toMatchObject({ status: 'pending', linkedLoanId: loanId })
    expect(await db.loans.get(loanId)).toMatchObject({ isDeleted: false })
    expect(await db.offline_mutations.where('entityType').equals('order_cancellation_commands').count()).toBe(1)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('does not mutate local records when the server rejects cancellation', async () => {
    const order = orderFixture('purchase', 'installments')
    await db.purchase_orders.put(order as PurchaseOrder)
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: new Error('cancelled_order_has_active_loan') } as never)

    await expect(cancelFinancedOrder('purchase', order)).rejects.toThrow('cancelled_order_has_active_loan')
    expect(await db.purchase_orders.get(orderId)).toMatchObject({ status: 'ordered', linkedLoanId: loanId })
    expect(await db.offline_mutations.count()).toBe(0)
  })

  it('rejects an incomplete result before changing the local order', async () => {
    const order = orderFixture('sales', 'loan')
    await db.sales_orders.put(order as SalesOrder)
    const incomplete = { ...resultFixture('sales', 'loan'), loan: null }

    await expect(persistFinancedOrderCancellation(incomplete, 'sales', orderId, workspaceId, loanId))
      .rejects.toThrow('order_cancellation_invalid_result')
    expect(await db.sales_orders.get(orderId)).toMatchObject({ status: 'pending', linkedLoanId: loanId })
  })

  it('rejects missing ledger counter-entries before changing the local order', async () => {
    const order = orderFixture('purchase', 'installments')
    await db.purchase_orders.put(order as PurchaseOrder)
    const incomplete = resultFixture('purchase', 'installments')
    incomplete.order_transactions.pop()

    await expect(persistFinancedOrderCancellation(incomplete, 'purchase', orderId, workspaceId, loanId))
      .rejects.toThrow('order_cancellation_invalid_result')
    expect(await db.purchase_orders.get(orderId)).toMatchObject({ status: 'ordered', linkedLoanId: loanId })
  })

  it('rejects a reversal with the wrong sign', async () => {
    const incomplete = resultFixture('sales', 'loan')
    incomplete.order_transactions[1].amount = 20

    await expect(persistFinancedOrderCancellation(incomplete, 'sales', orderId, workspaceId, loanId))
      .rejects.toThrow('order_cancellation_invalid_result')
    expect(await db.payment_transactions.count()).toBe(0)
  })

  it('accepts sub-cent rounding noise in linked reversal totals', async () => {
    const rounded = resultFixture('purchase', 'installments')
    rounded.order_transactions[0].amount = 20.0004

    await expect(persistFinancedOrderCancellation(rounded, 'purchase', orderId, workspaceId, loanId))
      .resolves.toMatchObject({ status: 'cancelled' })
  })
})
