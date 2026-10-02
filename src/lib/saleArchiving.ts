import type { Sale } from '@/types'

type SaleArchiveState = Pick<Sale, 'is_returned' | 'return_status' | 'items'> & {
    isArchived?: boolean
    isReturned?: boolean
    returnStatus?: string
}

export function isSaleFullyReturned(sale: SaleArchiveState): boolean {
    if (sale.is_returned === true || sale.isReturned === true) return true
    if (sale.return_status === 'full' || sale.returnStatus === 'full') return true

    const returnedItems = (sale.items ?? []).filter((item) => Number(item.quantity ?? 0) > 0)
    return returnedItems.length > 0 && returnedItems.every((item) => (
        item.is_returned === true
        || Number(item.returned_quantity ?? 0) >= Number(item.quantity ?? 0)
    ))
}

export function isActiveSale(sale: { is_archived?: boolean; isArchived?: boolean }): boolean {
    return sale.is_archived !== true && sale.isArchived !== true
}
