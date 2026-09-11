import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/utils', () => ({
    cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
    formatCurrency: (amount: number, currency: string) => `${amount} ${currency}`,
    formatDate: (value: string) => value,
    formatDateTime: (value: string) => value
}))

vi.mock('@/services/platformService', () => ({
    platformService: { convertFileSrc: (path: string) => path }
}))

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        i18n: {
            getFixedT: () => (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key
        }
    })
}))

import type { PartnerOrderItemsPrintData } from './PartnerOrderItemsPrintTemplate'
import {
    buildPartnerAccountStatementLedger,
    getPartnerAccountStatementClosingBalances,
    type PartnerAccountStatementData
} from '@/lib/partnerAccountStatement'
import {
    getPartnerAccountStatementEntryDescription,
    getPartnerAccountStatementEntryDetail
} from '@/lib/partnerAccountStatementPresentation'
import { PartnerAccountStatementPrintTemplate } from './PartnerAccountStatementPrintTemplate'

function statementData(): PartnerOrderItemsPrintData & PartnerAccountStatementData {
    return {
        partner: { partnerName: 'Sample Partner' },
        period: { type: 'custom', start: '2026-01-01', end: '2026-01-31' },
        generatedAt: '2026-02-01T10:00:00.000Z',
        balanceSummary: { receivable: [], payable: [] },
        salesOrders: [],
        purchaseOrders: [],
        statementOrders: [
            {
                id: 'sales-before-period',
                orderNumber: 'SO-0001',
                customerId: 'partner-1',
                total: 100,
                currency: 'usd',
                status: 'completed',
                createdAt: '2025-12-15T10:00:00.000Z',
                isDeleted: false,
                linkedLoanId: null
            },
            {
                id: 'sales-in-period',
                orderNumber: 'SO-0002',
                customerId: 'partner-1',
                total: 50,
                currency: 'usd',
                status: 'completed',
                createdAt: '2026-01-04T10:00:00.000Z',
                isDeleted: false,
                linkedLoanId: null
            },
            {
                id: 'purchase-in-period',
                orderNumber: 'PO-0001',
                supplierId: 'partner-1',
                total: 20,
                currency: 'usd',
                status: 'received',
                createdAt: '2026-01-05T10:00:00.000Z',
                isDeleted: false,
                linkedLoanId: null
            }
        ] as any,
        settlementTransactions: [
            {
                id: 'opening-payment',
                sourceType: 'sales_order',
                sourceRecordId: 'sales-before-period',
                direction: 'incoming',
                amount: 30,
                currency: 'usd',
                paidAt: '2025-12-20T10:00:00.000Z',
                createdAt: '2025-12-20T10:00:00.000Z',
                isDeleted: false
            },
            {
                id: 'period-payment',
                sourceType: 'sales_order',
                sourceRecordId: 'sales-in-period',
                direction: 'incoming',
                amount: 10,
                currency: 'usd',
                paidAt: '2026-01-06T10:00:00.000Z',
                createdAt: '2026-01-06T10:00:00.000Z',
                isDeleted: false
            },
            {
                id: 'period-direct-payment',
                sourceType: 'direct_transaction',
                sourceRecordId: 'direct-1',
                referenceLabel: 'Cash advance',
                direction: 'outgoing',
                amount: 5,
                currency: 'usd',
                paidAt: '2026-01-07T10:00:00.000Z',
                createdAt: '2026-01-07T10:00:00.000Z',
                isDeleted: false
            },
            {
                id: 'period-reversal',
                sourceType: 'sales_order',
                sourceRecordId: 'sales-in-period',
                direction: 'incoming',
                amount: -2,
                currency: 'usd',
                paidAt: '2026-01-08T10:00:00.000Z',
                createdAt: '2026-01-08T10:00:00.000Z',
                isDeleted: false,
                reversalOfTransactionId: 'period-payment'
            }
        ] as any
    }
}

describe('buildPartnerAccountStatementLedger', () => {
    it('returns each original-currency closing balance from the statement ledger', () => {
        const data = statementData()
        data.period = { type: 'allTime' }
        data.statementOrders = [
            {
                id: 'usd-sale', orderNumber: 'SO-USD', customerId: 'partner-1', total: 100,
                currency: 'usd', status: 'completed', createdAt: '2026-01-04T10:00:00.000Z', isDeleted: false, linkedLoanId: null
            },
            {
                id: 'iqd-purchase', orderNumber: 'PO-IQD', supplierId: 'partner-1', total: 500,
                currency: 'iqd', status: 'received', createdAt: '2026-01-05T10:00:00.000Z', isDeleted: false, linkedLoanId: null
            }
        ] as any
        data.settlementTransactions = [
            {
                id: 'usd-payment', sourceType: 'sales_order', sourceRecordId: 'usd-sale', direction: 'incoming', amount: 25,
                currency: 'usd', paidAt: '2026-01-06T10:00:00.000Z', createdAt: '2026-01-06T10:00:00.000Z', isDeleted: false
            },
            {
                id: 'iqd-payment', sourceType: 'purchase_order', sourceRecordId: 'iqd-purchase', direction: 'outgoing', amount: 200,
                currency: 'iqd', paidAt: '2026-01-06T10:00:00.000Z', createdAt: '2026-01-06T10:00:00.000Z', isDeleted: false
            }
        ] as any

        expect(getPartnerAccountStatementClosingBalances(data)).toEqual([
            { currency: 'iqd', closingBalance: -300 },
            { currency: 'usd', closingBalance: 75 }
        ])
    })

    it('labels pre-completion sales payments as advances and financed upfront amounts as order-loan down payments', () => {
        const data = statementData()
        data.statementOrders = [{
            id: 'sales-with-advance',
            orderNumber: 'SO-ADVANCE',
            customerId: 'partner-1',
            total: 100,
            currency: 'usd',
            status: 'completed',
            actualDeliveryDate: '2026-01-04T12:00:00.000Z',
            createdAt: '2026-01-04T08:00:00.000Z',
            isDeleted: false,
            linkedLoanId: null
        }, {
            id: 'sales-with-loan',
            orderNumber: 'SO-LOAN-ADVANCE',
            customerId: 'partner-1',
            total: 200,
            currency: 'usd',
            status: 'completed',
            actualDeliveryDate: '2026-01-05T12:00:00.000Z',
            createdAt: '2026-01-05T08:00:00.000Z',
            isDeleted: false,
            linkedLoanId: null
        }] as any
        data.settlementTransactions = [{
            id: 'cash-advance',
            sourceType: 'sales_order',
            sourceRecordId: 'sales-with-advance',
            direction: 'incoming',
            amount: 20,
            currency: 'usd',
            paidAt: '2026-01-04T09:00:00.000Z',
            createdAt: '2026-01-04T09:00:00.000Z',
            isDeleted: false
        }, {
            id: 'loan-down-payment',
            sourceType: 'sales_order',
            sourceRecordId: 'sales-with-loan',
            direction: 'incoming',
            amount: 40,
            currency: 'usd',
            paidAt: '2026-01-05T09:00:00.000Z',
            createdAt: '2026-01-05T09:00:00.000Z',
            isDeleted: false,
            metadata: { isDownPayment: true, isFinancingInitialPayment: true }
        }, {
            id: 'post-completion-payment',
            sourceType: 'sales_order',
            sourceRecordId: 'sales-with-advance',
            direction: 'incoming',
            amount: 80,
            currency: 'usd',
            paidAt: '2026-01-04T13:00:00.000Z',
            createdAt: '2026-01-04T13:00:00.000Z',
            isDeleted: false
        }] as any

        const entries = buildPartnerAccountStatementLedger(data).flatMap((ledger) => ledger.entries)
        expect(entries.find((entry) => entry.id === 'payment:cash-advance')?.descriptionKey).toBe('advancePaymentReceived')
        expect(entries.find((entry) => entry.id === 'payment:loan-down-payment')?.descriptionKey).toBe('orderLoanDownPaymentReceived')
        expect(entries.find((entry) => entry.id === 'payment:post-completion-payment')?.descriptionKey).toBe('paymentReceived')
    })

    it('lists agent-account sales and returns by product line with their document references', () => {
        const data = statementData()
        data.itemizeSalesOrders = true
        data.statementOrders = [{
            id: 'agent-sale',
            orderNumber: 'SO-AGENT-1',
            customerId: 'agent-partner',
            total: 80,
            originalTotalAmount: 100,
            returnedAmount: 20,
            currency: 'usd',
            status: 'completed',
            createdAt: '2026-01-04T10:00:00.000Z',
            isDeleted: false,
            linkedLoanId: null,
            items: [
                { id: 'line-a', productName: 'Coffee', quantity: 2, unit: 'pcs', lineTotal: 60 },
                { id: 'line-b', productName: 'Tea', quantity: 1, unit: 'pcs', lineTotal: 40 }
            ]
        }] as any
        data.settlementTransactions = []
        data.salesOrderReturns = [{
            id: 'return-1',
            orderId: 'agent-sale',
            reason: 'customer_returned',
            status: 'posted',
            refundAmount: 20,
            returnedAt: '2026-01-05T10:00:00.000Z',
            createdAt: '2026-01-05T10:00:00.000Z',
            isDeleted: false
        }] as any
        data.salesOrderReturnItems = [{
            id: 'return-line-a',
            returnId: 'return-1',
            orderId: 'agent-sale',
            orderItemId: 'line-a',
            quantity: 1,
            refundAmount: 20,
            isDeleted: false
        }] as any

        const entries = buildPartnerAccountStatementLedger(data).flatMap((ledger) => ledger.entries)
        expect(entries.map((entry) => [entry.reference, entry.itemName, entry.quantity, entry.delta])).toEqual([
            ['SO-AGENT-1', 'Coffee', 2, 60],
            ['SO-AGENT-1', 'Tea', 1, 40],
            ['SO-AGENT-1 · return-1', 'Coffee', -1, -20]
        ])
    })

    it('shows immutable per-unit and line product commission snapshots without changing the account balance', () => {
        const data = statementData()
        data.itemizeSalesOrders = true
        data.isAgentCommissionStatement = true
        data.statementOrders = [{
            id: 'commissioned-sale', orderNumber: 'SO-PRODUCT-1', customerId: 'agent-partner',
            total: 30, currency: 'iqd', status: 'completed', createdAt: '2026-01-04T10:00:00.000Z',
            isDeleted: false, linkedLoanId: null,
            items: [{ id: 'product-line', productName: 'Service pack', quantity: 3, unit: 'pcs', lineTotal: 30 }]
        }] as any
        data.settlementTransactions = []
        data.agentProductCommissionEntries = [{
            id: 'product-commission-accrual', orderId: 'commissioned-sale', assignmentId: 'assignment-1', agentId: 'agent-1',
            orderItemId: 'product-line', productId: 'product-1', kind: 'accrual', status: 'earned', currency: 'iqd',
            commissionType: 'fixed_amount', ratePercent: 0, quantity: 3, basisAmountPerUnit: 10,
            commissionPerUnit: 5, amount: 15, occurredAt: '2026-01-04T10:00:00.000Z', isDeleted: false
        }] as any

        const ledger = buildPartnerAccountStatementLedger(data)[0]
        const entry = ledger.entries.find((row) => row.id === 'sales-order:commissioned-sale:item:product-line')
        expect(entry).toMatchObject({ commissionPerProduct: 5, totalProductCommission: 15, delta: 30, runningBalance: 30 })
    })

    it('presents a fully automatic agent commission settlement as one zero-net statement row', () => {
        const data = statementData()
        data.statementOrders = []
        data.settlementTransactions = [{
            id: 'commission-payment',
            sourceType: 'agent_commission_payout',
            sourceRecordId: 'agent-1',
            direction: 'outgoing',
            amount: 40,
            currency: 'usd',
            paidAt: '2026-01-06T10:00:00.000Z',
            createdAt: '2026-01-06T10:00:00.000Z',
            isDeleted: false,
            sourceSubrecordId: 'commission-payout-entry',
            referenceLabel: 'SO-AGENT-1',
            metadata: { orderId: 'agent-sale', automaticSettlement: true }
        }] as any
        data.linkedOrderCodes = { 'agent-sale': 'SO-AGENT-1' }
        data.agentCommissionEntries = [
            {
                id: 'commission-accrual',
                orderId: 'agent-sale',
                assignmentId: 'assignment-1',
                agentId: 'agent-1',
                kind: 'accrual',
                amount: 40,
                currency: 'usd',
                occurredAt: '2026-01-04T10:00:00.000Z',
                createdAt: '2026-01-04T10:00:00.000Z',
                isDeleted: false
            },
            {
                id: 'commission-payout-entry',
                orderId: 'agent-sale',
                assignmentId: 'assignment-1',
                agentId: 'agent-1',
                kind: 'payout',
                amount: -40,
                currency: 'usd',
                occurredAt: '2026-01-06T10:00:00.000Z',
                createdAt: '2026-01-06T10:00:00.000Z',
                settlementSource: 'automatic',
                status: 'paid',
                isDeleted: false
            }
        ] as any

        const ledger = buildPartnerAccountStatementLedger(data)[0]
        expect(ledger.entries.map((entry) => [entry.id, entry.reference, entry.descriptionKey, entry.delta])).toEqual([
            ['agent-commission-settlement:commission-payout-entry', 'SO-AGENT-1', 'commissionSettledAutomatically', 0]
        ])
        expect(ledger.closingBalance).toBe(0)
    })

    it('nets a manual commission recovery against an overpaid, reversed commission exactly once', () => {
        const data = statementData()
        data.period = { type: 'allTime' }
        data.statementOrders = []
        data.linkedOrderCodes = { 'agent-sale': 'SO-AGENT-RECOVERY' }
        data.agentCommissionEntries = [
            {
                id: 'earned-entry', orderId: 'agent-sale', assignmentId: 'assignment-1', agentId: 'agent-1',
                kind: 'accrual', amount: 20_900, currency: 'iqd', occurredAt: '2026-01-04T10:00:00.000Z',
                createdAt: '2026-01-04T10:00:00.000Z', isDeleted: false
            },
            {
                id: 'payout-entry', orderId: 'agent-sale', assignmentId: 'assignment-1', agentId: 'agent-1',
                kind: 'payout', amount: -20_900, currency: 'iqd', occurredAt: '2026-01-05T10:00:00.000Z',
                createdAt: '2026-01-05T10:00:00.000Z', status: 'paid', settlementSource: 'manual', isDeleted: false
            },
            {
                id: 'reversal-entry', orderId: 'agent-sale', assignmentId: 'assignment-1', agentId: 'agent-1',
                kind: 'reversal', amount: -20_900, currency: 'iqd', occurredAt: '2026-01-06T10:00:00.000Z',
                createdAt: '2026-01-06T10:00:00.000Z', status: 'reversed', isDeleted: false
            },
            {
                id: 'recovery-entry', orderId: 'agent-sale', assignmentId: 'assignment-1', agentId: 'agent-1',
                kind: 'recovery', amount: 20_900, currency: 'iqd', occurredAt: '2026-01-07T10:00:00.000Z',
                createdAt: '2026-01-07T10:00:00.000Z', status: 'paid', settlementSource: 'manual', isDeleted: false
            }
        ] as any
        data.settlementTransactions = [
            {
                id: 'payout-payment', sourceType: 'agent_commission_payout', sourceRecordId: 'agent-1',
                sourceSubrecordId: 'payout-entry', direction: 'outgoing', amount: 20_900, currency: 'iqd',
                paidAt: '2026-01-05T10:00:00.000Z', createdAt: '2026-01-05T10:00:00.000Z',
                metadata: { orderId: 'agent-sale' }, isDeleted: false
            },
            {
                id: 'recovery-payment', sourceType: 'agent_commission_recovery', sourceRecordId: 'agent-1',
                sourceSubrecordId: 'recovery-entry', direction: 'incoming', amount: 20_900, currency: 'iqd',
                paidAt: '2026-01-07T10:00:00.000Z', createdAt: '2026-01-07T10:00:00.000Z',
                metadata: { orderId: 'agent-sale' }, isDeleted: false
            }
        ] as any

        const [ledger] = buildPartnerAccountStatementLedger(data)
        expect(ledger).toMatchObject({ currency: 'iqd', closingBalance: 0 })
        expect(ledger.entries.map((entry) => [entry.descriptionKey, entry.delta])).toEqual([
            ['commissionEarned', -20_900],
            ['commissionPaid', 20_900],
            ['commissionReversed', 20_900],
            ['commissionRecovered', -20_900]
        ])
    })

    it('keeps normal partner sales and returns as one row per document by default', () => {
        const data = statementData()
        data.statementOrders = [{
            id: 'partner-sale',
            orderNumber: 'SO-PARTNER-1',
            customerId: 'partner-1',
            total: 80,
            originalTotalAmount: 100,
            returnedAmount: 20,
            currency: 'usd',
            status: 'completed',
            createdAt: '2026-01-04T10:00:00.000Z',
            isDeleted: false,
            linkedLoanId: null,
            items: [
                { id: 'line-a', productName: 'Coffee', quantity: 2, unit: 'pcs', lineTotal: 60 },
                { id: 'line-b', productName: 'Tea', quantity: 1, unit: 'pcs', lineTotal: 40 }
            ]
        }] as any
        data.settlementTransactions = []
        data.salesOrderReturns = [{
            id: 'return-1',
            orderId: 'partner-sale',
            reason: 'customer_returned',
            status: 'posted',
            refundAmount: 20,
            returnedAt: '2026-01-05T10:00:00.000Z',
            createdAt: '2026-01-05T10:00:00.000Z',
            isDeleted: false
        }] as any
        data.salesOrderReturnItems = [{
            id: 'return-line-a',
            returnId: 'return-1',
            orderId: 'partner-sale',
            orderItemId: 'line-a',
            quantity: 1,
            refundAmount: 20,
            isDeleted: false
        }] as any

        const entries = buildPartnerAccountStatementLedger(data).flatMap((ledger) => ledger.entries)
        expect(entries.map((entry) => [entry.reference, entry.itemName, entry.quantity, entry.delta])).toEqual([
            ['SO-PARTNER-1', undefined, undefined, 80]
        ])
    })

    it('only prints item and quantity columns when itemized sales are enabled', () => {
        const data = statementData()
        data.statementOrders = [{
            id: 'partner-sale',
            orderNumber: 'SO-PARTNER-1',
            customerId: 'partner-1',
            total: 100,
            currency: 'usd',
            status: 'completed',
            createdAt: '2026-01-04T10:00:00.000Z',
            isDeleted: false,
            linkedLoanId: null,
            items: [{ id: 'line-a', productName: 'Coffee', quantity: 2, unit: 'pcs', lineTotal: 100 }]
        }] as any
        data.settlementTransactions = []

        const compactHtml = renderToStaticMarkup(createElement(PartnerAccountStatementPrintTemplate, {
            printLang: 'en',
            data: data as any
        }))
        data.itemizeSalesOrders = true
        const itemizedHtml = renderToStaticMarkup(createElement(PartnerAccountStatementPrintTemplate, {
            printLang: 'en',
            data: data as any
        }))

        expect(compactHtml).not.toContain('>Item</th>')
        expect(compactHtml).not.toContain('>Quantity</th>')
        expect(itemizedHtml).toContain('>Item</th>')
        expect(itemizedHtml).toContain('>Quantity</th>')
    })

    it('keeps a single-currency running balance from opening activity through payments and reversals', () => {
        const [ledger] = buildPartnerAccountStatementLedger(statementData())

        expect(ledger).toMatchObject({
            currency: 'usd',
            openingBalance: 70,
            debitTotal: 57,
            creditTotal: 30,
            closingBalance: 97
        })
        expect(ledger.entries.map((entry) => [entry.reference, entry.runningBalance])).toEqual([
            ['SO-0002', 120],
            ['PO-0001', 100],
            ['sales-in-period', 90],
            ['Cash advance', 95],
            ['sales-in-period', 97]
        ])
        expect(ledger.entries.find((entry) => entry.reference === 'SO-0002')?.source).toEqual({
            recordType: 'order',
            recordId: 'sales-in-period'
        })
        expect(ledger.entries.find((entry) => entry.reference === 'Cash advance')?.source).toEqual({
            recordType: 'payment_transaction',
            recordId: 'period-direct-payment'
        })
    })

    it('includes every merchant-facing Post Service movement once with the inverse delivery-ledger sign', () => {
        const data = statementData()
        data.statementOrders = []
        data.settlementTransactions = []
        data.deliveryShipmentReferences = { 'post-1': 'PST-20260827-00001' }
        data.deliveryLedgerEntries = [
            {
                id: 'delivery-cod',
                kind: 'merchant_cod_payable',
                shipmentId: 'post-1',
                amount: 50000,
                currency: 'iqd',
                occurredAt: '2026-01-05T10:00:00.000Z',
                createdAt: '2026-01-05T10:00:00.000Z',
                isDeleted: false
            },
            {
                id: 'delivery-fee',
                kind: 'merchant_fee',
                shipmentId: 'post-1',
                amount: -3000,
                currency: 'iqd',
                occurredAt: '2026-01-05T10:00:00.000Z',
                createdAt: '2026-01-05T10:00:00.000Z',
                isDeleted: false
            },
            {
                id: 'recipient-payout',
                kind: 'merchant_recipient_payout',
                shipmentId: 'post-1',
                amount: -10000,
                currency: 'iqd',
                occurredAt: '2026-01-05T10:00:00.000Z',
                createdAt: '2026-01-05T10:00:00.000Z',
                isDeleted: false
            },
            {
                id: 'merchant-payout',
                kind: 'merchant_payout',
                amount: -37000,
                currency: 'iqd',
                occurredAt: '2026-01-06T10:00:00.000Z',
                createdAt: '2026-01-06T10:00:00.000Z',
                isDeleted: false
            }
        ] as any

        const [ledger] = buildPartnerAccountStatementLedger(data)

        expect(ledger).toMatchObject({ currency: 'iqd', closingBalance: 0 })
        expect(ledger.entries.map((entry) => [entry.reference, entry.delta, entry.descriptionKey])).toEqual([
            ['PST-20260827-00001', -50000, 'deliveryCodPayable'],
            ['PST-20260827-00001', 3000, 'deliveryFee'],
            ['PST-20260827-00001', 10000, 'deliveryRecipientPayout'],
            ['merchant-payout', 37000, 'deliveryMerchantPayout']
        ])
        expect(ledger.entries.find((entry) => entry.descriptionKey === 'deliveryRecipientPayout')?.source).toEqual({
            recordType: 'delivery_ledger_entry',
            recordId: 'recipient-payout'
        })
    })

    it('retains independent balances for every currency instead of converting an audit trail', () => {
        const data = statementData()
        data.statementOrders?.push({
            id: 'iqd-sales-order',
            orderNumber: 'SO-IQD',
            customerId: 'partner-1',
            total: 150000,
            currency: 'iqd',
            status: 'completed',
            createdAt: '2026-01-09T10:00:00.000Z',
            isDeleted: false,
            linkedLoanId: null
        } as any)

        expect(buildPartnerAccountStatementLedger(data).map((ledger) => ({
            currency: ledger.currency,
            closingBalance: ledger.closingBalance
        }))).toEqual([
            { currency: 'iqd', closingBalance: 150000 },
            { currency: 'usd', closingBalance: 97 }
        ])
    })

    it('prints an order loan once and keeps its source order reference', () => {
        const data = statementData()
        data.statementOrders = [{
            id: 'financed-sales-order',
            orderNumber: 'SO-LOAN',
            customerId: 'partner-1',
            total: 200000,
            currency: 'iqd',
            status: 'completed',
            createdAt: '2026-01-10T10:00:00.000Z',
            isDeleted: false,
            linkedLoanId: 'order-loan'
        } as any]
        data.settlementTransactions = []
        data.loans = [{
            id: 'order-loan',
            loanNo: 'SL-0001',
            source: 'order',
            orderId: 'financed-sales-order',
            direction: 'lent',
            principalAmount: 200000,
            settlementCurrency: 'iqd',
            status: 'active',
            createdAt: '2026-01-10T10:00:00.000Z',
            isDeleted: false
        } as any]
        data.linkedOrderCodes = { 'financed-sales-order': 'SO-LOAN' }

        const ledgers = buildPartnerAccountStatementLedger(data)
        const iqdLedger = ledgers.find((ledger) => ledger.currency === 'iqd')

        expect(iqdLedger?.entries).toMatchObject([{
            reference: 'SO-LOAN · SL-0001',
            description: 'Order loan provided',
            delta: 200000,
            runningBalance: 200000
        }])
        expect(iqdLedger?.entries).toHaveLength(1)
    })

    it('replaces generated return and reversal notes with structured statement events', () => {
        const data = statementData()
        data.statementOrders = []
        data.settlementTransactions = [
            {
                id: 'order-return-reversal',
                sourceType: 'sales_order',
                sourceRecordId: 'sales-in-period',
                referenceLabel: 'SO-RETURN',
                direction: 'incoming',
                amount: -20,
                currency: 'usd',
                paidAt: '2026-01-10T10:00:00.000Z',
                createdAt: '2026-01-10T10:00:00.000Z',
                isDeleted: false,
                reversalOfTransactionId: 'original-payment',
                note: 'Order return 67438441-6dbc-4b99-9f81-f64270a3752e: customer_returned',
                metadata: {
                    orderReturnId: '67438441-6dbc-4b99-9f81-f64270a3752e',
                    returnReason: 'customer_returned'
                }
            },
            {
                id: 'manual-reversal',
                sourceType: 'sales_order',
                sourceRecordId: 'sales-in-period',
                referenceLabel: 'SO-REVERSAL',
                direction: 'incoming',
                amount: -10,
                currency: 'usd',
                paidAt: '2026-01-11T10:00:00.000Z',
                createdAt: '2026-01-11T10:00:00.000Z',
                isDeleted: false,
                reversalOfTransactionId: 'another-payment',
                note: 'Reversal of SO-REVERSAL',
                metadata: { reversal: true }
            }
        ] as any
        data.loans = [{
            id: 'return-credit-loan',
            loanNo: 'SL-RETURN',
            direction: 'lent',
            principalAmount: 100,
            settlementCurrency: 'usd',
            status: 'active',
            createdAt: '2026-01-01T10:00:00.000Z',
            isDeleted: false
        } as any]
        data.loanPayments = [{
            id: 'return-credit-payment',
            loanId: 'return-credit-loan',
            amount: 20,
            paymentMethod: 'loan_adjustment',
            paidAt: '2026-01-12T10:00:00.000Z',
            createdAt: '2026-01-12T10:00:00.000Z',
            isDeleted: false,
            note: 'Return Credit (Reason: customer_returned)'
        } as any]

        const entries = buildPartnerAccountStatementLedger(data).flatMap((ledger) => ledger.entries)
        expect(entries.find((entry) => entry.id === 'payment:order-return-reversal')).toMatchObject({
            descriptionKey: 'orderReturnRefund',
            note: null,
            returnReason: 'customer_returned'
        })
        expect(entries.find((entry) => entry.id === 'payment:manual-reversal')).toMatchObject({
            descriptionKey: 'paymentReversal',
            note: null
        })
        expect(entries.find((entry) => entry.id === 'loan-payment:return-credit-payment')).toMatchObject({
            descriptionKey: 'returnCredit',
            note: null,
            returnReason: 'customer_returned'
        })
    })

    it('localizes the structured statement event and return reason at display time', () => {
        const t = (key: string, options?: { defaultValue?: string }) => ({
            'businessPartners.accountStatement.descriptions.orderReturnRefund': 'گەڕاندنەوەی پارەی داواکاری',
            'businessPartners.accountStatement.reason': 'هۆکار',
            'businessPartners.accountStatement.reasonNotProvided': 'دیاری نەکراوە'
        }[key] || options?.defaultValue || key)
        const i18n = {
            getFixedT: (language: string) => (key: string) => (
                language === 'ku' && key === 'sales.return.reasons.customerReturned'
                    ? 'گەڕاندنەوەی کاڵا لەلایەن کڕیارەوە'
                    : key
            )
        } as any
        const entry = {
            description: 'Order return refund',
            descriptionKey: 'orderReturnRefund' as const,
            returnReason: 'customer_returned'
        }

        expect(getPartnerAccountStatementEntryDescription(entry, t)).toBe('گەڕاندنەوەی پارەی داواکاری')
        expect(getPartnerAccountStatementEntryDetail(entry, { t, i18n, language: 'ku' }))
            .toBe('هۆکار: گەڕاندنەوەی کاڵا لەلایەن کڕیارەوە')
    })

    it('uses conservative, page-safe chunks and marks every continuation ledger table for Atlas Standard-style page centering', () => {
        const data = statementData()
        data.statementOrders = Array.from({ length: 26 }, (_, index) => ({
            id: `sales-${index + 1}`,
            orderNumber: `SO-${index + 1}`,
            customerId: 'partner-1',
            total: 10,
            currency: 'usd',
            status: 'completed',
            createdAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
            isDeleted: false,
            linkedLoanId: null
        })) as any
        data.settlementTransactions = []

        const html = renderToStaticMarkup(createElement(PartnerAccountStatementPrintTemplate, {
            printLang: 'en',
            data: data as any
        }))

        expect(html).toContain('data-centered-table=""')
        expect(html.match(/data-centered-table/g)).toHaveLength(2)
        expect(html.match(/data-pdf-page-chunk/g)).toHaveLength(3)
        expect(html).not.toContain('aria-hidden="true"')
    })

    it('marks a different-currency ledger as a centered continuation table', () => {
        const data = statementData()
        data.statementOrders = [
            {
                id: 'usd-order',
                orderNumber: 'SO-USD',
                customerId: 'partner-1',
                total: 10,
                currency: 'usd',
                status: 'completed',
                createdAt: '2026-01-03T10:00:00.000Z',
                isDeleted: false,
                linkedLoanId: null
            },
            {
                id: 'iqd-order',
                orderNumber: 'SO-IQD',
                customerId: 'partner-1',
                total: 10000,
                currency: 'iqd',
                status: 'completed',
                createdAt: '2026-01-04T10:00:00.000Z',
                isDeleted: false,
                linkedLoanId: null
            }
        ] as any
        data.settlementTransactions = []

        const html = renderToStaticMarkup(createElement(PartnerAccountStatementPrintTemplate, {
            printLang: 'en',
            data: data as any
        }))

        expect(html.match(/data-centered-table/g)).toHaveLength(1)
        expect(html).toContain('Account Activity · USD')
    })
})
