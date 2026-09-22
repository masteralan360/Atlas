import type { Product } from '@/local-db/models'
import { isService, SERVICES_VIRTUAL_STORAGE_ID } from './catalogItem'

type OrderLineProduct = Pick<Product, 'isService'> | null | undefined

type SalesOrderLineIdentity = {
    productId: string
    storageId: string
    batchId: string
    unitRef: string
    quantity: number
    freeBonusQuantity: number
    unitPrice: number
    seq: number
}

/** Keeps otherwise-identical commercial lines distinct for returns and audit history. */
export function buildSalesOrderLineId(line: SalesOrderLineIdentity) {
    return [
        line.productId,
        line.storageId,
        line.batchId,
        line.unitRef,
        line.quantity,
        line.freeBonusQuantity,
        line.unitPrice,
        line.seq
    ].join('-')
}

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
    unitRef?: string
    unitRelationshipId?: string
    unitFactor?: string
    baseUnitRef?: string
    baseUnitCode?: string
    unitNameSnapshot?: string
    baseUnitNameSnapshot?: string
    freeBonusQuantity?: string
    freeBonusUnit?: string
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
        priceBookCostPrice: '',
        unitRef: '',
        unitRelationshipId: '',
        unitFactor: '',
        baseUnitRef: '',
        baseUnitCode: '',
        unitNameSnapshot: '',
        baseUnitNameSnapshot: '',
        freeBonusQuantity: '',
        freeBonusUnit: ''
    }
}
