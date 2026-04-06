import { useEffect, useState } from 'react'

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

export function useCart(storeSlug: string) {
    const storageKey = `atlas.marketplace.cart.${storeSlug}`
    const [items, setItems] = useState<MarketplaceCartItem[]>([])

    useEffect(() => {
        if (!storeSlug) {
            setItems([])
            return
        }

        setItems(readCart(storageKey))
    }, [storageKey, storeSlug])

    useEffect(() => {
        if (!storeSlug) {
            return
        }

        window.localStorage.setItem(storageKey, JSON.stringify(items))
    }, [items, storageKey, storeSlug])

    const addItem = (product: MarketplaceProduct) => {
        let wasAdded = true
        let reason: 'mixed-currency' | null = null

        setItems((currentItems) => {
            if (
                currentItems.length > 0
                && currentItems[0].currency.toLowerCase() !== product.currency.toLowerCase()
            ) {
                wasAdded = false
                reason = 'mixed-currency'
                return currentItems
            }

            const existingItem = currentItems.find((item) => item.product_id === product.id)
            if (existingItem) {
                return currentItems.map((item) => item.product_id === product.id
                    ? { ...item, quantity: item.quantity + 1 }
                    : item
                )
            }

            return [
                ...currentItems,
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
                    discount_ends_at: product.discount_ends_at
                }
            ]
        })

        return {
            ok: wasAdded,
            reason
        }
    }

    const setQuantity = (productId: string, quantity: number) => {
        setItems((currentItems) => currentItems
            .map((item) => item.product_id === productId ? { ...item, quantity } : item)
            .filter((item) => item.quantity > 0)
        )
    }

    const removeItem = (productId: string) => {
        setItems((currentItems) => currentItems.filter((item) => item.product_id !== productId))
    }

    const clearCart = () => {
        setItems([])
    }

    const syncCatalog = (products: MarketplaceProduct[]) => {
        const productsById = new Map(products.map((product) => [product.id, product]))
        setItems((currentItems) => currentItems
            .map((item) => {
                const latest = productsById.get(item.product_id)
                if (!latest) {
                    return null
                }

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
                    discount_ends_at: latest.discount_ends_at
                }
            })
            .filter((item): item is MarketplaceCartItem => Boolean(item))
        )
    }

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
