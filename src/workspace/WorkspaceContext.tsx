import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { supabase, isSupabaseConfigured } from '@/auth/supabase'
import { useAuth } from '@/auth/AuthContext'
import type {
    CurrencyCode,
    IQDDisplayPreference,
    Workspace,
    WorkspaceDataMode
} from '@/local-db/models'
import { db } from '@/local-db/database'
import { addToOfflineMutations } from '@/local-db/hooks'
import { hydrateLocalModeCacheFromSqlite } from '@/local-db/localModeSqlite'
import { isMobile } from '@/lib/platform'
import { connectionManager } from '@/lib/connectionManager'
import {
    readWorkspaceCache,
    writeWorkspaceCache,
    type WorkspaceCacheSnapshot
} from './workspaceCache'
import { writeWorkspaceModeSnapshot } from './workspaceMode'
import { runSupabaseAction } from '@/lib/supabaseRequest'

export type ModuleFeatureKey =
    | 'pos'
    | 'instant_pos'
    | 'sales_history'
    | 'crm'
    | 'travel_agency'
    | 'loans'
    | 'net_revenue'
    | 'budget'
    | 'monthly_comparison'
    | 'team_performance'
    | 'products'
    | 'storages'
    | 'inventory_transfer'
    | 'invoices_history'
    | 'hr'
    | 'members'
    | 'allow_whatsapp'

export interface WorkspaceFeatures {
    data_mode: WorkspaceDataMode
    // Module toggles
    pos: boolean
    instant_pos: boolean
    sales_history: boolean
    crm: boolean
    travel_agency: boolean
    loans: boolean
    net_revenue: boolean
    budget: boolean
    monthly_comparison: boolean
    team_performance: boolean
    products: boolean
    storages: boolean
    inventory_transfer: boolean
    invoices_history: boolean
    hr: boolean
    members: boolean
    // Other settings
    is_configured: boolean
    default_currency: CurrencyCode
    iqd_display_preference: IQDDisplayPreference
    eur_conversion_enabled: boolean
    try_conversion_enabled: boolean
    locked_workspace: boolean
    logo_url: string | null
    coordination: string | null
    max_discount_percent: number
    allow_whatsapp: boolean
    kds_enabled: boolean
    print_lang: 'auto' | 'en' | 'ar' | 'ku'
    print_qr: boolean
    receipt_template: 'primary' | 'modern'
    a4_template: 'primary' | 'modern'
    print_quality: 'low' | 'high'
    thermal_printing: boolean
    subscription_expires_at: string | null
}

export interface UpdateInfo {
    version: string
    date?: string
    body?: string
}

interface WorkspaceContextType {
    features: WorkspaceFeatures
    workspaceName: string | null
    isLoading: boolean
    pendingUpdate: UpdateInfo | null
    setPendingUpdate: (update: UpdateInfo | null) => void
    isFullscreen: boolean
    isLocked: boolean
    isLocalMode: boolean
    isCloudMode: boolean
    hasFeature: (feature: ModuleFeatureKey) => boolean
    refreshFeatures: () => Promise<void>
    updateSettings: (settings: Partial<Pick<WorkspaceFeatures, 'default_currency' | 'iqd_display_preference' | 'eur_conversion_enabled' | 'try_conversion_enabled' | 'allow_whatsapp' | 'kds_enabled' | 'logo_url' | 'coordination' | 'print_lang' | 'print_qr' | 'receipt_template' | 'a4_template' | 'print_quality' | 'thermal_printing'>> & { name?: string }) => Promise<void>
    activeWorkspace: { id: string } | undefined
}

const defaultFeatures: WorkspaceFeatures = {
    data_mode: 'cloud',
    pos: true,
    instant_pos: true,
    sales_history: true,
    crm: true,
    travel_agency: true,
    loans: true,
    net_revenue: true,
    budget: true,
    monthly_comparison: true,
    team_performance: true,
    products: true,
    storages: true,
    inventory_transfer: true,
    invoices_history: true,
    hr: true,
    members: true,
    is_configured: true,
    default_currency: 'usd',
    iqd_display_preference: 'IQD',
    eur_conversion_enabled: false,
    try_conversion_enabled: false,
    locked_workspace: false,
    logo_url: null,
    coordination: null,
    max_discount_percent: 100,
    allow_whatsapp: false,
    kds_enabled: false,
    print_lang: 'auto',
    print_qr: false,
    receipt_template: 'primary',
    a4_template: 'primary',
    print_quality: 'low',
    thermal_printing: false,
    subscription_expires_at: null
}

function mergeWorkspaceFeatures(features?: Partial<WorkspaceFeatures> | null): WorkspaceFeatures {
    return { ...defaultFeatures, ...(features ?? {}) }
}

function getFeaturesFromLocalWorkspace(localWorkspace: Workspace): WorkspaceFeatures | null {
    if (typeof localWorkspace.is_configured !== 'boolean') {
        return null
    }

    return mergeWorkspaceFeatures({
        data_mode: localWorkspace.data_mode ?? 'cloud',
        pos: localWorkspace.pos ?? true,
        instant_pos: localWorkspace.instant_pos ?? true,
        sales_history: localWorkspace.sales_history ?? true,
        crm: localWorkspace.crm ?? true,
        travel_agency: localWorkspace.travel_agency ?? true,
        loans: localWorkspace.loans ?? true,
        net_revenue: localWorkspace.net_revenue ?? true,
        budget: localWorkspace.budget ?? true,
        monthly_comparison: localWorkspace.monthly_comparison ?? true,
        team_performance: localWorkspace.team_performance ?? true,
        products: localWorkspace.products ?? true,
        storages: localWorkspace.storages ?? true,
        inventory_transfer: localWorkspace.inventory_transfer ?? true,
        invoices_history: localWorkspace.invoices_history ?? true,
        hr: localWorkspace.hr ?? true,
        members: localWorkspace.members ?? true,
        is_configured: localWorkspace.is_configured,
        default_currency: localWorkspace.default_currency,
        iqd_display_preference: localWorkspace.iqd_display_preference,
        eur_conversion_enabled: localWorkspace.eur_conversion_enabled ?? false,
        try_conversion_enabled: localWorkspace.try_conversion_enabled ?? false,
        locked_workspace: localWorkspace.locked_workspace ?? false,
        logo_url: localWorkspace.logo_url ?? null,
        coordination: localWorkspace.coordination ?? null,
        max_discount_percent: localWorkspace.max_discount_percent ?? 100,
        allow_whatsapp: localWorkspace.allow_whatsapp ?? false,
        kds_enabled: localWorkspace.kds_enabled ?? false,
        print_lang: localWorkspace.print_lang ?? 'auto',
        print_qr: localWorkspace.print_qr ?? false,
        receipt_template: localWorkspace.receipt_template ?? 'primary',
        a4_template: localWorkspace.a4_template ?? 'primary',
        print_quality: localWorkspace.print_quality ?? 'low',
        thermal_printing: localWorkspace.thermal_printing ?? false,
        subscription_expires_at: localWorkspace.subscription_expires_at ?? null
    })
}

function isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated, isLoading: authLoading, updateUser } = useAuth()

    const [features, setFeatures] = useState<WorkspaceFeatures>(defaultFeatures)
    const [workspaceName, setWorkspaceName] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [pendingUpdate, setPendingUpdate] = useState<UpdateInfo | null>(null)
    const [isFullscreen, setIsFullscreen] = useState(false)
    const realtimeChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
    const currentWorkspaceIdRef = useRef<string | null>(null)
    const fetchRequestRef = useRef(0)
    const featuresRef = useRef(defaultFeatures)
    const workspaceNameRef = useRef<string | null>(null)

    useEffect(() => {
        featuresRef.current = features
    }, [features])

    useEffect(() => {
        workspaceNameRef.current = workspaceName
    }, [workspaceName])

    useEffect(() => {
        // @ts-ignore
        const isTauri = !!window.__TAURI_INTERNALS__
        if (!isTauri) return

        const updateFSState = async () => {
            try {
                const { getCurrentWindow } = await import('@tauri-apps/api/window')
                const win = getCurrentWindow()
                const fs = await win.isFullscreen()
                setIsFullscreen(fs)

                if (fs && !isMobile()) {
                    document.documentElement.setAttribute('data-fullscreen', 'true')
                } else {
                    document.documentElement.removeAttribute('data-fullscreen')
                }
            } catch (e) {
                console.error('[Tauri] FS Update Error:', e)
            }
        }

        updateFSState()

        let unlisten: (() => void) | undefined
        const setup = async () => {
            const { getCurrentWindow } = await import('@tauri-apps/api/window')
            unlisten = await getCurrentWindow().onResized(updateFSState)
        }

        void setup()

        return () => unlisten?.()
    }, [])

    const isCurrentWorkspaceRequest = (workspaceId: string, requestId: number) => {
        return currentWorkspaceIdRef.current === workspaceId && fetchRequestRef.current === requestId
    }

    const persistWorkspaceState = async (
        workspaceId: string,
        nextFeatures: WorkspaceFeatures,
        nextWorkspaceName: string | null
    ) => {
        const existing = await db.workspaces.get(workspaceId)
        const timestamp = new Date().toISOString()

        await db.workspaces.put({
            id: workspaceId,
            workspaceId,
            name: nextWorkspaceName || existing?.name || user?.workspaceName || 'My Workspace',
            code: existing?.code || user?.workspaceCode || 'LOADED',
            data_mode: nextFeatures.data_mode,
            is_configured: nextFeatures.is_configured,
            pos: nextFeatures.pos,
            instant_pos: nextFeatures.instant_pos,
            sales_history: nextFeatures.sales_history,
            crm: nextFeatures.crm,
            travel_agency: nextFeatures.travel_agency,
            loans: nextFeatures.loans,
            net_revenue: nextFeatures.net_revenue,
            budget: nextFeatures.budget,
            monthly_comparison: nextFeatures.monthly_comparison,
            team_performance: nextFeatures.team_performance,
            products: nextFeatures.products,
            storages: nextFeatures.storages,
            inventory_transfer: nextFeatures.inventory_transfer,
            invoices_history: nextFeatures.invoices_history,
            hr: nextFeatures.hr,
            members: nextFeatures.members,
            default_currency: nextFeatures.default_currency,
            iqd_display_preference: nextFeatures.iqd_display_preference,
            eur_conversion_enabled: nextFeatures.eur_conversion_enabled,
            try_conversion_enabled: nextFeatures.try_conversion_enabled,
            locked_workspace: nextFeatures.locked_workspace,
            allow_whatsapp: nextFeatures.allow_whatsapp,
            kds_enabled: nextFeatures.kds_enabled,
            logo_url: nextFeatures.logo_url,
            coordination: nextFeatures.coordination,
            max_discount_percent: nextFeatures.max_discount_percent,
            print_lang: nextFeatures.print_lang,
            print_qr: nextFeatures.print_qr,
            receipt_template: nextFeatures.receipt_template,
            a4_template: nextFeatures.a4_template,
            print_quality: nextFeatures.print_quality,
            thermal_printing: nextFeatures.thermal_printing,
            subscription_expires_at: nextFeatures.subscription_expires_at,
            syncStatus: 'synced',
            lastSyncedAt: timestamp,
            version: existing?.version ?? 1,
            isDeleted: existing?.isDeleted ?? false,
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp
        })

        if (nextFeatures.data_mode === 'local') {
            await hydrateLocalModeCacheFromSqlite(db, workspaceId)
        }
    }

    const resolveTrustedFallback = async (
        workspaceId: string,
        cachedSnapshot?: WorkspaceCacheSnapshot<WorkspaceFeatures> | null
    ) => {
        if (cachedSnapshot) {
            return {
                features: mergeWorkspaceFeatures(cachedSnapshot.features),
                workspaceName: cachedSnapshot.workspaceName
            }
        }

        const localWorkspace = await db.workspaces.get(workspaceId)
        if (!localWorkspace) {
            return null
        }

        const localFeatures = getFeaturesFromLocalWorkspace(localWorkspace)
        if (!localFeatures) {
            return null
        }

        return {
            features: localFeatures,
            workspaceName: localWorkspace.name || null
        }
    }

    const fetchFeatures = async (
        silent = false,
        options?: {
            workspaceId?: string
            cachedSnapshot?: WorkspaceCacheSnapshot<WorkspaceFeatures> | null
        }
    ) => {
        const workspaceId = options?.workspaceId ?? user?.workspaceId

        if (!isSupabaseConfigured || !isAuthenticated || !workspaceId) {
            setFeatures(defaultFeatures)
            setWorkspaceName(null)
            if (!silent) setIsLoading(false)
            return
        }

        const requestId = ++fetchRequestRef.current
        const cachedSnapshot = options?.cachedSnapshot ?? readWorkspaceCache<WorkspaceFeatures>(workspaceId)

        const applyFallback = async () => {
            const fallback = await resolveTrustedFallback(workspaceId, cachedSnapshot)

            if (!isCurrentWorkspaceRequest(workspaceId, requestId)) {
                return
            }

            if (fallback) {
                setFeatures(fallback.features)
                setWorkspaceName(fallback.workspaceName)
            } else if (!silent) {
                setFeatures(defaultFeatures)
                setWorkspaceName(user?.workspaceName ?? null)
            }
        }

        if (isOffline()) {
            await applyFallback()
            if (!silent && isCurrentWorkspaceRequest(workspaceId, requestId)) {
                setIsLoading(false)
            }
            return
        }

        try {
            const { data, error } = await runSupabaseAction(
                'workspace.getFeatures',
                () => supabase.rpc('get_workspace_features').single(),
                { timeoutMs: 12000, platform: 'all' }
            ) as any

            if (error || !data || data.error) {
                throw error ?? new Error(data?.error || 'Workspace features fetch returned no data')
            }

            const featureData = data as any
            const localThermalPrinting = cachedSnapshot?.features?.thermal_printing
                ?? (await db.workspaces.get(workspaceId))?.thermal_printing
                ?? featuresRef.current.thermal_printing
                ?? false
            const fetchedFeatures = mergeWorkspaceFeatures({
                data_mode: featureData.data_mode,
                pos: featureData.pos ?? true,
                instant_pos: featureData.instant_pos ?? true,
                sales_history: featureData.sales_history ?? true,
                crm: featureData.crm ?? true,
                travel_agency: featureData.travel_agency ?? true,
                loans: featureData.loans ?? true,
                net_revenue: featureData.net_revenue ?? true,
                budget: featureData.budget ?? true,
                monthly_comparison: featureData.monthly_comparison ?? true,
                team_performance: featureData.team_performance ?? true,
                products: featureData.products ?? true,
                storages: featureData.storages ?? true,
                inventory_transfer: featureData.inventory_transfer ?? true,
                invoices_history: featureData.invoices_history ?? true,
                hr: featureData.hr ?? true,
                members: featureData.members ?? true,
                is_configured: featureData.is_configured ?? true,
                default_currency: featureData.default_currency,
                iqd_display_preference: featureData.iqd_display_preference,
                eur_conversion_enabled: featureData.eur_conversion_enabled,
                try_conversion_enabled: featureData.try_conversion_enabled,
                locked_workspace: featureData.locked_workspace,
                logo_url: featureData.logo_url ?? null,
                coordination: featureData.coordination ?? null,
                max_discount_percent: featureData.max_discount_percent ?? 100,
                allow_whatsapp: featureData.allow_whatsapp,
                kds_enabled: featureData.kds_enabled ?? false,
                print_lang: featureData.print_lang,
                print_qr: featureData.print_qr,
                receipt_template: featureData.receipt_template,
                a4_template: featureData.a4_template,
                print_quality: featureData.print_quality,
                thermal_printing: localThermalPrinting,
                subscription_expires_at: featureData.subscription_expires_at ?? null
            })
            const nextWorkspaceName = featureData.workspace_name || user?.workspaceName || 'My Workspace'

            if (!isCurrentWorkspaceRequest(workspaceId, requestId)) {
                return
            }

            setFeatures(fetchedFeatures)
            setWorkspaceName(nextWorkspaceName)
            writeWorkspaceCache({
                workspaceId,
                features: fetchedFeatures,
                workspaceName: nextWorkspaceName
            })
            await persistWorkspaceState(workspaceId, fetchedFeatures, nextWorkspaceName)
        } catch (err) {
            console.error('Error fetching workspace features:', err)
            await applyFallback()
        } finally {
            if (!silent && isCurrentWorkspaceRequest(workspaceId, requestId)) {
                setIsLoading(false)
            }
        }
    }

    useEffect(() => {
        if (authLoading) return

        const workspaceId = isAuthenticated ? user?.workspaceId ?? null : null
        currentWorkspaceIdRef.current = workspaceId
        fetchRequestRef.current += 1

        if (!workspaceId) {
            setFeatures(defaultFeatures)
            setWorkspaceName(null)
            setIsLoading(false)
            return
        }

        setIsLoading(true)
        setFeatures(defaultFeatures)
        setWorkspaceName(null)

        const cachedSnapshot = readWorkspaceCache<WorkspaceFeatures>(workspaceId)
        if (cachedSnapshot) {
            setFeatures(mergeWorkspaceFeatures(cachedSnapshot.features))
            setWorkspaceName(cachedSnapshot.workspaceName)
        }

        void fetchFeatures(false, { workspaceId, cachedSnapshot })
    }, [authLoading, isAuthenticated, user?.workspaceId])

    useEffect(() => {
        if (!isSupabaseConfigured || !isAuthenticated || !user?.workspaceId) return

        const channel = supabase
            .channel(`workspace-live-${user.workspaceId}`)
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'workspaces',
                    filter: `id=eq.${user.workspaceId}`
                },
                async (payload) => {
                    try {
                        const data = payload.new as any
                        const currentFeatures = featuresRef.current
                        const updatedFeatures = mergeWorkspaceFeatures({
                            ...currentFeatures,
                            data_mode: data.data_mode ?? currentFeatures.data_mode,
                            pos: data.pos ?? currentFeatures.pos,
                            instant_pos: data.instant_pos ?? currentFeatures.instant_pos,
                            sales_history: data.sales_history ?? currentFeatures.sales_history,
                            crm: data.crm ?? currentFeatures.crm,
                            travel_agency: data.travel_agency ?? currentFeatures.travel_agency,
                            loans: data.loans ?? currentFeatures.loans,
                            net_revenue: data.net_revenue ?? currentFeatures.net_revenue,
                            budget: data.budget ?? currentFeatures.budget,
                            monthly_comparison: data.monthly_comparison ?? currentFeatures.monthly_comparison,
                            team_performance: data.team_performance ?? currentFeatures.team_performance,
                            products: data.products ?? currentFeatures.products,
                            storages: data.storages ?? currentFeatures.storages,
                            inventory_transfer: data.inventory_transfer ?? currentFeatures.inventory_transfer,
                            invoices_history: data.invoices_history ?? currentFeatures.invoices_history,
                            hr: data.hr ?? currentFeatures.hr,
                            members: data.members ?? currentFeatures.members,
                            is_configured: data.is_configured ?? currentFeatures.is_configured,
                            default_currency: data.default_currency || currentFeatures.default_currency,
                            iqd_display_preference: data.iqd_display_preference || currentFeatures.iqd_display_preference,
                            eur_conversion_enabled: data.eur_conversion_enabled ?? currentFeatures.eur_conversion_enabled,
                            try_conversion_enabled: data.try_conversion_enabled ?? currentFeatures.try_conversion_enabled,
                            locked_workspace: data.locked_workspace ?? currentFeatures.locked_workspace,
                            logo_url: data.logo_url ?? currentFeatures.logo_url,
                            coordination: data.coordination ?? currentFeatures.coordination,
                            max_discount_percent: data.max_discount_percent ?? currentFeatures.max_discount_percent,
                            allow_whatsapp: data.allow_whatsapp ?? currentFeatures.allow_whatsapp,
                            kds_enabled: data.kds_enabled ?? currentFeatures.kds_enabled,
                            print_lang: data.print_lang ?? currentFeatures.print_lang,
                            print_qr: data.print_qr ?? currentFeatures.print_qr,
                            receipt_template: data.receipt_template ?? currentFeatures.receipt_template,
                            a4_template: data.a4_template ?? currentFeatures.a4_template,
                            print_quality: data.print_quality ?? currentFeatures.print_quality,
                            thermal_printing: currentFeatures.thermal_printing,
                            subscription_expires_at: data.subscription_expires_at ?? currentFeatures.subscription_expires_at
                        })
                        const nextWorkspaceName = data.name || workspaceNameRef.current || user.workspaceName || 'My Workspace'

                        setFeatures(updatedFeatures)
                        setWorkspaceName(nextWorkspaceName)
                        writeWorkspaceCache({
                            workspaceId: user.workspaceId,
                            features: updatedFeatures,
                            workspaceName: nextWorkspaceName
                        })
                        await persistWorkspaceState(user.workspaceId, updatedFeatures, nextWorkspaceName)
                    } catch (error) {
                        console.error('[Workspace] Failed to apply realtime update:', error)
                    }
                }
            )
            .subscribe((status) => {
                console.log(`[Workspace] Realtime subscription: ${status}`)
            })

        realtimeChannelRef.current = channel

        return () => {
            supabase.removeChannel(channel)
            realtimeChannelRef.current = null
        }
    }, [isAuthenticated, user?.workspaceId, user?.workspaceName])

    useEffect(() => {
        if (!isSupabaseConfigured || !isAuthenticated || !user?.workspaceId) return

        const unsubscribe = connectionManager.subscribe((event) => {
            if (event === 'wake') {
                console.log('[Workspace] Wake event - re-fetching features silently')
                void fetchFeatures(true, { workspaceId: user.workspaceId })
            }
        })

        return unsubscribe
    }, [isAuthenticated, user?.workspaceId])

    const hasFeature = (feature: ModuleFeatureKey): boolean => {
        return features[feature] === true
    }

    const refreshFeatures = async () => {
        const workspaceId = user?.workspaceId
        if (!workspaceId) return

        setIsLoading(true)
        await fetchFeatures(false, { workspaceId })
    }

    const updateSettings = async (
        settings: Partial<Pick<WorkspaceFeatures, 'default_currency' | 'iqd_display_preference' | 'eur_conversion_enabled' | 'try_conversion_enabled' | 'allow_whatsapp' | 'kds_enabled' | 'logo_url' | 'coordination' | 'print_lang' | 'print_qr' | 'receipt_template' | 'a4_template' | 'print_quality' | 'thermal_printing'>> & { name?: string }
    ) => {
        const workspaceId = user?.workspaceId
        if (!workspaceId) return

        const { name, ...featureSettings } = settings
        const currentFeatures = featuresRef.current
        const nextWorkspaceName = name ?? workspaceNameRef.current ?? user?.workspaceName ?? 'My Workspace'
        const newFeatures = { ...currentFeatures, ...featureSettings }
        const now = new Date().toISOString()

        if (name) {
            setWorkspaceName(name)
            updateUser({ workspaceName: name })
        }

        setFeatures(newFeatures)
        writeWorkspaceCache({
            workspaceId,
            features: newFeatures,
            workspaceName: nextWorkspaceName
        })

        const existing = await db.workspaces.get(workspaceId)
        const supabaseUpdate: Record<string, unknown> = { ...featureSettings }
        delete supabaseUpdate.thermal_printing
        if (name !== undefined) {
            supabaseUpdate.name = name
        }
        const shouldSync = Object.keys(supabaseUpdate).length > 0

        const localUpdateData = {
            ...featureSettings,
            ...(name !== undefined && { name }),
            is_configured: newFeatures.is_configured,
            crm: newFeatures.crm,
            updatedAt: now,
            ...(shouldSync ? { syncStatus: 'pending' as const } : {})
        }

        if (existing) {
            await db.workspaces.update(workspaceId, localUpdateData)
        } else {
            await db.workspaces.put({
                id: workspaceId,
                workspaceId,
                name: nextWorkspaceName,
                code: user?.workspaceCode || 'LOCAL',
                data_mode: newFeatures.data_mode,
                is_configured: newFeatures.is_configured,
                pos: newFeatures.pos,
                instant_pos: newFeatures.instant_pos,
                sales_history: newFeatures.sales_history,
                crm: newFeatures.crm,
                travel_agency: newFeatures.travel_agency,
                loans: newFeatures.loans,
                net_revenue: newFeatures.net_revenue,
                budget: newFeatures.budget,
                monthly_comparison: newFeatures.monthly_comparison,
                team_performance: newFeatures.team_performance,
                products: newFeatures.products,
                storages: newFeatures.storages,
                inventory_transfer: newFeatures.inventory_transfer,
                invoices_history: newFeatures.invoices_history,
                hr: newFeatures.hr,
                members: newFeatures.members,
                default_currency: newFeatures.default_currency,
                iqd_display_preference: newFeatures.iqd_display_preference,
                eur_conversion_enabled: newFeatures.eur_conversion_enabled,
                try_conversion_enabled: newFeatures.try_conversion_enabled,
                locked_workspace: newFeatures.locked_workspace,
                allow_whatsapp: newFeatures.allow_whatsapp,
                kds_enabled: newFeatures.kds_enabled,
                logo_url: newFeatures.logo_url,
                coordination: newFeatures.coordination,
                max_discount_percent: newFeatures.max_discount_percent,
                print_lang: newFeatures.print_lang,
                print_qr: newFeatures.print_qr,
                receipt_template: newFeatures.receipt_template,
                a4_template: newFeatures.a4_template,
                print_quality: newFeatures.print_quality,
                thermal_printing: newFeatures.thermal_printing,
                subscription_expires_at: newFeatures.subscription_expires_at,
                syncStatus: shouldSync ? 'pending' : 'synced',
                lastSyncedAt: shouldSync ? null : new Date().toISOString(),
                version: 1,
                isDeleted: false,
                createdAt: now,
                updatedAt: now
            })
        }

        if (!shouldSync) {
            return
        }

        if (navigator.onLine) {
            const { error } = await supabase
                .from('workspaces')
                .update(supabaseUpdate)
                .eq('id', workspaceId)

            if (error) {
                console.error('Error updating workspace settings on Supabase:', error)
                await addToOfflineMutations('workspaces', workspaceId, 'update', supabaseUpdate, workspaceId)
            } else {
                await db.workspaces.update(workspaceId, {
                    syncStatus: 'synced',
                    lastSyncedAt: new Date().toISOString()
                })
            }
        } else {
            await addToOfflineMutations('workspaces', workspaceId, 'update', supabaseUpdate, workspaceId)
        }
    }

    useEffect(() => {
        if (!user?.workspaceId) {
            return
        }

        writeWorkspaceModeSnapshot({
            workspaceId: user.workspaceId,
            dataMode: features.data_mode
        })
    }, [
        features.data_mode,
        user?.workspaceId
    ])

    const isLocalMode = features.data_mode === 'local'
    const isCloudMode = features.data_mode === 'cloud'
    const isLocked = features.locked_workspace
        || (features.subscription_expires_at ? new Date(features.subscription_expires_at) < new Date() : false)

    return (
        <WorkspaceContext.Provider value={{
            features,
            workspaceName,
            isLoading,
            pendingUpdate,
            setPendingUpdate,
            isLocked,
            isLocalMode,
            isCloudMode,
            hasFeature,
            isFullscreen,
            refreshFeatures,
            updateSettings,
            activeWorkspace: user?.workspaceId ? { id: user.workspaceId } : undefined
        }}>
            {children}
        </WorkspaceContext.Provider>
    )
}

export function useWorkspace() {
    const context = useContext(WorkspaceContext)
    if (context === undefined) {
        throw new Error('useWorkspace must be used within a WorkspaceProvider')
    }
    return context
}
