import { describe, expect, it } from 'vitest'
import {
    freshPosClient, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
    setupHostedPos, withLivePosFixture, livePosMethods, livePosCurrency
} from '../fixtures/posLive'

describe('POS · hosted checkout', () => {
    setupHostedPos()

    for (const method of livePosMethods) {
        it(`${method}: checkout persists POS sale, item, stock batch, payment, and one replay identity`, async () => {
            const currency = livePosCurrency
            await withLivePosFixture(async ({ ids, product, storage, batch, input }) => {
                const { commitPosCheckout } = await import('@/local-db/posCheckout')
                const { db } = await import('@/local-db/database')
                const checkout = input({ method, quantity: 2 })
                ids.saleId = checkout.payload.id
                recordPosFixture(ids)
                const result = await commitPosCheckout(checkout)
                expect(result.sequenceId).toBeGreaterThan(0)
                expect(await db.invoices.get(checkout.payload.id)).toMatchObject({
                    workspaceId: livePosWorkspaceId, origin: 'pos', totalAmount: 200
                })
                const fresh = await freshPosClient()
                try {
                    const sale = requirePosLiveData(await fresh.from('sales')
                        .select('id,workspace_id,origin,total_amount,payment_method,settlement_currency,sequence_id')
                        .eq('id', checkout.payload.id).single(), 'POS sale')
                    const lines = requirePosLiveData(await fresh.from('sale_items')
                        .select('id,quantity,product_id,storage_id').eq('sale_id', checkout.payload.id), 'POS lines')
                    const stock = requirePosLiveData(await fresh.from('inventory')
                        .select('quantity').eq('workspace_id', livePosWorkspaceId)
                        .eq('product_id', product.id).eq('storage_id', storage.id).single(), 'POS inventory')
                    const savedBatch = requirePosLiveData(await fresh.from('stock_batches')
                        .select('quantity').eq('id', batch!.id).single(), 'POS batch')
                    const payments = requirePosLiveData(await fresh.from('payment_transactions')
                        .select('id,amount,currency,payment_method,source_type,source_record_id,reversal_of_transaction_id')
                        .eq('workspace_id', livePosWorkspaceId).eq('source_type', 'pos_sale')
                        .eq('source_record_id', checkout.payload.id), 'POS payments')
                    expect(sale).toMatchObject({ id: checkout.payload.id, workspace_id: livePosWorkspaceId,
                        origin: 'pos', payment_method: method, settlement_currency: currency, sequence_id: result.sequenceId })
                    expect(Number(sale.total_amount)).toBe(200)
                    expect(lines).toHaveLength(1)
                    expect(lines[0]).toMatchObject({ product_id: product.id, storage_id: storage.id })
                    expect(Number(lines[0].quantity)).toBe(2)
                    expect(Number(stock.quantity)).toBe(18)
                    expect(Number(savedBatch.quantity)).toBe(18)
                    expect(payments).toHaveLength(1)
                    expect(payments[0]).toMatchObject({ id: checkout.payload.id, currency, payment_method: method,
                        source_type: 'pos_sale', source_record_id: checkout.payload.id, reversal_of_transaction_id: null })
                    expect(Number(payments[0].amount)).toBe(200)
                } finally { await fresh.auth.signOut() }
                expect(await commitPosCheckout(checkout)).toEqual(result)
                const replay = await freshPosClient()
                try {
                    const sales = requirePosLiveData(await replay.from('sales')
                        .select('id').eq('id', checkout.payload.id), 'replayed sale')
                    const payments = requirePosLiveData(await replay.from('payment_transactions')
                        .select('id').eq('workspace_id', livePosWorkspaceId)
                        .eq('source_record_id', checkout.payload.id), 'replayed payment')
                    const stock = requirePosLiveData(await replay.from('inventory')
                        .select('quantity').eq('product_id', product.id).eq('storage_id', storage.id).single(), 'replayed stock')
                    expect(sales).toHaveLength(1)
                    expect(payments).toHaveLength(1)
                    expect(Number(stock.quantity)).toBe(18)
                } finally { await replay.auth.signOut() }
            })
        }, 120_000)
    }

    it('selected payment account creates exactly one hosted account movement', async () => {
        await withLivePosFixture(async ({ tag, ids, input }) => {
            const { fetchTableFromSupabase } = await import('@/local-db/hooks')
            const { savePaymentAccount } = await import('@/local-db/paymentAccounts')
            const { commitPosCheckout } = await import('@/local-db/posCheckout')
            const { db } = await import('@/local-db/database')
            if (!await fetchTableFromSupabase('payment_accounts', db.payment_accounts, livePosWorkspaceId, { force: true })) {
                throw new Error('live_payment_account_hydration_failed')
            }
            const account = await savePaymentAccount(livePosWorkspaceId, {
                name: `${tag} account`, accountType: 'cash_drawer', iconKey: 'cash_drawer', openingBalances: []
            })
            ids.accountId = account.id
            const checkout = input()
            checkout.account = { id: account.id, name: account.name }
            ids.saleId = checkout.payload.id
            recordPosFixture(ids)
            await commitPosCheckout(checkout)
            const fresh = await freshPosClient()
            try {
                const payments = requirePosLiveData(await fresh.from('payment_transactions')
                    .select('id,amount,account_id').eq('source_record_id', checkout.payload.id), 'account payment')
                const movements = requirePosLiveData(await fresh.schema('payment_accounts').from('account_movements')
                    .select('account_id,payment_transaction_id,amount,delta_amount')
                    .eq('account_id', account.id), 'POS account movements')
                expect(payments).toHaveLength(1)
                expect(payments[0]).toMatchObject({ id: checkout.payload.id, account_id: account.id })
                expect(movements).toHaveLength(1)
                expect(movements[0]).toMatchObject({ account_id: account.id,
                    payment_transaction_id: payments[0].id })
                expect(Number(movements[0].delta_amount)).toBe(100)
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)
})
