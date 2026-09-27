import type { supabase as SupabaseClientValue } from '@/auth/supabase'

export type StorefrontCatalogRuleType = 'inclusion' | 'exclusion'
export type StorefrontCatalogRuleTargetType = 'native' | 'price_book' | 'storage'

export type StorefrontCatalogRuleRecord = {
    id: string
    rule_type: StorefrontCatalogRuleType
    target_type: StorefrontCatalogRuleTargetType
    price_book_id: string | null
    storage_id: string | null
    override_prices: boolean
}

export type StorefrontCatalogRuleTarget = {
    workspaceId: string
    storefrontId: string | null
    ruleType: StorefrontCatalogRuleType
    targetType: StorefrontCatalogRuleTargetType
    priceBookId?: string | null
    storageId?: string | null
}

const ruleFields = 'id, rule_type, target_type, price_book_id, storage_id, override_prices'

export async function fetchStorefrontCatalogRules(
    workspaceId: string,
    storefrontId: string | null,
    client: typeof SupabaseClientValue
) {
    const query = client
        .from('workspace_storefront_catalog_rules')
        .select(ruleFields)
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: true })

    const result = storefrontId
        ? await query.eq('storefront_id', storefrontId)
        : await query.is('storefront_id', null)

    if (result.error) throw result.error
    return (result.data ?? []) as StorefrontCatalogRuleRecord[]
}

export async function addStorefrontCatalogRule(
    target: StorefrontCatalogRuleTarget,
    client: typeof SupabaseClientValue
) {
    const result = await client
        .from('workspace_storefront_catalog_rules')
        .insert({
            workspace_id: target.workspaceId,
            storefront_id: target.storefrontId,
            rule_type: target.ruleType,
            target_type: target.targetType,
            price_book_id: target.targetType === 'price_book' ? target.priceBookId ?? null : null,
            storage_id: target.targetType === 'storage' ? target.storageId ?? null : null
        })
        .select(ruleFields)
        .single()

    if (result.error) throw result.error
    return result.data as StorefrontCatalogRuleRecord
}

export async function removeStorefrontCatalogRule(
    ruleId: string,
    workspaceId: string,
    client: typeof SupabaseClientValue
) {
    const result = await client
        .from('workspace_storefront_catalog_rules')
        .delete()
        .eq('id', ruleId)
        .eq('workspace_id', workspaceId)

    if (result.error) throw result.error
}

export async function setStorefrontCatalogRulePriceOverride(
    ruleId: string,
    workspaceId: string,
    enabled: boolean,
    client: typeof SupabaseClientValue
) {
    const result = await client
        .from('workspace_storefront_catalog_rules')
        .update({ override_prices: enabled })
        .eq('id', ruleId)
        .eq('workspace_id', workspaceId)

    if (result.error) throw result.error
}
