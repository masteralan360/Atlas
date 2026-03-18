import type { Invoice } from '@/local-db/models'
import { isTauri } from '@/lib/platform'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { type PrintFormat } from './pdfGenerator'
import { platformService } from './platformService'

type InvoicePrintFeatures = {
    print_qr?: boolean
}

type InvoicePdfRecord = Pick<Invoice, 'localPathA4' | 'localPathReceipt'>

export function shouldUseLocalInvoiceStorage(workspaceId?: string | null) {
    return !!workspaceId && isLocalWorkspaceMode(workspaceId)
}

export function canPersistLocalInvoiceFiles(workspaceId?: string | null) {
    return shouldUseLocalInvoiceStorage(workspaceId) && isTauri()
}

export function disableInvoiceQrInLocalMode<T extends InvoicePrintFeatures | undefined>(
    workspaceId: string | null | undefined,
    features: T
): T {
    if (!features || !shouldUseLocalInvoiceStorage(workspaceId) || !features.print_qr) {
        return features
    }

    return {
        ...features,
        print_qr: false
    } as T
}

export function getLocalInvoicePdfRelativePath(
    workspaceId: string,
    invoiceId: string,
    format: PrintFormat
) {
    const folder = format === 'a4' ? 'A4' : 'receipts'
    return `printed-invoices/${workspaceId}/${folder}/${invoiceId}.pdf`
}

export function getStoredLocalInvoicePdfPath(
    invoice: InvoicePdfRecord,
    format: PrintFormat
) {
    return format === 'a4'
        ? invoice.localPathA4 ?? null
        : invoice.localPathReceipt ?? null
}

export async function saveInvoicePdfToLocalAppData(
    workspaceId: string,
    invoiceId: string,
    format: PrintFormat,
    blob: Blob
) {
    if (!canPersistLocalInvoiceFiles(workspaceId)) {
        return null
    }

    const relativePath = getLocalInvoicePdfRelativePath(workspaceId, invoiceId, format)
    return platformService.saveFile(relativePath, await blob.arrayBuffer())
}

export async function getAbsoluteAppDataPath(relativePath: string) {
    const appDataDir = await platformService.getAppDataDir()
    const normalizedParts = relativePath
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)

    return platformService.joinPath(appDataDir, ...normalizedParts)
}
