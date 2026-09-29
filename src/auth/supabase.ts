import { createClient } from '@supabase/supabase-js'
import { getAppSettingSync } from '@/local-db/settings'
import { decrypt, encrypt } from '@/lib/encryption'
import { createWorkspaceUsageFetch } from '@/lib/workspaceUsageFetch'
import { isTauri } from '@/lib/platform'
import { createAuthSessionManager } from './sessionManager'
import { subscribeAppMaintenance } from '@/lib/appMaintenanceState'
import { isCurrentWorkspaceMaintenanceBlockingDataAccess } from '@/lib/appMaintenanceAccess'
import {
    createMaintenanceAwareFetch,
    installGlobalMaintenanceFetchGate,
    installMaintenanceRealtimeGate
} from '@/lib/supabaseMaintenanceGate'

// Custom storage adapter that encrypts everything in local storage
const EncryptedStorage = {
    getItem: (key: string): string | null => {
        const value = localStorage.getItem(key)
        if (!value) return null
        return decrypt(value)
    },
    setItem: (key: string, value: string): void => {
        localStorage.setItem(key, encrypt(value))
    },
    removeItem: (key: string): void => {
        localStorage.removeItem(key)
    }
}

const parseBooleanEnv = (value: string | undefined): boolean => {
    if (!value) return false
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
}

const envSupabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''
const envSupabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || ''
const customSupabaseUrl = getAppSettingSync('supabase_url') || ''
const customSupabaseAnonKey = getAppSettingSync('supabase_anon_key') || ''

export const isBackendConfigurationRequired = parseBooleanEnv(import.meta.env.VITE_REQUIRE_BACKEND_CONFIGURATION)

export const resolvedSupabaseUrl = isBackendConfigurationRequired
    ? customSupabaseUrl
    : (envSupabaseUrl || customSupabaseUrl || '')
export const resolvedSupabaseAnonKey = isBackendConfigurationRequired
    ? customSupabaseAnonKey
    : (envSupabaseAnonKey || customSupabaseAnonKey || '')

// Check if Supabase is configured with valid values
const isUrlValid = resolvedSupabaseUrl && resolvedSupabaseUrl.startsWith('https://') && !resolvedSupabaseUrl.includes('your_supabase_url')
const isKeyValid = resolvedSupabaseAnonKey && resolvedSupabaseAnonKey.length > 50 && !resolvedSupabaseAnonKey.includes('your_supabase_anon')

export const isSupabaseConfigured = Boolean(isUrlValid && isKeyValid)

// Create Supabase client with fallbacks to prevent crash if not configured
// The app will redirect to configuration page if isSupabaseConfigured is false
const clientUrl = isUrlValid ? resolvedSupabaseUrl : 'https://placeholder.supabase.co'
const clientKey = isKeyValid ? resolvedSupabaseAnonKey : 'placeholder-key'
installGlobalMaintenanceFetchGate(clientUrl, isCurrentWorkspaceMaintenanceBlockingDataAccess)
// Browser REST traffic is sent through the same-origin usage gateway so the
// server, not the browser, chooses the Web Live (20x) charge rate. Desktop
// clients retain their direct Tauri (10x) metering path.
const webUsageGatewayUrl = !isTauri() && !isBackendConfigurationRequired
    ? (import.meta.env.VITE_WEB_USAGE_GATEWAY_URL || (import.meta.env.PROD ? '/api-workspace-data' : ''))
    : ''
const webStorageUsageGatewayUrl = !isTauri() && !isBackendConfigurationRequired
    ? (import.meta.env.VITE_WEB_STORAGE_USAGE_GATEWAY_URL || (import.meta.env.PROD ? '/api-workspace-storage' : ''))
    : ''

const workspaceUsageFetch = createWorkspaceUsageFetch({
    supabaseUrl: clientUrl,
    supabaseAnonKey: clientKey,
    webGatewayUrl: webUsageGatewayUrl,
    webStorageGatewayUrl: webStorageUsageGatewayUrl
})

export const supabase = createClient(clientUrl, clientKey, {
    global: {
        fetch: createMaintenanceAwareFetch(
            workspaceUsageFetch,
            clientUrl,
            isCurrentWorkspaceMaintenanceBlockingDataAccess
        )
    },
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: EncryptedStorage
    }
})

const maintenanceRealtimeGate = installMaintenanceRealtimeGate(
    supabase as any,
    isCurrentWorkspaceMaintenanceBlockingDataAccess
)
subscribeAppMaintenance(() => {
    void maintenanceRealtimeGate.reconcile()
})

export const createAppMaintenanceRealtimeChannel = () =>
    maintenanceRealtimeGate.createMaintenanceChannel()

const authSessionManager = createAuthSessionManager({
    refreshSession: () => supabase.auth.refreshSession(),
    signOut: (options) => supabase.auth.signOut(options)
})

export const refreshSupabaseSession = () => authSessionManager.refreshSession()
export const signOutCurrentSupabaseSession = () => authSessionManager.signOutCurrentSession()
// Database table types for Supabase
export type SupabaseProduct = {
    id: string
    sku: string
    name: string
    description: string
    category: string
    price: number
    cost_price: number | null
    quantity: number
    min_stock_level: number
    unit: string
    image_url: string | null
    created_at: string
    updated_at: string
    version: number
    is_deleted: boolean
    user_id: string
}

export type SupabaseCustomer = {
    id: string
    name: string
    email: string
    phone: string
    address: string
    city: string
    country: string
    notes: string | null
    total_orders: number
    total_spent: number
    created_at: string
    updated_at: string
    version: number
    is_deleted: boolean
    user_id: string
}

export type SupabaseOrder = {
    id: string
    order_number: string
    customer_id: string
    customer_name: string
    items: object[]
    subtotal: number
    tax: number
    discount: number
    total: number
    status: string
    notes: string | null
    shipping_address: string
    created_at: string
    updated_at: string
    version: number
    is_deleted: boolean
    user_id: string
}

export type SupabaseInvoice = {
    id: string
    invoiceid: string
    order_id?: string | null
    items: object[]
    subtotal: number
    discount: number
    total: number
    currency: string
    created_at: string
    updated_at: string
    version: number
    is_deleted: boolean
    user_id: string
    created_by_name?: string
    cashier_name?: string
}

