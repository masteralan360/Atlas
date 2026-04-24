import { createAdminClient } from '../_shared/supabase.ts'
import { errorResponse, jsonResponse, corsHeaders } from '../_shared/http.ts'
import { listMarketplaceAssetUrls, resolvePublicAssetUrl } from '../_shared/marketplace.ts'

type WorkspaceRow = {
    id: string
    name: string
    store_slug: string | null
    store_description: string | null
    logo_url: string | null
    default_currency: string | null
}

type MarketplaceStorageRow = {
    id: string
    workspace_id: string
}

type ProductSummaryRow = {
    id: string
    workspace_id: string
    category_id: string | null
}

type InventoryRow = {
    workspace_id: string
    storage_id: string
    product_id: string
    quantity: number | null
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    if (req.method !== 'GET') {
        return errorResponse('Method not allowed', 405)
    }

    try {
        const adminClient = createAdminClient()

        const { data: workspaces, error: workspaceError } = await adminClient
            .from('workspaces')
            .select('id, name, store_slug, store_description, logo_url, default_currency')
            .eq('visibility', 'public')
            .is('deleted_at', null)
            .order('name', { ascending: true })

        if (workspaceError) {
            return errorResponse(workspaceError.message, 500)
        }

        const publicWorkspaces = ((workspaces ?? []) as WorkspaceRow[]).filter((workspace) => Boolean(workspace.store_slug))
        const workspaceIds = publicWorkspaces.map((workspace) => workspace.id)
        const countsByWorkspace = new Map<string, { productIds: Set<string>; categoryIds: Set<string> }>()

        if (workspaceIds.length > 0) {
            const [
                { data: marketplaceStorages, error: marketplaceStorageError },
                { data: products, error: productError }
            ] = await Promise.all([
                adminClient
                    .from('storages')
                    .select('id, workspace_id')
                    .in('workspace_id', workspaceIds)
                    .eq('is_deleted', false)
                    .eq('is_marketplace', true),
                adminClient
                    .from('products')
                    .select('id, workspace_id, category_id')
                    .in('workspace_id', workspaceIds)
                    .eq('is_deleted', false)
            ])

            if (marketplaceStorageError) {
                return errorResponse(marketplaceStorageError.message, 500)
            }

            if (productError) {
                return errorResponse(productError.message, 500)
            }

            const marketplaceStorageIdByWorkspace = new Map<string, string>()
            for (const row of (marketplaceStorages ?? []) as MarketplaceStorageRow[]) {
                if (!marketplaceStorageIdByWorkspace.has(row.workspace_id)) {
                    marketplaceStorageIdByWorkspace.set(row.workspace_id, row.id)
                }
            }

            const productById = new Map<string, ProductSummaryRow>()
            for (const row of (products ?? []) as ProductSummaryRow[]) {
                productById.set(row.id, row)
            }

            const marketplaceStorageIds = Array.from(new Set(Array.from(marketplaceStorageIdByWorkspace.values())))
            if (marketplaceStorageIds.length > 0) {
                const { data: inventoryRows, error: inventoryError } = await adminClient
                    .from('inventory')
                    .select('workspace_id, storage_id, product_id, quantity')
                    .in('workspace_id', workspaceIds)
                    .in('storage_id', marketplaceStorageIds)
                    .eq('is_deleted', false)
                    .gt('quantity', 0)

                if (inventoryError) {
                    return errorResponse(inventoryError.message, 500)
                }

                for (const row of (inventoryRows ?? []) as InventoryRow[]) {
                    if (marketplaceStorageIdByWorkspace.get(row.workspace_id) !== row.storage_id) {
                        continue
                    }

                    const product = productById.get(row.product_id)
                    if (!product || product.workspace_id !== row.workspace_id) {
                        continue
                    }

                    const current = countsByWorkspace.get(row.workspace_id) ?? {
                        productIds: new Set<string>(),
                        categoryIds: new Set<string>()
                    }

                    current.productIds.add(product.id)
                    if (product.category_id) {
                        current.categoryIds.add(product.category_id)
                    }

                    countsByWorkspace.set(row.workspace_id, current)
                }
            }
        }

        const stores = await Promise.all(publicWorkspaces.map(async (workspace) => {
            const counts = countsByWorkspace.get(workspace.id) ?? {
                productIds: new Set<string>(),
                categoryIds: new Set<string>()
            }
            const logoUrl = resolvePublicAssetUrl(workspace.logo_url)
                ?? (await listMarketplaceAssetUrls([
                    `${workspace.id}/workspace-logos/`,
                    `${workspace.id}/workspaces/`
                ], 1))[0]
                ?? null

            return {
                name: workspace.name,
                slug: workspace.store_slug,
                description: workspace.store_description,
                logo_url: logoUrl,
                default_currency: workspace.default_currency ?? 'iqd',
                product_count: counts.productIds.size,
                category_count: counts.categoryIds.size
            }
        }))

        return jsonResponse(
            { stores },
            {
                headers: {
                    'Cache-Control': 'public, max-age=60, s-maxage=300'
                }
            }
        )
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error'
        return errorResponse(message, 500)
    }
})
