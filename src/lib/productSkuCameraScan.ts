import { normalizeBarcodeScannerText } from '@/lib/barcodeScanner'

export type CameraBarcodeCapture = {
    rawValue?: string | null
}

/** Returns the first readable SKU from the camera scanner's detected codes. */
export function getProductSkuFromCameraCapture(
    barcodes: readonly CameraBarcodeCapture[]
): string | null {
    for (const barcode of barcodes) {
        const sku = normalizeBarcodeScannerText(barcode.rawValue)
        if (sku) {
            return sku
        }
    }

    return null
}
