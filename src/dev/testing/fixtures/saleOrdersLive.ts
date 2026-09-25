import 'fake-indexeddb/auto'
import { afterAll, beforeAll, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { db } from '@/local-db/database'
import type { BusinessPartner, Product, Storage } from '@/local-db/models'
import { setActiveBusinessUser, setActiveBusinessWorkspace } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { liveSupabase } from '../liveSupabase'
import { installTestBrowser } from './browser'

vi.mock('@/auth/supabase', async () => ({ supabase: (await import('../liveSupabase')).liveSupabase }))

export const liveWorkspaceId = process.env.ATLAS_LIVE_WORKSPACE_ID || ''
const workspaceName = process.env.ATLAS_LIVE_WORKSPACE_NAME || ''
const email = process.env.ATLAS_LIVE_TEST_EMAIL || ''
const password = process.env.ATLAS_LIVE_TEST_PASSWORD || ''
const runId = process.env.ATLAS_LIVE_RUN_ID || ''
const supabaseUrl = process.env.ATLAS_LIVE_SUPABASE_URL || ''
const supabaseKey = process.env.ATLAS_LIVE_SUPABASE_KEY || ''

export function requireLiveData<T = any>(result: { data: unknown; error: { message: string } | null }, label: string): T {
    if (result.error || result.data === null) throw new Error(`${label}: ${result.error?.message || 'missing row'}`)
    return result.data as T
}

export function recordLiveFixture(ids: Record<string, string | null>, cleanup?: string) {
    process.stdout.write(`ATLAS_TEST_EVENT ${JSON.stringify({ type: 'fixture', fixture: { runId, workspaceId: liveWorkspaceId, ...ids, ...(cleanup ? { cleanup } : {}) } })}\n`)
}

export async function freshLiveClient() {
    const client = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: globalThis.fetch.bind(globalThis) }
    })
    const { error } = await client.auth.signInWithPassword({ email, password })
    if (error) throw new Error('live_auth_failed')
    return client
}

export function setupHostedSaleOrders() {
    beforeAll(async () => {
        installTestBrowser()
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
        if (!runId || !liveWorkspaceId || !/^DEV TEST\b/i.test(workspaceName)) throw new Error('live_config_invalid')
        const { data, error } = await liveSupabase.auth.signInWithPassword({ email, password })
        if (error || !data.user || data.user.email?.toLowerCase() !== email.toLowerCase()) throw new Error('live_auth_failed')
        const profile = requireLiveData<{ current_workspace: string | null; role: string }>(
            await liveSupabase.from('profiles').select('current_workspace,role').eq('id', data.user.id).single(), 'profile')
        const workspace = requireLiveData<{ id: string; name: string; data_mode: 'cloud' | 'hybrid' }>(
            await liveSupabase.from('workspaces').select('id,name,data_mode').eq('id', liveWorkspaceId).single(), 'workspace')
        const accessible = requireLiveData<Array<{ id: string }>>(await liveSupabase.from('workspaces').select('id').limit(2), 'visible workspaces')
        if (profile.current_workspace !== liveWorkspaceId || profile.role !== 'admin'
            || workspace.id !== liveWorkspaceId || workspace.name !== workspaceName
            || !['cloud', 'hybrid'].includes(workspace.data_mode)
            || accessible.length !== 1 || accessible[0].id !== liveWorkspaceId) throw new Error('live_workspace_mismatch')
        writeWorkspaceModeSnapshot({ workspaceId: liveWorkspaceId, dataMode: workspace.data_mode })
        setActiveBusinessWorkspace(liveWorkspaceId)
        setActiveBusinessUser(data.user.id, 'admin', liveWorkspaceId)
        await db.delete()
        await db.open()
        const { fetchTableFromSupabase } = await import('@/local-db/hooks')
        if (!await fetchTableFromSupabase('storages', db.storages, liveWorkspaceId, { force: true })) {
            throw new Error('live_storage_hydration_failed')
        }
    }, 120_000)

    afterAll(async () => {
        clearWorkspaceModeSnapshot(liveWorkspaceId)
        setActiveBusinessUser(null)
        setActiveBusinessWorkspace(null)
        await liveSupabase.auth.signOut().catch(() => undefined)
        await db.delete()
    })
}

export type LiveSaleOrderFixture = {
    tag: string
    ids: Record<string, string | null>
    partner: BusinessPartner
    storage: Storage
    product: Product
}

export async function withLiveSaleOrderFixture<T>(
    scenario: (fixture: LiveSaleOrderFixture) => Promise<T>,
    options: { stock?: number; currency?: 'usd' | 'iqd'; price?: number; costPrice?: number; unit?: string } = {}
): Promise<T> {
    const hooks = await import('@/local-db/hooks')
    const partners = await import('@/local-db/businessPartners')
    const tag = `DEV TEST ${runId.slice(0, 8)} ${crypto.randomUUID().slice(0, 8)}`
    const ids: Record<string, string | null> = { partnerId: null, storageId: null, productId: null, orderId: null }
    let passed = false
    try {
        const partner = await partners.createBusinessPartner(liveWorkspaceId, {
            partnerName: `${tag} customer`, phone: '', defaultCurrency: options.currency ?? 'usd',
            creditLimit: 0, receivableCreditLimit: null, payableCreditLimit: null, role: 'customer'
        })
        ids.partnerId = partner.id
        recordLiveFixture(ids)
        const storage = await hooks.createStorage(liveWorkspaceId, { name: `${tag} storage` })
        ids.storageId = storage.id
        recordLiveFixture(ids)
        const product = await hooks.createProduct(liveWorkspaceId, {
            sku: `DT-${crypto.randomUUID().slice(0, 12)}`, name: `${tag} product`, description: '',
            categoryId: null, category: null, storageId: storage.id, storageName: storage.name,
            price: options.price ?? 100, costPrice: options.costPrice ?? 40,
            quantity: options.stock ?? 10, minStockLevel: 0, unit: options.unit ?? 'pcs',
            currency: options.currency ?? 'usd', barcode: '', barcodes: [], imageUrl: '',
            canBeReturned: true, returnRules: '', createdBy: null
        })
        ids.productId = product.id
        recordLiveFixture(ids)
        const result = await scenario({ tag, ids, partner, storage, product })
        passed = true
        return result
    } finally {
        let cleanup = 'retained'
        if (passed && ids.productId) {
            try { await hooks.deleteProduct(ids.productId); cleanup = 'product-retired' }
            catch { cleanup = 'product-retire-failed' }
        }
        recordLiveFixture(ids, cleanup)
    }
}
