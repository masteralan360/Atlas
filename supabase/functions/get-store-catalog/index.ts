import { createAdminClient } from '../_shared/supabase.ts'
import { corsHeaders, errorResponse, jsonResponse } from '../_shared/http.ts'
import {
    listMarketplaceAssetUrls,
    resolvePublicAssetUrl,
    sanitizeMarketplaceText
} from '../_shared/marketplace.ts'

type WorkspaceRow = {
    id: string
    name: string
    store_slug: string | null
    store_description: string | null
    logo_url: string | null
    default_currency: string | null
}

type ProductRow = {
    id: string
    name: string
    sku: string
    description: string | null
    price: number
    currency: string | null
    unit: string | null
    category_id: string | null
    image_url: string | null
}

type CategoryRow = {
    id: string
    name: string
}

type ContactRow = {
    type: string
    value: string
    label: string | null
    is_primary: boolean | null
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    if (req.method !== 'GET') {
        return errorResponse('Method not allowed', 405)
    }

    try {
        const url = new URL(req.url)
        const slug = sanitizeMarketplaceText(url.searchParams.get('slug'), 80).toLowerCase()
        if (!slug) {
            return errorResponse('Store slug is required')
        }

        const adminClient = createAdminClient()

        const { data: workspace, error: workspaceError } = await adminClient
            .from('workspaces')
            .select('id, name, store_slug, store_description, logo_url, default_currency')
            .eq('store_slug', slug)
            .eq('visibility', 'public')
            .is('deleted_at', null)
            .maybeSingle()

        if (workspaceError) {
            return errorResponse(workspaceError.message, 500)
        }

        if (!workspace) {
            return errorResponse('Store not found', 404)
        }

        const resolvedWorkspace = workspace as WorkspaceRow

        const [
            { data: contacts, error: contactsError },
            { data: products, error: productsError }
        ] = await Promise.all([
            adminClient
                .from('workspace_contacts')
                .select('type, value, label, is_primary')
                .eq('workspace_id', resolvedWorkspace.id)
                .order('is_primary', { ascending: false })
                .order('created_at', { ascending: true }),
            adminClient
                .from('products')
                .select('id, name, sku, description, price, currency, unit, category_id, image_url')
                .eq('workspace_id', resolvedWorkspace.id)
                .eq('is_deleted', false)
                .order('name', { ascending: true })
        ])

        if (contactsError) {
            return errorResponse(contactsError.message, 500)
        }

        if (productsError) {
            return errorResponse(productsError.message, 500)
        }

        const productRows = (products ?? []) as ProductRow[]
        const categoryIds = Array.from(new Set(productRows.map((product) => product.category_id).filter((value): value is string => Boolean(value))))
        const categoryNameById = new Map<string, string>()

        if (categoryIds.length > 0) {
            const { data: categories, error: categoryError } = await adminClient
                .from('categories')
                .select('id, name')
                .in('id', categoryIds)
                .eq('is_deleted', false)
                .order('name', { ascending: true })

            if (categoryError) {
                return errorResponse(categoryError.message, 500)
            }

            for (const category of (categories ?? []) as CategoryRow[]) {
                categoryNameById.set(category.id, category.name)
            }
        }

        const primaryContacts = ((contacts ?? []) as ContactRow[]).filter((contact) => contact.is_primary)
        const visibleContacts = (primaryContacts.length > 0 ? primaryContacts : (contacts ?? []) as ContactRow[]).slice(0, 5)
        const resolvedLogoUrl = resolvePublicAssetUrl(resolvedWorkspace.logo_url)
            ?? (await listMarketplaceAssetUrls([
                `${resolvedWorkspace.id}/workspace-logos/`,
                `${resolvedWorkspace.id}/workspaces/`
            ], 1))[0]
            ?? null

        const resolvedProductImageUrls = productRows.map((product) => resolvePublicAssetUrl(product.image_url))
        const missingProductImageCount = resolvedProductImageUrls.filter((value) => !value).length
        const fallbackProductImageUrls = missingProductImageCount > 0
            ? await listMarketplaceAssetUrls([`${resolvedWorkspace.id}/product-images/`], missingProductImageCount)
            : []
        let fallbackProductImageIndex = 0

        return jsonResponse(
            {
                store: {
                    name: resolvedWorkspace.name,
                    slug: resolvedWorkspace.store_slug,
                    description: resolvedWorkspace.store_description,
                    logo_url: resolvedLogoUrl,
                    currency: resolvedWorkspace.default_currency ?? 'iqd',
                    contacts: visibleContacts.map((contact) => ({
                        type: contact.type,
                        value: contact.value,
                        label: contact.label,
                        is_primary: Boolean(contact.is_primary)
                    }))
                },
                categories: categoryIds
                    .map((categoryId) => ({
                        id: categoryId,
                        name: categoryNameById.get(categoryId)
                    }))
                    .filter((category): category is { id: string; name: string } => Boolean(category.name)),
                products: productRows.map((product, index) => ({
                    id: product.id,
                    name: product.name,
                    sku: product.sku,
                    description: product.description ?? '',
                    price: Number(product.price ?? 0),
                    currency: product.currency ?? resolvedWorkspace.default_currency ?? 'iqd',
                    unit: product.unit ?? 'pcs',
                    category_id: product.category_id,
                    category_name: product.category_id ? (categoryNameById.get(product.category_id) ?? null) : null,
                    image_url: resolvedProductImageUrls[index]
                        ?? fallbackProductImageUrls[fallbackProductImageIndex++]
                        ?? resolvedLogoUrl
                }))
            },
            {
                headers: {
                    'Cache-Control': 'public, max-age=30, s-maxage=120'
                }
            }
        )
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error'
        return errorResponse(message, 500)
    }
})
