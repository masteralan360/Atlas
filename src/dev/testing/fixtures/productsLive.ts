import 'fake-indexeddb/auto'
import { afterAll, beforeAll, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { db } from '@/local-db/database'
import type { CurrencyCode, Product } from '@/local-db/models'
import { setActiveBusinessUser, setActiveBusinessWorkspace, setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { liveSupabase } from '../liveSupabase'
import { installTestBrowser } from './browser'

vi.mock('@/auth/supabase', async () => ({ supabase: (await import('../liveSupabase')).liveSupabase }))

export const liveProductsWorkspaceId = process.env.ATLAS_LIVE_WORKSPACE_ID || ''
const workspaceName = process.env.ATLAS_LIVE_WORKSPACE_NAME || ''
const email = process.env.ATLAS_LIVE_TEST_EMAIL || ''
const password = process.env.ATLAS_LIVE_TEST_PASSWORD || ''
const runId = process.env.ATLAS_LIVE_RUN_ID || ''
const supabaseUrl = process.env.ATLAS_LIVE_SUPABASE_URL || ''
const supabaseKey = process.env.ATLAS_LIVE_SUPABASE_KEY || ''

export function requireProductsLiveData<T = any>(result: { data: unknown; error: { message: string } | null }, label: string): T {
    if (result.error || result.data === null) throw new Error(`${label}: ${result.error?.message || 'missing row'}`)
    return result.data as T
}

export function recordProductFixture(ids: Record<string, string | null>, cleanup?: string) {
    process.stdout.write(`ATLAS_TEST_EVENT ${JSON.stringify({
        type: 'fixture', fixture: { runId, workspaceId: liveProductsWorkspaceId, ...ids, ...(cleanup ? { cleanup } : {}) }
    })}\n`)
}

export async function freshProductsClient() {
    const client = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: globalThis.fetch.bind(globalThis) }
    })
    const { error } = await client.auth.signInWithPassword({ email, password })
    if (error) throw new Error('live_auth_failed')
    return client
}

export async function priceBooksCapabilityAllowed() {
    const client = await freshProductsClient()
    try {
        const workspace = requireProductsLiveData<{ plan: string }>(
            await client.from('workspaces').select('plan').eq('id', liveProductsWorkspaceId).single(), 'Price Books workspace plan')
        return requireProductsLiveData<boolean>(await client.rpc('workspace_capability_allowed', {
            p_workspace_id: liveProductsWorkspaceId,
            p_plan: workspace.plan,
            p_capability: 'priceBooks'
        }), 'Price Books capability')
    } finally {
        await client.auth.signOut()
    }
}

export async function salesAgentCommissionsModuleAllowed() {
    const client = await freshProductsClient()
    try {
        const workspace = requireProductsLiveData<{ plan: string }>(
            await client.from('workspaces').select('plan').eq('id', liveProductsWorkspaceId).single(), 'commission workspace plan')
        return requireProductsLiveData<boolean>(await client.rpc('workspace_module_allowed', {
            p_workspace_id: liveProductsWorkspaceId,
            p_plan: workspace.plan,
            p_module: 'sales_agent_commissions'
        }), 'Sales agent commissions module access')
    } finally {
        await client.auth.signOut()
    }
}

export function setupHostedProducts() {
    beforeAll(async () => {
        installTestBrowser()
        setNetworkStatus(true)
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
        if (!runId || !liveProductsWorkspaceId || !/^DEV TEST\b/i.test(workspaceName)) throw new Error('live_config_invalid')
        const { data, error } = await liveSupabase.auth.signInWithPassword({ email, password })
        if (error || !data.user || data.user.email?.toLowerCase() !== email.toLowerCase()) throw new Error('live_auth_failed')
        const profile = requireProductsLiveData<{ current_workspace: string | null; role: string }>(
            await liveSupabase.from('profiles').select('current_workspace,role').eq('id', data.user.id).single(), 'profile')
        const workspace = requireProductsLiveData<{ id: string; name: string; data_mode: 'cloud' | 'hybrid' }>(
            await liveSupabase.from('workspaces').select('id,name,data_mode').eq('id', liveProductsWorkspaceId).single(), 'workspace')
        const accessible = requireProductsLiveData<Array<{ id: string }>>(
            await liveSupabase.from('workspaces').select('id').limit(2), 'visible workspaces')
        if (profile.current_workspace !== liveProductsWorkspaceId || profile.role !== 'admin'
            || workspace.id !== liveProductsWorkspaceId || workspace.name !== workspaceName
            || !['cloud', 'hybrid'].includes(workspace.data_mode)
            || accessible.length !== 1 || accessible[0].id !== liveProductsWorkspaceId) throw new Error('live_workspace_mismatch')

        writeWorkspaceModeSnapshot({ workspaceId: liveProductsWorkspaceId, dataMode: workspace.data_mode })
        setActiveBusinessWorkspace(liveProductsWorkspaceId)
        setActiveBusinessUser(data.user.id, 'admin', liveProductsWorkspaceId)
        await db.delete()
        await db.open()
        const { fetchTableFromSupabase } = await import('@/local-db/hooks')
        if (!await fetchTableFromSupabase('storages', db.storages, liveProductsWorkspaceId, { force: true })) {
            throw new Error('live_storage_hydration_failed')
        }
    }, 120_000)

    afterAll(async () => {
        clearWorkspaceModeSnapshot(liveProductsWorkspaceId)
        setActiveBusinessUser(null)
        setActiveBusinessWorkspace(null)
        setNetworkStatus(true)
        await liveSupabase.auth.signOut().catch(() => undefined)
        await db.delete()
    })
}

export type LiveProductFixture = {
    tag: string
    ids: Record<string, string | null>
    product: Product
}

export async function withLiveProductFixture<T>(
    scenario: (fixture: LiveProductFixture) => Promise<T>,
    options: { skuPrefix?: string; retireOnSuccess?: boolean; successCleanup?: string } = {}
): Promise<T> {
    const hooks = await import('@/local-db/hooks')
    const tag = `DEV TEST PRODUCT ${runId.slice(0, 8)} ${crypto.randomUUID().slice(0, 8)}`
    const ids: Record<string, string | null> = { productId: null, barcodeId: null, variantId: null, priceBookId: null, storageId: null }
    let passed = false
    let product: Product | null = null
    try {
        product = await hooks.createProduct(liveProductsWorkspaceId, {
            sku: `${options.skuPrefix ?? 'DTP'}-${crypto.randomUUID().slice(0, 12)}`,
            name: `${tag} product`, description: '', categoryId: null, category: null,
            storageId: null, price: 1250, costPrice: 700, quantity: 0, minStockLevel: 2,
            unit: 'pcs', currency: 'iqd' as CurrencyCode, imageUrl: '', canBeReturned: true,
            returnRules: '', barcode: '', barcodes: [], createdBy: null
        })
        ids.productId = product.id
        recordProductFixture(ids)
        const result = await scenario({ tag, ids, product })
        passed = true
        return result
    } finally {
        let cleanup = 'retained-for-inspection'
        if (passed && product && options.retireOnSuccess !== false) {
            try { await hooks.deleteProduct(product.id); cleanup = 'product-retired' }
            catch { cleanup = 'product-retire-failed' }
        } else if (passed && options.successCleanup) {
            cleanup = options.successCleanup
        }
        recordProductFixture(ids, cleanup)
    }
}
