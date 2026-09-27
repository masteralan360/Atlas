import type { supabase as SupabaseClientValue } from '@/auth/supabase'

export const MAX_ADDITIONAL_STOREFRONTS = 2

export function canAddAdditionalMarketplaceStorefront(currentCount: number) {
    return Number.isFinite(currentCount)
        && currentCount >= 0
        && currentCount < MAX_ADDITIONAL_STOREFRONTS
}

export type AdditionalMarketplaceStorefront = {
    id: string
    visibility: 'private' | 'public' | 'link_only'
    slug: string
    description: string | null
}

export type AdditionalMarketplaceStorefrontDraft = Pick<AdditionalMarketplaceStorefront, 'visibility' | 'slug' | 'description'>

const storefrontFields = 'id, visibility, slug, description'

export async function fetchAdditionalMarketplaceStorefronts(
    workspaceId: string,
    client: typeof SupabaseClientValue
) {
    const result = await client
        .from('workspace_storefronts')
        .select(storefrontFields)
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: true })

    if (result.error) throw result.error
    return (result.data ?? []) as AdditionalMarketplaceStorefront[]
}

export async function createAdditionalMarketplaceStorefront(
    workspaceId: string,
    client: typeof SupabaseClientValue
) {
    const result = await client
        .from('workspace_storefronts')
        .insert({ workspace_id: workspaceId, visibility: 'private', slug: '', description: null })
        .select(storefrontFields)
        .single()

    if (result.error) throw result.error
    return result.data as AdditionalMarketplaceStorefront
}

export async function saveAdditionalMarketplaceStorefront(
    workspaceId: string,
    storefrontId: string,
    draft: AdditionalMarketplaceStorefrontDraft,
    client: typeof SupabaseClientValue
) {
    const result = await client
        .from('workspace_storefronts')
        .update(draft)
        .eq('workspace_id', workspaceId)
        .eq('id', storefrontId)
        .select(storefrontFields)
        .single()

    if (result.error) throw result.error
    return result.data as AdditionalMarketplaceStorefront
}

export async function removeAdditionalMarketplaceStorefront(
    workspaceId: string,
    storefrontId: string,
    client: typeof SupabaseClientValue
) {
    const result = await client
        .from('workspace_storefronts')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('id', storefrontId)

    if (result.error) throw result.error
}

export async function isAdditionalMarketplaceStorefrontSlugAvailable(
    slug: string,
    excludeStorefrontId: string,
    client: typeof SupabaseClientValue
) {
    const result = await client.rpc('check_storefront_slug_available', {
        p_slug: slug,
        p_exclude_storefront_id: excludeStorefrontId
    })

    if (result.error) throw result.error
    return Boolean(result.data)
}
