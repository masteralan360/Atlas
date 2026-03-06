import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { supabase, isSupabaseConfigured } from '@/auth/supabase'
import { useAuth } from '@/auth/AuthContext'
import type { CurrencyCode, IQDDisplayPreference, Workspace } from '@/local-db/models'
import { db } from '@/local-db/database'
import { addToOfflineMutations } from '@/local-db/hooks'
import { isMobile } from '@/lib/platform'
import { connectionManager } from '@/lib/connectionManager'
import {
    readWorkspaceCache,
    writeWorkspaceCache,
    type WorkspaceCacheSnapshot
} from './workspaceCache'

export interface WorkspaceFeatures {
    allow_pos: boolean
    allow_customers: boolean
    allow_suppliers: boolean
    allow_orders: boolean
    allow_invoices: boolean
    is_configured: boolean
    default_currency: CurrencyCode
    iqd_display_preference: IQDDisplayPreference
    eur_conversion_enabled: boolean
    try_conversion_enabled: boolean
    locked_workspace: boolean
    logo_url: string | null
    max_discount_percent: number
    allow_whatsapp: boolean
    print_lang: 'auto' | 'en' | 'ar' | 'ku'
    print_qr: boolean
    receipt_template: 'primary' | 'modern'
    a4_template: 'primary' | 'modern'
    print_quality: 'low' | 'high'
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
    hasFeature: (feature: 'allow_pos' | 'allow_customers' | 'allow_suppliers' | 'allow_orders' | 'allow_invoices' | 'allow_whatsapp') => boolean
    refreshFeatures: () => Promise<void>
    updateSettings: (settings: Partial<Pick<WorkspaceFeatures, 'default_currency' | 'iqd_display_preference' | 'eur_conversion_enabled' | 'try_conversion_enabled' | 'allow_whatsapp' | 'logo_url' | 'print_lang' | 'print_qr' | 'receipt_template' | 'a4_template' | 'print_quality'>> & { name?: string }) => Promise<void>
    activeWorkspace: { id: string } | undefined
}

const defaultFeatures: WorkspaceFeatures = {
    allow_pos: true,
    allow_customers: true,
    allow_suppliers: true,
    allow_orders: true,
    allow_invoices: true,
    is_configured: true,
    default_currency: 'usd',
    iqd_display_preference: 'IQD',
    eur_conversion_enabled: false,
    try_conversion_enabled: false,
    locked_workspace: false,
    logo_url: null,
    max_discount_percent: 100,
    allow_whatsapp: false,
    print_lang: 'auto',
    print_qr: false,
    receipt_template: 'primary',
    a4_template: 'primary',
    print_quality: 'low',
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
        allow_pos: localWorkspace.allow_pos ?? true,
        allow_customers: localWorkspace.allow_customers ?? true,
        allow_suppliers: localWorkspace.allow_suppliers ?? true,
        allow_orders: localWorkspace.allow_orders ?? true,
        allow_invoices: localWorkspace.allow_invoices ?? true,
        is_configured: localWorkspace.is_configured,
        default_currency: localWorkspace.default_currency,
        iqd_display_preference: localWorkspace.iqd_display_preference,
        eur_conversion_enabled: localWorkspace.eur_conversion_enabled ?? false,
        try_conversion_enabled: localWorkspace.try_conversion_enabled ?? false,
        locked_workspace: localWorkspace.locked_workspace ?? false,
        logo_url: localWorkspace.logo_url ?? null,
        max_discount_percent: localWorkspace.max_discount_percent ?? 100,
        allow_whatsapp: localWorkspace.allow_whatsapp ?? false,
        print_lang: localWorkspace.print_lang ?? 'auto',
        print_qr: localWorkspace.print_qr ?? false,
        receipt_template: localWorkspace.receipt_template ?? 'primary',
        a4_template: localWorkspace.a4_template ?? 'primary',
        print_quality: localWorkspace.print_quality ?? 'low',
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
            is_configured: nextFeatures.is_configured,
            default_currency: nextFeatures.default_currency,
            iqd_display_preference: nextFeatures.iqd_display_preference,
            eur_conversion_enabled: nextFeatures.eur_conversion_enabled,
            try_conversion_enabled: nextFeatures.try_conversion_enabled,
            locked_workspace: nextFeatures.locked_workspace,
            allow_pos: nextFeatures.allow_pos,
            allow_customers: nextFeatures.allow_customers,
            allow_suppliers: nextFeatures.allow_suppliers,
            allow_orders: nextFeatures.allow_orders,
            allow_invoices: nextFeatures.allow_invoices,
            allow_whatsapp: nextFeatures.allow_whatsapp,
            logo_url: nextFeatures.logo_url,
            max_discount_percent: nextFeatures.max_discount_percent,
            print_lang: nextFeatures.print_lang,
            print_qr: nextFeatures.print_qr,
            receipt_template: nextFeatures.receipt_template,
            a4_template: nextFeatures.a4_template,
            print_quality: nextFeatures.print_quality,
            subscription_expires_at: nextFeatures.subscription_expires_at,
            syncStatus: 'synced',
            lastSyncedAt: timestamp,
            version: existing?.version ?? 1,
            isDeleted: existing?.isDeleted ?? false,
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp
        })
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
            const rpcPromise = supabase.rpc('get_workspace_features').single()
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Workspace features fetch timed out')), 12000)
            )

            const { data, error } = await Promise.race([rpcPromise, timeoutPromise]) as any

            if (error || !data || data.error) {
                throw error ?? new Error(data?.error || 'Workspace features fetch returned no data')
            }

            const featureData = data as any
            const fetchedFeatures = mergeWorkspaceFeatures({
                allow_pos: featureData.allow_pos ?? true,
                allow_customers: featureData.allow_customers ?? true,
                allow_suppliers: featureData.allow_suppliers ?? true,
                allow_orders: featureData.allow_orders ?? true,
                allow_invoices: featureData.allow_invoices ?? true,
                is_configured: featureData.is_configured ?? true,
                default_currency: featureData.default_currency || 'usd',
                iqd_display_preference: featureData.iqd_display_preference || 'IQD',
                eur_conversion_enabled: featureData.eur_conversion_enabled ?? false,
                try_conversion_enabled: featureData.try_conversion_enabled ?? false,
                locked_workspace: featureData.locked_workspace ?? false,
                logo_url: featureData.logo_url ?? null,
                max_discount_percent: featureData.max_discount_percent ?? 100,
                allow_whatsapp: featureData.allow_whatsapp ?? false,
                print_lang: featureData.print_lang ?? 'auto',
                print_qr: featureData.print_qr ?? false,
                receipt_template: featureData.receipt_template ?? 'primary',
                a4_template: featureData.a4_template ?? 'primary',
                print_quality: featureData.print_quality ?? 'low',
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
                            allow_pos: data.allow_pos ?? currentFeatures.allow_pos,
                            allow_customers: data.allow_customers ?? currentFeatures.allow_customers,
                            allow_suppliers: data.allow_suppliers ?? currentFeatures.allow_suppliers,
                            allow_orders: data.allow_orders ?? currentFeatures.allow_orders,
                            allow_invoices: data.allow_invoices ?? currentFeatures.allow_invoices,
                            is_configured: data.is_configured ?? currentFeatures.is_configured,
                            default_currency: data.default_currency || currentFeatures.default_currency,
                            iqd_display_preference: data.iqd_display_preference || currentFeatures.iqd_display_preference,
                            eur_conversion_enabled: data.eur_conversion_enabled ?? currentFeatures.eur_conversion_enabled,
                            try_conversion_enabled: data.try_conversion_enabled ?? currentFeatures.try_conversion_enabled,
                            locked_workspace: data.locked_workspace ?? currentFeatures.locked_workspace,
                            logo_url: data.logo_url ?? currentFeatures.logo_url,
                            max_discount_percent: data.max_discount_percent ?? currentFeatures.max_discount_percent,
                            allow_whatsapp: data.allow_whatsapp ?? currentFeatures.allow_whatsapp,
                            print_lang: data.print_lang ?? currentFeatures.print_lang,
                            print_qr: data.print_qr ?? currentFeatures.print_qr,
                            receipt_template: data.receipt_template ?? currentFeatures.receipt_template,
                            a4_template: data.a4_template ?? currentFeatures.a4_template,
                            print_quality: data.print_quality ?? currentFeatures.print_quality,
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

    const hasFeature = (feature: 'allow_pos' | 'allow_customers' | 'allow_suppliers' | 'allow_orders' | 'allow_invoices' | 'allow_whatsapp'): boolean => {
        return features[feature] === true
    }

    const refreshFeatures = async () => {
        const workspaceId = user?.workspaceId
        if (!workspaceId) return

        setIsLoading(true)
        await fetchFeatures(false, { workspaceId })
    }

    const updateSettings = async (
        settings: Partial<Pick<WorkspaceFeatures, 'default_currency' | 'iqd_display_preference' | 'eur_conversion_enabled' | 'try_conversion_enabled' | 'allow_whatsapp' | 'logo_url' | 'print_lang' | 'print_qr' | 'receipt_template' | 'a4_template' | 'print_quality'>> & { name?: string }
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
        const localUpdateData = {
            ...featureSettings,
            ...(name !== undefined && { name }),
            is_configured: newFeatures.is_configured,
            updatedAt: now,
            syncStatus: 'pending' as const
        }

        if (existing) {
            await db.workspaces.update(workspaceId, localUpdateData)
        } else {
            await db.workspaces.put({
                id: workspaceId,
                workspaceId,
                name: nextWorkspaceName,
                code: user?.workspaceCode || 'LOCAL',
                is_configured: newFeatures.is_configured,
                default_currency: newFeatures.default_currency,
                iqd_display_preference: newFeatures.iqd_display_preference,
                eur_conversion_enabled: newFeatures.eur_conversion_enabled,
                try_conversion_enabled: newFeatures.try_conversion_enabled,
                locked_workspace: newFeatures.locked_workspace,
                allow_pos: newFeatures.allow_pos,
                allow_customers: newFeatures.allow_customers,
                allow_suppliers: newFeatures.allow_suppliers,
                allow_orders: newFeatures.allow_orders,
                allow_invoices: newFeatures.allow_invoices,
                allow_whatsapp: newFeatures.allow_whatsapp,
                logo_url: newFeatures.logo_url,
                max_discount_percent: newFeatures.max_discount_percent,
                print_lang: newFeatures.print_lang,
                print_qr: newFeatures.print_qr,
                receipt_template: newFeatures.receipt_template,
                a4_template: newFeatures.a4_template,
                print_quality: newFeatures.print_quality,
                subscription_expires_at: newFeatures.subscription_expires_at,
                syncStatus: 'pending',
                lastSyncedAt: null,
                version: 1,
                isDeleted: false,
                createdAt: now,
                updatedAt: now
            })
        }

        const supabaseUpdate: Record<string, unknown> = { ...featureSettings }
        if (name !== undefined) {
            supabaseUpdate.name = name
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

    const isLocked = features.locked_workspace || (features.subscription_expires_at ? new Date(features.subscription_expires_at) < new Date() : false)

    return (
        <WorkspaceContext.Provider value={{
            features,
            workspaceName,
            isLoading,
            pendingUpdate,
            setPendingUpdate,
            isLocked,
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
