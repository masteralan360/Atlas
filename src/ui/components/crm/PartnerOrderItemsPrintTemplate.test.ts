import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/utils', () => ({
    formatCurrency: (amount: number, currency: string) => `${amount} ${currency}`,
    formatDate: (value: string) => value,
    formatDateTime: (value: string) => value
}))

vi.mock('@/services/platformService', () => ({
    platformService: {
        convertFileSrc: (path: string) => path
    }
}))

import type { Loan, LoanPayment, PaymentTransaction, PurchaseOrder, SalesOrder } from '@/local-db'
import {
    buildPartnerOrderItemsPrintMoneyMovements,
    buildPartnerOrderItemsPrintOrderBlocks,
    buildPartnerOrderItemsPrintLoanPortfolio,
    buildPartnerOrderItemsPrintSettlementActivities,
    buildPartnerOrderItemsPrintSection,
    buildPartnerOrderItemsPrintTimeline,
    getPartnerOrderItemsPrintRowHierarchy
} from './PartnerOrderItemsPrintTemplate'

const createdAt = '2026-07-01T08:00:00.000Z'

function salesOrder(overrides: Partial<SalesOrder> = {}): SalesOrder {
    return {
        id: 'sales-order-0004',
        workspaceId: 'workspace-1',
        orderNumber: '0004',
        customerId: 'partner-1',
        customerName: 'Business Partner',
        items: [
            {
                id: 'item-1',
                productId: 'product-1',
                productName: 'Product 1',
                productSku: 'PRODUCT-1',
                note: 'First item note',
                unit: 'pcs',
                quantity: 2,
                lineTotal: 10,
                originalCurrency: 'usd',
                originalUnitPrice: 5,
                convertedUnitPrice: 5,
                settlementCurrency: 'usd',
                costPrice: 3,
                convertedCostPrice: 3
            },
            {
                id: 'item-2',
                productId: 'product-2',
                productName: 'Product 2',
                productSku: 'PRODUCT-2',
                unit: 'pcs',
                quantity: 2,
                lineTotal: 10,
                originalCurrency: 'usd',
                originalUnitPrice: 5,
                convertedUnitPrice: 5,
                settlementCurrency: 'usd',
                costPrice: 3,
                convertedCostPrice: 3
            }
        ],
        subtotal: 20,
        discount: 3,
        tax: 2,
        total: 25,
        currency: 'usd',
        orderAdjustments: [
            {
                id: 'delivery',
                type: 'addition',
                name: 'Delivery',
                currency: 'usd',
                amount: 7,
                orderCurrency: 'usd',
                convertedAmount: 7,
                exchangeRate: 1,
                exchangeRateSource: 'native',
                exchangeRateTimestamp: createdAt,
                exchangeRates: []
            },
            {
                id: 'credit',
                type: 'deduction',
                name: 'Customer credit',
                currency: 'usd',
                amount: 1,
                orderCurrency: 'usd',
                convertedAmount: 1,
                exchangeRate: 1,
                exchangeRateSource: 'native',
                exchangeRateTimestamp: createdAt,
                exchangeRates: []
            }
        ],
        exchangeRate: null,
        exchangeRateSource: null,
        exchangeRateTimestamp: null,
        status: 'completed',
        isPaid: false,
        paymentStatus: 'partial',
        paidAmount: 5,
        balanceAmount: 20,
        initialPaymentAmount: 0,
        isInstallmentBased: false,
        installmentCount: 0,
        notes: 'Order-level note',
        createdAt,
        updatedAt: createdAt,
        syncStatus: 'synced',
        lastSyncedAt: null,
        version: 1,
        isDeleted: false,
        isArchived: false,
        ...overrides
    }
}

function purchaseOrder(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
    return {
        id: 'purchase-order-0005',
        workspaceId: 'workspace-1',
        orderNumber: '0005',
        supplierId: 'partner-1',
        supplierName: 'Business Partner',
        items: [{
            id: 'purchase-item-1',
            productId: 'product-3',
            productName: 'Product 3',
            productSku: 'PRODUCT-3',
            unit: 'box',
            quantity: 1,
            lineTotal: 11,
            originalCurrency: 'usd',
            originalUnitPrice: 11,
            convertedUnitPrice: 11,
            settlementCurrency: 'usd'
        }],
        subtotal: 11,
        discount: 0,
        total: 11,
        currency: 'usd',
        exchangeRate: null,
        exchangeRateSource: null,
        exchangeRateTimestamp: null,
        status: 'received',
        isPaid: true,
        paymentStatus: 'paid',
        paidAmount: 11,
        balanceAmount: 0,
        initialPaymentAmount: 0,
        isInstallmentBased: false,
        installmentCount: 0,
        createdAt,
        updatedAt: createdAt,
        syncStatus: 'synced',
        lastSyncedAt: null,
        version: 1,
        isDeleted: false,
        isArchived: false,
        ...overrides
    }
}

function loan(overrides: Partial<Loan> = {}): Loan {
    return {
        id: 'loan-1',
        workspaceId: 'workspace-1',
        loanNo: 'LN-001',
        source: 'manual',
        loanCategory: 'simple',
        direction: 'lent',
        linkedPartyType: 'business_partner',
        linkedPartyId: 'partner-1',
        borrowerName: 'Business Partner',
        borrowerPhone: '',
        borrowerAddress: '',
        borrowerNationalId: '',
        principalAmount: 500,
        totalPaidAmount: 100,
        balanceAmount: 400,
        settlementCurrency: 'usd',
        exchangeRateSnapshot: null,
        installmentCount: 5,
        installmentFrequency: 'monthly',
        firstDueDate: null,
        status: 'active',
        createdAt,
        updatedAt: createdAt,
        syncStatus: 'synced',
        lastSyncedAt: null,
        version: 1,
        isDeleted: false,
        ...overrides
    }
}

function loanPayment(overrides: Partial<LoanPayment> = {}): LoanPayment {
    return {
        id: 'loan-payment-1',
        loanId: 'loan-1',
        workspaceId: 'workspace-1',
        amount: 100,
        paymentMethod: 'cash',
        paidAt: '2026-07-03T10:00:00.000Z',
        note: 'Second installment',
        createdAt: '2026-07-03T10:00:00.000Z',
        updatedAt: '2026-07-03T10:00:00.000Z',
        syncStatus: 'synced',
        lastSyncedAt: null,
        version: 1,
        isDeleted: false,
        ...overrides
    }
}

function directTransaction(overrides: Partial<PaymentTransaction> = {}): PaymentTransaction {
    return {
        id: 'direct-tx-1',
        workspaceId: 'workspace-1',
        sourceModule: 'payments',
        sourceType: 'direct_transaction',
        sourceRecordId: 'direct-tx-1',
        sourceSubrecordId: 'partner-1',
        direction: 'incoming',
        amount: 50,
        currency: 'usd',
        paymentMethod: 'cash',
        paidAt: '2026-07-02T10:00:00.000Z',
        referenceLabel: 'Cash received',
        note: null,
        createdAt: '2026-07-02T10:00:00.000Z',
        updatedAt: '2026-07-02T10:00:00.000Z',
        syncStatus: 'synced',
        lastSyncedAt: null,
        version: 1,
        isDeleted: false,
        metadata: { reason: 'Cash received', businessPartnerId: 'partner-1' },
        ...overrides
    }
}

describe('buildPartnerOrderItemsPrintSection', () => {
    it('keeps every sales item and commercial row tied to its repeated order code', () => {
        const section = buildPartnerOrderItemsPrintSection([salesOrder()], 'sales')

        expect(section.rows.map((row) => row.orderCode)).toEqual([
            '0004', '0004', '0004', '0004', '0004', '0004', '0004', '0004'
        ])
        expect(section.rows.map((row) => row.kind)).toEqual([
            'item', 'item', 'discount', 'tax', 'adjustment', 'adjustment', 'order_note', 'order_total'
        ])
        expect(section.rows.find((row) => row.kind === 'item')?.note).toBe('First item note')
        expect(section.rows.find((row) => row.kind === 'order_note')?.note).toBe('Order-level note')
        expect(section.rows.filter((row) => row.kind === 'adjustment').map((row) => row.amount)).toEqual([7, -1])
        expect(section.rows.find((row) => row.kind === 'discount')?.amount).toBe(-3)
        expect(section.rows.find((row) => row.kind === 'tax')?.amount).toBe(2)
        expect(section.rows.find((row) => row.kind === 'order_total')).toMatchObject({
            amount: 25,
            paidAmount: 5,
            remainingAmount: 20
        })
        expect(section.rows.map((_, index) => getPartnerOrderItemsPrintRowHierarchy(section.rows, index))).toEqual([
            'first', 'middle', 'middle', 'middle', 'middle', 'middle', 'middle', 'last'
        ])
        expect(section.summaries).toEqual([{
            currency: 'usd',
            orderCount: 1,
            itemSubtotal: 20,
            discount: 3,
            tax: 2,
            additions: 7,
            deductions: 1,
            total: 25,
            paidAmount: 5,
            remainingAmount: 20
        }])
    })

    it('excludes cancelled orders from rows and summaries entirely, and does not create a tax row for purchase orders', () => {
        const section = buildPartnerOrderItemsPrintSection([
            purchaseOrder(),
            salesOrder({
                id: 'cancelled',
                orderNumber: '0006',
                status: 'cancelled',
                items: [{
                    id: 'item-1',
                    productId: 'product-1',
                    productName: 'Product 1',
                    productSku: 'PRODUCT-1',
                    note: null,
                    unit: 'pcs',
                    quantity: 2,
                    lineTotal: 10,
                    originalCurrency: 'usd',
                    originalUnitPrice: 5,
                    convertedUnitPrice: 5,
                    settlementCurrency: 'usd',
                    costPrice: 3,
                    convertedCostPrice: 3
                }],
                discount: 0,
                tax: 0,
                orderAdjustments: [],
                notes: undefined
            })
        ], 'purchase')

        expect(section.rows.map((row) => row.orderCode)).toEqual(['0005', '0005'])
        expect(section.rows.some((row) => row.kind === 'tax')).toBe(false)
        expect(section.summaries).toEqual([{
            currency: 'usd',
            orderCount: 1,
            itemSubtotal: 11,
            discount: 0,
            tax: 0,
            additions: 0,
            deductions: 0,
            total: 11,
            paidAmount: 11,
            remainingAmount: 0
        }])
        expect(section.rows.map((_, index) => getPartnerOrderItemsPrintRowHierarchy(section.rows, index))).toEqual([
            'first', 'last'
        ])
    })

    it('flags every row of a returned sales order, whether partially or fully returned', () => {
        const section = buildPartnerOrderItemsPrintSection([
            salesOrder({ id: 'partially-returned', orderNumber: '0007', returnStatus: 'partial', returnedAt: createdAt }),
            salesOrder({ id: 'fully-returned', orderNumber: '0008', returnStatus: 'full', returnedAt: createdAt }),
            salesOrder({ id: 'intact', orderNumber: '0009', returnStatus: 'none' })
        ], 'sales')

        expect(section.rows.filter((row) => row.orderId === 'partially-returned').every((row) => row.isReturned)).toBe(true)
        expect(section.rows.filter((row) => row.orderId === 'fully-returned').every((row) => row.isReturned)).toBe(true)
        expect(section.rows.filter((row) => row.orderId === 'intact').every((row) => row.isReturned)).toBe(false)
    })

    it('never flags purchase-order rows as returned', () => {
        const section = buildPartnerOrderItemsPrintSection([purchaseOrder()], 'purchase')

        expect(section.rows.every((row) => !row.isReturned)).toBe(true)
    })

    it('flags rows of partially paid orders in both sections', () => {
        const sales = buildPartnerOrderItemsPrintSection([
            salesOrder({ id: 'partial', orderNumber: '0010', paymentStatus: 'partial' }),
            salesOrder({ id: 'paid', orderNumber: '0011', paymentStatus: 'paid' }),
            salesOrder({ id: 'unpaid', orderNumber: '0012', paymentStatus: 'unpaid' })
        ], 'sales')

        expect(sales.rows.filter((row) => row.orderId === 'partial').every((row) => row.isPartialPaid)).toBe(true)
        expect(sales.rows.filter((row) => row.orderId === 'paid').every((row) => row.isPartialPaid)).toBe(false)
        expect(sales.rows.filter((row) => row.orderId === 'unpaid').every((row) => row.isPartialPaid)).toBe(false)

        const purchase = buildPartnerOrderItemsPrintSection([
            purchaseOrder({ id: 'partial-purchase', orderNumber: '0013', paymentStatus: 'partial' }),
            purchaseOrder({ id: 'paid-purchase', orderNumber: '0014', paymentStatus: 'paid' })
        ], 'purchase')

        expect(purchase.rows.filter((row) => row.orderId === 'partial-purchase').every((row) => row.isPartialPaid)).toBe(true)
        expect(purchase.rows.filter((row) => row.orderId === 'paid-purchase').every((row) => row.isPartialPaid)).toBe(false)
    })

    it('flags rows of unpaid orders', () => {
        const sales = buildPartnerOrderItemsPrintSection([
            salesOrder({ id: 'unpaid', orderNumber: '0015', paymentStatus: 'unpaid' }),
            salesOrder({ id: 'partial', orderNumber: '0016', paymentStatus: 'partial' })
        ], 'sales')

        expect(sales.rows.filter((row) => row.orderId === 'unpaid').every((row) => row.isUnpaid)).toBe(true)
        expect(sales.rows.filter((row) => row.orderId === 'partial').every((row) => row.isUnpaid)).toBe(false)
    })
})

describe('buildPartnerOrderItemsPrintOrderBlocks', () => {
    it('groups each order into one atomic block with all of its rows', () => {
        const section = buildPartnerOrderItemsPrintSection([
            salesOrder({ id: 'first', orderNumber: '0020' }),
            salesOrder({ id: 'second', orderNumber: '0021' })
        ], 'sales')

        const blocks = buildPartnerOrderItemsPrintOrderBlocks(section.rows)

        expect(blocks).toHaveLength(2)
        expect(blocks[0]).toMatchObject({ orderId: 'first', orderCode: '0020', isPartialPaid: true })
        expect(blocks[0].rows.map((row) => row.kind)).toEqual([
            'item', 'item', 'discount', 'tax', 'adjustment', 'adjustment', 'order_note', 'order_total'
        ])
        expect(blocks[0].rows.every((row) => row.orderId === 'first')).toBe(true)
        expect(blocks[1]).toMatchObject({ orderId: 'second', orderCode: '0021' })
        expect(blocks[1].rows[blocks[1].rows.length - 1].kind).toBe('order_total')
    })

    it('returns one block per order even when orders share a display code', () => {
        const section = buildPartnerOrderItemsPrintSection([
            salesOrder({ id: 'order-a', orderNumber: '0099' }),
            salesOrder({ id: 'order-b', orderNumber: '0099' })
        ], 'sales')

        const blocks = buildPartnerOrderItemsPrintOrderBlocks(section.rows)

        expect(blocks).toHaveLength(2)
        expect(blocks[0].orderId).toBe('order-a')
        expect(blocks[1].orderId).toBe('order-b')
    })

    it('returns an empty list for an empty section', () => {
        expect(buildPartnerOrderItemsPrintOrderBlocks([])).toEqual([])
    })
})

describe('buildPartnerOrderItemsPrintMoneyMovements', () => {
    it('maps loan repayments with loan reference, date, direction and currency', () => {
        const rows = buildPartnerOrderItemsPrintMoneyMovements(
            [loan()],
            [loanPayment()],
            []
        )

        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            kind: 'loan_repayment',
            orderId: 'loan-payment:loan-payment-1',
            orderCode: 'LN-001',
            orderDate: '2026-07-03T10:00:00.000Z',
            amount: 100,
            currency: 'usd',
            direction: 'incoming',
            paymentMethod: 'cash',
            note: 'Second installment'
        })
    })

    it('flags repayments on borrowed loans as outgoing', () => {
        const rows = buildPartnerOrderItemsPrintMoneyMovements(
            [loan({ direction: 'borrowed' })],
            [loanPayment()],
            []
        )

        expect(rows[0].direction).toBe('outgoing')
    })

    it('maps direct transactions with their reference and direction', () => {
        const rows = buildPartnerOrderItemsPrintMoneyMovements(
            [],
            [],
            [
                directTransaction(),
                directTransaction({
                    id: 'direct-tx-2',
                    direction: 'outgoing',
                    amount: 25,
                    paidAt: '2026-07-04T10:00:00.000Z',
                    referenceLabel: 'Paid out'
                })
            ]
        )

        expect(rows).toHaveLength(2)
        expect(rows[0]).toMatchObject({
            kind: 'direct_transaction',
            orderCode: 'Cash received',
            direction: 'incoming',
            amount: 50,
            currency: 'usd'
        })
        expect(rows[1]).toMatchObject({ orderCode: 'Paid out', direction: 'outgoing', amount: 25 })
    })

    it('skips payments without their loan, deleted payments and reversed transactions', () => {
        const rows = buildPartnerOrderItemsPrintMoneyMovements(
            [loan()],
            [
                loanPayment({ id: 'orphan', loanId: 'missing-loan' }),
                loanPayment({ id: 'deleted', isDeleted: true })
            ],
            [directTransaction({ id: 'reversed', reversalOfTransactionId: 'original-1' })]
        )

        expect(rows).toEqual([])
    })

    it('sorts movements chronologically', () => {
        const rows = buildPartnerOrderItemsPrintMoneyMovements(
            [loan()],
            [
                loanPayment({ id: 'p1', paidAt: '2026-07-05T10:00:00.000Z' }),
                loanPayment({ id: 'p2', paidAt: '2026-07-01T10:00:00.000Z' })
            ],
            [directTransaction({ id: 'd1', paidAt: '2026-07-03T10:00:00.000Z' })]
        )

        expect(rows.map((row) => row.id)).toEqual([
            'loan-payment:p2',
            'direct-transaction:d1',
            'loan-payment:p1'
        ])
    })
})

describe('buildPartnerOrderItemsPrintTimeline', () => {
    it('interleaves orders, loan repayments and direct transactions by date', () => {
        const timeline = buildPartnerOrderItemsPrintTimeline(
            [salesOrder({ id: 's1', orderNumber: 'S1', createdAt: '2026-07-01T08:00:00.000Z' })],
            [purchaseOrder({ id: 'p1', orderNumber: 'P1', createdAt: '2026-07-04T08:00:00.000Z' })],
            [loan()],
            [loanPayment({ id: 'lp1', paidAt: '2026-07-02T10:00:00.000Z' })],
            [directTransaction({ id: 'dt1', paidAt: '2026-07-03T10:00:00.000Z' })]
        )

        expect(timeline.rows.map((row) => row.orderId)).toEqual([
            's1', 's1', 's1', 's1', 's1', 's1', 's1', 's1',
            'loan-payment:lp1',
            'direct-transaction:dt1',
            'p1', 'p1'
        ])
        expect(timeline.rows.map((row) => row.kind).slice(8, 10)).toEqual(['loan_repayment', 'direct_transaction'])
        expect(timeline.rows.find((row) => row.orderId === 's1')?.sectionKind).toBe('sales')
        expect(timeline.rows.find((row) => row.orderId === 'p1')?.sectionKind).toBe('purchase')
    })

    it('keeps per-type summaries separate for the end of the document', () => {
        const timeline = buildPartnerOrderItemsPrintTimeline(
            [salesOrder({ id: 's1', orderNumber: 'S1' })],
            [purchaseOrder({ id: 'p1', orderNumber: 'P1' })],
            [loan()],
            [loanPayment()],
            [directTransaction()]
        )

        expect(timeline.salesSummary[0]).toMatchObject({ currency: 'usd', orderCount: 1, total: 25 })
        expect(timeline.purchaseSummary[0]).toMatchObject({ currency: 'usd', orderCount: 1, total: 11 })
        expect(timeline.loanRepaymentSummary).toEqual([{ currency: 'usd', count: 1, received: 100, paid: 0 }])
        expect(timeline.directTransactionSummary).toEqual([{ currency: 'usd', count: 1, received: 50, paid: 0 }])
    })

    it('sums received and paid separately per currency', () => {
        const timeline = buildPartnerOrderItemsPrintTimeline(
            [],
            [],
            [loan(), loan({ id: 'loan-2', loanNo: 'LN-002', direction: 'borrowed' })],
            [
                loanPayment({ id: 'incoming-payment', amount: 100, paidAt: '2026-07-02T10:00:00.000Z' }),
                loanPayment({ id: 'outgoing-payment', loanId: 'loan-2', amount: 40, paidAt: '2026-07-03T10:00:00.000Z' })
            ],
            []
        )

        expect(timeline.loanRepaymentSummary).toEqual([{ currency: 'usd', count: 2, received: 100, paid: 40 }])
        expect(timeline.directTransactionSummary).toEqual([])
    })

    it('returns an empty timeline when there is no activity at all', () => {
        const timeline = buildPartnerOrderItemsPrintTimeline([], [], [], [], [])

        expect(timeline.rows).toEqual([])
        expect(timeline.salesSummary).toEqual([])
        expect(timeline.purchaseSummary).toEqual([])
        expect(timeline.loanRepaymentSummary).toEqual([])
        expect(timeline.directTransactionSummary).toEqual([])
    })
})

describe('buildPartnerOrderItemsPrintLoanPortfolio', () => {
    it('carries a June loan into July with its opening balance and July repayment', () => {
        const rows = buildPartnerOrderItemsPrintLoanPortfolio(
            [loan({
                id: 'june-loan',
                loanNo: 'LN-JUNE',
                createdAt: '2026-06-15T08:00:00.000Z',
                principalAmount: 75,
                balanceAmount: 58,
                totalPaidAmount: 17
            })],
            [
                loanPayment({ id: 'july-payment', loanId: 'june-loan', amount: 12, paidAt: '2026-07-12T10:00:00.000Z' }),
                loanPayment({ id: 'august-payment', loanId: 'june-loan', amount: 5, paidAt: '2026-08-05T10:00:00.000Z' })
            ],
            { type: 'custom', start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z' }
        )

        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            currency: 'usd',
            direction: 'lent',
            periodActivity: ['partially_repaid'],
            openingBalance: 75,
            repayments: 12,
            closingBalance: 63
        })
    })

    it('labels new, carried-forward, partial, and fully repaid loan activity', () => {
        const rows = buildPartnerOrderItemsPrintLoanPortfolio(
            [
                loan({ id: 'new-loan', loanNo: 'LN-NEW', createdAt: '2026-07-03T08:00:00.000Z', balanceAmount: 100 }),
                loan({ id: 'opening-loan', loanNo: 'LN-OPENING', createdAt: '2026-06-03T08:00:00.000Z', balanceAmount: 100 }),
                loan({ id: 'partial-loan', loanNo: 'LN-PARTIAL', createdAt: '2026-06-04T08:00:00.000Z', balanceAmount: 80 }),
                loan({ id: 'settled-loan', loanNo: 'LN-SETTLED', createdAt: '2026-06-05T08:00:00.000Z', balanceAmount: 0 })
            ],
            [
                loanPayment({ id: 'partial-payment', loanId: 'partial-loan', amount: 20, paidAt: '2026-07-10T10:00:00.000Z' }),
                loanPayment({ id: 'settled-payment', loanId: 'settled-loan', amount: 100, paidAt: '2026-07-11T10:00:00.000Z' })
            ],
            { type: 'custom', start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z' }
        )

        expect(Object.fromEntries(rows.map((row) => [row.loan.loanNo, row.periodActivity]))).toEqual({
            'LN-NEW': ['new_loan'],
            'LN-OPENING': ['opening_balance'],
            'LN-PARTIAL': ['partially_repaid'],
            'LN-SETTLED': ['fully_repaid']
        })
    })
})

describe('buildPartnerOrderItemsPrintSettlementActivities', () => {
    it('shows normal order payments alongside carried-forward loans and their repayments', () => {
        const order = salesOrder({ balanceAmount: 0, paidAmount: 25, paymentStatus: 'paid', isPaid: true })
        const rows = buildPartnerOrderItemsPrintSettlementActivities(
            [order],
            [loan({
                id: 'june-loan',
                loanNo: 'LN-JUNE',
                source: 'order',
                orderId: order.id,
                orderType: 'sales',
                createdAt: '2026-06-15T08:00:00.000Z',
                principalAmount: 50,
                balanceAmount: 30
            })],
            [loanPayment({ id: 'july-loan-payment', loanId: 'june-loan', amount: 20, paidAt: '2026-07-08T10:00:00.000Z' })],
            [
                directTransaction({
                    id: 'order-payment-1',
                    sourceModule: 'orders',
                    sourceType: 'sales_order',
                    sourceRecordId: order.id,
                    amount: 10,
                    paidAt: '2026-07-02T10:00:00.000Z'
                }),
                directTransaction({
                    id: 'order-payment-2',
                    sourceModule: 'orders',
                    sourceType: 'sales_order',
                    sourceRecordId: order.id,
                    amount: 15,
                    paidAt: '2026-07-04T10:00:00.000Z'
                })
            ],
            { type: 'custom', start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z' },
            { [order.id]: 'SO-2026-00004' }
        )

        expect(rows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'order-payment:order-payment-1',
                kind: 'order_payment',
                reference: '0004',
                amount: 10,
                balanceAfter: 15
            }),
            expect.objectContaining({
                id: 'order-payment:order-payment-2',
                kind: 'order_payment',
                reference: '0004',
                amount: 15,
                balanceAfter: 0
            }),
            expect.objectContaining({
                kind: 'opening_loan_balance',
                reference: 'SO-2026-00004 · LN-JUNE',
                balanceAfter: 50
            }),
            expect.objectContaining({
                id: 'loan-payment:july-loan-payment',
                kind: 'loan_repayment',
                balanceAfter: 30
            })
        ]))
    })

    it('excludes cancelled orders and fully reversed payment transactions', () => {
        const cancelledOrder = salesOrder({ id: 'cancelled-order', orderNumber: '0005', status: 'cancelled', balanceAmount: 10 })
        const reversedOrder = salesOrder({ id: 'reversed-order', orderNumber: '0006', balanceAmount: 0, paidAmount: 10, isPaid: true, paymentStatus: 'paid' })
        const rows = buildPartnerOrderItemsPrintSettlementActivities(
            [cancelledOrder, reversedOrder],
            [],
            [],
            [
                directTransaction({
                    id: 'cancelled-order-payment',
                    sourceModule: 'orders',
                    sourceType: 'sales_order',
                    sourceRecordId: cancelledOrder.id,
                    amount: 10
                }),
                directTransaction({
                    id: 'reversed-order-payment',
                    sourceModule: 'orders',
                    sourceType: 'sales_order',
                    sourceRecordId: reversedOrder.id,
                    amount: 10
                }),
                directTransaction({
                    id: 'reversal',
                    sourceModule: 'orders',
                    sourceType: 'sales_order',
                    sourceRecordId: reversedOrder.id,
                    direction: 'outgoing',
                    amount: 10,
                    reversalOfTransactionId: 'reversed-order-payment'
                })
            ],
            { type: 'allTime' }
        )

        expect(rows).toEqual([])
    })
})
