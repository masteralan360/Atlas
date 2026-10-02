import type { UniversalInvoice } from '@/types'

export interface PrintPosReceiptOptions {
    title?: string
    pdfBuilder?: () => Promise<Blob>
}

export function printPosPreprintReceipt({
    saleData,
    pdfBuilder,
    printReceipt,
}: {
    saleData: Pick<UniversalInvoice, 'id' | 'invoiceid'>
    pdfBuilder: () => Promise<Blob>
    printReceipt: (options: PrintPosReceiptOptions) => Promise<void>
}): Promise<void> {
    return printReceipt({
        title: `Receipt_${saleData.invoiceid || saleData.id || 'Sale'}`,
        pdfBuilder,
    })
}
