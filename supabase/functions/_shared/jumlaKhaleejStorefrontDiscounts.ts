import type { ResolvedWorkspaceDiscountRow } from './discounts.ts'

type JumlaKhaleejStorefrontProduct = {
    id: string
    parent_product_id: string | null
}

/**
 * Jumla Khaleej treats a product-family discount as applying to every
 * storefront variant. A variant-specific product discount takes precedence;
 * otherwise a parent product discount takes precedence over a category rule.
 */
export function getJumlaKhaleejStorefrontDiscount(
    product: JumlaKhaleejStorefrontProduct,
    discountsByProductId: ReadonlyMap<string, ResolvedWorkspaceDiscountRow>
) {
    const productDiscount = discountsByProductId.get(product.id)
    const inheritedParentDiscount = product.parent_product_id
        ? discountsByProductId.get(product.parent_product_id)
        : undefined
    const parentProductDiscount = inheritedParentDiscount?.source === 'product'
        ? inheritedParentDiscount
        : undefined

    if (productDiscount?.source === 'product') return productDiscount
    if (parentProductDiscount) return parentProductDiscount
    return productDiscount
}
