import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000301'
const SALE_ID = '00000000-0000-4000-8000-000000000302'
const RETURN_ID = '00000000-0000-4000-8000-000000000303'

let createLoanFromPosSale: typeof import('./hooks').createLoanFromPosSale
let createLoanFromOrder: typeof import('./hooks').createLoanFromOrder
let cancelOrderLinkedLoan: typeof import('./hooks').cancelOrderLinkedLoan
let deleteLoan: typeof import('./hooks').deleteLoan
let markPosLoanCancelledForFullSaleReturn: typeof import('./hooks').markPosLoanCancelledForFullSaleReturn
let recordLoanPayment: typeof import('./hooks').recordLoanPayment

function installBrowserStorage() {
    const rows = new Map<string, string>()
    const storage = {
        get length() {
            return rows.size
        },
        getItem: (key: string) => rows.get(key) ?? null,
        setItem: (key: string, value: string) => rows.set(key, value),
        removeItem: (key: string) => rows.delete(key),
        clear: () => rows.clear(),
        key: (index: number) => Array.from(rows.keys())[index] ?? null
    }

    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis.URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' })
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            localStorage: storage,
            sessionStorage: storage,
            location: { origin: 'http://localhost', hash: '', pathname: '/' },
            URL: globalThis.URL,
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }
    })
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            visibilityState: 'visible',
            dir: 'ltr',
            documentElement: { lang: 'en', dir: 'ltr', style: {} },
            head: { appendChild: () => undefined },
            getElementsByTagName: () => [{ appendChild: () => undefined }],
            createElement: () => ({ appendChild: () => undefined, setAttribute: () => undefined, style: {} }),
            createTextNode: () => ({}),
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }
    })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
    Object.defineProperty(globalThis, 'DOMMatrix', { configurable: true, value: class DOMMatrix {} })
    Object.defineProperty(globalThis, 'ImageData', { configurable: true, value: class ImageData {} })
    Object.defineProperty(globalThis, 'Path2D', { configurable: true, value: class Path2D {} })
    Object.defineProperty(globalThis, 'Element', { configurable: true, value: class Element {} })
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class HTMLElement {} })
}

describe('POS loan full returns', () => {
    beforeAll(async () => {
        installBrowserStorage()
        const loans = await import('./hooks')
        createLoanFromPosSale = loans.createLoanFromPosSale
        createLoanFromOrder = loans.createLoanFromOrder
        cancelOrderLinkedLoan = loans.cancelOrderLinkedLoan
        deleteLoan = loans.deleteLoan
        markPosLoanCancelledForFullSaleReturn = loans.markPosLoanCancelledForFullSaleReturn
        recordLoanPayment = loans.recordLoanPayment
    })

    beforeEach(async () => {
        await db.delete()
        await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    })

    afterEach(() => {
        setNetworkStatus(true)
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
    })

    afterAll(async () => {
        await db.delete()
    })

    it('creates a simple loan for one repayment and an installment loan for multiple repayments', async () => {
        const simple = await createLoanFromPosSale(WORKSPACE_ID, {
            saleId: '00000000-0000-4000-8000-000000000304',
            borrowerName: 'One Repayment Customer',
            borrowerPhone: '07500000304',
            borrowerAddress: 'Erbil',
            borrowerNationalId: 'ID-304',
            principalAmount: 100,
            settlementCurrency: 'usd',
            installmentCount: 1,
            installmentFrequency: 'monthly',
            firstDueDate: '2026-08-01'
        })
        const installments = await createLoanFromPosSale(WORKSPACE_ID, {
            saleId: '00000000-0000-4000-8000-000000000305',
            borrowerName: 'Multiple Repayments Customer',
            borrowerPhone: '07500000305',
            borrowerAddress: 'Erbil',
            borrowerNationalId: 'ID-305',
            principalAmount: 100,
            settlementCurrency: 'usd',
            installmentCount: 2,
            installmentFrequency: 'monthly',
            firstDueDate: '2026-08-01'
        })

        expect(simple.loan).toMatchObject({ loanCategory: 'simple', installmentCount: 1 })
        expect(simple.loan.loanNo).toMatch(/^SL-/)
        expect(simple.installments).toHaveLength(1)
        expect(installments.loan).toMatchObject({ loanCategory: 'standard', installmentCount: 2 })
        expect(installments.loan.loanNo).toMatch(/^LN-/)
        expect(installments.installments).toHaveLength(2)
    })

    it('cancels the POS loan and reverses prior repayments without adding a loan adjustment', async () => {
        const { loan, installments } = await createLoanFromPosSale(WORKSPACE_ID, {
            saleId: SALE_ID,
            borrowerName: 'POS Return Customer',
            borrowerPhone: '07500000301',
            borrowerAddress: 'Erbil',
            borrowerNationalId: 'ID-301',
            principalAmount: 100,
            settlementCurrency: 'usd',
            installmentCount: 2,
            installmentFrequency: 'monthly',
            firstDueDate: '2026-08-01'
        })

        await recordLoanPayment(WORKSPACE_ID, {
            loanId: loan.id,
            amount: 40,
            paymentMethod: 'cash',
            paidAt: '2026-08-02T12:00:00.000Z'
        })

        const originalTransaction = (await db.payment_transactions
            .where('workspaceId')
            .equals(WORKSPACE_ID)
            .toArray())
            .find((transaction) => transaction.metadata?.loanPaymentId && !transaction.reversalOfTransactionId)

        expect(originalTransaction).toBeTruthy()

        await markPosLoanCancelledForFullSaleReturn({
            workspaceId: WORKSPACE_ID,
            saleId: SALE_ID,
            returnId: RETURN_ID,
            reason: 'Customer returned all items'
        })

        expect(await db.loans.get(loan.id)).toMatchObject({
            principalAmount: 100,
            totalPaidAmount: 0,
            balanceAmount: 0,
            status: 'cancelled'
        })
        expect(await db.loan_installments.where('loanId').equals(loan.id).toArray()).toEqual(
            expect.arrayContaining(installments.map((installment) => expect.objectContaining({
                id: installment.id,
                paidAmount: 0,
                balanceAmount: 0,
                status: 'cancelled'
            })))
        )
        const transactions = await db.payment_transactions.where('workspaceId').equals(WORKSPACE_ID).toArray()
        const reversalTransaction = transactions.find((transaction) => (
            transaction.reversalOfTransactionId === originalTransaction!.id
        ))
        expect(reversalTransaction).toBeTruthy()
        expect(await db.loan_payments.where('loanId').equals(loan.id).toArray()).toEqual([
            expect.objectContaining({
                amount: 40,
                paymentMethod: 'cash',
                paymentTransactionId: originalTransaction!.id,
                reversedAmount: 40,
                reversalTransactionId: reversalTransaction!.id,
                isDeleted: true,
                integrityVersion: 1
            })
        ])

        expect(transactions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: originalTransaction!.id,
                amount: 40,
                reversalOfTransactionId: null
            }),
            expect.objectContaining({
                amount: -40,
                paymentMethod: 'cash',
                reversalOfTransactionId: originalTransaction!.id,
                metadata: expect.objectContaining({
                    saleId: SALE_ID,
                    saleReturnId: RETURN_ID,
                    fullSaleReturn: true
                })
            })
        ]))
        expect(transactions.some((transaction) => transaction.paymentMethod === 'loan_adjustment')).toBe(false)
    })

    it('keeps a loan intact when an offline Cloud Sync delete cannot be represented', async () => {
        const { loan } = await createLoanFromPosSale(WORKSPACE_ID, {
            saleId: '00000000-0000-4000-8000-000000000306',
            borrowerName: 'Offline Delete Customer',
            borrowerPhone: '07500000306',
            borrowerAddress: 'Erbil',
            borrowerNationalId: 'ID-306',
            principalAmount: 100,
            settlementCurrency: 'usd',
            installmentCount: 1,
            installmentFrequency: 'monthly',
            firstDueDate: '2026-08-01'
        })
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'hybrid' })
        setNetworkStatus(false)

        await expect(deleteLoan(loan.id)).rejects.toThrow('loan_delete_online_required')
        expect(await db.loans.get(loan.id)).toMatchObject({
            id: loan.id,
            isDeleted: false
        })
    })

    it('keeps an order loan intact when offline Cloud Sync cancellation cannot be represented', async () => {
        const { loan } = await createLoanFromOrder(WORKSPACE_ID, {
            orderId: '00000000-0000-4000-8000-000000000307',
            orderType: 'sales',
            borrowerName: 'Offline Cancel Customer',
            borrowerPhone: '07500000307',
            borrowerAddress: 'Erbil',
            borrowerNationalId: 'ID-307',
            principalAmount: 100,
            settlementCurrency: 'usd',
            installmentCount: 1,
            installmentFrequency: 'monthly',
            firstDueDate: '2026-08-01'
        })
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'hybrid' })
        setNetworkStatus(false)

        await expect(cancelOrderLinkedLoan(loan.id)).rejects.toThrow('loan_delete_online_required')
        expect(await db.loans.get(loan.id)).toMatchObject({
            id: loan.id,
            isDeleted: false
        })
    })
})
