import { normalizeBarcodeScannerText } from '@/lib/barcodeScanner'

export type PosBarcodeLookupProduct = {
    id: string
    sku: string
}

export function getPosBarcodeLookupProducts<
    TInventory extends PosBarcodeLookupProduct,
    TService extends PosBarcodeLookupProduct
>(
    inventoryProducts: readonly TInventory[],
    serviceProducts: readonly TService[],
    isServicesStorage: boolean
): readonly (TInventory | TService)[] {
    return isServicesStorage ? serviceProducts : inventoryProducts
}

export function findPosBarcodeCandidates<T extends PosBarcodeLookupProduct>(
    scannedValue: string,
    products: readonly T[],
    barcodeMap: ReadonlyMap<string, string>
): T[] {
    const normalizedValue = normalizeBarcodeScannerText(scannedValue)
    if (!normalizedValue) {
        return []
    }

    const normalizedTerm = normalizedValue.toLowerCase()
    const barcodeProductId = barcodeMap.get(normalizedValue) ?? barcodeMap.get(normalizedTerm)

    return barcodeProductId
        ? products.filter((product) => product.id === barcodeProductId)
        : products.filter((product) => product.sku.toLowerCase() === normalizedTerm)
}
