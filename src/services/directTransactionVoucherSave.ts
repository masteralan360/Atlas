import { saveInvoiceFromSnapshot } from '@/local-db/hooks'
import type { PaymentTransaction } from '@/local-db/models'
import { formatDirectTransactionVoucherNumber } from '@/lib/directTransactionVoucher'
import { persistInvoiceVersion } from './invoiceVersionService'

type Author = { id?: string; name?: string }

/** Store an immutable voucher PDF through the app's document version flow. */
export async function saveDirectTransactionVoucherPdf(
    workspaceId: string,
    transaction: PaymentTransaction,
    blob: Blob,
    author: Author
): Promise<string> {
    if (transaction.workspaceId !== workspaceId || transaction.sourceType !== 'direct_transaction') {
        throw new Error('The direct transaction does not belong to this workspace.')
    }
    if (!blob.size || blob.type !== 'application/pdf') {
        throw new Error('A generated voucher PDF is required.')
    }

    const reference = formatDirectTransactionVoucherNumber(transaction)
    const invoice = await saveInvoiceFromSnapshot(workspaceId, {
        invoiceid: reference,
        sourceId: transaction.id,
        origin: 'direct_transaction',
        totalAmount: transaction.amount,
        settlementCurrency: transaction.currency,
        printFormat: 'a4',
        createdBy: author.id,
        createdByName: author.name,
        cashierName: author.name
    }, transaction.id)

    await persistInvoiceVersion({
        invoice,
        blob,
        format: 'a4',
        author,
        metadata: {
            module: 'directTransaction',
            documentType: 'voucher',
            transactionId: transaction.id,
            voucherReference: reference
        }
    })

    return reference
}
