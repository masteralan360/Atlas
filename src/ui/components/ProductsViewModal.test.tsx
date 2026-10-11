import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Product } from '@/local-db'
import { ProductsViewModal } from './ProductsViewModal'

const { filterSelectableProducts } = vi.hoisted(() => ({
    filterSelectableProducts: vi.fn((products: unknown[]) => products)
}))

vi.hoisted(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: () => null,
            setItem: () => undefined,
            removeItem: () => undefined
        }
    })
})

vi.mock('@/auth', () => ({
    useOptionalAuth: () => undefined
}))

vi.mock('@/lib/productImageStorage', () => ({
    getProductImageDisplayUrl: (url: string) => url
}))

vi.mock('@/local-db', () => ({
    useProductSelectionAccess: () => ({
        canSelectProduct: () => true,
        filterProducts: filterSelectableProducts,
        storageAccess: {
            signature: 'all',
            canAccessStorage: () => true
        }
    })
}))

vi.mock('@/ui/components', () => ({
    Button: () => null,
    Dialog: () => null,
    DialogContent: () => null,
    DialogDescription: () => null,
    DialogHeader: () => null,
    DialogTitle: () => null,
    Input: () => null,
    Label: () => null,
    Select: () => null,
    SelectContent: () => null,
    SelectItem: () => null,
    SelectTrigger: () => null,
    SelectValue: () => null
}))

function renderPicker(open: boolean, products: Product[]) {
    return renderToStaticMarkup(
        <ProductsViewModal
            open={open}
            onOpenChange={() => undefined}
            products={products}
            storages={[]}
            onSelectProduct={() => undefined}
        />
    )
}

describe('ProductsViewModal catalog work', () => {
    beforeEach(() => {
        filterSelectableProducts.mockClear()
    })

    it('does not scan a large product catalog while the shared picker is closed', () => {
        const products = Array.from({ length: 2018 }, (_, index) => ({ id: String(index) }) as unknown as Product)

        expect(renderPicker(false, products)).toBe('')
        expect(filterSelectableProducts).not.toHaveBeenCalled()
    })

    it('filters the catalog when the picker opens', () => {
        const products = [{ id: 'product-1' } as unknown as Product]

        renderPicker(true, products)

        expect(filterSelectableProducts).toHaveBeenCalledTimes(1)
        expect(filterSelectableProducts).toHaveBeenCalledWith(products)
    })
})
