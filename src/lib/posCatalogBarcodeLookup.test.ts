import { describe, expect, it } from 'vitest'

import { findPosBarcodeCandidates, getPosBarcodeLookupProducts } from './posCatalogBarcodeLookup'

describe('POS catalog barcode lookup', () => {
    const inventoryProduct = { id: 'product-1', sku: 'PRD-001', storageId: 'storage-1' }
    const service = { id: 'service-1', sku: 'SVC-001', storageId: '__atlas_services__' }

    it('uses the services catalog when the Services virtual storage is active', () => {
        expect(getPosBarcodeLookupProducts([inventoryProduct], [service], true)).toEqual([service])
        expect(getPosBarcodeLookupProducts([inventoryProduct], [service], false)).toEqual([inventoryProduct])
    })

    it('resolves service SKUs and barcode aliases within the active catalog', () => {
        const scannableProducts = getPosBarcodeLookupProducts([inventoryProduct], [service], true)

        expect(findPosBarcodeCandidates(' svc-001 ', scannableProducts, new Map())).toEqual([service])
        expect(findPosBarcodeCandidates('SERVICE-CODE', scannableProducts, new Map([
            ['SERVICE-CODE', service.id]
        ]))).toEqual([service])
        expect(findPosBarcodeCandidates('PRD-001', scannableProducts, new Map())).toEqual([])
    })
})
