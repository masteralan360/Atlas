import type { Product } from '@/local-db/models'
import { isService, SERVICES_VIRTUAL_STORAGE_ID } from './catalogItem'

type OrderLineProduct = Pick<Product, 'isService'> | null | undefined

/**
 * The Services location is a form affordance only. Keep it out of the order
 * JSON so every persisted storage reference remains a real storage UUID.
 */
export function getPersistedSalesOrderItemStorageId(
    product: OrderLineProduct,
    storageId: string | null | undefined
): string | null {
    return isService(product) ? null : storageId || null
}

/** Restores the form-only Services location for a persisted service line. */
export function getSalesOrderFormItemStorageId(
    product: OrderLineProduct,
    storageId: string | null | undefined,
    fallbackStorageId = ''
): string {
    return isService(product)
        ? SERVICES_VIRTUAL_STORAGE_ID
        : storageId || fallbackStorageId
}

type SalesOrderLineProductSelection = {
    productId: string
    productSearch: string
    unitPrice: string
    batchId: string
    priceBookId: string
    priceBookItemId: string
    priceSourceCurrency: string
    priceBookCostPrice: string
}

/** Clears product-specific values when a sales line moves to Services. */
export function clearSalesItemProductForServicesStorage(
    item: SalesOrderLineProductSelection
): SalesOrderLineProductSelection {
    return {
        ...item,
        productId: '',
        productSearch: '',
        unitPrice: '',
        batchId: '',
        priceBookId: '',
        priceBookItemId: '',
        priceSourceCurrency: '',
        priceBookCostPrice: ''
    }
}
