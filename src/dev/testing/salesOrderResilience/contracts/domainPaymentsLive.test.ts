import { describe, expect, it, vi } from 'vitest'
import { db } from '@/local-db/database'
import { liveSupabase } from '../../liveSupabase'
import { initialPaymentRegression } from '../scenarios/regressionScenarios'
import { authenticateActor } from '../fixtures/testActor'
import { saleOrderInput } from '../../fixtures/orderInput'
import {
    freshLiveClient, liveWorkspaceId, recordLiveFixture, requireLiveData,
    setupHostedOrderFixture, withLiveSaleOrderFixture
} from '../../fixtures/orderLive'

describe('Sale Orders · hosted payments', () => {
    setupHostedOrderFixture()

    for (const selectedAccount of [false, true]) {
        it(`${initialPaymentRegression.id} ${selectedAccount ? 'selected account' : 'no account'}: initial paid save is atomic and replays a lost response`, async () => {
            await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
                const orders = await import('@/local-db/orders')
                const accounts = await import('@/local-db/paymentAccounts')
                if (selectedAccount) {
                    const { fetchTableFromSupabase } = await import('@/local-db/hooks')
                    if (!await fetchTableFromSupabase('payment_accounts', db.payment_accounts, liveWorkspaceId, { force: true })) {
                        throw new Error('live_payment_account_hydration_failed')
                    }
                }
                const account = selectedAccount ? await accounts.savePaymentAccount(liveWorkspaceId, {
                    name: `${tag} initial account`, accountType: 'cash_drawer', iconKey: 'cash_drawer', openingBalances: []
                }) : null
                const orderId = crypto.randomUUID(), paymentId = crypto.randomUUID()
                Object.assign(ids, { orderId, paymentId, ...(account ? { accountId: account.id } : {}) })
                recordLiveFixture(ids)
                const input = { ...saleOrderInput(partner.id, product, storage.id, 'cash'),
                    isPaid: true, customerName: partner.partnerName, notes: tag,
                    initialPaymentAccountId: account?.id ?? null, initialPaymentAccountNameSnapshot: account?.name ?? null }
                const options = { orderId, initialPaymentTransactionId: paymentId, requireRemoteConfirmation: true }
                const originalRpc = liveSupabase.rpc.bind(liveSupabase)
                let committed = false
                const fault = vi.spyOn(liveSupabase, 'rpc').mockImplementation(((name: string, args: any) => {
                    if (name !== 'create_sales_order_with_initial_payment' || committed) return originalRpc(name, args)
                    return Promise.resolve(originalRpc(name, args)).then(result => {
                        if (result.error) return result
                        committed = true
                        return { data: null, error: new Error('Committed initial order response was lost') }
                    })
                }) as typeof liveSupabase.rpc)
                try {
                    await expect(orders.createSalesOrder(liveWorkspaceId, input, undefined, options))
                        .rejects.toThrow('remote_order_save_confirmation_failed')
                    expect(committed).toBe(true)
                    expect(await db.sales_orders.get(orderId)).toBeUndefined()
                    expect(await db.payment_transactions.get(paymentId)).toBeUndefined()
                } finally { fault.mockRestore() }
                const saved = await orders.createSalesOrder(liveWorkspaceId, input, undefined, options)
                const replay = await orders.createSalesOrder(liveWorkspaceId, input, undefined, options)
                expect(replay.id).toBe(saved.id)
                const fresh = await freshLiveClient()
                try {
                    const remote = requireLiveData(await fresh.schema('crm').from('sales_orders')
                        .select('*').eq('id', orderId).single(), 'initial paid order')
                    const payments = requireLiveData<Array<Record<string, any>>>(await fresh.from('payment_transactions')
                        .select('*').eq('workspace_id', liveWorkspaceId).eq('source_type', 'sales_order')
                        .eq('source_record_id', orderId), 'initial paid ledger')
                    expect(remote).toMatchObject({ status: 'draft', paid_amount: 100, balance_amount: 0, is_paid: true })
                    expect(payments).toHaveLength(1)
                    expect(payments[0]).toMatchObject({ id: paymentId, amount: 100, account_id: account?.id ?? null,
                        reference_label: remote.order_number })
                    const stock = requireLiveData(await fresh.from('inventory').select('quantity')
                        .eq('product_id', product.id).eq('storage_id', storage.id).single(), 'draft stock')
                    expect(Number(stock.quantity)).toBe(10)
                    const movements = requireLiveData<Array<Record<string, any>>>(await fresh.schema('payment_accounts')
                        .from('account_movements').select('*').eq('payment_transaction_id', paymentId), 'initial account ledger')
                    expect(movements).toHaveLength(selectedAccount ? 1 : 0)
                    if (account) {
                        expect(Number(movements[0].delta_amount)).toBe(100)
                        const balances = requireLiveData<Array<{ balance_amount: number }>>(await fresh.schema('payment_accounts')
                            .from('account_balances').select('balance_amount').eq('account_id', account.id).eq('currency', 'usd'), 'initial account balance')
                        expect(balances).toHaveLength(1)
                        expect(Number(balances[0].balance_amount)).toBe(100)
                    }
                    // A different payment intent cannot reuse an initial receipt.
                    const conflict = await fresh.rpc('create_sales_order_with_initial_payment', {
                        p_order: { ...remote, total: 90, paid_amount: 90 },
                        p_transaction: { ...payments[0], amount: 90 }
                    })
                    expect(conflict.error?.code).toBe('23514')
                    expect(requireLiveData(await fresh.from('payment_transactions').select('amount')
                        .eq('id', paymentId).single(), 'unchanged receipt').amount).toBe(100)
                    // Account rejection occurs after inserting the parent inside
                    // the transaction, and must leave neither record behind.
                    const rejectedOrderId = crypto.randomUUID(), rejectedPaymentId = crypto.randomUUID(), missingAccountId = crypto.randomUUID()
                    const rejected = await fresh.rpc('create_sales_order_with_initial_payment', {
                        p_order: { ...remote, id: rejectedOrderId, initial_payment_account_id: missingAccountId },
                        p_transaction: { ...payments[0], id: rejectedPaymentId, source_record_id: rejectedOrderId, account_id: missingAccountId }
                    })
                    expect(rejected.error).not.toBeNull()
                    expect(requireLiveData(await fresh.schema('crm').from('sales_orders').select('id')
                        .eq('id', rejectedOrderId), 'rolled back order')).toEqual([])
                    expect(requireLiveData(await fresh.from('payment_transactions').select('id')
                        .eq('id', rejectedPaymentId), 'rolled back payment')).toEqual([])
                    expect(requireLiveData(await fresh.schema('payment_accounts').from('account_movements').select('id')
                        .eq('payment_transaction_id', rejectedPaymentId), 'rolled back account movement')).toEqual([])
                    for (const actorName of ['foreign.admin', 'enterprise.viewer', 'enterprise.denied', 'revoke.admin']) {
                        const actor = await authenticateActor(actorName)
                        try {
                            const denied = await actor.client.rpc('create_sales_order_with_initial_payment', {
                                p_order: { ...remote, id: crypto.randomUUID(),
                                    workspace_id: actorName === 'foreign.admin' ? liveWorkspaceId : actor.workspaceId },
                                p_transaction: payments[0]
                            })
                            expect(denied.error?.code).toBe('42501')
                        } finally { await actor.client.auth.signOut({ scope: 'local' }) }
                    }
                } finally { await fresh.auth.signOut() }
            })
        }, 120_000)
    }

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
