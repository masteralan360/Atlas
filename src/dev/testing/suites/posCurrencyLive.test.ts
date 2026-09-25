import { describe, expect, it } from 'vitest'
import {
    freshPosClient, livePosConversionEnabled, livePosCurrency, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
    setupHostedPos, withLivePosFixture
} from '../fixtures/posLive'

describe('POS · hosted currency', () => {
    setupHostedPos()

    it('reads the actual POS currency-conversion policy from the test workspace', async () => {
        const { loadPosCurrencyConversionPolicy } = await import('@/local-db/posCheckout')
        const fresh = await freshPosClient()
        try {
            const workspace = requirePosLiveData(await fresh.from('workspaces')
                .select('pos_convert_to_workspace_currency').eq('id', livePosWorkspaceId).single(), 'POS currency policy')
            expect(await loadPosCurrencyConversionPolicy(livePosWorkspaceId))
                .toBe(workspace.pos_convert_to_workspace_currency !== false)
        } finally { await fresh.auth.signOut() }
    })

    for (const currency of ['eur', 'try'] as const) {
        it(`${currency}: honors the hosted workspace conversion policy without fabricated exchange rows`, async () => {
            await withLivePosFixture(async ({ ids, input }) => {
                const { commitPosCheckout } = await import('@/local-db/posCheckout')
                const checkout = input()
                ids.saleId = checkout.payload.id
                recordPosFixture(ids)
                const mustReject = livePosConversionEnabled && currency !== livePosCurrency
                if (mustReject) await expect(commitPosCheckout(checkout)).rejects.toThrow()
                else await commitPosCheckout(checkout)
                const fresh = await freshPosClient()
                try {
                    const sales = requirePosLiveData(await fresh.from('sales')
                        .select('settlement_currency,currency_conversion_applied')
                        .eq('id', checkout.payload.id), 'currency sales')
                    const payments = requirePosLiveData(await fresh.from('payment_transactions')
                        .select('currency,amount').eq('source_record_id', checkout.payload.id), 'currency payments')
                    const exchange = requirePosLiveData(await fresh.from('sales_exchange')
                        .select('id').eq('sale_id', checkout.payload.id), 'currency exchange rows')
                    if (mustReject) {
                        expect(sales).toHaveLength(0)
                        expect(payments).toHaveLength(0)
                    } else {
                        expect(sales).toHaveLength(1)
                        expect(sales[0]).toMatchObject({ settlement_currency: currency, currency_conversion_applied: false })
                        expect(payments).toHaveLength(1)
                        expect(payments[0].currency).toBe(currency)
                        expect(Number(payments[0].amount)).toBe(100)
                    }
                    expect(exchange).toHaveLength(0)
                } finally { await fresh.auth.signOut() }
            }, { currency })
        }, 120_000)
    }
})
