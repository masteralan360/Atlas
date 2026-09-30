import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { ProductMinimumSellingPriceDisclosure } from './ProductMinimumSellingPriceDisclosure'

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

function renderDisclosure(open: boolean, value = '') {
    return renderToStaticMarkup(
        <ProductMinimumSellingPriceDisclosure
            enabled
            open={open}
            onOpenChange={() => undefined}
            value={value}
            onValueChange={() => undefined}
            currencySymbol="IQD"
            readOnly={false}
            minimumPriceLabel="Minimum Selling Price"
            invalidLabel="Enter a valid minimum selling price of 0 or more."
            showLabel="Show minimum selling price"
            hideLabel="Hide minimum selling price"
        >
            {(toggleButton) => (
                <div className="flex">
                    <input aria-label="Selling Price" />
                    {toggleButton}
                </div>
            )}
        </ProductMinimumSellingPriceDisclosure>
    )
}

describe('ProductMinimumSellingPriceDisclosure', () => {
    it('keeps the minimum-price field hidden by default and exposes an accessible attached trigger', () => {
        const html = renderDisclosure(false)

        expect(html).toContain('aria-expanded="false"')
        expect(html).toContain('aria-label="Show minimum selling price"')
        expect(html).not.toContain('id="product-minimum-selling-price"')
    })

    it('renders the editable minimum-price field when opened and reports invalid values', () => {
        const html = renderDisclosure(true, '-1')

        expect(html).toContain('aria-expanded="true"')
        expect(html).toContain('aria-label="Hide minimum selling price"')
        expect(html).toContain('id="product-minimum-selling-price"')
        expect(html).toContain('aria-invalid="true"')
        expect(html).toContain('Enter a valid minimum selling price of 0 or more.')
    })

    it('keeps the control unavailable when minimum-price management is disabled', () => {
        const html = renderToStaticMarkup(
            <ProductMinimumSellingPriceDisclosure
                enabled={false}
                open={false}
                onOpenChange={() => undefined}
                value=""
                onValueChange={() => undefined}
                currencySymbol="IQD"
                readOnly={false}
                minimumPriceLabel="Minimum Selling Price"
                invalidLabel="Invalid minimum price"
                showLabel="Show minimum selling price"
                hideLabel="Hide minimum selling price"
            >
                {(toggleButton) => <div>{toggleButton}</div>}
            </ProductMinimumSellingPriceDisclosure>
        )

        expect(html).not.toContain('aria-label="Show minimum selling price"')
        expect(html).not.toContain('id="product-minimum-selling-price"')
    })
})
