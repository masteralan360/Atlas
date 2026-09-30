import { describe, expect, it } from 'vitest'
import { saleOrderInput } from '../fixtures/saleOrder'
import {
    financeLivePosInput, freshPosClient, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
    setupHostedPos, withLivePosFixture, livePosCurrency
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

    it('links a POS Quick Order initial loan repayment to its payment transaction', async () => {
        await withLivePosFixture(async ({ ids, tag, product, storage }) => {
            const partners = await import('@/local-db/businessPartners')
            const orders = await import('@/local-db/orders')
            const partner = await partners.createBusinessPartner(livePosWorkspaceId, {
                partnerName: `${tag} customer`, phone: '', defaultCurrency: livePosCurrency,
                creditLimit: 0, receivableCreditLimit: null, payableCreditLimit: null, role: 'customer'
            })
            ids.partnerId = partner.id
            recordPosFixture(ids)

            const dueDate = new Date(Date.now() + 60 * 86_400_000).toISOString()
            const completed = await orders.createQuickSalesOrder(livePosWorkspaceId, {
                ...saleOrderInput(partner.id, product, storage.id, 'loan', {
                    currency: livePosCurrency,
                    initialPayment: 25
                }),
                status: 'completed',
                customerName: partner.partnerName,
                notes: tag,
                firstDueDate: dueDate,
                nextDueDate: dueDate
            })
            ids.orderId = completed.id
            ids.loanId = completed.linkedLoanId ?? null
            recordPosFixture(ids)

            expect(completed).toMatchObject({
                status: 'completed',
                paymentMethod: 'loan',
                paymentStatus: 'partial',
                paidAmount: 25,
                balanceAmount: 75,
                linkedLoanId: expect.any(String)
            })

            const fresh = await freshPosClient()
            try {
                const order = requirePosLiveData(await fresh.schema('crm').from('sales_orders')
                    .select('id,status,total,currency,payment_method,payment_status,paid_amount,balance_amount,linked_loan_id')
                    .eq('id', completed.id).single(), 'Quick Order loan order')
                const loan = requirePosLiveData(await fresh.from('loans')
                    .select('id,order_id,source,principal_amount,total_paid_amount,balance_amount,is_deleted')
                    .eq('id', completed.linkedLoanId).single(), 'Quick Order loan')
                const repayments = requirePosLiveData(await fresh.from('loan_payments')
                    .select('id,amount,sequence_no,payment_transaction_id,integrity_version,is_deleted')
                    .eq('workspace_id', livePosWorkspaceId).eq('loan_id', completed.linkedLoanId),
                'Quick Order initial loan repayment')
                const transactions = requirePosLiveData(await fresh.from('payment_transactions')
                    .select('id,source_type,source_record_id,source_subrecord_id,direction,amount,currency,payment_method,metadata,is_deleted,void_id')
                    .eq('workspace_id', livePosWorkspaceId).eq('source_module', 'loans')
                    .eq('source_record_id', completed.linkedLoanId), 'Quick Order loan payment transaction')
                const schedule = requirePosLiveData(await fresh.from('loan_installments')
                    .select('planned_amount,paid_amount,balance_amount').eq('loan_id', completed.linkedLoanId),
                'Quick Order loan schedule')
                const inventory = requirePosLiveData(await fresh.from('inventory')
                    .select('quantity').eq('workspace_id', livePosWorkspaceId)
                    .eq('product_id', product.id).eq('storage_id', storage.id).single(), 'Quick Order loan inventory')
                const movements = requirePosLiveData(await fresh.from('inventory_transactions')
                    .select('product_id,storage_id,transaction_type,quantity_delta,previous_quantity,new_quantity')
                    .eq('workspace_id', livePosWorkspaceId).eq('reference_type', 'sales_order')
                    .eq('reference_id', completed.id), 'Quick Order loan inventory movements')

                expect(order).toMatchObject({
                    id: completed.id,
                    status: 'completed',
                    currency: livePosCurrency,
                    payment_method: 'loan',
                    payment_status: 'partial',
                    linked_loan_id: completed.linkedLoanId
                })
                expect(Number(order.total)).toBe(100)
                expect(Number(order.paid_amount)).toBe(25)
                expect(Number(order.balance_amount)).toBe(75)
                expect(loan).toMatchObject({
                    id: completed.linkedLoanId,
                    order_id: completed.id,
                    source: 'order',
                    is_deleted: false
                })
                expect(Number(loan.principal_amount)).toBe(100)
                expect(Number(loan.total_paid_amount)).toBe(25)
                expect(Number(loan.balance_amount)).toBe(75)
                expect(repayments).toHaveLength(1)
                expect(Number(repayments[0].amount)).toBe(25)
                expect(repayments[0]).toMatchObject({
                    sequence_no: 1,
                    payment_transaction_id: expect.any(String),
                    integrity_version: 1,
                    is_deleted: false
                })
                expect(transactions).toHaveLength(1)
                expect(transactions[0]).toMatchObject({
                    id: repayments[0].payment_transaction_id,
                    source_type: 'simple_loan',
                    source_record_id: completed.linkedLoanId,
                    source_subrecord_id: repayments[0].id,
                    direction: 'incoming',
                    currency: livePosCurrency,
                    payment_method: 'cash',
                    is_deleted: false,
                    void_id: null,
                    metadata: {
                        loanPaymentId: repayments[0].id,
                        isOrderLoanInitialRepayment: true
                    }
                })
                expect(Number(transactions[0].amount)).toBe(25)
                expect(schedule).toHaveLength(1)
                expect(Number(schedule[0].planned_amount)).toBe(100)
                expect(Number(schedule[0].paid_amount)).toBe(25)
                expect(Number(schedule[0].balance_amount)).toBe(75)
                expect(Number(inventory.quantity)).toBe(19)
                expect(movements).toHaveLength(1)
                expect(movements[0]).toMatchObject({
                    product_id: product.id,
                    storage_id: storage.id,
                    transaction_type: 'sale'
                })
                expect(Number(movements[0].quantity_delta)).toBe(-1)
                expect(Number(movements[0].previous_quantity)).toBe(20)
                expect(Number(movements[0].new_quantity)).toBe(19)
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)
})
