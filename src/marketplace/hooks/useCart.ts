import { useCallback, useEffect, useRef, useState } from 'react'

import type { MarketplaceProduct } from '../lib/marketplaceApi'

export interface MarketplaceCartItem {
    product_id: string
    name: string
    sku: string
    unit_price: number
    original_unit_price: number
    currency: string
    image_url: string | null
    unit: string
    quantity: number
    discount_type: string | null
    discount_value: number | null
    discount_ends_at: string | null
    stock_quantity?: number
    storage_id?: string
}

function readCart(storageKey: string) {
    try {
        const raw = window.localStorage.getItem(storageKey)
        if (!raw) {
            return []
        }

        const parsed = JSON.parse(raw) as MarketplaceCartItem[]
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

export function mergeCartWithCatalog(
    currentItems: MarketplaceCartItem[],
    products: MarketplaceProduct[]
) {
    const productsById = new Map(products.map((product) => [product.id, product]))

    return currentItems.map((item) => {
        const latest = productsById.get(item.product_id)
        if (!latest) return item

        return {
            ...item,
            name: latest.name,
            sku: latest.sku,
            unit_price: latest.discount_price ?? latest.price,
            original_unit_price: latest.price,
            currency: latest.currency,
            image_url: latest.image_url,
            unit: latest.unit,
            discount_type: latest.discount_type,
            discount_value: latest.discount_value,
            discount_ends_at: latest.discount_ends_at,
            stock_quantity: latest.stock_quantity ?? item.stock_quantity,
            storage_id: latest.source_storage_id
        }
    })
}

export function hasInsufficientMarketplaceStock(items: MarketplaceCartItem[]) {
    return items.some((item) => Number.isFinite(item.stock_quantity)
        && (Number(item.stock_quantity) <= 0 || item.quantity > Number(item.stock_quantity)))
}

export function useCart(storeSlug: string) {
    const storageKey = `atlas.marketplace.cart.${storeSlug}`
    const [items, setItems] = useState<MarketplaceCartItem[]>([])
    const itemsRef = useRef<MarketplaceCartItem[]>([])
    const hydratedStorageKeyRef = useRef<string | null>(null)
    const skipPersistenceRef = useRef(false)

    const updateItems = useCallback((update: (currentItems: MarketplaceCartItem[]) => MarketplaceCartItem[]) => {
        const nextItems = update(itemsRef.current)
        itemsRef.current = nextItems
        setItems(nextItems)
    }, [])

    useEffect(() => {
        if (!storeSlug) {
            itemsRef.current = []
            setItems([])
            return
        }

        const storedItems = readCart(storageKey)
        itemsRef.current = storedItems
        hydratedStorageKeyRef.current = storageKey
        skipPersistenceRef.current = true
        setItems(storedItems)
    }, [storageKey, storeSlug])

    useEffect(() => {
        if (!storeSlug || hydratedStorageKeyRef.current !== storageKey) {
            return
        }

        if (skipPersistenceRef.current) {
            skipPersistenceRef.current = false
            return
        }

        window.localStorage.setItem(storageKey, JSON.stringify(items))
    }, [items, storageKey, storeSlug])

    const addItem = (product: MarketplaceProduct) => {
        const currentItems = itemsRef.current
        const stockQuantity = Number(product.stock_quantity)
        const hasKnownStock = Number.isFinite(product.stock_quantity)

        if (hasKnownStock && stockQuantity <= 0) {
            return { ok: false, reason: 'out-of-stock' as const }
        }

        if (hasKnownStock && stockQuantity < 1) {
            return { ok: false, reason: 'insufficient-stock' as const }
        }

        if (
            currentItems.length > 0
            && currentItems[0].currency.toLowerCase() !== product.currency.toLowerCase()
        ) {
            return { ok: false, reason: 'mixed-currency' as const }
        }

        const existingItem = currentItems.find((item) => item.product_id === product.id)
        if (existingItem && hasKnownStock && existingItem.quantity + 1 > stockQuantity) {
            return { ok: false, reason: 'insufficient-stock' as const }
        }

        updateItems((current) => {
            const currentItem = current.find((item) => item.product_id === product.id)
            if (currentItem) {
                if (hasKnownStock && currentItem.quantity + 1 > stockQuantity) return current
                return current.map((item) => item.product_id === product.id
                    ? { ...item, quantity: item.quantity + 1 }
                    : item
                )
            }

            return [
                ...current,
                {
                    product_id: product.id,
                    name: product.name,
                    sku: product.sku,
                    unit_price: product.discount_price ?? product.price,
                    original_unit_price: product.price,
                    currency: product.currency,
                    image_url: product.image_url,
                    unit: product.unit,
                    quantity: 1,
                    discount_type: product.discount_type,
                    discount_value: product.discount_value,
                    discount_ends_at: product.discount_ends_at,
                    stock_quantity: product.stock_quantity,
                    storage_id: product.source_storage_id
                }
            ]
        })

        return {
            ok: true,
            reason: null
        }
    }

    const setQuantity = (productId: string, quantity: number) => {
        updateItems((currentItems) => currentItems
            .map((item) => {
                if (item.product_id !== productId) return item
                const nextQuantity = Number.isFinite(item.stock_quantity)
                    ? Math.min(quantity, Math.max(0, Number(item.stock_quantity)))
                    : quantity
                return { ...item, quantity: nextQuantity }
            })
            .filter((item) => item.quantity > 0)
        )
    }

    const removeItem = (productId: string) => {
        updateItems((currentItems) => currentItems.filter((item) => item.product_id !== productId))
    }

    const clearCart = () => {
        updateItems(() => [])
    }

    const syncCatalog = useCallback((products: MarketplaceProduct[]) => {
        updateItems((currentItems) => mergeCartWithCatalog(currentItems, products))
    }, [updateItems])

    const itemCount = items.reduce((sum, item) => sum + item.quantity, 0)
    const total = items.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0)
    const currency = items[0]?.currency ?? null

    return {
        items,
        itemCount,
        total,
        currency,
        addItem,
        setQuantity,
        removeItem,
        clearCart,
        syncCatalog
    }
}
