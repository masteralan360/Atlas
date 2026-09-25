import 'fake-indexeddb/auto'
import { afterAll, beforeAll, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { db } from '@/local-db/database'
import type { CurrencyCode, Product, StockBatch, Storage } from '@/local-db/models'
import type { PosCheckoutInput } from '@/local-db/posCheckout'
import { setActiveBusinessUser, setActiveBusinessWorkspace } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { financePosInput, POS_METHODS, posCheckoutInput } from './pos'
import { installTestBrowser } from './browser'
import { liveSupabase } from '../liveSupabase'

vi.mock('@/auth/supabase', async () => ({ supabase: (await import('../liveSupabase')).liveSupabase }))

export const livePosWorkspaceId = process.env.ATLAS_LIVE_WORKSPACE_ID || ''
export const livePosMethods = POS_METHODS
export const financeLivePosInput = financePosInput
export let livePosCurrency: CurrencyCode = 'usd'
export let livePosConversionEnabled = false
const workspaceName = process.env.ATLAS_LIVE_WORKSPACE_NAME || ''
const email = process.env.ATLAS_LIVE_TEST_EMAIL || ''
const password = process.env.ATLAS_LIVE_TEST_PASSWORD || ''
const runId = process.env.ATLAS_LIVE_RUN_ID || ''
const supabaseUrl = process.env.ATLAS_LIVE_SUPABASE_URL || ''
const supabaseKey = process.env.ATLAS_LIVE_SUPABASE_KEY || ''
let livePosUserId = ''

// The ungenerated public schema makes Supabase's selected row type `never`.
// These hosted assertions validate the actual selected fields at runtime.
export function requirePosLiveData(result: { data: any; error: { message: string } | null }, label: string): any {
    if (result.error || result.data === null) throw new Error(`${label}: ${result.error?.message || 'missing row'}`)
    return result.data
}

export function recordPosFixture(ids: Record<string, string | null>, cleanup?: string) {
    process.stdout.write(`ATLAS_TEST_EVENT ${JSON.stringify({ type: 'fixture', fixture: { runId, workspaceId: livePosWorkspaceId, ...ids, ...(cleanup ? { cleanup } : {}) } })}\n`)
}

export async function freshPosClient() {
    const client = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: globalThis.fetch.bind(globalThis) }
    })
    const { error } = await client.auth.signInWithPassword({ email, password })
    if (error) throw new Error('live_auth_failed')
    return client
}

export function setupHostedPos() {
    beforeAll(async () => {
        installTestBrowser()
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
        if (!runId || !livePosWorkspaceId || !/^DEV TEST\b/i.test(workspaceName)) throw new Error('live_config_invalid')
        const { data, error } = await liveSupabase.auth.signInWithPassword({ email, password })
        if (error || !data.user || data.user.email?.toLowerCase() !== email.toLowerCase()) throw new Error('live_auth_failed')
        const profile = requirePosLiveData(await liveSupabase.from('profiles')
            .select('current_workspace,role').eq('id', data.user.id).single(), 'profile')
        const workspace = requirePosLiveData(await liveSupabase.from('workspaces')
            .select('id,name,data_mode,default_currency,pos_convert_to_workspace_currency')
            .eq('id', livePosWorkspaceId).single(), 'workspace')
        const accessible = requirePosLiveData(await liveSupabase.from('workspaces').select('id').limit(2), 'visible workspaces')
        if (profile.current_workspace !== livePosWorkspaceId || profile.role !== 'admin'
            || workspace.id !== livePosWorkspaceId || workspace.name !== workspaceName
            || !['cloud', 'hybrid'].includes(workspace.data_mode)
            || accessible.length !== 1 || accessible[0].id !== livePosWorkspaceId) throw new Error('live_workspace_mismatch')
        const currency = String(workspace.default_currency ?? '').toLowerCase()
        if (!['usd', 'iqd', 'eur', 'try'].includes(currency)) throw new Error('live_workspace_currency_invalid')
        livePosCurrency = currency as CurrencyCode
        livePosConversionEnabled = workspace.pos_convert_to_workspace_currency !== false
        livePosUserId = data.user.id
        writeWorkspaceModeSnapshot({ workspaceId: livePosWorkspaceId, dataMode: workspace.data_mode })
        setActiveBusinessWorkspace(livePosWorkspaceId)
        setActiveBusinessUser(data.user.id, 'admin', livePosWorkspaceId)
        await db.delete()
        await db.open()
        const { fetchTableFromSupabase } = await import('@/local-db/hooks')
        if (!await fetchTableFromSupabase('storages', db.storages, livePosWorkspaceId, { force: true })) {
            throw new Error('live_storage_hydration_failed')
        }
    }, 120_000)

    afterAll(async () => {
        clearWorkspaceModeSnapshot(livePosWorkspaceId)
        setActiveBusinessUser(null)
        setActiveBusinessWorkspace(null)
        await liveSupabase.auth.signOut().catch(() => undefined)
        await db.delete()
    })
}

export type LivePosFixture = {
    tag: string
    ids: Record<string, string | null>
    storage: Storage
    product: Product
    batch: StockBatch | null
    input: (options?: { method?: PosCheckoutInput['payload']['payment_method']; quantity?: number; unitPrice?: number }) => PosCheckoutInput
}

export async function withLivePosFixture<T>(
    scenario: (fixture: LivePosFixture) => Promise<T>,
    options: { currency?: CurrencyCode; stock?: number; price?: number; costPrice?: number; service?: boolean; unit?: string } = {}
): Promise<T> {
    const hooks = await import('@/local-db/hooks')
    const batches = await import('@/local-db/stockBatches')
    const tag = `DEV TEST POS ${runId.slice(0, 8)} ${crypto.randomUUID().slice(0, 8)}`
    const ids: Record<string, string | null> = { storageId: null, productId: null, batchId: null, saleId: null }
    let passed = false
    try {
        const storage = await hooks.createStorage(livePosWorkspaceId, { name: `${tag} storage` })
        ids.storageId = storage.id
        recordPosFixture(ids)
        const currency = options.currency ?? livePosCurrency
        const stock = options.stock ?? 20
        const price = options.price ?? 100
        const costPrice = options.costPrice ?? 40
        const service = options.service === true
        const product = await hooks.createProduct(livePosWorkspaceId, {
            sku: `DTP-${crypto.randomUUID().slice(0, 12)}`, name: `${tag} product`, description: '',
            categoryId: null, category: null, storageId: service ? null : storage.id,
            storageName: service ? undefined : storage.name, price, costPrice: service ? 0 : costPrice,
            quantity: service ? 0 : stock, minStockLevel: 0, unit: service ? '' : options.unit ?? 'pcs',
            currency, barcode: '', barcodes: [], imageUrl: '', canBeReturned: true,
            returnRules: '', createdBy: null, isService: service
        })
        ids.productId = product.id
        recordPosFixture(ids)
        const batch = service ? null : await batches.createStockBatch(livePosWorkspaceId, {
            productId: product.id, storageId: storage.id, batchNumber: `POS-${crypto.randomUUID().slice(0, 8)}`,
            quantity: stock, price, costPrice, currency, expiryDate: null, manufacturingDate: null,
            notes: null, sourcePurchaseOrderId: null, sourcePurchaseOrderItemId: null
        })
        ids.batchId = batch?.id ?? null
        recordPosFixture(ids)
        if (batch) {
            const fresh = await freshPosClient()
            try {
                requirePosLiveData(await fresh.from('stock_batches').select('id')
                    .eq('id', batch.id).single(), 'fixture stock batch')
            } finally { await fresh.auth.signOut() }
        }
        const input: LivePosFixture['input'] = (values = {}) => {
            const quantity = values.quantity ?? 1
            const unitPrice = values.unitPrice ?? price
            const draft = posCheckoutInput({ currency, method: values.method ?? 'cash', service, quantity, unitPrice })
            const now = new Date().toISOString()
            draft.payload.workspace_id = livePosWorkspaceId
            draft.payload.items[0] = {
                ...draft.payload.items[0], product_id: product.id, storage_id: service ? null : storage.id,
                product_name: product.name, product_sku: product.sku, created_at: now, updated_at: now,
                cost_price: service ? 0 : costPrice, converted_cost_price: service ? 0 : costPrice,
                original_unit_price: price, inventory_snapshot: service ? null : stock,
                batch_allocations: batch ? [{ batch_id: batch.id, batch_number: batch.batchNumber,
                    quantity, price, cost_price: costPrice, currency, expiry_date: null, manufacturing_date: null }] : null
            }
            draft.user = { id: livePosUserId, name: 'DEV TEST POS cashier' }
            draft.timestamp = now
            draft.batchPlans = batch ? [{ productId: product.id, storageId: storage.id,
                allocations: [{ batchId: batch.id, batchNumber: batch.batchNumber, quantity,
                    price, costPrice, currency }] }] : []
            return draft
        }
        const result = await scenario({ tag, ids, storage, product, batch, input })
        passed = true
        return result
    } finally {
        let cleanup = 'retained'
        if (passed && ids.productId) {
            try { await hooks.updateProduct(ids.productId, { isDeleted: true }); cleanup = 'product-retired' }
            catch { cleanup = 'product-retire-failed' }
        }
        recordPosFixture(ids, cleanup)
    }
}
