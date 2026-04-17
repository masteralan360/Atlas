import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { supabase } from '@/auth/supabase'
import { useAuth } from '@/auth'
import { type SnoozedItem, useUnifiedSnooze } from '@/context/UnifiedSnoozeContext'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import type { IQDDisplayPreference } from '@/local-db/models'
import { useToast } from '@/ui/components'
import { useWorkspace } from '@/workspace'
import {
    MarketplaceOrderReminderModal,
    type MarketplaceOrderReminderItem
} from './MarketplaceOrderReminderModal'

const MARKETPLACE_REMINDER_COOLDOWN_STORAGE_KEY = 'marketplace_order_reminder_cooldowns'
const MARKETPLACE_REMINDER_COOLDOWN_MS = 6 * 60 * 60 * 1000
const MARKETPLACE_ORDER_REFRESH_EVENT = 'marketplace-orders:changed'

type MarketplaceOrderRecord = {
    id: string
    order_number: string
    customer_name: string
    customer_phone: string
    customer_city: string | null
    total: number
    currency: string
    items: Array<{ quantity?: number | null }> | null
    created_at: string
}

type MarketplaceReminderCooldownMap = Record<string, string>

function readMarketplaceReminderCooldowns(): MarketplaceReminderCooldownMap {
    if (typeof window === 'undefined') {
        return {}
    }

    try {
        const raw = window.localStorage.getItem(MARKETPLACE_REMINDER_COOLDOWN_STORAGE_KEY)
        if (!raw) {
            return {}
        }

        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {}
        }

        const next: MarketplaceReminderCooldownMap = {}
        for (const [orderId, cooldownUntil] of Object.entries(parsed)) {
            if (typeof orderId === 'string' && typeof cooldownUntil === 'string') {
                next[orderId] = cooldownUntil
            }
        }

        return next
    } catch {
        return {}
    }
}

function persistMarketplaceReminderCooldowns(cooldowns: MarketplaceReminderCooldownMap) {
    if (typeof window === 'undefined') {
        return
    }

    if (Object.keys(cooldowns).length === 0) {
        window.localStorage.removeItem(MARKETPLACE_REMINDER_COOLDOWN_STORAGE_KEY)
        return
    }

    window.localStorage.setItem(
        MARKETPLACE_REMINDER_COOLDOWN_STORAGE_KEY,
        JSON.stringify(cooldowns)
    )
}

function cleanupMarketplaceReminderCooldowns(
    cooldowns: MarketplaceReminderCooldownMap,
    items: MarketplaceOrderReminderItem[],
    now: number = Date.now()
): MarketplaceReminderCooldownMap {
    const activeOrderIds = new Set(items.map(item => item.orderId))
    let changed = false
    const next: MarketplaceReminderCooldownMap = {}

    for (const [orderId, cooldownUntil] of Object.entries(cooldowns)) {
        const cooldownEndsAt = Date.parse(cooldownUntil)
        if (!activeOrderIds.has(orderId) || !Number.isFinite(cooldownEndsAt) || cooldownEndsAt <= now) {
            changed = true
            continue
        }

        next[orderId] = cooldownUntil
    }

    return changed ? next : cooldowns
}

function isMarketplaceReminderCoolingDown(
    item: MarketplaceOrderReminderItem,
    cooldowns: MarketplaceReminderCooldownMap,
    now: number
): boolean {
    const cooldownUntil = cooldowns[item.orderId]
    if (!cooldownUntil) {
        return false
    }

    const cooldownEndsAt = Date.parse(cooldownUntil)
    return Number.isFinite(cooldownEndsAt) && cooldownEndsAt > now
}

function getMarketplaceOrderItemCount(items: MarketplaceOrderRecord['items']) {
    if (!Array.isArray(items) || items.length === 0) {
        return 0
    }

    return items.reduce((sum, item) => {
        const quantity = Number(item?.quantity)
        return sum + (Number.isFinite(quantity) && quantity > 0 ? quantity : 1)
    }, 0)
}

export function GlobalMarketplaceOrderReminders() {
    const { user } = useAuth()
    const { features, hasFeature } = useWorkspace()
    const { toast } = useToast()
    const { t } = useTranslation()
    const [location, setLocation] = useLocation()
    const isOnline = useNetworkStatus()
    const workspaceId = user?.workspaceId
    const isReadOnly = user?.role === 'viewer'
    const canUseMarketplaceReminders =
        Boolean(workspaceId)
        && !isReadOnly
        && features.data_mode !== 'local'
        && hasFeature('ecommerce')
    const iqdPreference = features.iqd_display_preference as IQDDisplayPreference

    const [orders, setOrders] = useState<MarketplaceOrderReminderItem[]>([])
    const [reminderCooldowns, setReminderCooldowns] = useState<MarketplaceReminderCooldownMap>(() => readMarketplaceReminderCooldowns())
    const [currentReminderOrderId, setCurrentReminderOrderId] = useState<string | null>(null)
    const [isHydrating, setIsHydrating] = useState(true)
    const [isReminderActionLoading, setIsReminderActionLoading] = useState(false)

    const loadOrders = useCallback(async () => {
        if (!workspaceId) {
            setOrders([])
            return
        }

        const { data, error } = await supabase
            .from('marketplace_orders')
            .select('id, order_number, customer_name, customer_phone, customer_city, total, currency, items, created_at')
            .eq('workspace_id', workspaceId)
            .eq('status', 'pending')
            .order('created_at', { ascending: true })

        if (error) {
            throw error
        }

        setOrders(((data ?? []) as MarketplaceOrderRecord[]).map((order) => ({
            orderId: order.id,
            orderNumber: order.order_number,
            customerName: order.customer_name,
            customerPhone: order.customer_phone,
            customerCity: order.customer_city,
            total: Number(order.total ?? 0),
            currency: order.currency || 'usd',
            itemCount: getMarketplaceOrderItemCount(order.items),
            createdAt: order.created_at
        })))
    }, [workspaceId])

    useEffect(() => {
        if (!isOnline || !canUseMarketplaceReminders) {
            setOrders([])
            setIsHydrating(false)
            return
        }

        let cancelled = false
        setIsHydrating(true)

        const hydrateMarketplaceOrders = async () => {
            try {
                await loadOrders()
            } catch (error) {
                if (!cancelled) {
                    console.error('[GlobalMarketplaceOrderReminders] Failed to hydrate pending orders:', error)
                }
            } finally {
                if (!cancelled) {
                    setIsHydrating(false)
                }
            }
        }

        void hydrateMarketplaceOrders()

        const handleMarketplaceOrdersChanged = () => { void hydrateMarketplaceOrders() }
        window.addEventListener('focus', handleMarketplaceOrdersChanged)
        window.addEventListener(MARKETPLACE_ORDER_REFRESH_EVENT, handleMarketplaceOrdersChanged)
        const intervalId = window.setInterval(() => { void hydrateMarketplaceOrders() }, 60_000)

        return () => {
            cancelled = true
            window.removeEventListener('focus', handleMarketplaceOrdersChanged)
            window.removeEventListener(MARKETPLACE_ORDER_REFRESH_EVENT, handleMarketplaceOrdersChanged)
            window.clearInterval(intervalId)
        }
    }, [canUseMarketplaceReminders, isOnline, loadOrders])

    useEffect(() => {
        setReminderCooldowns(prev => cleanupMarketplaceReminderCooldowns(prev, orders))

        const validOrderIds = new Set(orders.map(item => item.orderId))
        if (currentReminderOrderId && !validOrderIds.has(currentReminderOrderId)) {
            setCurrentReminderOrderId(null)
        }
    }, [currentReminderOrderId, orders])

    useEffect(() => {
        persistMarketplaceReminderCooldowns(reminderCooldowns)
    }, [reminderCooldowns])

    useEffect(() => {
        const now = Date.now()
        let nextCooldownEndsAt = Number.POSITIVE_INFINITY

        for (const cooldownUntil of Object.values(reminderCooldowns)) {
            const cooldownEndsAt = Date.parse(cooldownUntil)
            if (Number.isFinite(cooldownEndsAt) && cooldownEndsAt > now && cooldownEndsAt < nextCooldownEndsAt) {
                nextCooldownEndsAt = cooldownEndsAt
            }
        }

        if (!Number.isFinite(nextCooldownEndsAt)) {
            return
        }

        const timeoutId = window.setTimeout(() => {
            setReminderCooldowns(prev => cleanupMarketplaceReminderCooldowns(prev, orders))
        }, Math.max(0, nextCooldownEndsAt - now + 100))

        return () => window.clearTimeout(timeoutId)
    }, [orders, reminderCooldowns])

    const activeReminderItems = useMemo(
        () => orders.filter(item => !isMarketplaceReminderCoolingDown(item, reminderCooldowns, Date.now())),
        [orders, reminderCooldowns]
    )

    const snoozedReminderItems = useMemo(
        () => orders.filter(item => isMarketplaceReminderCoolingDown(item, reminderCooldowns, Date.now())),
        [orders, reminderCooldowns]
    )

    const currentReminder = useMemo(
        () => currentReminderOrderId
            ? activeReminderItems.find(item => item.orderId === currentReminderOrderId) ?? null
            : null,
        [activeReminderItems, currentReminderOrderId]
    )

    const currentReminderIndex = currentReminder
        ? activeReminderItems.findIndex(item => item.orderId === currentReminder.orderId)
        : -1

    useEffect(() => {
        const isEcommerceRoute = location === '/ecommerce' || location.startsWith('/ecommerce/')
        if (isEcommerceRoute || isHydrating || isReminderActionLoading || !canUseMarketplaceReminders) {
            if (isEcommerceRoute && currentReminderOrderId) {
                setCurrentReminderOrderId(null)
            }
            return
        }

        if (activeReminderItems.length === 0) {
            if (currentReminderOrderId) {
                setCurrentReminderOrderId(null)
            }
            return
        }

        const stillValid = currentReminderOrderId
            ? activeReminderItems.some(item => item.orderId === currentReminderOrderId)
            : false

        if (!stillValid) {
            setCurrentReminderOrderId(activeReminderItems[0].orderId)
        }
    }, [
        activeReminderItems,
        canUseMarketplaceReminders,
        currentReminderOrderId,
        isHydrating,
        isReminderActionLoading,
        location
    ])

    const applyReminderCooldown = useCallback((item: MarketplaceOrderReminderItem) => {
        const cooldownUntil = new Date(Date.now() + MARKETPLACE_REMINDER_COOLDOWN_MS).toISOString()

        setReminderCooldowns(prev => {
            if (prev[item.orderId] === cooldownUntil) {
                return prev
            }

            return {
                ...prev,
                [item.orderId]: cooldownUntil
            }
        })
    }, [])

    const removeReminderCooldown = useCallback(async (
        item: MarketplaceOrderReminderItem,
        options?: { silent?: boolean }
    ) => {
        setIsReminderActionLoading(true)
        try {
            setReminderCooldowns(prev => {
                if (!(item.orderId in prev)) {
                    return prev
                }

                const next = { ...prev }
                delete next[item.orderId]
                return next
            })

            if (!options?.silent) {
                toast({
                    title: t('common.success', { defaultValue: 'Success' }),
                    description: t('common.unsnoozed', { defaultValue: 'Reminder is active again.' })
                })
            }
            return true
        } finally {
            setIsReminderActionLoading(false)
        }
    }, [t, toast])

    const openOrderDetails = useCallback((item: MarketplaceOrderReminderItem) => {
        applyReminderCooldown(item)
        setCurrentReminderOrderId(null)
        setLocation(`/ecommerce/${item.orderId}`)
    }, [applyReminderCooldown, setLocation])

    const handleReminderSnooze = useCallback(() => {
        if (!currentReminder) {
            return
        }

        setIsReminderActionLoading(true)
        try {
            applyReminderCooldown(currentReminder)
            setCurrentReminderOrderId(null)
            toast({
                title: t('common.success', { defaultValue: 'Success' }),
                description: t('common.snoozed', { defaultValue: 'Reminder snoozed.' })
            })
        } finally {
            setIsReminderActionLoading(false)
        }
    }, [currentReminder, t, toast])

    const unifiedSnoozedItems = useMemo<SnoozedItem[]>(() => {
        return snoozedReminderItems.map(item => ({
            id: `marketplace-${item.orderId}`,
            type: 'marketplace',
            title: item.customerName,
            subtitle: item.orderNumber,
            amount: item.total,
            currency: item.currency,
            priority: 'warning',
            onAction: () => {
                openOrderDetails(item)
            },
            onUnsnooze: () => {
                void removeReminderCooldown(item)
            }
        }))
    }, [openOrderDetails, removeReminderCooldown, snoozedReminderItems])

    const { registerItems, unregisterItems } = useUnifiedSnooze()

    useEffect(() => {
        if (unifiedSnoozedItems.length > 0) {
            registerItems('marketplace', unifiedSnoozedItems)
        } else {
            unregisterItems('marketplace')
        }
    }, [registerItems, unifiedSnoozedItems, unregisterItems])

    if (!canUseMarketplaceReminders) {
        return null
    }

    return (
        <MarketplaceOrderReminderModal
            isOpen={!!currentReminder}
            item={currentReminder}
            queuePosition={currentReminderIndex >= 0 ? currentReminderIndex + 1 : 1}
            queueTotal={activeReminderItems.length}
            iqdPreference={iqdPreference}
            onReview={() => {
                if (!currentReminder) {
                    return
                }
                openOrderDetails(currentReminder)
            }}
            onSnooze={handleReminderSnooze}
            onOpenChange={(open) => {
                if (!open && currentReminder) {
                    applyReminderCooldown(currentReminder)
                    setCurrentReminderOrderId(null)
                }
            }}
        />
    )
}
