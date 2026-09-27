import { createAdminClient } from './supabase.ts'
import {
    getStorefrontStorageIds,
    type StorefrontCatalogRule
} from './storefrontCatalogRules.ts'

export type { StorefrontCatalogRule } from './storefrontCatalogRules.ts'

const PUBLIC_ASSET_FOLDERS = new Set([
    'product-images',
    'workspace-logos',
    'profile-images'
])

const LEGACY_PUBLIC_ASSET_FOLDERS = new Set([
    'workspaces'
])

const MARKETPLACE_ASSET_FOLDERS = new Set([
    ...PUBLIC_ASSET_FOLDERS,
    ...LEGACY_PUBLIC_ASSET_FOLDERS
])

const ORDER_MESSAGES: Record<'en' | 'ar' | 'ku', string> = {
    en: 'Order submitted successfully. The store will contact you shortly.',
    ar: 'تم إرسال الطلب بنجاح. سيتواصل المتجر معك قريبًا.',
    ku: 'داواکاریەکەت بە سەرکەوتوویی نێردرا. فرۆشگا بە زوویی پەیوەندیت پێوە دەکات.'
}

function normalizeR2Path(path: string) {
    return path
        .split('/')
        .filter(Boolean)
        .map((segment) => {
            try {
                return encodeURIComponent(decodeURIComponent(segment))
            } catch {
                return encodeURIComponent(segment)
            }
        })
        .join('/')
}

type ResolvedMarketplaceAsset = {
    canonicalPath: string
    r2Key: string
}

function resolveMarketplaceAsset(path: string): ResolvedMarketplaceAsset | null {
    const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
    if (segments.length < 3) {
        return null
    }

    for (let index = 0; index <= segments.length - 3; index += 1) {
        const folder = segments[index]
        const workspaceId = segments[index + 1]
        const filePath = segments.slice(index + 2).join('/')

        if (!MARKETPLACE_ASSET_FOLDERS.has(folder) || !workspaceId || !filePath) {
            continue
        }

        return {
            canonicalPath: `${folder}/${workspaceId}/${filePath}`,
            r2Key: `${workspaceId}/${folder}/${filePath}`
        }
    }

    for (let index = 0; index <= segments.length - 3; index += 1) {
        const workspaceId = segments[index]
        const folder = segments[index + 1]
        const filePath = segments.slice(index + 2).join('/')

        if (!MARKETPLACE_ASSET_FOLDERS.has(folder) || !workspaceId || !filePath) {
            continue
        }

        return {
            canonicalPath: `${folder}/${workspaceId}/${filePath}`,
            r2Key: `${workspaceId}/${folder}/${filePath}`
        }
    }

    return null
}

function getMarketplaceAssetBaseUrl() {
    for (const key of ['R2_PUBLIC_BASE_URL', 'R2_WORKER_PUBLIC_BASE_URL', 'R2_WORKER_URL', 'VITE_R2_WORKER_URL']) {
        const value = (Deno.env.get(key) ?? '').trim().replace(/\/+$/, '')
        if (value) {
            return value
        }
    }

    return ''
}

function getMarketplaceAssetServiceToken() {
    for (const key of ['R2_WORKER_SERVICE_TOKEN', 'R2_SERVICE_TOKEN']) {
        const value = (Deno.env.get(key) ?? '').trim()
        if (value) {
            return value
        }
    }

    return ''
}

export function getMarketplaceAssetUrlFromKey(key?: string | null): string | null {
    const normalizedKey = sanitizeMarketplaceText(key, 4096)
    if (!normalizedKey) {
        return null
    }

    const baseUrl = getMarketplaceAssetBaseUrl()
    if (!baseUrl) {
        return null
    }

    return `${baseUrl}/${normalizeR2Path(normalizedKey.replace(/^\/+/, ''))}`
}

export async function listMarketplaceAssetKeys(prefix: string): Promise<string[]> {
    const baseUrl = getMarketplaceAssetBaseUrl()
    const serviceToken = getMarketplaceAssetServiceToken()
    const normalizedPrefix = sanitizeMarketplaceText(prefix, 1024)

    if (!baseUrl || !serviceToken || !normalizedPrefix) {
        return []
    }

    try {
        const listUrl = new URL(`${baseUrl}/`)
        listUrl.searchParams.set('list', '1')
        listUrl.searchParams.set('prefix', normalizedPrefix)

        const response = await fetch(listUrl.toString(), {
            headers: {
                'X-R2-Service-Token': serviceToken
            }
        })

        if (!response.ok) {
            console.warn('[marketplace] Failed to list R2 assets', normalizedPrefix, response.status)
            return []
        }

        const payload = await response.json() as { keys?: unknown }
        if (!Array.isArray(payload.keys)) {
            return []
        }

        return payload.keys.filter((value): value is string => typeof value === 'string')
    } catch (error) {
        console.warn('[marketplace] Failed to list R2 assets', normalizedPrefix, error)
        return []
    }
}

export async function listMarketplaceAssetUrls(prefixes: string[], limit?: number): Promise<string[]> {
    if (prefixes.length === 0) {
        return []
    }

    const keyGroups = await Promise.all(prefixes.map((prefix) => listMarketplaceAssetKeys(prefix)))
    const keys = Array.from(new Set(keyGroups.flat()))
        .sort((left, right) => left.localeCompare(right))

    const selectedKeys = typeof limit === 'number' && limit >= 0
        ? keys.slice(Math.max(keys.length - limit, 0))
        : keys

    return selectedKeys
        .map((key) => getMarketplaceAssetUrlFromKey(key))
        .filter((value): value is string => Boolean(value))
}

export function normalizeMarketplaceLanguage(value?: string | null): 'en' | 'ar' | 'ku' {
    const normalized = (value ?? '').trim().toLowerCase()
    if (normalized === 'ar' || normalized === 'ku') {
        return normalized
    }

    return 'en'
}

export function getLocalizedMarketplaceOrderMessage(language?: string | null) {
    return ORDER_MESSAGES[normalizeMarketplaceLanguage(language)]
}

export function sanitizeMarketplaceText(value: unknown, maxLength = 240) {
    if (typeof value !== 'string') {
        return ''
    }

    return value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/[<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength)
}

export function sanitizeNullableMarketplaceText(value: unknown, maxLength = 240) {
    const sanitized = sanitizeMarketplaceText(value, maxLength)
    return sanitized.length > 0 ? sanitized : null
}

export function resolvePublicAssetUrl(rawPath?: string | null): string | null {
    const path = sanitizeMarketplaceText(rawPath, 4096)
    if (!path) {
        return null
    }

    if (/^https?:\/\//i.test(path) || /^data:image\//i.test(path)) {
        return path
    }

    let normalizedPath = path.replace(/\\/g, '/')

    if (/^file:\/\//i.test(normalizedPath)) {
        try {
            normalizedPath = decodeURIComponent(new URL(normalizedPath).pathname)
        } catch {
            return null
        }
    } else if (/^(data|blob):/i.test(normalizedPath)) {
        return null
    }

    const resolvedAsset = resolveMarketplaceAsset(normalizedPath)
    if (!resolvedAsset) {
        return null
    }

    const baseUrl = getMarketplaceAssetBaseUrl()
    if (!baseUrl) {
        return resolvedAsset.canonicalPath
    }

    return `${baseUrl}/${normalizeR2Path(resolvedAsset.r2Key)}`
}

export function getRequesterIp(req: Request) {
    const forwardedFor = req.headers.get('x-forwarded-for')
    if (forwardedFor) {
        const firstIp = forwardedFor.split(',')[0]?.trim()
        if (firstIp) {
            return firstIp
        }
    }

    return sanitizeNullableMarketplaceText(
        req.headers.get('cf-connecting-ip')
        ?? req.headers.get('x-real-ip')
        ?? req.headers.get('fly-client-ip')
        ?? req.headers.get('x-vercel-forwarded-for'),
        128
    )
}

export async function hashMarketplaceValue(value: string) {
    const bytes = new TextEncoder().encode(value)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest))
        .map((part) => part.toString(16).padStart(2, '0'))
        .join('')
}

export function isMarketplaceOriginAllowed(origin: string | null) {
    const allowlist = (Deno.env.get('MARKETPLACE_ALLOWED_ORIGINS') ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)

    if (allowlist.length === 0) {
        return true
    }

    if (!origin) {
        return false
    }

    return allowlist.includes(origin)
}

export async function fetchStorefrontCatalogRules(
    adminClient: ReturnType<typeof createAdminClient>,
    workspaceId: string,
    storefrontId?: string | null
): Promise<StorefrontCatalogRule[]> {
    let query = adminClient
        .from('workspace_storefront_catalog_rules')
        .select('rule_type, target_type, price_book_id, storage_id, override_prices')
        .eq('workspace_id', workspaceId)

    query = storefrontId
        ? query.eq('storefront_id', storefrontId)
        : query.is('storefront_id', null)

    const { data, error } = await query

    if (error) {
        throw error
    }

    return ((data ?? []) as {
        rule_type: string
        target_type: string | null
        price_book_id: string | null
        storage_id: string | null
        override_prices: boolean | null
    }[]).map((row) => ({
        rule_type: row.rule_type === 'exclusion' ? 'exclusion' : 'inclusion',
        target_type: row.target_type === 'storage'
            ? 'storage'
            : row.target_type === 'price_book' || row.price_book_id
                ? 'price_book'
                : 'native',
        price_book_id: row.price_book_id,
        storage_id: row.storage_id,
        override_prices: Boolean(row.override_prices)
    }))
}

/**
 * Resolves this storefront's inventory sources. Explicit storage inclusion
 * rules replace the workspace's designated Marketplace storage; exclusion-only
 * rules filter that default source list. Only active storages in this workspace
 * can be returned.
 */
export async function resolveStorefrontStorageIds(
    adminClient: ReturnType<typeof createAdminClient>,
    workspaceId: string,
    options?: {
        storefrontId?: string | null
        rules?: StorefrontCatalogRule[]
        defaultStorageIds?: string[]
    }
) {
    const rules = options?.rules ?? await fetchStorefrontCatalogRules(adminClient, workspaceId, options?.storefrontId)
    const hasStorageInclusions = rules.some((rule) => rule.target_type === 'storage' && rule.rule_type === 'inclusion')
    let defaultStorageIds = options?.defaultStorageIds

    if (!hasStorageInclusions && !defaultStorageIds) {
        const { data, error } = await adminClient.rpc('ensure_marketplace_storage', { p_workspace_id: workspaceId })
        if (error) throw error
        defaultStorageIds = typeof data === 'string' && data ? [data] : []
    }

    const configuredStorageIds = getStorefrontStorageIds(defaultStorageIds ?? [], rules)
    if (configuredStorageIds.length === 0) return []

    const { data, error } = await adminClient
        .from('storages')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('is_deleted', false)
        .in('id', configuredStorageIds)

    if (error) throw error

    const activeStorageIds = new Set(((data ?? []) as { id: string }[]).map((storage) => storage.id))
    return configuredStorageIds.filter((storageId) => activeStorageIds.has(storageId))
}

export type StorefrontPriceOverrideItem = {
    price: number
    currency: string | null
    cost_price: number | null
}

/**
 * Returns the price book that overrides storefront prices for the workspace
 * storefront (the single rule with override_prices enabled), along with its
 * item prices keyed by product id. Null when no override rule exists.
 */
export async function fetchStorefrontPriceOverride(
    adminClient: ReturnType<typeof createAdminClient>,
    workspaceId: string,
    storefrontId?: string | null,
    rules?: StorefrontCatalogRule[]
): Promise<{ priceBookId: string; items: Map<string, StorefrontPriceOverrideItem> } | null> {
    const resolvedRules = rules ?? await fetchStorefrontCatalogRules(adminClient, workspaceId, storefrontId)
    const overrideRule = resolvedRules.find((rule) => rule.target_type === 'price_book' && rule.override_prices && rule.price_book_id)
    if (!overrideRule?.price_book_id) {
        return null
    }

    const { data, error } = await adminClient
        .from('price_book_items')
        .select('product_id, price, cost_price, currency')
        .eq('workspace_id', workspaceId)
        .eq('price_book_id', overrideRule.price_book_id)
        .eq('is_deleted', false)

    if (error) {
        throw error
    }

    const items = new Map<string, StorefrontPriceOverrideItem>()
    for (const row of (data ?? []) as {
        product_id: string
        price: number | string
        cost_price: number | string | null
        currency: string | null
    }[]) {
        items.set(row.product_id, {
            price: Number(row.price ?? 0),
            currency: row.currency,
            cost_price: row.cost_price == null ? null : Number(row.cost_price)
        })
    }

    return { priceBookId: overrideRule.price_book_id, items }
}

/**
 * Resolves which of the candidate products are visible on a storefront given
 * its catalog rules. Returns null when no rules exist (all visible).
 *
 * A rule targets a price book (products listed in that book) or native products
 * (products not listed in any price book). Inclusion rules restrict the
 * storefront to their targets; exclusion rules always remove their targets.
 * When storefrontId is omitted, the primary storefront rules apply.
 */
export async function resolveStorefrontVisibleProductIds(
    adminClient: ReturnType<typeof createAdminClient>,
    workspaceId: string,
    candidateProductIds: string[],
    options?: {
        storefrontId?: string | null
        rules?: StorefrontCatalogRule[]
    }
): Promise<Set<string> | null> {
    const resolvedRules = options?.rules ?? await fetchStorefrontCatalogRules(adminClient, workspaceId, options?.storefrontId)
    if (resolvedRules.length === 0) {
        return null
    }

    const productRules = resolvedRules.filter((rule) => rule.target_type !== 'storage')
    const includedBookIds = new Set<string>()
    const excludedBookIds = new Set<string>()
    let includeNative = false
    let excludeNative = false
    for (const rule of productRules) {
        if (rule.rule_type === 'inclusion') {
            if (rule.target_type === 'price_book' && rule.price_book_id) {
                includedBookIds.add(rule.price_book_id)
            } else if (rule.target_type === 'native') {
                includeNative = true
            }
        } else if (rule.target_type === 'price_book' && rule.price_book_id) {
            excludedBookIds.add(rule.price_book_id)
        } else if (rule.target_type === 'native') {
            excludeNative = true
        }
    }

    const hasInclusionRules = includeNative || includedBookIds.size > 0
    if (!hasInclusionRules && !excludeNative && excludedBookIds.size === 0) {
        return null
    }

    if (candidateProductIds.length === 0) {
        return new Set<string>()
    }

    const bookProductIds = new Map<string, Set<string>>()
    const referencedBookIds = Array.from(new Set([...includedBookIds, ...excludedBookIds]))
    if (referencedBookIds.length > 0) {
        const { data: items, error: itemsError } = await adminClient
            .from('price_book_items')
            .select('price_book_id, product_id')
            .eq('workspace_id', workspaceId)
            .eq('is_deleted', false)
            .in('price_book_id', referencedBookIds)
            .in('product_id', candidateProductIds)

        if (itemsError) {
            throw itemsError
        }

        for (const item of (items ?? []) as { price_book_id: string; product_id: string }[]) {
            let productSet = bookProductIds.get(item.price_book_id)
            if (!productSet) {
                productSet = new Set<string>()
                bookProductIds.set(item.price_book_id, productSet)
            }
            productSet.add(item.product_id)
        }
    }

    let bookedProductIds = new Set<string>()
    if (includeNative || excludeNative) {
        const { data: bookedItems, error: bookedError } = await adminClient
            .from('price_book_items')
            .select('product_id')
            .eq('workspace_id', workspaceId)
            .eq('is_deleted', false)
            .in('product_id', candidateProductIds)

        if (bookedError) {
            throw bookedError
        }

        bookedProductIds = new Set(
            ((bookedItems ?? []) as { product_id: string }[]).map((row) => row.product_id)
        )
    }

    const includedProductIds = new Set<string>()
    for (const bookId of includedBookIds) {
        const productSet = bookProductIds.get(bookId)
        if (productSet) {
            for (const productId of productSet) {
                includedProductIds.add(productId)
            }
        }
    }

    const excludedProductIds = new Set<string>()
    for (const bookId of excludedBookIds) {
        const productSet = bookProductIds.get(bookId)
        if (productSet) {
            for (const productId of productSet) {
                excludedProductIds.add(productId)
            }
        }
    }

    const visible = new Set<string>()
    for (const productId of candidateProductIds) {
        if (hasInclusionRules) {
            const isIncludedByBook = includedProductIds.has(productId)
            const isIncludedNative = includeNative && !bookedProductIds.has(productId)
            if (!isIncludedByBook && !isIncludedNative) {
                continue
            }
        }

        if (excludedProductIds.has(productId)) {
            continue
        }

        if (excludeNative && !bookedProductIds.has(productId)) {
            continue
        }

        visible.add(productId)
    }

    return visible
}
