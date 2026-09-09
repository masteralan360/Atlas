import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { supabase, isSupabaseConfigured } from '@/auth/supabase'
import { useAuth } from '@/auth/AuthContext'
import type {
    CurrencyCode,
    IQDDisplayPreference,
    SalesAgentCommissionSheetType,
    Workspace,
    WorkspaceDataMode
} from '@/local-db/models'
import { db } from '@/local-db/database'
import { hasCurrencyExchangeAccountingData } from '@/local-db/currencyExchange'
import { addToOfflineMutations } from '@/local-db/hooks'
import { hydrateLocalModeCacheFromSqlite, clearWorkspaceSqliteData, seedWorkspaceFromDexie } from '@/local-db/localModeSqlite'
import { fetchCachedCustomTemplates } from '@/lib/cachedCustomTemplates'
import { isMobile } from '@/lib/platform'
import { connectionManager } from '@/lib/connectionManager'
import {
    clearWorkspaceCache,
    readWorkspaceCache,
    writeWorkspaceCache,
    type WorkspaceCacheSnapshot
} from './workspaceCache'
import {
    normalizeWorkspaceDataMode,
    writeWorkspaceModeSnapshot
} from './workspaceMode'
import { isWorkspaceResolutionPending } from './workspaceLoading'
import { resolveFetchedWorkspaceLogo, resolvePersistedWorkspaceLogo } from './workspaceLogo'
import {
    resolveFetchedWorkspaceName,
    resolveFetchedWorkspaceSettings,
    resolvePersistedLocallyOwnedSettings
} from './workspaceLocalSettings'
import { runSupabaseAction, normalizeSupabaseActionError } from '@/lib/supabaseRequest'
import {
    DEFAULT_LEDGER_DASHBOARD_CONFIG,
    normalizeLedgerDashboardConfig,
    type LedgerDashboardConfig
} from '@/lib/ledgerCashSummary'
import {
    getWorkspacePaymentSummary,
    hasWorkspacePaymentAccessStateUpdate,
    isWorkspacePaymentAccessExpired,
    shouldWorkspacePaymentLockAccess,
    type WorkspacePaymentSummary
} from '@/lib/workspacePayments'
import {
    applyWorkspaceOverrides,
    getPlanCapabilities,
    getPrimaryCurrencyForPlan,
    normalizeWorkspacePlan,
    planHasWorkspaceFeature,
    WORKSPACE_FEATURE_MODULE_MAP,
    type PlanCapabilityKey,
    type ResolvedWorkspacePlan,
    type WorkspaceAccessOverride,
    type WorkspaceFeatureKey,
    type WorkspacePlan
} from '@/plans/workspacePlans'

export type ModuleFeatureKey = WorkspaceFeatureKey

export interface WorkspaceFeatures {
    plan: WorkspacePlan
    data_mode: WorkspaceDataMode
    // Module toggles
    pos: boolean
    instant_pos: boolean
    kds: boolean
    sales_history: boolean
    crm: boolean
    orders: boolean
    agents: boolean
    sales_agent_commissions: boolean
    agent_sales_accounts: boolean
    post_service: boolean
    car_rental: boolean
    travel_transportation: boolean
    ecommerce: boolean
    real_estate: boolean
    activities: boolean
    currency_exchange: boolean
    clinical_appointments: boolean
    loans: boolean
    installments: boolean
    net_revenue: boolean
    budget: boolean
    monthly_comparison: boolean
    team_performance: boolean
    products: boolean
    services: boolean
    discounts: boolean
    storages: boolean
    inventory_transfer: boolean
    inventory_transactions: boolean
    stock_adjustments: boolean
    invoices_history: boolean
    hr: boolean
    // Other settings
    is_configured: boolean
    default_currency: CurrencyCode
    pos_convert_to_workspace_currency: boolean
    iqd_display_preference: IQDDisplayPreference
    allowed_currencies: CurrencyCode[]
    locked_workspace: boolean
    logo_url: string | null
    coordination: string | null
    max_discount_percent: number
    allow_whatsapp: boolean
    print_lang: 'auto' | 'en' | 'ar' | 'ku'
    print_qr: boolean
    receipt_template: 'primary' | 'modern'
    a4_template: 'primary' | 'modern' | 'professional'
    print_quality: 'high'
    thermal_printing: boolean
    subscription_expires_at: string | null
    renewal_due_at: string | null
    has_usage_limits: boolean
    upload_limit_mb: number | null
    visibility: 'private' | 'public' | 'link_only'
    store_slug: string | null
    store_description: string | null
    sales_agent_commission_sheet_type: SalesAgentCommissionSheetType
    ledger_dashboard_config: LedgerDashboardConfig
    private_staff_customers: boolean
    private_staff_suppliers: boolean
    suppliers_admin_only: boolean
}

export interface UpdateInfo {
    version: string
    date?: string
    body?: string
}

export interface BranchInfo {
    isBranch: boolean
    relationId?: string
    branchName?: string
    sourceWorkspaceId?: string
    sourceWorkspaceName?: string
}

interface WorkspaceContextType {
    features: WorkspaceFeatures
    plan: WorkspacePlan
    planCapabilities: ResolvedWorkspacePlan
    workspaceName: string | null
    branchInfo: BranchInfo | null
    resolvedBranchInfoWorkspaceId: string | null
    isLoading: boolean
    loadedWorkspaceId: string | null
    paymentSummary: WorkspacePaymentSummary | null
    isPaymentSummaryLoading: boolean
    pendingUpdate: UpdateInfo | null
    setPendingUpdate: (update: UpdateInfo | null) => void
    isFullscreen: boolean
    isLocked: boolean
    isLocalMode: boolean
    isDemoMode: boolean
    isCloudMode: boolean
    isHybridMode: boolean
    hasFeature: (feature: ModuleFeatureKey) => boolean
    hasCapability: (capability: PlanCapabilityKey) => boolean
    refreshFeatures: () => Promise<void>
    refreshPaymentSummary: () => Promise<WorkspacePaymentSummary | null>
    updateSettings: (
        settings: Partial<Pick<WorkspaceFeatures, 'default_currency' | 'pos_convert_to_workspace_currency' | 'iqd_display_preference' | 'allow_whatsapp' | 'logo_url' | 'coordination' | 'print_lang' | 'print_qr' | 'receipt_template' | 'a4_template' | 'thermal_printing' | 'visibility' | 'store_slug' | 'store_description' | 'sales_agent_commission_sheet_type' | 'ledger_dashboard_config' | 'private_staff_customers' | 'private_staff_suppliers' | 'suppliers_admin_only' | 'upload_limit_mb' | 'data_mode' | 'plan' | 'is_configured'>> & { name?: string },
        options?: { requireRemoteSync?: boolean }
    ) => Promise<void>
    switchDataMode: (newMode: 'cloud' | 'hybrid') => Promise<{ error: string | null }>
    activeWorkspace: { id: string } | undefined
}

const PLAN_DERIVED_FEATURE_KEYS: ModuleFeatureKey[] = [
    'pos',
    'instant_pos',
    'kds',
    'sales_history',
    'crm',
    'orders',
    'agents',
    'sales_agent_commissions',
    'agent_sales_accounts',
    'post_service',
    'car_rental',
    'travel_transportation',
    'ecommerce',
    'real_estate',
    'activities',
    'currency_exchange',
    'clinical_appointments',
    'loans',
    'installments',
    'net_revenue',
    'budget',
    'monthly_comparison',
    'team_performance',
    'products',
    'services',
    'discounts',
    'storages',
    'inventory_transfer',
    'inventory_transactions',
    'stock_adjustments',
    'invoices_history',
    'hr',
    'allow_whatsapp'
]

function getPlanFeatureFlags(plan: WorkspacePlan) {
    return PLAN_DERIVED_FEATURE_KEYS.reduce((flags, key) => {
        flags[key] = planHasWorkspaceFeature(plan, key)
        return flags
    }, {} as Record<ModuleFeatureKey, boolean>)
}

function getResolvedFeatureFlags(resolved: ResolvedWorkspacePlan) {
    const moduleSet = new Set(resolved.modules)
    const capabilitySet = new Set(resolved.capabilities)
    return PLAN_DERIVED_FEATURE_KEYS.reduce((flags, key) => {
        switch (key) {
            case 'monthly_comparison':
                flags[key] = moduleSet.has('revenue_analytics')
                break
            case 'allow_whatsapp':
                flags[key] = capabilitySet.has('whatsappIntegration')
                break
            case 'crm':
                flags[key] = moduleSet.has('customers')
                break
            default: {
                const mappedModule = WORKSPACE_FEATURE_MODULE_MAP[key]
                flags[key] = mappedModule ? moduleSet.has(mappedModule) : moduleSet.has(key as any)
                break
            }
        }
        return flags
    }, {} as Record<ModuleFeatureKey, boolean>)
}

const defaultPlan = normalizeWorkspacePlan('basic')

const PLAN_CONTROLLED_SETTINGS = new Set<string>([
    ...PLAN_DERIVED_FEATURE_KEYS,
    'allow_whatsapp',
    'upload_limit_mb'
])

const defaultFeatures: WorkspaceFeatures = {
    plan: defaultPlan,
    data_mode: 'cloud',
    ...getPlanFeatureFlags(defaultPlan),
    is_configured: true,
    default_currency: 'usd',
    pos_convert_to_workspace_currency: true,
    iqd_display_preference: 'IQD',
    allowed_currencies: ['usd', 'iqd'],
    locked_workspace: false,
    logo_url: null,
    coordination: null,
    max_discount_percent: 100,
    allow_whatsapp: false,
    real_estate: false,
    activities: false,
    currency_exchange: false,
    agents: false,
    post_service: false,
    car_rental: false,
    travel_transportation: false,
    clinical_appointments: false,
    print_lang: 'auto',
    print_qr: false,
    receipt_template: 'primary',
    a4_template: 'professional',
    print_quality: 'high' as const,
    thermal_printing: false,
    subscription_expires_at: null,
    renewal_due_at: null,
    has_usage_limits: false,
    upload_limit_mb: null,
    visibility: 'private',
    store_slug: null,
    store_description: null,
    sales_agent_commission_sheet_type: 'normal',
    ledger_dashboard_config: { ...DEFAULT_LEDGER_DASHBOARD_CONFIG, groupOrder: [...DEFAULT_LEDGER_DASHBOARD_CONFIG.groupOrder] },
    private_staff_customers: false,
    private_staff_suppliers: false,
    suppliers_admin_only: false
}

const WORKSPACE_FEATURE_COLUMNS = [
    'name',
    'plan',
    'data_mode',
    'real_estate',
    'is_configured',
    'default_currency',
    'pos_convert_to_workspace_currency',
    'iqd_display_preference',
    'locked_workspace',
    'logo_url',
    'coordination',
    'max_discount_percent',
    'allow_whatsapp',
    'print_lang',
    'print_qr',
    'receipt_template',
    'a4_template',
    'subscription_expires_at',
    'upload_limit_mb',
    'visibility',
    'store_slug',
    'store_description',
    'sales_agent_commission_sheet_type',
    'ledger_dashboard_config',
    'private_staff_customers',
    'private_staff_suppliers',
    'suppliers_admin_only'
].join(', ')

function mergeWorkspaceFeatures(
    features?: Partial<WorkspaceFeatures> | null,
    overrides?: WorkspaceAccessOverride[] | null
): WorkspaceFeatures {
    const plan = normalizeWorkspacePlan(features?.plan ?? defaultFeatures.plan)
    const planCapabilities = getPlanCapabilities(plan)
    const resolvedCapabilities = overrides?.length
        ? applyWorkspaceOverrides(planCapabilities, overrides)
        : planCapabilities
    const allowedCurrencies = resolvedCapabilities.allowedCurrencies
    const requestedCurrency = String(features?.default_currency ?? defaultFeatures.default_currency).toLowerCase()
    const defaultCurrency = allowedCurrencies.includes(requestedCurrency as CurrencyCode)
        ? requestedCurrency as CurrencyCode
        : getPrimaryCurrencyForPlan(plan) as CurrencyCode
    const supportsUploads = resolvedCapabilities.capabilities.includes('workspaceStorageUploads' as PlanCapabilityKey)

    const capSet = new Set(resolvedCapabilities.capabilities)

    return {
        ...defaultFeatures,
        ...(features ?? {}),
        ...getResolvedFeatureFlags(resolvedCapabilities),
        plan,
        data_mode: normalizeWorkspaceDataMode(features?.data_mode),
        default_currency: defaultCurrency,
        allowed_currencies: allowedCurrencies,
        allow_whatsapp: capSet.has('whatsappIntegration')
            ? features?.allow_whatsapp ?? false
            : false,
        upload_limit_mb: supportsUploads
            ? features?.upload_limit_mb ?? resolvedCapabilities.limits.maxUploadSizeMb
            : null,
        visibility: capSet.has('marketplaceStorefronts')
            ? features?.visibility ?? defaultFeatures.visibility
            : 'private',
        store_slug: capSet.has('marketplaceStorefronts')
            ? features?.store_slug ?? defaultFeatures.store_slug
            : null,
        store_description: capSet.has('marketplaceStorefronts')
            ? features?.store_description ?? defaultFeatures.store_description
            : null,
        thermal_printing: capSet.has('thermalPrinter')
            ? features?.thermal_printing ?? defaultFeatures.thermal_printing
            : false,
        ledger_dashboard_config: normalizeLedgerDashboardConfig(features?.ledger_dashboard_config),
        print_quality: 'high' as const
    }
}

function isWorkspaceCurrentlyLocked(
    features: Pick<WorkspaceFeatures, 'locked_workspace' | 'subscription_expires_at' | 'renewal_due_at' | 'has_usage_limits'>,
    summary?: WorkspacePaymentSummary | null,
    now?: Date
) {
    if (features.locked_workspace) return true

    return isWorkspacePaymentAccessExpired({
        subscriptionExpiresAt: features.subscription_expires_at,
        renewalDueAt: features.renewal_due_at,
        hasUsageLimits: features.has_usage_limits,
        summary,
        now
    })
}

function getFeaturesFromLocalWorkspace(localWorkspace: Workspace): WorkspaceFeatures | null {
    if (typeof localWorkspace.is_configured !== 'boolean') {
        return null
    }

    return mergeWorkspaceFeatures({
        plan: normalizeWorkspacePlan(localWorkspace.plan),
        data_mode: localWorkspace.data_mode ?? 'cloud',
        real_estate: localWorkspace.real_estate ?? true,
        activities: localWorkspace.activities ?? false,
        currency_exchange: localWorkspace.currency_exchange ?? false,
        agents: localWorkspace.agents ?? false,
        post_service: localWorkspace.post_service ?? false,
        car_rental: localWorkspace.car_rental ?? false,
        clinical_appointments: localWorkspace.clinical_appointments ?? false,
        is_configured: localWorkspace.is_configured,
        default_currency: localWorkspace.default_currency,
        pos_convert_to_workspace_currency: localWorkspace.pos_convert_to_workspace_currency ?? true,
        iqd_display_preference: localWorkspace.iqd_display_preference,
        locked_workspace: localWorkspace.locked_workspace ?? false,
        logo_url: localWorkspace.logo_url ?? null,
        coordination: localWorkspace.coordination ?? null,
        max_discount_percent: localWorkspace.max_discount_percent ?? 100,
        allow_whatsapp: localWorkspace.allow_whatsapp ?? false,
        print_lang: localWorkspace.print_lang ?? 'auto',
        print_qr: localWorkspace.print_qr ?? false,
        receipt_template: localWorkspace.receipt_template ?? 'primary',
        a4_template: localWorkspace.a4_template ?? 'professional',
        print_quality: 'high' as const,
        thermal_printing: localWorkspace.thermal_printing ?? false,
        subscription_expires_at: localWorkspace.subscription_expires_at ?? null,
        renewal_due_at: localWorkspace.renewal_due_at ?? null,
        has_usage_limits: localWorkspace.has_usage_limits ?? false,
        upload_limit_mb: localWorkspace.upload_limit_mb ?? null,
        visibility: localWorkspace.visibility ?? 'private',
        store_slug: localWorkspace.store_slug ?? null,
        store_description: localWorkspace.store_description ?? null,
        sales_agent_commission_sheet_type: localWorkspace.sales_agent_commission_sheet_type ?? 'normal',
        ledger_dashboard_config: normalizeLedgerDashboardConfig(localWorkspace.ledger_dashboard_config),
        private_staff_customers: localWorkspace.private_staff_customers ?? false,
        private_staff_suppliers: localWorkspace.private_staff_suppliers ?? false,
        suppliers_admin_only: localWorkspace.suppliers_admin_only ?? false
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
    const [branchInfo, setBranchInfo] = useState<BranchInfo | null>(null)
    const [resolvedBranchInfoWorkspaceId, setResolvedBranchInfoWorkspaceId] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [loadedWorkspaceId, setLoadedWorkspaceId] = useState<string | null>(null)
    const [paymentSummary, setPaymentSummary] = useState<WorkspacePaymentSummary | null>(null)
    const [isPaymentSummaryLoading, setIsPaymentSummaryLoading] = useState(false)
    const [billingNowMs, setBillingNowMs] = useState(() => Date.now())
    const [pendingUpdate, setPendingUpdate] = useState<UpdateInfo | null>(null)
    const [isFullscreen, setIsFullscreen] = useState(false)
    const [overrides, setOverrides] = useState<WorkspaceAccessOverride[]>([])
    const realtimeChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
    const currentWorkspaceIdRef = useRef<string | null>(null)
    const fetchRequestRef = useRef(0)
    const branchFetchRequestRef = useRef(0)
    const featuresRef = useRef(defaultFeatures)
    const paymentSummaryRef = useRef<WorkspacePaymentSummary | null>(null)
    const overridesRef = useRef<WorkspaceAccessOverride[]>([])
    const workspaceNameRef = useRef<string | null>(null)

    useEffect(() => {
        featuresRef.current = features
    }, [features])

    useEffect(() => {
        paymentSummaryRef.current = paymentSummary
    }, [paymentSummary])

    useEffect(() => {
        overridesRef.current = overrides
    }, [overrides])

    useEffect(() => {
        workspaceNameRef.current = workspaceName
    }, [workspaceName])

    useEffect(() => {
        const updateBillingClock = () => setBillingNowMs(Date.now())
        const intervalId = window.setInterval(updateBillingClock, 15_000)

        window.addEventListener('focus', updateBillingClock)
        document.addEventListener('visibilitychange', updateBillingClock)

        return () => {
            window.clearInterval(intervalId)
            window.removeEventListener('focus', updateBillingClock)
            document.removeEventListener('visibilitychange', updateBillingClock)
        }
    }, [])

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

    const isCurrentBranchWorkspaceRequest = (workspaceId: string, requestId: number) => {
        return currentWorkspaceIdRef.current === workspaceId && branchFetchRequestRef.current === requestId
    }

    const persistWorkspaceState = async (
        workspaceId: string,
        nextFeatures: WorkspaceFeatures,
        nextWorkspaceName: string | null
    ) => {
        const existing = await db.workspaces.get(workspaceId)
        const timestamp = new Date().toISOString()
        const logoUrl = resolvePersistedWorkspaceLogo({
            nextWorkspaceMode: nextFeatures.data_mode,
            existingWorkspaceMode: existing?.data_mode,
            nextLogoUrl: nextFeatures.logo_url,
            existingLogoUrl: existing?.logo_url
        })
        const persistedLocallyOwned = resolvePersistedLocallyOwnedSettings({
            nextMode: nextFeatures.data_mode,
            existingMode: existing?.data_mode,
            next: nextFeatures,
            existing: existing ?? null
        })

        await db.workspaces.put({
            id: workspaceId,
            workspaceId,
            name: nextWorkspaceName || existing?.name || user?.workspaceName || 'My Workspace',
            code: existing?.code || user?.workspaceCode || 'LOADED',
            plan: nextFeatures.plan,
            data_mode: nextFeatures.data_mode,
            is_configured: nextFeatures.is_configured,
            pos: nextFeatures.pos,
            sales_history: nextFeatures.sales_history,
            crm: nextFeatures.crm,
            orders: nextFeatures.orders,
            ecommerce: nextFeatures.ecommerce,
            real_estate: nextFeatures.real_estate,
            activities: nextFeatures.activities,
            currency_exchange: nextFeatures.currency_exchange,
            agents: nextFeatures.agents,
            post_service: nextFeatures.post_service,
            car_rental: nextFeatures.car_rental,
            clinical_appointments: nextFeatures.clinical_appointments,
            loans: nextFeatures.loans,
            net_revenue: nextFeatures.net_revenue,
            budget: nextFeatures.budget,
            monthly_comparison: nextFeatures.monthly_comparison,
            team_performance: nextFeatures.team_performance,
            products: nextFeatures.products,
            services: nextFeatures.services,
            discounts: nextFeatures.discounts,
            storages: nextFeatures.storages,
            inventory_transfer: nextFeatures.inventory_transfer,
            inventory_transactions: nextFeatures.inventory_transactions,
            stock_adjustments: nextFeatures.stock_adjustments,
            invoices_history: nextFeatures.invoices_history,
            hr: nextFeatures.hr,
            default_currency: persistedLocallyOwned.default_currency ?? nextFeatures.default_currency,
            pos_convert_to_workspace_currency: persistedLocallyOwned.pos_convert_to_workspace_currency ?? nextFeatures.pos_convert_to_workspace_currency,
            iqd_display_preference: persistedLocallyOwned.iqd_display_preference ?? nextFeatures.iqd_display_preference,
            locked_workspace: nextFeatures.locked_workspace,
            allow_whatsapp: persistedLocallyOwned.allow_whatsapp ?? nextFeatures.allow_whatsapp,
            logo_url: logoUrl,
            coordination: persistedLocallyOwned.coordination ?? nextFeatures.coordination,
            max_discount_percent: persistedLocallyOwned.max_discount_percent ?? nextFeatures.max_discount_percent,
            print_lang: persistedLocallyOwned.print_lang ?? nextFeatures.print_lang,
            print_qr: persistedLocallyOwned.print_qr ?? nextFeatures.print_qr,
            receipt_template: persistedLocallyOwned.receipt_template ?? nextFeatures.receipt_template,
            a4_template: persistedLocallyOwned.a4_template ?? nextFeatures.a4_template,
            thermal_printing: persistedLocallyOwned.thermal_printing ?? nextFeatures.thermal_printing,
            subscription_expires_at: nextFeatures.subscription_expires_at,
            renewal_due_at: nextFeatures.renewal_due_at,
            has_usage_limits: nextFeatures.has_usage_limits,
            upload_limit_mb: persistedLocallyOwned.upload_limit_mb ?? nextFeatures.upload_limit_mb,
            visibility: nextFeatures.visibility,
            store_slug: nextFeatures.store_slug,
            store_description: nextFeatures.store_description,
            sales_agent_commission_sheet_type: nextFeatures.sales_agent_commission_sheet_type,
            ledger_dashboard_config: nextFeatures.ledger_dashboard_config,
            private_staff_customers: nextFeatures.private_staff_customers,
            private_staff_suppliers: nextFeatures.private_staff_suppliers,
            suppliers_admin_only: nextFeatures.suppliers_admin_only,
            syncStatus: 'synced',
            lastSyncedAt: timestamp,
            version: existing?.version ?? 1,
            isDeleted: existing?.isDeleted ?? false,
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp
        })

        // Important: If we are in local/hybrid mode, we MUST keep our local logo_url
        // as the source of truth, even if fetchFeatures later tries to sync from Supabase.
        if (nextFeatures.data_mode === 'local' || nextFeatures.data_mode === 'hybrid') {
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
            setPaymentSummary(null)
            setIsPaymentSummaryLoading(false)
            if (!silent) setIsLoading(false)
            return
        }

        const requestId = ++fetchRequestRef.current
        const cachedSnapshot = options?.cachedSnapshot ?? readWorkspaceCache<WorkspaceFeatures>(workspaceId)
        setIsPaymentSummaryLoading(true)

        const applyFallback = async () => {
            const fallback = await resolveTrustedFallback(workspaceId, cachedSnapshot)

            if (!isCurrentWorkspaceRequest(workspaceId, requestId)) {
                return
            }

            if (fallback) {
                setFeatures(fallback.features)
                setWorkspaceName(fallback.workspaceName)
                if (cachedSnapshot?.overrides) {
                    setOverrides(cachedSnapshot.overrides)
                }
            } else if (!silent) {
                setFeatures(defaultFeatures)
                setWorkspaceName(user?.workspaceName ?? null)
            }
        }

        // Demo workspaces use local DB exclusively — skip Supabase queries
        if (user?.workspaceMode === 'demo') {
            await applyFallback()
            if (isCurrentWorkspaceRequest(workspaceId, requestId)) {
                setPaymentSummary(null)
                setIsPaymentSummaryLoading(false)
                if (!silent) setIsLoading(false)
            }
            return
        }

        if (isOffline()) {
            await applyFallback()
            if (isCurrentWorkspaceRequest(workspaceId, requestId)) {
                setIsPaymentSummaryLoading(false)
                if (!silent) setIsLoading(false)
            }
            return
        }

        try {
            const [workspaceResult, overridesResult, usageStatusResult, paymentSummaryResult] = await Promise.all([
                runSupabaseAction(
                    'workspace.getFeatures',
                    () => supabase.from('workspaces').select(WORKSPACE_FEATURE_COLUMNS).eq('id', workspaceId).maybeSingle(),
                    { timeoutMs: 12000, platform: 'all' }
                ),
                supabase
                    .from('workspace_access_overrides')
                    .select('id, workspace_id, type, key, value, created_by, created_at')
                    .eq('workspace_id', workspaceId),
                runSupabaseAction(
                    'workspace.getUsageStatus',
                    () => supabase.rpc('get_workspace_usage_status', { p_workspace_id: workspaceId }),
                    { timeoutMs: 12000, platform: 'all' }
                ),
                getWorkspacePaymentSummary()
                    .then((summary) => ({ summary, error: null as unknown }))
                    .catch((error: unknown) => ({ summary: null, error }))
            ]) as any

            const { data, error } = workspaceResult

            if (error) {
                throw error
            }

            if (!data) {
                if (isCurrentWorkspaceRequest(workspaceId, requestId)) {
                    clearWorkspaceCache(workspaceId)
                    setFeatures(defaultFeatures)
                    setWorkspaceName(null)
                    setPaymentSummary(null)
                    updateUser({
                        workspaceId: '',
                        workspaceCode: '',
                        workspaceName: undefined,
                        isConfigured: undefined,
                        workspaceMode: 'cloud'
                    })
                }
                return
            }

            const workspaceRow = data as any
            const fetchedOverrides = (overridesResult?.data ?? []) as WorkspaceAccessOverride[]
            const usageStatus = Array.isArray(usageStatusResult?.data)
                ? usageStatusResult.data[0]
                : null
            const currentFeatures = featuresRef.current
            const renewalDueAt = paymentSummaryResult.error
                ? cachedSnapshot?.features?.renewal_due_at ?? currentFeatures.renewal_due_at
                : paymentSummaryResult.summary?.configuration?.renewalDueAt ?? null
            const persistedWorkspace = await db.workspaces.get(workspaceId)
            const localThermalPrinting = cachedSnapshot?.features?.thermal_printing
                ?? persistedWorkspace?.thermal_printing
                ?? currentFeatures.thermal_printing
                ?? false
            const resolvedLocallyOwned = resolveFetchedWorkspaceSettings({
                workspaceMode: workspaceRow.data_mode,
                persistedMode: persistedWorkspace?.data_mode,
                remote: workspaceRow,
                persisted: persistedWorkspace ?? null,
                cached: cachedSnapshot?.features ?? null,
                current: currentFeatures
            })
            const fetchedFeatures = mergeWorkspaceFeatures({
                plan: normalizeWorkspacePlan(workspaceRow.plan),
                data_mode: workspaceRow.data_mode ?? currentFeatures.data_mode,
                real_estate: workspaceRow.real_estate ?? currentFeatures.real_estate,
                activities: currentFeatures.activities,
                currency_exchange: currentFeatures.currency_exchange,
                agents: currentFeatures.agents,
                post_service: currentFeatures.post_service,
                car_rental: currentFeatures.car_rental,
                clinical_appointments: currentFeatures.clinical_appointments,
                is_configured: workspaceRow.is_configured ?? currentFeatures.is_configured,
                default_currency: resolvedLocallyOwned.default_currency ?? workspaceRow.default_currency ?? currentFeatures.default_currency,
                pos_convert_to_workspace_currency: resolvedLocallyOwned.pos_convert_to_workspace_currency ?? workspaceRow.pos_convert_to_workspace_currency ?? currentFeatures.pos_convert_to_workspace_currency,
                iqd_display_preference: resolvedLocallyOwned.iqd_display_preference ?? workspaceRow.iqd_display_preference ?? currentFeatures.iqd_display_preference,
                locked_workspace: workspaceRow.locked_workspace ?? currentFeatures.locked_workspace,
                logo_url: resolveFetchedWorkspaceLogo({
                    workspaceMode: workspaceRow.data_mode,
                    persistedWorkspaceMode: persistedWorkspace?.data_mode,
                    persistedLogoUrl: persistedWorkspace?.logo_url,
                    cachedLogoUrl: cachedSnapshot?.features?.logo_url,
                    currentLogoUrl: currentFeatures.logo_url,
                    remoteLogoUrl: workspaceRow.logo_url
                }),
                coordination: resolvedLocallyOwned.coordination ?? workspaceRow.coordination ?? null,
                max_discount_percent: resolvedLocallyOwned.max_discount_percent ?? workspaceRow.max_discount_percent ?? currentFeatures.max_discount_percent,
                allow_whatsapp: resolvedLocallyOwned.allow_whatsapp ?? workspaceRow.allow_whatsapp ?? currentFeatures.allow_whatsapp,
                print_lang: resolvedLocallyOwned.print_lang ?? workspaceRow.print_lang ?? currentFeatures.print_lang,
                print_qr: resolvedLocallyOwned.print_qr ?? workspaceRow.print_qr ?? currentFeatures.print_qr,
                receipt_template: resolvedLocallyOwned.receipt_template ?? workspaceRow.receipt_template ?? currentFeatures.receipt_template,
                a4_template: resolvedLocallyOwned.a4_template ?? workspaceRow.a4_template ?? currentFeatures.a4_template,
                print_quality: 'high' as const,
                thermal_printing: resolvedLocallyOwned.thermal_printing ?? localThermalPrinting,
                subscription_expires_at: workspaceRow.subscription_expires_at ?? currentFeatures.subscription_expires_at,
                renewal_due_at: renewalDueAt,
                has_usage_limits: Boolean(usageStatus?.has_limits),
                upload_limit_mb: resolvedLocallyOwned.upload_limit_mb ?? workspaceRow.upload_limit_mb ?? null,
                visibility: workspaceRow.visibility ?? currentFeatures.visibility,
                store_slug: workspaceRow.store_slug ?? currentFeatures.store_slug,
                store_description: workspaceRow.store_description ?? currentFeatures.store_description,
                sales_agent_commission_sheet_type: workspaceRow.sales_agent_commission_sheet_type ?? currentFeatures.sales_agent_commission_sheet_type,
                ledger_dashboard_config: normalizeLedgerDashboardConfig(workspaceRow.ledger_dashboard_config ?? currentFeatures.ledger_dashboard_config),
                private_staff_customers: workspaceRow.private_staff_customers ?? currentFeatures.private_staff_customers,
                private_staff_suppliers: workspaceRow.private_staff_suppliers ?? currentFeatures.private_staff_suppliers,
                suppliers_admin_only: workspaceRow.suppliers_admin_only ?? currentFeatures.suppliers_admin_only
            }, fetchedOverrides)
            const nextWorkspaceName = resolveFetchedWorkspaceName({
                workspaceMode: workspaceRow.data_mode,
                persistedMode: persistedWorkspace?.data_mode,
                remoteName: workspaceRow.name,
                persistedName: persistedWorkspace?.name,
                cachedName: cachedSnapshot?.workspaceName,
                currentName: workspaceNameRef.current ?? user?.workspaceName
            })
            const resolvedNextWorkspaceName = nextWorkspaceName || user?.workspaceName || 'My Workspace'

            if (!isCurrentWorkspaceRequest(workspaceId, requestId)) {
                return
            }

            setOverrides(fetchedOverrides)
            setFeatures(fetchedFeatures)
            setWorkspaceName(resolvedNextWorkspaceName)
            setLoadedWorkspaceId(workspaceId)
            if (paymentSummaryResult.error) {
                console.warn('[WorkspacePayments] Failed to load payment summary:', paymentSummaryResult.error)
            } else {
                paymentSummaryRef.current = paymentSummaryResult.summary
                setPaymentSummary(paymentSummaryResult.summary)
            }
            writeWorkspaceCache({
                workspaceId,
                features: fetchedFeatures,
                workspaceName: resolvedNextWorkspaceName,
                overrides: fetchedOverrides
            })
            await persistWorkspaceState(workspaceId, fetchedFeatures, resolvedNextWorkspaceName)
        } catch (err) {
            console.error('Error fetching workspace features:', err)
            await applyFallback()
        } finally {
            if (isCurrentWorkspaceRequest(workspaceId, requestId)) {
                setIsPaymentSummaryLoading(false)
                if (!silent) setIsLoading(false)
            }
        }
    }

    const fetchBranchInfo = async (workspaceId: string, requestId: number) => {
        if (!isSupabaseConfigured || !isAuthenticated || !workspaceId) {
            setBranchInfo(null)
            return
        }

        if (isOffline()) {
            if (isCurrentBranchWorkspaceRequest(workspaceId, requestId)) {
                setBranchInfo(null)
            }
            return
        }

        try {
            const { data, error } = await runSupabaseAction(
                'workspace.getBranchInfo',
                () => supabase
                    .from('workspace_branches')
                    .select('id, name, source_workspace_id')
                    .eq('branch_workspace_id', workspaceId)
                    .is('archived_at', null)
                    .maybeSingle(),
                { timeoutMs: 8000, platform: 'all' }
            ) as {
                data: { id: string; name?: string | null; source_workspace_id?: string | null } | null
                error?: unknown
            }

            if (!isCurrentBranchWorkspaceRequest(workspaceId, requestId)) {
                return
            }

            if (error) {
                throw error
            }

            if (!data?.source_workspace_id) {
                setBranchInfo(null)
                setResolvedBranchInfoWorkspaceId(workspaceId)
                return
            }

            const { data: sourceWorkspace, error: sourceWorkspaceError } = await runSupabaseAction(
                'workspace.getBranchSourceWorkspace',
                () => supabase
                    .from('workspaces')
                    .select('id, name')
                    .eq('id', data.source_workspace_id)
                    .maybeSingle(),
                { timeoutMs: 8000, platform: 'all' }
            ) as {
                data: { id: string; name?: string | null } | null
                error?: unknown
            }

            if (!isCurrentBranchWorkspaceRequest(workspaceId, requestId)) {
                return
            }

            if (sourceWorkspaceError) {
                throw sourceWorkspaceError
            }

            setBranchInfo({
                isBranch: true,
                relationId: data.id,
                branchName: data.name ?? undefined,
                sourceWorkspaceId: data.source_workspace_id,
                sourceWorkspaceName: sourceWorkspace?.name ?? undefined
            })
            setResolvedBranchInfoWorkspaceId(workspaceId)
        } catch (error) {
            console.error('[Workspace] Failed to fetch branch info:', error)
            if (isCurrentBranchWorkspaceRequest(workspaceId, requestId)) {
                setBranchInfo(null)
            }
        }
    }

    useEffect(() => {
        if (authLoading) return

        const workspaceId = isAuthenticated ? user?.workspaceId ?? null : null
        currentWorkspaceIdRef.current = workspaceId
        fetchRequestRef.current += 1
        branchFetchRequestRef.current += 1
        setLoadedWorkspaceId(null)
        setResolvedBranchInfoWorkspaceId(null)

        if (!workspaceId) {
            setFeatures(defaultFeatures)
            setWorkspaceName(null)
            setBranchInfo(null)
            paymentSummaryRef.current = null
            setPaymentSummary(null)
            setIsPaymentSummaryLoading(false)
            setIsLoading(false)
            return
        }

        setIsLoading(true)
        setFeatures(defaultFeatures)
        setWorkspaceName(null)
        setBranchInfo(null)
        paymentSummaryRef.current = null
        setPaymentSummary(null)

        const cachedSnapshot = readWorkspaceCache<WorkspaceFeatures>(workspaceId)
        if (cachedSnapshot) {
            setFeatures(mergeWorkspaceFeatures(cachedSnapshot.features))
            setWorkspaceName(cachedSnapshot.workspaceName)
            if (cachedSnapshot.overrides) {
                setOverrides(cachedSnapshot.overrides)
            }
        }

        void fetchFeatures(false, { workspaceId, cachedSnapshot })
        void fetchBranchInfo(workspaceId, branchFetchRequestRef.current)
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
                        const persistedWorkspaceUpdate = await db.workspaces.get(user.workspaceId)
                        const accessStateChanged = hasWorkspacePaymentAccessStateUpdate({
                            lockedWorkspace: currentFeatures.locked_workspace,
                            subscriptionExpiresAt: currentFeatures.subscription_expires_at
                        }, data)
                        const resolvedLocallyOwnedUpdate = resolveFetchedWorkspaceSettings({
                            workspaceMode: data.data_mode,
                            persistedMode: persistedWorkspaceUpdate?.data_mode,
                            remote: data,
                            persisted: persistedWorkspaceUpdate ?? null,
                            cached: readWorkspaceCache<WorkspaceFeatures>(user.workspaceId)?.features ?? null,
                            current: currentFeatures
                        })
                        const updatedFeatures = mergeWorkspaceFeatures({
                            ...currentFeatures,
                            plan: normalizeWorkspacePlan(data.plan ?? currentFeatures.plan),
                            data_mode: data.data_mode ?? currentFeatures.data_mode,
                            real_estate: data.real_estate ?? currentFeatures.real_estate,
                            currency_exchange: currentFeatures.currency_exchange,
                            agents: currentFeatures.agents,
                            post_service: currentFeatures.post_service,
                            car_rental: currentFeatures.car_rental,
                            clinical_appointments: currentFeatures.clinical_appointments,
                            is_configured: data.is_configured ?? currentFeatures.is_configured,
                            default_currency: resolvedLocallyOwnedUpdate.default_currency ?? (data.default_currency || currentFeatures.default_currency),
                            pos_convert_to_workspace_currency: resolvedLocallyOwnedUpdate.pos_convert_to_workspace_currency ?? data.pos_convert_to_workspace_currency ?? currentFeatures.pos_convert_to_workspace_currency,
                            iqd_display_preference: resolvedLocallyOwnedUpdate.iqd_display_preference ?? (data.iqd_display_preference || currentFeatures.iqd_display_preference),
                            locked_workspace: data.locked_workspace ?? currentFeatures.locked_workspace,
                            logo_url: resolveFetchedWorkspaceLogo({
                                workspaceMode: data.data_mode,
                                persistedWorkspaceMode: persistedWorkspaceUpdate?.data_mode,
                                persistedLogoUrl: persistedWorkspaceUpdate?.logo_url,
                                cachedLogoUrl: readWorkspaceCache<WorkspaceFeatures>(user.workspaceId)?.features?.logo_url,
                                currentLogoUrl: currentFeatures.logo_url,
                                remoteLogoUrl: data.logo_url
                            }),
                            coordination: resolvedLocallyOwnedUpdate.coordination ?? data.coordination ?? currentFeatures.coordination,
                            max_discount_percent: resolvedLocallyOwnedUpdate.max_discount_percent ?? data.max_discount_percent ?? currentFeatures.max_discount_percent,
                            allow_whatsapp: resolvedLocallyOwnedUpdate.allow_whatsapp ?? data.allow_whatsapp ?? currentFeatures.allow_whatsapp,
                            print_lang: resolvedLocallyOwnedUpdate.print_lang ?? data.print_lang ?? currentFeatures.print_lang,
                            print_qr: resolvedLocallyOwnedUpdate.print_qr ?? data.print_qr ?? currentFeatures.print_qr,
                            receipt_template: resolvedLocallyOwnedUpdate.receipt_template ?? data.receipt_template ?? currentFeatures.receipt_template,
                            a4_template: resolvedLocallyOwnedUpdate.a4_template ?? data.a4_template ?? currentFeatures.a4_template,
                            print_quality: 'high' as const,
                            thermal_printing: resolvedLocallyOwnedUpdate.thermal_printing ?? currentFeatures.thermal_printing,
                            subscription_expires_at: data.subscription_expires_at ?? currentFeatures.subscription_expires_at,
                            renewal_due_at: currentFeatures.renewal_due_at,
                            has_usage_limits: currentFeatures.has_usage_limits,
                            visibility: data.visibility ?? currentFeatures.visibility,
                            store_slug: data.store_slug ?? currentFeatures.store_slug,
                            store_description: data.store_description ?? currentFeatures.store_description,
                            sales_agent_commission_sheet_type: data.sales_agent_commission_sheet_type ?? currentFeatures.sales_agent_commission_sheet_type,
                            ledger_dashboard_config: normalizeLedgerDashboardConfig(data.ledger_dashboard_config ?? currentFeatures.ledger_dashboard_config),
                            private_staff_customers: data.private_staff_customers ?? currentFeatures.private_staff_customers,
                            private_staff_suppliers: data.private_staff_suppliers ?? currentFeatures.private_staff_suppliers,
                            suppliers_admin_only: data.suppliers_admin_only ?? currentFeatures.suppliers_admin_only
                        }, overridesRef.current)
                        const nextWorkspaceName = resolveFetchedWorkspaceName({
                            workspaceMode: data.data_mode,
                            persistedMode: persistedWorkspaceUpdate?.data_mode,
                            remoteName: data.name,
                            persistedName: persistedWorkspaceUpdate?.name,
                            cachedName: readWorkspaceCache<WorkspaceFeatures>(user.workspaceId)?.workspaceName,
                            currentName: workspaceNameRef.current ?? user.workspaceName
                        }) || workspaceNameRef.current || user.workspaceName || 'My Workspace'

                        setFeatures(updatedFeatures)
                        setWorkspaceName(nextWorkspaceName)
                        writeWorkspaceCache({
                            workspaceId: user.workspaceId,
                            features: updatedFeatures,
                            workspaceName: nextWorkspaceName,
                            overrides: overridesRef.current
                        })
                        await persistWorkspaceState(user.workspaceId, updatedFeatures, nextWorkspaceName)

                        if (accessStateChanged) {
                            void getWorkspacePaymentSummary()
                                .then((summary) => {
                                    if (currentWorkspaceIdRef.current !== user.workspaceId) return
                                    paymentSummaryRef.current = summary
                                    setPaymentSummary(summary)

                                    const currentFeatures = featuresRef.current
                                    const renewalDueAt = summary.configuration?.renewalDueAt ?? null
                                    if (currentFeatures.renewal_due_at !== renewalDueAt) {
                                        const updatedFeatures = mergeWorkspaceFeatures({
                                            ...currentFeatures,
                                            renewal_due_at: renewalDueAt
                                        }, overridesRef.current)
                                        setFeatures(updatedFeatures)
                                        const nextWorkspaceName = workspaceNameRef.current ?? user.workspaceName ?? 'My Workspace'
                                        writeWorkspaceCache({
                                            workspaceId: user.workspaceId,
                                            features: updatedFeatures,
                                            workspaceName: nextWorkspaceName,
                                            overrides: overridesRef.current
                                        })
                                        void persistWorkspaceState(user.workspaceId, updatedFeatures, nextWorkspaceName)
                                    }
                                })
                                .catch((error) => {
                                    console.warn('[WorkspacePayments] Failed to refresh after an access-state update:', error)
                                })
                        }
                    } catch (error) {
                        console.error('[Workspace] Failed to apply realtime update:', error)
                    }
                }
            )
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'workspace_usage_limits',
                    filter: `workspace_id=eq.${user.sourceWorkspaceId || user.workspaceId}`
                },
                () => {
                    void fetchFeatures(true, { workspaceId: user.workspaceId })
                }
            )
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'workspace_access_overrides',
                    filter: `workspace_id=eq.${user.workspaceId}`
                },
                async () => {
                    try {
                        const { data: freshOverrides } = await supabase
                            .from('workspace_access_overrides')
                            .select('id, workspace_id, type, key, value, created_by, created_at')
                            .eq('workspace_id', user.workspaceId)

                        const nextOverrides = (freshOverrides ?? []) as WorkspaceAccessOverride[]
                        setOverrides(nextOverrides)

                        const currentFeatures = featuresRef.current
                        const updatedFeatures = mergeWorkspaceFeatures(currentFeatures, nextOverrides)
                        setFeatures(updatedFeatures)
                        writeWorkspaceCache({
                            workspaceId: user.workspaceId,
                            features: updatedFeatures,
                            workspaceName: workspaceNameRef.current ?? user.workspaceName ?? 'My Workspace',
                            overrides: nextOverrides
                        })
                        await persistWorkspaceState(user.workspaceId, updatedFeatures, workspaceNameRef.current ?? user.workspaceName ?? 'My Workspace')
                    } catch (error) {
                        console.error('[Workspace] Failed to apply override change:', error)
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
    }, [isAuthenticated, user?.workspaceId, user?.workspaceName, user?.sourceWorkspaceId])

    useEffect(() => {
        if (!isSupabaseConfigured || !isAuthenticated || !user?.workspaceId) return

        const unsubscribe = connectionManager.subscribe((event) => {
            const shouldRefresh =
                event === 'wake'
                || event === 'online'
                || (event === 'heartbeat' && (
                    isWorkspaceCurrentlyLocked(featuresRef.current, paymentSummaryRef.current)
                    || shouldWorkspacePaymentLockAccess(paymentSummaryRef.current)
                ))

            if (shouldRefresh) {
                console.log(`[Workspace] ${event} event - re-fetching features silently`)
                void fetchFeatures(true, { workspaceId: user.workspaceId })
            }
        })

        return unsubscribe
    }, [isAuthenticated, user?.workspaceId])

    const hasFeature = (feature: ModuleFeatureKey): boolean => {
        if (feature === 'ecommerce') {
            return features.data_mode !== 'local'
                && features.data_mode !== 'demo'
                && planCapabilities.modules.includes('ecommerce')
        }
        if (feature === 'allow_whatsapp') {
            return features.allow_whatsapp
                && planCapabilities.capabilities.includes('whatsappIntegration')
                && planCapabilities.modules.includes('whatsapp')
        }
        const mappedModule = WORKSPACE_FEATURE_MODULE_MAP[feature]
        if (mappedModule) {
            return planCapabilities.modules.includes(mappedModule)
        }
        return planCapabilities.modules.includes(feature as any)
    }

    const hasCapability = (capability: PlanCapabilityKey): boolean => {
        return planCapabilities.capabilities.includes(capability)
    }

    const refreshPaymentSummary = async (): Promise<WorkspacePaymentSummary | null> => {
        const workspaceId = user?.workspaceId
        if (!isSupabaseConfigured || !isAuthenticated || !workspaceId || user?.workspaceMode === 'demo') {
            return null
        }
        if (isOffline()) {
            throw new Error('An internet connection is required to load workspace payments')
        }

        setIsPaymentSummaryLoading(true)
        try {
            const summary = await getWorkspacePaymentSummary()
            if (currentWorkspaceIdRef.current !== workspaceId) {
                return paymentSummaryRef.current
            }

            paymentSummaryRef.current = summary
            setPaymentSummary(summary)

            const currentFeatures = featuresRef.current
            const renewalDueAt = summary.configuration?.renewalDueAt ?? null
            if (currentFeatures.renewal_due_at !== renewalDueAt) {
                const updatedFeatures = mergeWorkspaceFeatures({
                    ...currentFeatures,
                    renewal_due_at: renewalDueAt
                }, overridesRef.current)
                setFeatures(updatedFeatures)
                const nextWorkspaceName = workspaceNameRef.current ?? user.workspaceName ?? 'My Workspace'
                writeWorkspaceCache({
                    workspaceId,
                    features: updatedFeatures,
                    workspaceName: nextWorkspaceName,
                    overrides: overridesRef.current
                })
                await persistWorkspaceState(workspaceId, updatedFeatures, nextWorkspaceName)
            }
            return summary
        } catch (error) {
            console.warn('[WorkspacePayments] Failed to refresh payment summary:', error)
            throw error
        } finally {
            if (currentWorkspaceIdRef.current === workspaceId) {
                setIsPaymentSummaryLoading(false)
            }
        }
    }

    const refreshFeatures = async () => {
        const workspaceId = user?.workspaceId
        if (!workspaceId) return

        setIsLoading(true)
        const branchRequestId = ++branchFetchRequestRef.current
        await Promise.all([
            fetchFeatures(false, { workspaceId }),
            fetchBranchInfo(workspaceId, branchRequestId)
        ])
    }

    const updateSettings = async (
        settings: Partial<Pick<WorkspaceFeatures, 'default_currency' | 'pos_convert_to_workspace_currency' | 'iqd_display_preference' | 'allow_whatsapp' | 'logo_url' | 'coordination' | 'print_lang' | 'print_qr' | 'receipt_template' | 'a4_template' | 'thermal_printing' | 'visibility' | 'store_slug' | 'store_description' | 'sales_agent_commission_sheet_type' | 'ledger_dashboard_config' | 'private_staff_customers' | 'private_staff_suppliers' | 'suppliers_admin_only' | 'upload_limit_mb' | 'data_mode' | 'plan' | 'is_configured'>> & { name?: string },
        options?: { requireRemoteSync?: boolean }
    ) => {
        const workspaceId = user?.workspaceId
        if (!workspaceId) return

        const { name, ...rawFeatureSettings } = settings
        const featureSettings = Object.fromEntries(
            Object.entries(rawFeatureSettings).filter(([key]) => !PLAN_CONTROLLED_SETTINGS.has(key))
        ) as typeof rawFeatureSettings
        const currentFeatures = featuresRef.current
        const currentBranchInfo = branchInfo
        const nextWorkspaceName = name ?? workspaceNameRef.current ?? user?.workspaceName ?? 'My Workspace'
        if (
            featureSettings.default_currency
            && featureSettings.default_currency !== currentFeatures.default_currency
            && await hasCurrencyExchangeAccountingData(workspaceId)
        ) {
            throw new Error('Workspace currency is locked because Currency Exchange has safes or transactions. This protects historical balances and profit reports.')
        }

        const newFeatures = mergeWorkspaceFeatures({ ...currentFeatures, ...featureSettings }, overridesRef.current)
        const now = new Date().toISOString()

        if (name) {
            setWorkspaceName(name)
            updateUser({ workspaceName: name })
            if (currentBranchInfo?.isBranch) {
                setBranchInfo({
                    ...currentBranchInfo,
                    branchName: name
                })
            }
        }

        setFeatures(newFeatures)
        writeWorkspaceCache({
            workspaceId,
            features: newFeatures,
            workspaceName: nextWorkspaceName,
            overrides: overridesRef.current
        })

        const existing = await db.workspaces.get(workspaceId)
        const usesCloudBusinessData = newFeatures.data_mode === 'cloud'
            || newFeatures.data_mode === 'hybrid'
        const supabaseUpdate: Record<string, unknown> = { ...featureSettings }
        delete supabaseUpdate.thermal_printing
        if (newFeatures.data_mode === 'local' || newFeatures.data_mode === 'demo') {
            delete supabaseUpdate.logo_url
        }
        if (name !== undefined) {
            supabaseUpdate.name = name
        }
        const shouldSync = (usesCloudBusinessData || options?.requireRemoteSync)
            && Object.keys(supabaseUpdate).length > 0

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
                plan: newFeatures.plan,
                data_mode: newFeatures.data_mode,
                is_configured: newFeatures.is_configured,
                pos: newFeatures.pos,
                sales_history: newFeatures.sales_history,
                crm: newFeatures.crm,
                orders: newFeatures.orders,
                ecommerce: newFeatures.ecommerce,
                real_estate: newFeatures.real_estate,
                currency_exchange: newFeatures.currency_exchange,
                agents: newFeatures.agents,
                post_service: newFeatures.post_service,
                clinical_appointments: newFeatures.clinical_appointments,
                default_currency: newFeatures.default_currency,
                pos_convert_to_workspace_currency: newFeatures.pos_convert_to_workspace_currency,
                iqd_display_preference: newFeatures.iqd_display_preference,
                locked_workspace: newFeatures.locked_workspace,
                allow_whatsapp: newFeatures.allow_whatsapp,
                logo_url: newFeatures.logo_url,
                coordination: newFeatures.coordination,
                max_discount_percent: newFeatures.max_discount_percent,
                print_lang: newFeatures.print_lang,
                print_qr: newFeatures.print_qr,
                receipt_template: newFeatures.receipt_template,
                a4_template: newFeatures.a4_template,
                thermal_printing: newFeatures.thermal_printing,
                subscription_expires_at: newFeatures.subscription_expires_at,
                renewal_due_at: newFeatures.renewal_due_at,
                upload_limit_mb: newFeatures.upload_limit_mb,
                visibility: newFeatures.visibility,
                store_slug: newFeatures.store_slug,
                store_description: newFeatures.store_description,
                sales_agent_commission_sheet_type: newFeatures.sales_agent_commission_sheet_type,
                ledger_dashboard_config: newFeatures.ledger_dashboard_config,
                private_staff_customers: newFeatures.private_staff_customers,
                private_staff_suppliers: newFeatures.private_staff_suppliers,
                suppliers_admin_only: newFeatures.suppliers_admin_only,
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
            let updatedRow: {
                pos_convert_to_workspace_currency?: boolean
            } | null = null
            let remoteWriteError: unknown = null

            try {
                const { data, error } = await runSupabaseAction(
                    'workspace.updateSettings',
                    () => supabase
                        .from('workspaces')
                        .update(supabaseUpdate)
                        .eq('id', workspaceId)
                        .select('pos_convert_to_workspace_currency')
                        .maybeSingle(),
                    options?.requireRemoteSync
                        ? { timeoutMs: 20_000, platform: 'all' }
                        : undefined
                ) as {
                    data: { pos_convert_to_workspace_currency?: boolean } | null
                    error: unknown
                }
                updatedRow = data
                remoteWriteError = error
            } catch (error) {
                remoteWriteError = error
            }

            // PostgREST returns no error when RLS filters every updated row. Treat
            // that as a failed save so a location is never reported as cloud-saved
            // when it only exists in the device cache.
            if (!remoteWriteError && !updatedRow) {
                remoteWriteError = new Error('Workspace settings could not be saved to the cloud.')
            }

            if (remoteWriteError) {
                console.error('Error updating workspace settings on Supabase:', remoteWriteError)
                await addToOfflineMutations('workspaces', workspaceId, 'update', supabaseUpdate, workspaceId)
                if (name !== undefined && currentBranchInfo?.isBranch && currentBranchInfo.relationId) {
                    await addToOfflineMutations(
                        'workspace_branches',
                        currentBranchInfo.relationId,
                        'update',
                        {
                            id: currentBranchInfo.relationId,
                            name
                        },
                        workspaceId
                    )
                }
                if (options?.requireRemoteSync) {
                    throw normalizeSupabaseActionError(remoteWriteError)
                }
            } else {
                if (name !== undefined && currentBranchInfo?.isBranch && currentBranchInfo.relationId) {
                    const branchUpdatePayload = {
                        id: currentBranchInfo.relationId,
                        name
                    }

                    const { error: branchError } = await supabase
                        .from('workspace_branches')
                        .update({ name })
                        .eq('id', currentBranchInfo.relationId)

                    if (branchError) {
                        console.error('Error updating branch settings on Supabase:', branchError)
                        await addToOfflineMutations('workspace_branches', currentBranchInfo.relationId, 'update', branchUpdatePayload, workspaceId)
                    }
                }

                if (updatedRow) {
                    const patched: Record<string, unknown> = {}
                    if ('pos_convert_to_workspace_currency' in supabaseUpdate && typeof updatedRow.pos_convert_to_workspace_currency === 'boolean') {
                        patched.pos_convert_to_workspace_currency = updatedRow.pos_convert_to_workspace_currency
                    }
                    if (Object.keys(patched).length > 0) {
                        const corrected = mergeWorkspaceFeatures({ ...featuresRef.current, ...patched }, overridesRef.current)
                        setFeatures(corrected)
                        writeWorkspaceCache({
                            workspaceId,
                            features: corrected,
                            workspaceName: workspaceNameRef.current || nextWorkspaceName,
                            overrides: overridesRef.current
                        })
                    }
                }

                await db.workspaces.update(workspaceId, {
                    syncStatus: 'synced',
                    lastSyncedAt: new Date().toISOString()
                })
            }
        } else {
            await addToOfflineMutations('workspaces', workspaceId, 'update', supabaseUpdate, workspaceId)
            if (name !== undefined && currentBranchInfo?.isBranch && currentBranchInfo.relationId) {
                await addToOfflineMutations(
                    'workspace_branches',
                    currentBranchInfo.relationId,
                    'update',
                    {
                        id: currentBranchInfo.relationId,
                        name
                    },
                    workspaceId
                )
            }
        }
    }

    const switchDataMode = async (newMode: 'cloud' | 'hybrid'): Promise<{ error: string | null }> => {
        const workspaceId = user?.workspaceId
        if (!workspaceId) return { error: 'No workspace' }

        const currentMode = featuresRef.current.data_mode
        if (currentMode === 'local') return { error: 'Cannot switch from local mode' }
        if (currentMode === newMode) return { error: null }

        try {
            const { error: updateError } = await runSupabaseAction(
                'workspace.switchDataMode',
                () => supabase
                    .from('workspaces')
                    .update({ data_mode: newMode })
                    .eq('id', workspaceId),
                { timeoutMs: 12000, platform: 'all' }
            ) as any

            if (updateError) {
                const normalized = normalizeSupabaseActionError(updateError)
                return { error: normalized.message }
            }

            const { error: authError } = await runSupabaseAction(
                'auth.updateWorkspaceMode',
                () => supabase.auth.updateUser({
                    data: {
                        data_mode: newMode
                    }
                }),
                { timeoutMs: 8000, platform: 'all' }
            ) as any

            if (authError) {
                console.warn('[Workspace] Failed to persist workspace mode in auth metadata:', authError)
            }

            // Update local state
            const updatedFeatures = mergeWorkspaceFeatures({ ...featuresRef.current, data_mode: newMode }, overridesRef.current)
            setFeatures(updatedFeatures)
            writeWorkspaceCache({
                workspaceId,
                features: updatedFeatures,
                workspaceName: workspaceNameRef.current ?? user?.workspaceName ?? 'My Workspace',
                overrides: overridesRef.current
            })

            // Update workspace mode snapshot
            writeWorkspaceModeSnapshot({
                workspaceId,
                dataMode: newMode
            })

            // Update Dexie workspace record
            await db.workspaces.update(workspaceId, { data_mode: newMode })

            // Update auth user mode
            updateUser({ workspaceMode: newMode })

            if (newMode === 'hybrid') {
                // Cloud → Hybrid: seed SQLite from Dexie cache, then hydrate
                await seedWorkspaceFromDexie(db, workspaceId)
                await hydrateLocalModeCacheFromSqlite(db, workspaceId)

                try {
                    await fetchCachedCustomTemplates(workspaceId)
                } catch (customTemplateSeedError) {
                    console.warn(
                        '[Workspace] Custom templates will be mirrored on the next successful refresh:',
                        customTemplateSeedError
                    )
                }
            } else {
                // Hybrid → Cloud: abandon SQLite data
                await clearWorkspaceSqliteData(workspaceId)
            }

            return { error: null }
        } catch (err) {
            const normalized = normalizeSupabaseActionError(err)
            return { error: normalized.message }
        }
    }

    useEffect(() => {
        if (!user?.workspaceId || loadedWorkspaceId !== user.workspaceId) {
            return
        }

        writeWorkspaceModeSnapshot({
            workspaceId: user.workspaceId,
            dataMode: features.data_mode
        })
    }, [
        features.data_mode,
        loadedWorkspaceId,
        user?.workspaceId
    ])

    const isLocalMode = features.data_mode === 'local' || features.data_mode === 'demo'
    const isDemoMode = features.data_mode === 'demo'
    const isCloudMode = features.data_mode === 'cloud'
    const isHybridMode = features.data_mode === 'hybrid'
    const isWorkspaceLoading = isWorkspaceResolutionPending({
        isLoading,
        isAuthenticated,
        workspaceId: user?.workspaceId,
        resolvingWorkspaceId: currentWorkspaceIdRef.current
    })
    const isLocked = isWorkspaceCurrentlyLocked(features, paymentSummary, new Date(billingNowMs))
        || shouldWorkspacePaymentLockAccess(paymentSummary)
    const planCapabilities = overrides.length
        ? applyWorkspaceOverrides(getPlanCapabilities(features.plan), overrides)
        : getPlanCapabilities(features.plan)

    return (
        <WorkspaceContext.Provider value={{
            features,
            plan: features.plan,
            planCapabilities,
            workspaceName,
            branchInfo,
            resolvedBranchInfoWorkspaceId,
            isLoading: isWorkspaceLoading,
            loadedWorkspaceId,
            paymentSummary,
            isPaymentSummaryLoading,
            pendingUpdate,
            setPendingUpdate,
            isLocked,
            isLocalMode,
            isDemoMode,
            isCloudMode,
            isHybridMode,
            hasFeature,
            hasCapability,
            isFullscreen,
            refreshFeatures,
            refreshPaymentSummary,
            updateSettings,
            switchDataMode,
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
