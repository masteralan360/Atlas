import { resolvedSupabaseAnonKey, resolvedSupabaseUrl } from '@/auth/supabase'

export type MarketplaceLanguage = 'en' | 'ar' | 'ku'

export interface MarketplaceStoreSummary {
    name: string
    slug: string
    description: string | null
    logo_url: string | null
    default_currency: string
    product_count: number
    category_count: number
}

export interface MarketplaceStoreContact {
    type: string
    value: string
    label?: string | null
    is_primary: boolean
}

export interface MarketplaceCategory {
    id: string
    name: string
}

export interface MarketplaceProduct {
    id: string
    name: string
    sku: string
    description: string
    price: number
    currency: string
    unit: string
    category_id: string | null
    category_name: string | null
    image_url: string | null
    discount_price: number | null
    discount_type: string | null
    discount_value: number | null
    discount_ends_at: string | null
}

export interface MarketplaceStoreCatalog {
    store: {
        name: string
        slug: string
        description: string | null
        logo_url: string | null
        currency: string
        contacts: MarketplaceStoreContact[]
    }
    categories: MarketplaceCategory[]
    products: MarketplaceProduct[]
}

export interface MarketplaceOrderCustomer {
    name: string
    phone: string
    email?: string
    city?: string
    address?: string
    notes?: string
}

export interface MarketplaceOrderItemInput {
    product_id: string
    quantity: number
}

export interface MarketplaceOrderResponse {
    order_number: string
    message: string
}

export class MarketplaceApiError extends Error {
    status: number

    constructor(message: string, status: number) {
        super(message)
        this.name = 'MarketplaceApiError'
        this.status = status
    }
}

const functionBaseUrl = `${resolvedSupabaseUrl.replace(/\/+$/, '')}/functions/v1`

const publicHeaders: HeadersInit = {
    apikey: resolvedSupabaseAnonKey,
    Authorization: `Bearer ${resolvedSupabaseAnonKey}`
}

async function parseError(response: Response) {
    try {
        const payload = await response.json() as { error?: string }
        return payload.error || `Request failed with status ${response.status}`
    } catch {
        return `Request failed with status ${response.status}`
    }
}

async function request<T>(path: string, init?: RequestInit) {
    const response = await fetch(`${functionBaseUrl}/${path}`, {
        ...init,
        headers: {
            ...publicHeaders,
            ...(init?.headers || {})
        }
    })

    if (!response.ok) {
        throw new MarketplaceApiError(await parseError(response), response.status)
    }

    return await response.json() as T
}

export async function getMarketplaceStores(language: MarketplaceLanguage) {
    const payload = await request<{ stores: MarketplaceStoreSummary[] }>(`get-marketplace-stores?lang=${encodeURIComponent(language)}`)
    return payload.stores
}

export async function getStoreCatalog(slug: string, language: MarketplaceLanguage) {
    return await request<MarketplaceStoreCatalog>(
        `get-store-catalog?slug=${encodeURIComponent(slug)}&lang=${encodeURIComponent(language)}`
    )
}

export async function placeInquiryOrder(input: {
    store_slug: string
    customer: MarketplaceOrderCustomer
    items: MarketplaceOrderItemInput[]
    lang: MarketplaceLanguage
}) {
    return await request<MarketplaceOrderResponse>('place-inquiry-order', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(input)
    })
}
