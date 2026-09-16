import { supabase } from '@/auth/supabase'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'

export const MARKETPLACE_ORDER_REFRESH_EVENT = 'marketplace-orders:changed'

export type MarketplaceOrderRealtimePayload = RealtimePostgresChangesPayload<Record<string, unknown>>

export type MarketplaceOrderRefreshSource = 'local' | 'realtime' | 'reconnected'

export type MarketplaceOrderRefreshDetail = {
    workspaceId: string
    source: MarketplaceOrderRefreshSource
    eventType?: MarketplaceOrderRealtimePayload['eventType']
    orderId?: string
}

export type MarketplaceOrderRealtimeEvent =
    | {
        type: 'change'
        payload: MarketplaceOrderRealtimePayload
    }
    | {
        type: 'reconnected'
    }

type MarketplaceOrderRealtimeSubscriber = (event: MarketplaceOrderRealtimeEvent) => void

type MarketplaceOrderRealtimeSubscription = {
    channel: ReturnType<typeof supabase.channel>
    subscribers: Set<MarketplaceOrderRealtimeSubscriber>
    hasSubscribed: boolean
    isClosedByClient: boolean
}

const realtimeSubscriptionsByWorkspaceId = new Map<string, MarketplaceOrderRealtimeSubscription>()

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function readOrderId(payload: MarketplaceOrderRealtimePayload) {
    const row = isRecord(payload.new)
        ? payload.new
        : isRecord(payload.old)
            ? payload.old
            : null
    const id = row?.id
    return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Broadcasts an authoritative-refresh request without exposing the Realtime
 * row payload, which can include customer contact details.
 */
export function notifyMarketplaceOrdersChanged(detail: MarketplaceOrderRefreshDetail) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') {
        return
    }

    window.dispatchEvent(new CustomEvent<MarketplaceOrderRefreshDetail>(MARKETPLACE_ORDER_REFRESH_EVENT, {
        detail
    }))
}

/**
 * Shares one filtered marketplace-order channel for each active workspace.
 * Consumers receive invalidations only and fetch their own authoritative view.
 */
export function subscribeToMarketplaceOrderChanges(
    workspaceId: string,
    callback: MarketplaceOrderRealtimeSubscriber,
) {
    let subscription = realtimeSubscriptionsByWorkspaceId.get(workspaceId)

    if (!subscription) {
        const subscribers = new Set<MarketplaceOrderRealtimeSubscriber>()
        let createdSubscription: MarketplaceOrderRealtimeSubscription | null = null
        const channel = supabase
            .channel(`marketplace-orders-${workspaceId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'marketplace_orders',
                    filter: `workspace_id=eq.${workspaceId}`
                },
                (payload) => {
                    for (const subscriber of createdSubscription?.subscribers ?? []) {
                        subscriber({
                            type: 'change',
                            payload: payload as MarketplaceOrderRealtimePayload
                        })
                    }
                }
            )
            .subscribe((status) => {
                if (!createdSubscription) return

                if (status === 'SUBSCRIBED') {
                    if (createdSubscription.hasSubscribed) {
                        for (const subscriber of createdSubscription.subscribers) {
                            subscriber({ type: 'reconnected' })
                        }
                    }
                    createdSubscription.hasSubscribed = true
                    return
                }

                if (
                    status === 'CHANNEL_ERROR'
                    || status === 'TIMED_OUT'
                    || (status === 'CLOSED' && !createdSubscription.isClosedByClient)
                ) {
                    console.warn(`[MarketplaceOrders] Realtime subscription: ${status}`)
                }
            })

        createdSubscription = {
            channel,
            subscribers,
            hasSubscribed: false,
            isClosedByClient: false
        }
        realtimeSubscriptionsByWorkspaceId.set(workspaceId, createdSubscription)
        subscription = createdSubscription
    }

    subscription.subscribers.add(callback)

    return () => {
        const activeSubscription = realtimeSubscriptionsByWorkspaceId.get(workspaceId)
        if (!activeSubscription) return

        activeSubscription.subscribers.delete(callback)
        if (activeSubscription.subscribers.size === 0) {
            realtimeSubscriptionsByWorkspaceId.delete(workspaceId)
            activeSubscription.isClosedByClient = true
            void supabase.removeChannel(activeSubscription.channel)
        }
    }
}

export function getMarketplaceOrderRefreshDetail(
    workspaceId: string,
    event: MarketplaceOrderRealtimeEvent,
): MarketplaceOrderRefreshDetail {
    if (event.type === 'reconnected') {
        return {
            workspaceId,
            source: 'reconnected'
        }
    }

    return {
        workspaceId,
        source: 'realtime',
        eventType: event.payload.eventType,
        orderId: readOrderId(event.payload)
    }
}
