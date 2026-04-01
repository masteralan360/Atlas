import { db } from './database'
import { getInventoryRowsForProduct } from './inventory'
import type { Storage } from './models'

function isLegacyMainStorage(storage?: Pick<Storage, 'name' | 'isSystem' | 'isDeleted'> | null) {
    return !!storage
        && !storage.isDeleted
        && storage.isSystem
        && storage.name.trim().toLowerCase() === 'main'
}

export function normalizeStorageRecord(storage: Storage): Storage {
    return {
        ...storage,
        isSystem: !!storage.isSystem,
        isProtected: !!storage.isProtected,
        isPrimary: !!storage.isPrimary
    }
}

export function isPrimaryStorage(storage?: Pick<Storage, 'name' | 'isSystem' | 'isDeleted' | 'isPrimary'> | null) {
    if (!storage || storage.isDeleted) {
        return false
    }

    return storage.isPrimary === true || isLegacyMainStorage(storage)
}

export function getPrimaryStorageFromList(storages: Storage[]) {
    const activeStorages = storages.filter((storage) => !storage.isDeleted)
    if (activeStorages.length === 0) {
        return undefined
    }

    return activeStorages.find((storage) => storage.isPrimary)
        ?? activeStorages.find((storage) => isLegacyMainStorage(storage))
        ?? activeStorages[0]
}

export function sortStoragesByPriority(storages: Storage[]) {
    return [...storages].sort((left, right) => {
        const leftPrimary = isPrimaryStorage(left) ? 1 : 0
        const rightPrimary = isPrimaryStorage(right) ? 1 : 0
        if (leftPrimary !== rightPrimary) {
            return rightPrimary - leftPrimary
        }

        const leftSystem = left.isSystem ? 1 : 0
        const rightSystem = right.isSystem ? 1 : 0
        if (leftSystem !== rightSystem) {
            return rightSystem - leftSystem
        }

        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    })
}

export async function getPrimaryStorage(workspaceId: string) {
    const storages = await db.storages
        .where('workspaceId')
        .equals(workspaceId)
        .and((storage) => !storage.isDeleted)
        .toArray()

    return getPrimaryStorageFromList(storages.map(normalizeStorageRecord)) ?? null
}

export async function getPrimaryStorageId(workspaceId: string, excludedStorageId?: string | null) {
    const storages = await db.storages
        .where('workspaceId')
        .equals(workspaceId)
        .and((storage) => !storage.isDeleted && storage.id !== excludedStorageId)
        .toArray()

    return getPrimaryStorageFromList(storages.map(normalizeStorageRecord))?.id ?? null
}

export async function resolveReturnStorageId(input: {
    workspaceId: string
    productId: string
    saleStorageId?: string | null
}) {
    const storages = (await db.storages
        .where('workspaceId')
        .equals(input.workspaceId)
        .and((storage) => !storage.isDeleted)
        .toArray())
        .map(normalizeStorageRecord)

    const activeStorageMap = new Map(storages.map((storage) => [storage.id, storage] as const))
    const primaryStorage = getPrimaryStorageFromList(storages)

    if (input.saleStorageId) {
        return activeStorageMap.has(input.saleStorageId)
            ? input.saleStorageId
            : (primaryStorage?.id ?? null)
    }

    const inventoryRows = await getInventoryRowsForProduct(input.productId)
    const activeInventoryStorageIds = Array.from(new Set(
        inventoryRows
            .map((row) => row.storageId)
            .filter((storageId) => activeStorageMap.has(storageId))
    ))

    if (activeInventoryStorageIds.length === 1) {
        return activeInventoryStorageIds[0]
    }

    const product = await db.products.get(input.productId)
    if (product?.storageId && activeStorageMap.has(product.storageId)) {
        return product.storageId
    }

    return primaryStorage?.id ?? activeInventoryStorageIds[0] ?? null
}
