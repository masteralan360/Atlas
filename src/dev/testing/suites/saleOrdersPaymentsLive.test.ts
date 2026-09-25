import { describe, expect, it } from 'vitest'
import { saleOrderInput } from '../fixtures/saleOrder'
import {
    freshLiveClient, liveWorkspaceId, recordLiveFixture, requireLiveData,
    setupHostedSaleOrders, withLiveSaleOrderFixture
} from '../fixtures/saleOrdersLive'

describe('Sale Orders · hosted payments', () => {
    setupHostedSaleOrders()

    for (const selectedAccount of [false, true]) {
        it(`${selectedAccount ? 'selected account' : 'no account'}: partial payment and reversal persist exact effects`, async () => {
            await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
                const orders = await import('@/local-db/orders')
                const accounts = await import('@/local-db/paymentAccounts')
                if (selectedAccount) {
                    const { fetchTableFromSupabase } = await import('@/local-db/hooks')
                    const { db } = await import('@/local-db/database')
                    if (!await fetchTableFromSupabase('payment_accounts', db.payment_accounts, liveWorkspaceId, { force: true })) {
                        throw new Error('live_payment_account_hydration_failed')
                    }
                }
                const account = selectedAccount ? await accounts.savePaymentAccount(liveWorkspaceId, {
                    name: `${tag} account`, accountType: 'cash_drawer', iconKey: 'cash_drawer', openingBalances: []
                }) : null
                if (account) { ids.accountId = account.id; recordLiveFixture(ids) }
                if (account) {
                    const verified = await freshLiveClient()
                    try {
                        const saved = requireLiveData(await verified.schema('payment_accounts').from('accounts')
                            .select('id,is_active').eq('id', account.id).maybeSingle(), 'hosted payment account')
                        expect(saved).toMatchObject({ id: account.id, is_active: true })
                    } finally { await verified.auth.signOut() }
                }
                const order = await orders.createCompletedSalesOrder(liveWorkspaceId, {
                    ...saleOrderInput(partner.id, product, storage.id, 'cash'),
                    customerName: partner.partnerName, notes: tag
                })
                ids.orderId = order.id
                recordLiveFixture(ids)
                const payment = await orders.recordOrderPayment(liveWorkspaceId, {
                    orderType: 'sales', orderId: order.id, amount: 60, paymentMethod: 'cash',
                    paidAt: new Date().toISOString(), accountId: account?.id ?? null,
                    accountNameSnapshot: account?.name ?? null
                })
                const before = await freshLiveClient()
                try {
                    const saved = requireLiveData(await before.schema('crm').from('sales_orders')
                        .select('paid_amount,balance_amount').eq('id', order.id).single(), 'part-paid order')
                    const transactions = requireLiveData(await before.from('payment_transactions')
                        .select('id,amount,account_id').eq('workspace_id', liveWorkspaceId)
                        .eq('source_type', 'sales_order').eq('source_record_id', order.id), 'initial payments')
                    expect(Number(saved.paid_amount)).toBe(60)
                    expect(Number(saved.balance_amount)).toBe(40)
                    expect(transactions).toHaveLength(1)
                    expect(transactions[0]).toMatchObject({ id: payment.transaction.id, amount: 60, account_id: account?.id ?? null })
                    if (account) {
                        const movements = requireLiveData(await before.schema('payment_accounts').from('account_movements')
                            .select('account_id,payment_transaction_id,amount,delta_amount').eq('payment_transaction_id', payment.transaction.id), 'account movement')
                        expect(movements).toHaveLength(1)
                        expect(movements[0]).toMatchObject({ account_id: account.id, payment_transaction_id: payment.transaction.id })
                        expect(Number(movements[0].amount)).toBe(60)
                    }
                } finally { await before.auth.signOut() }
                const returned = await orders.returnSalesOrder({
                    orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: 0.5 }],
                    reason: 'customer_returned', actorRole: 'admin'
                })
                ids.returnId = returned.return.id
                recordLiveFixture(ids)
                const fresh = await freshLiveClient()
                try {
                    const saved = requireLiveData(await fresh.schema('crm').from('sales_orders')
                        .select('paid_amount,balance_amount,return_status').eq('id', order.id).single(), 'returned order')
                    const transactions = requireLiveData<Array<{ id: string; amount: number; reversal_of_transaction_id: string | null; account_id: string | null }>>(await fresh.from('payment_transactions')
                        .select('id,amount,reversal_of_transaction_id,account_id').eq('workspace_id', liveWorkspaceId)
                        .eq('source_type', 'sales_order').eq('source_record_id', order.id), 'returned payments')
                    expect(saved.return_status).toBe('partial')
                    expect(Number(saved.paid_amount)).toBe(10)
                    expect(transactions).toHaveLength(2)
                    expect(transactions.find((row) => Number(row.amount) < 0)).toMatchObject({
                        amount: -50, reversal_of_transaction_id: payment.transaction.id, account_id: account?.id ?? null
                    })
                    if (account) {
                        const movements = requireLiveData<Array<{ amount: number; delta_amount: number; payment_transaction_id: string }>>(await fresh.schema('payment_accounts').from('account_movements')
                            .select('amount,delta_amount,payment_transaction_id').eq('account_id', account.id), 'reversed account movements')
                        expect(movements).toHaveLength(2)
                        expect(movements.reduce((sum, row) => sum + Number(row.delta_amount), 0)).toBe(10)
                    }
                } finally { await fresh.auth.signOut() }
            })
        }, 120_000)
    }
})
