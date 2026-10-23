import { normalizeBarcodeScannerText } from './barcodeScanner'
import type { Product, ProductBarcode } from '@/local-db/models'

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
