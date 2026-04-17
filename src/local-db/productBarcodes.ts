import { db } from './database'
import type { Product, ProductBarcode } from './models'

export class DuplicateProductBarcodeError extends Error {
    readonly code = 'PRODUCT_BARCODE_DUPLICATE'

    constructor(message = 'This barcode is already assigned to another product.') {
        super(message)
        this.name = 'DuplicateProductBarcodeError'
    }
}

export function normalizeProductBarcodeValue(value: string): string {
    return value.trim()
}

export function normalizeProductBarcodeLabel(value?: string | null): string | undefined {
    const normalized = value?.trim()
    return normalized ? normalized : undefined
}

function compareStringArrays(a: string[] | undefined, b: string[]) {
    if ((a?.length ?? 0) !== b.length) {
        return false
    }

    return (a ?? []).every((value, index) => value === b[index])
}

export function compareProductBarcodes(a: ProductBarcode, b: ProductBarcode) {
    if (a.isPrimary !== b.isPrimary) {
        return a.isPrimary ? -1 : 1
    }

    if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt)
    }

    return a.barcode.localeCompare(b.barcode)
}

export function sortProductBarcodes(rows: ProductBarcode[]) {
    return [...rows].sort(compareProductBarcodes)
}

export async function findActiveProductBarcodeByValue(
    workspaceId: string,
    barcode: string,
    options?: { excludeId?: string }
) {
    const normalizedBarcode = normalizeProductBarcodeValue(barcode)
    if (!workspaceId || !normalizedBarcode) {
        return undefined
    }

    return db.product_barcodes
        .where('[workspaceId+barcode]')
        .equals([workspaceId, normalizedBarcode])
        .and((row) => !row.isDeleted && row.id !== options?.excludeId)
        .first()
}

function buildProductBarcodeCache(rows: ProductBarcode[]) {
    const sortedRows = sortProductBarcodes(rows.filter((row) => !row.isDeleted))
    const cachedBarcodes = sortedRows.map((row) => row.barcode)
    const primaryBarcode = sortedRows.find((row) => row.isPrimary)?.barcode ?? cachedBarcodes[0]
    return {
        barcode: primaryBarcode,
        barcodes: cachedBarcodes
    }
}

function productBarcodeCacheChanged(product: Product, nextCache: { barcode?: string; barcodes: string[] }) {
    return product.barcode !== nextCache.barcode || !compareStringArrays(product.barcodes, nextCache.barcodes)
}

export async function syncProductBarcodeCache(productId: string): Promise<void> {
    if (!productId) {
        return
    }

    const [product, barcodeRows] = await Promise.all([
        db.products.get(productId),
        db.product_barcodes.where('productId').equals(productId).toArray()
    ])

    if (!product) {
        return
    }

    const nextCache = buildProductBarcodeCache(barcodeRows)
    if (!productBarcodeCacheChanged(product, nextCache)) {
        return
    }

    await db.products.update(productId, nextCache)
}

export async function syncProductBarcodeCachesForWorkspace(workspaceId: string): Promise<void> {
    if (!workspaceId) {
        return
    }

    const [products, barcodeRows] = await Promise.all([
        db.products.where('workspaceId').equals(workspaceId).toArray(),
        db.product_barcodes.where('workspaceId').equals(workspaceId).toArray()
    ])

    if (products.length === 0) {
        return
    }

    const rowsByProductId = new Map<string, ProductBarcode[]>()
    for (const row of barcodeRows) {
        if (row.isDeleted) {
            continue
        }

        const productRows = rowsByProductId.get(row.productId) ?? []
        productRows.push(row)
        rowsByProductId.set(row.productId, productRows)
    }

    const productsToUpdate: Product[] = []
    for (const product of products) {
        const nextCache = buildProductBarcodeCache(rowsByProductId.get(product.id) ?? [])
        if (!productBarcodeCacheChanged(product, nextCache)) {
            continue
        }

        productsToUpdate.push({
            ...product,
            ...nextCache
        })
    }

    if (productsToUpdate.length === 0) {
        return
    }

    await db.products.bulkPut(productsToUpdate)
}
