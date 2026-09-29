import type { Product } from '@/local-db/models'

/**
 * Catalog domain rules. Keep product/service decisions here instead of
 * spreading `isService` checks through sales and inventory code.
 */
export function isService(item: Pick<Product, 'isService'> | null | undefined): boolean {
    return item?.isService === true
}

export function isInventoryItem(item: Pick<Product, 'isService'> | null | undefined): boolean {
    return !isService(item)
}

export function requiresPhysicalStorage(item: Pick<Product, 'isService'> | null | undefined): boolean {
    return isInventoryItem(item)
}

export function affectsStock(item: Pick<Product, 'isService'> | null | undefined): boolean {
    return isInventoryItem(item)
}

export function canBePurchased(item: Pick<Product, 'isService'> | null | undefined): boolean {
    return isInventoryItem(item)
}

/** A UI-only location key. It is never persisted to products, inventory, or sales. */
export const SERVICES_VIRTUAL_STORAGE_ID = '__atlas_services__'
export const ACTIVITIES_VIRTUAL_STORAGE_ID = '__atlas_activities__'

export function isServicesVirtualStorage(storageId: string | null | undefined): boolean {
    return storageId === SERVICES_VIRTUAL_STORAGE_ID
}
