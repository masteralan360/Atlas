import { normalizeBarcodeScannerText } from './barcodeScanner'
import type { Product, ProductBarcode } from '@/local-db/models'

type OrderBarcodeLine = {
    storageId?: string | null
    productId?: string | null
}

/**
 * Finds the catalog product assigned to a scanned code. Product barcode rows
 * take precedence over the legacy barcode cache on the product record.
 */
export function findProductByOrderBarcode(
    products: Product[],
    productBarcodes: ProductBarcode[],
    scannedValue: string
): Product | undefined {
    const barcode = normalizeBarcodeScannerText(scannedValue)
    if (!barcode) return undefined

    const normalizedBarcode = barcode.toLowerCase()
    const barcodeProductId = productBarcodes.find((entry) => (
        normalizeBarcodeScannerText(entry.barcode).toLowerCase() === normalizedBarcode
    ))?.productId

    if (barcodeProductId) {
        return products.find((product) => product.id === barcodeProductId)
    }

    return products.find((product) => (
        normalizeBarcodeScannerText(product.sku).toLowerCase() === normalizedBarcode
        || normalizeBarcodeScannerText(product.barcode).toLowerCase() === normalizedBarcode
        || product.barcodes?.some((entry) => (
            normalizeBarcodeScannerText(entry).toLowerCase() === normalizedBarcode
        ))
    ))
}

/**
 * A directly focused product input always owns the scan. Without one, order
 * rows are filled in their creation order, even though the UI renders the
 * newest row first. The first unfilled line in that entry order must have a
 * storage selected before it can accept a barcode.
 */
export function getOrderBarcodeTargetIndex(
    items: OrderBarcodeLine[],
    focusedProductInputIndex: number | null
): number | null {
    if (
        focusedProductInputIndex !== null
        && focusedProductInputIndex >= 0
        && focusedProductInputIndex < items.length
    ) {
        return focusedProductInputIndex
    }

    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        const item = items[itemIndex]
        if (!item?.productId) {
            return item.storageId ? itemIndex : null
        }
    }

    return null
}
