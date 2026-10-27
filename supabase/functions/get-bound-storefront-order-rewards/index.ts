import { createAdminClient } from '../_shared/supabase.ts'
import { errorResponse, jsonResponse } from '../_shared/http.ts'
import {
    evaluateJumlaKhaleejOrderRewards,
    type JumlaKhaleejRewardMilestone
} from '../_shared/jumlaKhaleejOrderRewards.ts'
import {
    isWebsiteStorefrontGatewayRequest,
    loadWebsiteStorefrontContext,
    parseWebsiteStorefrontMode
} from '../_shared/websiteStorefront.ts'

function privateJsonResponse(payload: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers)
    headers.set('Cache-Control', 'private, no-store')
    return jsonResponse(payload, { ...init, headers })
}

Deno.serve(async (req) => {
    if (req.method !== 'GET') return errorResponse('Method not allowed', 405)
    if (!isWebsiteStorefrontGatewayRequest(req)) return errorResponse('Unauthorized', 401)

    try {
        const url = new URL(req.url)
        const mode = parseWebsiteStorefrontMode(url.searchParams.get('mode'))
        if (!mode) return errorResponse('A valid storefront mode is required')

        const adminClient = createAdminClient()
        const context = await loadWebsiteStorefrontContext(adminClient, req)
        if ('error' in context) return errorResponse(context.error, context.status)

        const { data: ruleSet, error: ruleSetError } = await adminClient
            .from('storefront_order_reward_sets')
            .select('id')
            .eq('workspace_id', context.workspace.id)
            .eq('site_key', context.config.site_key)
            .eq('shopping_mode', mode)
            .eq('is_enabled', true)
            .maybeSingle()

        if (ruleSetError) return errorResponse(ruleSetError.message, 500)
        if (!ruleSet) return privateJsonResponse({ milestones: [], deliveryFeeWaived: false })

        const { data: rows, error: milestonesError } = await adminClient
            .from('storefront_order_reward_milestones')
            .select('id, threshold, node_type, node_types')
            .eq('rule_set_id', ruleSet.id)
            .order('threshold', { ascending: true })

        if (milestonesError) return errorResponse(milestonesError.message, 500)

        const milestones: JumlaKhaleejRewardMilestone[] = (rows ?? []).map((row) => ({
            id: String(row.id),
            threshold: String(row.threshold),
            node_type: row.node_type as JumlaKhaleejRewardMilestone['node_type'],
            node_types: (Array.isArray(row.node_types) ? row.node_types : [row.node_type]) as JumlaKhaleejRewardMilestone['node_types']
        }))
        const rawSubtotal = url.searchParams.get('subtotal')
        const subtotal = rawSubtotal === null ? null : Number(rawSubtotal)
        if (rawSubtotal !== null && (!Number.isFinite(subtotal) || subtotal < 0)) {
            return errorResponse('Enter a valid order subtotal.')
        }

        if (subtotal === null) {
            return privateJsonResponse({ milestones, deliveryFeeWaived: false })
        }

        return privateJsonResponse(evaluateJumlaKhaleejOrderRewards(milestones, subtotal))
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error'
        console.error('[get-bound-storefront-order-rewards]', message)
        return errorResponse('Unable to load order rewards.', 500)
    }
})
