import { normalizeSupabaseActionError } from '@/lib/supabaseRequest'

import type { MarketplaceOrderStatus } from './MarketplaceOrderTypes'

export const MARKETPLACE_ORDER_TRANSITION_RPC = 'transition_marketplace_order' as const

export type MarketplaceTransitionResponse = {
    status?: MarketplaceOrderStatus
    warning?: string | null
    sales_order_id?: string | null
    customer_id?: string | null
    business_partner_id?: string | null
}

export type MarketplaceOrderTransitionArguments = {
    order_id: string
    next_status: MarketplaceOrderStatus
    cancel_reason: string | null
}

type MarketplaceOrderTransitionRpc = (
    functionName: typeof MARKETPLACE_ORDER_TRANSITION_RPC,
    arguments_: MarketplaceOrderTransitionArguments
) => PromiseLike<{
    data: MarketplaceTransitionResponse | null
    error: unknown | null
}>

export async function executeMarketplaceOrderTransition({
    rpc,
    orderId,
    nextStatus,
    cancelReason
}: {
    rpc: MarketplaceOrderTransitionRpc
    orderId: string
    nextStatus: MarketplaceOrderStatus
    cancelReason?: string
}): Promise<MarketplaceTransitionResponse | null> {
    const { data, error } = await rpc(MARKETPLACE_ORDER_TRANSITION_RPC, {
        order_id: orderId,
        next_status: nextStatus,
        cancel_reason: cancelReason || null
    })

    if (error) {
        // PostgREST errors are plain objects. Normalize them here so validation
        // details and friendly retry messages survive every caller.
        throw normalizeSupabaseActionError(error)
    }

    return data
}
