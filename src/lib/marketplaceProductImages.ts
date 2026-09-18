import type { Product } from '@/local-db'

/**
 * E-commerce order visuals always use the current product record. Order-item
 * JSON remains an immutable commercial snapshot, but never supplies an image
 * for rendering.
 */
export type MarketplaceProductImageUrls = ReadonlyMap<string, string | null | undefined>

export function createMarketplaceProductImageUrls(
    products: Iterable<Pick<Product, 'id' | 'imageUrl'>>
): MarketplaceProductImageUrls {
    return new Map(Array.from(products, (product) => [product.id, product.imageUrl]))
}

export function getMarketplaceProductImageUrl(
    productId: string,
    productImageUrls: MarketplaceProductImageUrls
): string | null {
    return productImageUrls.get(productId) ?? null
}
