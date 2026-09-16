import { useEffect, useRef } from 'react'

import { useAuth } from '@/auth'
import { isSupabaseConfigured } from '@/auth/supabase'
import {
    getMarketplaceOrderRefreshDetail,
    notifyMarketplaceOrdersChanged,
    subscribeToMarketplaceOrderChanges,
    type MarketplaceOrderRefreshDetail
} from '@/services/marketplaceOrderRealtime'
import { useWorkspace } from '@/workspace'
import { useWorkspacePermissions } from '@/permissions'

const REALTIME_CHANGE_DEBOUNCE_MS = 250

/**
 * Owns the sole marketplace-order Realtime channel for a layout instance.
 * It deliberately publishes only an invalidation so each view continues to
 * read its complete, privacy-filtered representation from Supabase.
 */
export function MarketplaceOrderRealtimeBridge() {
    const { user } = useAuth()
    const { features, hasFeature } = useWorkspace()
    const { hasPermission } = useWorkspacePermissions()
    const timerRef = useRef<number | null>(null)
    const queuedDetailRef = useRef<MarketplaceOrderRefreshDetail | null>(null)

    const workspaceId = user?.workspaceId
    const canSubscribe = Boolean(
        isSupabaseConfigured
        && workspaceId
        && (user?.role === 'admin' || user?.role === 'staff')
        && features.data_mode !== 'local'
        && features.data_mode !== 'demo'
        && hasFeature('ecommerce')
        && hasPermission('ecommerce.access')
    )

    useEffect(() => {
        if (!canSubscribe || !workspaceId) return

        const publishQueuedChange = () => {
            const detail = queuedDetailRef.current
            queuedDetailRef.current = null
            timerRef.current = null
            if (detail) notifyMarketplaceOrdersChanged(detail)
        }

        const queueChange = (detail: MarketplaceOrderRefreshDetail) => {
            // Reconnection supersedes an earlier row event because every
            // consumer must reconcile its full view either way.
            queuedDetailRef.current = detail.source === 'reconnected'
                ? detail
                : (queuedDetailRef.current ?? detail)

            if (timerRef.current) return
            timerRef.current = window.setTimeout(publishQueuedChange, REALTIME_CHANGE_DEBOUNCE_MS)
        }

        const unsubscribe = subscribeToMarketplaceOrderChanges(workspaceId, (event) => {
            queueChange(getMarketplaceOrderRefreshDetail(workspaceId, event))
        })

        return () => {
            unsubscribe()
            if (timerRef.current) {
                window.clearTimeout(timerRef.current)
                timerRef.current = null
            }
            queuedDetailRef.current = null
        }
    }, [canSubscribe, workspaceId])

    return null
}
