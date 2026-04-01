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

type ProductCountRow = {
    workspace_id: string
    category_id: string | null
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
        const countsByWorkspace = new Map<string, { productCount: number; categoryIds: Set<string> }>()

        if (workspaceIds.length > 0) {
            const { data: products, error: productError } = await adminClient
                .from('products')
                .select('workspace_id, category_id')
                .in('workspace_id', workspaceIds)
                .eq('is_deleted', false)

            if (productError) {
                return errorResponse(productError.message, 500)
            }

            for (const row of (products ?? []) as ProductCountRow[]) {
                const current = countsByWorkspace.get(row.workspace_id) ?? {
                    productCount: 0,
                    categoryIds: new Set<string>()
                }

                current.productCount += 1
                if (row.category_id) {
                    current.categoryIds.add(row.category_id)
                }

                countsByWorkspace.set(row.workspace_id, current)
            }
        }

        const stores = await Promise.all(publicWorkspaces.map(async (workspace) => {
            const counts = countsByWorkspace.get(workspace.id)
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
                product_count: counts?.productCount ?? 0,
                category_count: counts?.categoryIds.size ?? 0
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
