import { describe, expect, it } from 'vitest'
import {
    financeLivePosInput, freshPosClient, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
    setupHostedPos, withLivePosFixture
} from '../fixtures/posLive'

describe('POS · hosted financing', () => {
    setupHostedPos()

    for (const installments of [1, 3]) {
        it(`${installments === 1 ? 'simple' : 'installment'} loan persists one POS sale, schedule, stock, and no receipt`, async () => {
            await withLivePosFixture(async ({ ids, product, storage, input }) => {
                const { commitPosCheckout } = await import('@/local-db/posCheckout')
                const checkout = financeLivePosInput(input(), installments)
                const loanPayload = checkout.atomicLoanPayload!
                loanPayload.workspace_id = livePosWorkspaceId
                loanPayload.sale_id = checkout.payload.id
                loanPayload.created_by = checkout.user.id
                loanPayload.first_due_date = new Date(Date.now() + 30 * 86_400_000).toISOString()
                checkout.loanRegistration!.firstDueDate = loanPayload.first_due_date as string
                ids.saleId = checkout.payload.id
                ids.loanId = loanPayload.id as string
                recordPosFixture(ids)
                const result = await commitPosCheckout(checkout)
                expect(result.loanId).toBe(ids.loanId)
                const fresh = await freshPosClient()
                try {
                    const sale = requirePosLiveData(await fresh.from('sales')
                        .select('id,payment_method,total_amount').eq('id', checkout.payload.id).single(), 'financed POS sale')
                    const loan = requirePosLiveData(await fresh.from('loans')
                        .select('id,sale_id,source,principal_amount,balance_amount,total_paid_amount,loan_category,is_deleted')
                        .eq('id', ids.loanId).single(), 'POS loan')
                    const schedule = requirePosLiveData(await fresh.from('loan_installments')
                        .select('id,planned_amount,paid_amount').eq('loan_id', ids.loanId), 'POS schedule')
                    const payments = requirePosLiveData(await fresh.from('payment_transactions')
                        .select('id').eq('workspace_id', livePosWorkspaceId)
                        .eq('source_type', 'pos_sale').eq('source_record_id', checkout.payload.id), 'POS loan checkout payments')
                    const stock = requirePosLiveData(await fresh.from('inventory')
                        .select('quantity').eq('product_id', product.id).eq('storage_id', storage.id).single(), 'financed POS stock')
                    expect(sale.payment_method).toBe('loan')
                    expect(Number(sale.total_amount)).toBe(100)
                    expect(loan).toMatchObject({ id: ids.loanId, sale_id: checkout.payload.id,
                        source: 'pos', is_deleted: false,
                        loan_category: installments === 1 ? 'simple' : 'standard' })
                    expect(Number(loan.principal_amount)).toBe(100)
                    expect(Number(loan.balance_amount)).toBe(100)
                    expect(Number(loan.total_paid_amount)).toBe(0)
                    expect(schedule).toHaveLength(installments)
                    expect(schedule.reduce((sum: number, row: { planned_amount: number }) => sum + Number(row.planned_amount), 0)).toBeCloseTo(100, 3)
                    expect(payments).toHaveLength(0)
                    expect(Number(stock.quantity)).toBe(19)
                } finally { await fresh.auth.signOut() }
                expect(await commitPosCheckout(checkout)).toEqual(result)
            })
        }, 120_000)
    }
})
