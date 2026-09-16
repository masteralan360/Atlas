import { useCallback, useEffect, useRef, useState } from 'react'

import { useAuth } from '@/auth'
import { isSupabaseConfigured } from '@/auth/supabase'
import { connectionManager } from '@/lib/connectionManager'
import { LAST_SYNC_KEY } from '@/sync/constants'
import { runManagedFullSync } from '@/sync/syncCoordinator'
import { useWorkspace } from '@/workspace'

const WARMUP_VERSION = 1
const MODULE_PRELOAD_BATCH_SIZE = 4

function isInstalledPwa() {
    if (typeof window === 'undefined') return false

    return window.matchMedia('(display-mode: standalone)').matches
        || window.matchMedia('(display-mode: window-controls-overlay)').matches
        || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

function getWarmupKey(workspaceId: string) {
    return `atlas_pwa_workspace_warmup:v${WARMUP_VERSION}:${workspaceId}`
}

function scheduleIdleTask(task: () => void) {
    const requestIdleCallback = window.requestIdleCallback

    if (typeof requestIdleCallback === 'function') {
        const idleId = requestIdleCallback.call(window, task, { timeout: 5000 })
        return () => window.cancelIdleCallback(idleId)
    }

    const timeoutId = globalThis.setTimeout(task, 1000)
    return () => globalThis.clearTimeout(timeoutId)
}

async function runInBatches(tasks: Array<() => Promise<unknown>>, batchSize: number) {
    for (let index = 0; index < tasks.length; index += batchSize) {
        const batch = tasks.slice(index, index + batchSize)
        await Promise.allSettled(batch.map((task) => task()))
    }
}

export function WorkspaceWarmup() {
    const { user, isAuthenticated } = useAuth()
    const {
        features,
        hasFeature,
        hasCapability,
        isLoading: isWorkspaceLoading,
        isLocalMode
    } = useWorkspace()
    const [isOnline, setIsOnline] = useState(() => connectionManager.getState().isOnline)
    const warmedWorkspacesRef = useRef(new Set<string>())
    const modulePreloadedWorkspacesRef = useRef(new Set<string>())

    useEffect(() => {
        const unsubscribe = connectionManager.subscribe((event) => {
            if (event === 'online' || event === 'heartbeat' || event === 'wake') {
                setIsOnline(true)
            } else if (event === 'offline') {
                setIsOnline(false)
            }
        })

        return unsubscribe
    }, [])

    const preloadWorkspaceModules = useCallback(async () => {
        const tasks: Array<() => Promise<unknown>> = [
            () => import('@/ui/pages/Dashboard'),
            () => import('@/ui/pages/ModuleLauncher'),
            () => import('@/ui/pages/Settings'),
        ]

        if (hasFeature('pos')) tasks.push(() => import('@/ui/pages/POS'))
        if (hasFeature('instant_pos')) tasks.push(() => import('@/ui/pages/InstantPOS'))
        if (hasFeature('kds')) tasks.push(() => import('@/ui/pages/KDSDashboard'))
        if (hasFeature('sales_history')) tasks.push(() => import('@/ui/pages/Sales'))
        if (hasFeature('crm')) {
            tasks.push(
                () => import('@/ui/pages/BusinessPartners'),
                () => import('@/ui/pages/BusinessPartnerDetails'),
                () => import('@/ui/pages/AccountStatements'),
                () => import('@/ui/pages/PartnerProductMovementsStatement'),
                () => import('@/ui/pages/Customers'),
                () => import('@/ui/pages/CustomerDetails'),
                () => import('@/ui/pages/Suppliers'),
                () => import('@/ui/pages/SupplierDetails'),
                () => import('@/ui/pages/Orders'),
            )
        }
        if (hasFeature('ecommerce')) tasks.push(() => import('@/ui/pages/Ecommerce'))
        if (hasFeature('real_estate')) tasks.push(() => import('@/ui/pages/RealEstate'))
        if (hasFeature('activities')) tasks.push(() => import('@/ui/pages/Activities'))
        if (hasFeature('currency_exchange')) tasks.push(() => import('@/ui/pages/CurrencyExchange'))
        if (hasFeature('manual_entry')) {
            tasks.push(
                () => import('@/ui/pages/ManualEntry'),
                () => import('@/ui/pages/ManualEntryTemplates'),
            )
        }
        if (hasFeature('agents')) {
            tasks.push(
                () => import('@/ui/pages/Agents'),
                () => import('@/ui/pages/AgentDetails'),
                () => import('@/ui/pages/FleetManagement'),
                () => import('@/ui/pages/AgentLocationSharing')
            )
        }
        if (hasFeature('post_service')) tasks.push(() => import('@/ui/pages/PostService'))
        if (hasFeature('car_rental')) tasks.push(() => import('@/ui/pages/CarRental'))
        if (hasFeature('clinical_appointments')) {
          tasks.push(
            () => import('@/ui/pages/ClinicalAppointments'),
            () => import('@/ui/pages/ClinicalPatients'),
            () => import('@/ui/pages/ClinicalPatientDetails'),
            () => import('@/ui/pages/ClinicalPresets'),
          )
        }
        if (hasFeature('ledger')) tasks.push(() => import('@/ui/pages/Ledger'))
        if (hasFeature('payments')) tasks.push(() => import('@/ui/pages/Payments'))
        if (hasFeature('direct_transactions')) tasks.push(() => import('@/ui/pages/DirectTransactions'))
        if (hasFeature('net_revenue')) tasks.push(() => import('@/ui/pages/Revenue'))
        if (hasFeature('budget')) tasks.push(() => import('@/ui/pages/Budget'))
        if (hasFeature('monthly_comparison')) tasks.push(() => import('@/ui/pages/MonthlyComparison'))
        if (hasFeature('team_performance')) tasks.push(() => import('@/ui/pages/TeamPerformance'))
        if (hasFeature('allow_whatsapp')) tasks.push(() => import('@/ui/pages/WhatsAppWeb'))
        if (hasFeature('products')) {
            tasks.push(
                () => import('@/ui/pages/Products'),
                () => import('@/ui/pages/ProductFormPage'),
                () => import('@/ui/pages/UnitsPage'),
            )
        }
        if (hasFeature('discounts')) tasks.push(() => import('@/ui/pages/Discounts'))
        if (hasFeature('storages')) tasks.push(() => import('@/ui/pages/Storages'))
        if (hasFeature('inventory_transfer')) tasks.push(() => import('@/ui/pages/InventoryTransfer'))
        if (hasFeature('inventory_transactions')) tasks.push(() => import('@/ui/pages/InventoryTransactions'))
        if (hasFeature('stock_adjustments')) tasks.push(() => import('@/ui/pages/StockAdjustments'))
        if (hasFeature('hr')) tasks.push(() => import('@/ui/pages/HR'))
        if (hasFeature('loans') || hasFeature('installments') || hasFeature('real_estate')) tasks.push(() => import('@/ui/pages/Loans'))
        if (hasFeature('invoices_history')) tasks.push(() => import('@/ui/pages/InvoicesHistory'))
        if (hasCapability('multiCurrency') && features.allowed_currencies.length > 1) {
            tasks.push(() => import('@/ui/pages/CurrencyConverter'))
        }
        if (hasFeature('members')) tasks.push(() => import('@/ui/pages/Members'))
        if (user?.role === 'admin') tasks.push(() => import('@/ui/pages/CustomTemplates'))

        await runInBatches(tasks, MODULE_PRELOAD_BATCH_SIZE)
    }, [features.allowed_currencies.length, hasCapability, hasFeature, user?.role])

    useEffect(() => {
        if (
            !isInstalledPwa()
            || !isSupabaseConfigured
            || !isAuthenticated
            || !user?.workspaceId
            || isWorkspaceLoading
            || isLocalMode
        ) {
            return
        }

        const workspaceId = user.workspaceId
        let cancelled = false

        const cancelIdleTask = scheduleIdleTask(() => {
            if (cancelled) return

            if (!modulePreloadedWorkspacesRef.current.has(workspaceId)) {
                modulePreloadedWorkspacesRef.current.add(workspaceId)
                void preloadWorkspaceModules()
            }

            if (!isOnline || warmedWorkspacesRef.current.has(workspaceId)) {
                return
            }

            warmedWorkspacesRef.current.add(workspaceId)

            const warmupKey = getWarmupKey(workspaceId)
            const hasCompletedInitialWarmup = localStorage.getItem(warmupKey) === 'true'
            const lastSyncTime = hasCompletedInitialWarmup
                ? localStorage.getItem(LAST_SYNC_KEY)
                : null

            void runManagedFullSync(user.id, workspaceId, lastSyncTime)
                .then((result) => {
                    if (cancelled) return

                    if (result.success) {
                        const now = new Date().toISOString()
                        localStorage.setItem(LAST_SYNC_KEY, now)
                        localStorage.setItem(warmupKey, 'true')
                    } else {
                        warmedWorkspacesRef.current.delete(workspaceId)
                    }
                })
                .catch((error) => {
                    warmedWorkspacesRef.current.delete(workspaceId)
                    console.error('[WorkspaceWarmup] Failed to warm workspace data:', error)
                })
        })

        return () => {
            cancelled = true
            cancelIdleTask()
        }
    }, [
        isAuthenticated,
        isLocalMode,
        isOnline,
        isWorkspaceLoading,
        preloadWorkspaceModules,
        user?.id,
        user?.workspaceId,
    ])

    return null
}
