import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Invoice, PaymentTransaction } from '@/local-db/models'
import { saveDirectTransactionVoucherPdf } from './directTransactionVoucherSave'

const mocks = vi.hoisted(() => ({
    saveInvoiceFromSnapshot: vi.fn(),
    persistInvoiceVersion: vi.fn()
}))

vi.mock('@/local-db/hooks', () => ({ saveInvoiceFromSnapshot: mocks.saveInvoiceFromSnapshot }))
vi.mock('./invoiceVersionService', () => ({ persistInvoiceVersion: mocks.persistInvoiceVersion }))

const workspaceId = '00000000-0000-4000-8000-000000000672'
const transaction = {
    id: '00000000-0000-4000-8000-000000000673',
    workspaceId,
    sourceType: 'direct_transaction',
    voucherNumber: 23,
    amount: 1500,
    currency: 'usd'
} as PaymentTransaction
const invoice = {
    id: transaction.id,
    workspaceId,
    sourceId: transaction.id,
    invoiceid: 'DT-000023',
    origin: 'direct_transaction'
} as Invoice
const pdf = new Blob(['%PDF-1.4'], { type: 'application/pdf' })

describe('direct transaction Print & Save', () => {
    beforeEach(() => {
        mocks.saveInvoiceFromSnapshot.mockReset().mockResolvedValue(invoice)
        mocks.persistInvoiceVersion.mockReset().mockResolvedValue({ id: 'version-1' })
    })

    it('saves the recorded voucher identity and generated A4 PDF through document versioning', async () => {
        await expect(saveDirectTransactionVoucherPdf(workspaceId, transaction, pdf, {
            id: 'user-1', name: 'Cashier'
        })).resolves.toBe('DT-000023')

        expect(mocks.saveInvoiceFromSnapshot).toHaveBeenCalledWith(workspaceId, expect.objectContaining({
            invoiceid: 'DT-000023', sourceId: transaction.id, origin: 'direct_transaction',
            totalAmount: 1500, settlementCurrency: 'usd', printFormat: 'a4'
        }), transaction.id)
        expect(mocks.persistInvoiceVersion).toHaveBeenCalledWith(expect.objectContaining({
            invoice, blob: pdf, format: 'a4',
            metadata: expect.objectContaining({ transactionId: transaction.id, voucherReference: 'DT-000023' })
        }))
    })

    it('rejects a wrong workspace or missing PDF before writing a document', async () => {
        await expect(saveDirectTransactionVoucherPdf('another-workspace', transaction, pdf, {})).rejects.toThrow()
        await expect(saveDirectTransactionVoucherPdf(workspaceId, transaction, new Blob(), {})).rejects.toThrow()
        expect(mocks.saveInvoiceFromSnapshot).not.toHaveBeenCalled()
        expect(mocks.persistInvoiceVersion).not.toHaveBeenCalled()
    })

    it('reports parent and version persistence failures without claiming the voucher was saved', async () => {
        mocks.saveInvoiceFromSnapshot.mockRejectedValueOnce(new Error('remote parent failed'))
        await expect(saveDirectTransactionVoucherPdf(workspaceId, transaction, pdf, {})).rejects.toThrow('remote parent failed')
        expect(mocks.persistInvoiceVersion).not.toHaveBeenCalled()

        mocks.persistInvoiceVersion.mockRejectedValueOnce(new Error('remote version failed'))
        await expect(saveDirectTransactionVoucherPdf(workspaceId, transaction, pdf, {})).rejects.toThrow('remote version failed')
    })
})
