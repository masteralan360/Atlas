import type { BusinessPartner, CurrencyCode, PriceBook, PriceBookItem, PriceBookUnitPrice, Product } from '@/local-db/models'

export function resolvePartnerPriceBookUnitPrice(
    priceBookItem: Pick<PriceBookItem, 'price' | 'currency'>,
    productCurrency: CurrencyCode,
    unitOption?: Pick<{ isBase: boolean; sellingPrice: number }, 'isBase' | 'sellingPrice'> | null,
    priceBookUnitPrice?: Pick<PriceBookUnitPrice, 'price' | 'currency'> | null
) {
    if (priceBookUnitPrice) {
        return { price: priceBookUnitPrice.price, currency: priceBookUnitPrice.currency }
    }

    if (unitOption && !unitOption.isBase) {
        return { price: unitOption.sellingPrice, currency: productCurrency }
    }

    // A product's base-unit price book row is the override for its base UOM.
    // The product UOM selling price is only the fallback for alternate units.
    return { price: priceBookItem.price, currency: priceBookItem.currency }
}

export function findPartnerProductPriceBookItem(
    enabled: boolean,
    partner: Pick<BusinessPartner, 'priceBookId'> | null | undefined,
    product: Pick<Product, 'id'> | string | null | undefined,
    priceBooks: readonly PriceBook[],
    priceBookItems: readonly PriceBookItem[]
) {
    if (!enabled || !partner?.priceBookId || !product) {
        return undefined
    }

    const productId = typeof product === 'string' ? product : product.id
    const hasActiveBook = priceBooks.some((book) => (
        book.id === partner.priceBookId && !book.isDeleted
    ))
    if (!hasActiveBook) {
        return undefined
    }

    return priceBookItems.find((item) => (
        !item.isDeleted
        && item.priceBookId === partner.priceBookId
        && item.productId === productId
    ))
}
