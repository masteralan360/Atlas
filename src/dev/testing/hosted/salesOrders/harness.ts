import { mkdir, writeFile } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { expect } from 'vitest'
import type { CurrencyCode, Product, SalesOrder, SalesOrderItem } from '@/local-db/models'
import { liveSupabase } from '../../liveSupabase'
import { liveWorkspaceId, recordLiveFixture, requireLiveData, withLiveSaleOrderFixture, type LiveSaleOrderFixture } from '../../fixtures/saleOrdersLive'
import { saleOrderInput } from '../../fixtures/saleOrder'
import { active, assertGraph, canonical, graphHash, money, quantity, readGraph, sum } from './graph'
import { HostedBlocked, type ExtendedConfig, type Family, type Graph, type HostedClient, type HostedEvidence, type RequestEvidence, type Row, type Scope } from './types'

export function extendedConfig(): ExtendedConfig {
    const config = JSON.parse(process.env.ATLAS_LIVE_SALES_CONFIG || '{}')
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('hosted_sales_config_invalid')
    return config
}
export function requireFixture(caseId: string): NonNullable<ExtendedConfig['fixtures']>[string] {
    const fixture = extendedConfig().fixtures?.[caseId]
    if (!fixture) throw new HostedBlocked(`fixture ${caseId} is not configured in .atlas-sales-order-hosted.local.json`)
    return fixture
}
export async function personaClient(name: string): Promise<HostedClient> {
    const client = createClient(process.env.ATLAS_LIVE_SUPABASE_URL!, process.env.ATLAS_LIVE_SUPABASE_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: globalThis.fetch.bind(globalThis) }
    })
    if (name === 'anonymous') return client
    const persona = extendedConfig().personas?.[name]
    if (!persona) throw new HostedBlocked(`persona ${name} is not configured`)
    if (!/^DEV TEST\b/i.test(persona.workspaceName)) throw new Error('hosted_persona_workspace_invalid')
    const auth = await client.auth.signInWithPassword({ email: persona.email, password: persona.password })
    if (auth.error || !auth.data.user) throw new Error('hosted_persona_auth_failed')
    const profile = requireLiveData<Row>(await client.from('profiles').select('role,current_workspace').eq('id', auth.data.user.id).single(), 'persona profile')
    const workspace = requireLiveData<Row>(await client.from('workspaces').select('id,name,data_mode').eq('id', persona.workspaceId).single(), 'persona workspace')
    if (profile.role !== persona.role || profile.current_workspace !== persona.workspaceId || workspace.name !== persona.workspaceName || !['cloud', 'hybrid'].includes(workspace.data_mode)) throw new Error('hosted_persona_identity_mismatch')
    return client
}

/** Separate HTTP client with the existing verified session; observation must not revoke the action actor's session. */
export async function freshObserver(): Promise<HostedClient> {
    let session = (await liveSupabase.auth.getSession()).data.session
    if (!session) throw new Error('hosted_observer_session_missing')
    const identity = await liveSupabase.auth.getUser(session.access_token)
    if (identity.error?.status === 401) {
        // A different test process can revoke the shared account's sessions. Restore identity before creating fixtures.
        const auth = await liveSupabase.auth.signInWithPassword({ email: process.env.ATLAS_LIVE_TEST_EMAIL!, password: process.env.ATLAS_LIVE_TEST_PASSWORD! })
        if (auth.error || !auth.data.session || auth.data.user?.email?.toLowerCase() !== process.env.ATLAS_LIVE_TEST_EMAIL!.toLowerCase()) throw new Error(`hosted_actor_reauthentication_failed:${auth.error?.code ?? 'identity'}`)
        const profile = requireLiveData<Row>(await liveSupabase.from('profiles').select('role,current_workspace').eq('id', auth.data.user.id).single(), 'reauthenticated profile')
        if (profile.role !== 'admin' || profile.current_workspace !== liveWorkspaceId) throw new Error('hosted_actor_reauthentication_identity_mismatch')
        session = auth.data.session
    } else if (identity.error || !identity.data.user) throw new Error(`hosted_actor_identity_failed:${identity.error?.code ?? 'no_user'}`)
    if ((session.expires_at ?? 0) * 1000 - Date.now() < 120_000) {
        const refreshed = await liveSupabase.auth.refreshSession()
        if (refreshed.error || !refreshed.data.session) throw new Error('hosted_actor_refresh_failed')
        session = refreshed.data.session
    }
    const client = createClient(process.env.ATLAS_LIVE_SUPABASE_URL!, process.env.ATLAS_LIVE_SUPABASE_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: globalThis.fetch.bind(globalThis) }
    })
    const result = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token })
    if (result.error) throw new Error(`hosted_observer_session_invalid:${result.error.status}:${result.error.code}`)
    return client
}

let refreshingActor: Promise<NonNullable<Awaited<ReturnType<typeof liveSupabase.auth.getSession>>['data']['session']>> | undefined
const observerTokens = new WeakMap<HostedClient, string>()
async function synchronizeObserverSession(observer: HostedClient) {
    let session = (await liveSupabase.auth.getSession()).data.session
    if (!session) throw new Error('hosted_actor_session_missing')
    if ((session.expires_at ?? 0) * 1000 - Date.now() < 120_000) {
        refreshingActor ??= liveSupabase.auth.refreshSession().then(result => {
            if (result.error || !result.data.session) throw new Error('hosted_actor_refresh_failed')
            return result.data.session
        }).finally(() => { refreshingActor = undefined })
        session = await refreshingActor
    }
    if (observerTokens.get(observer) !== session.access_token) {
        const result = await observer.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token })
        if (result.error) throw new Error(`hosted_observer_refresh_failed:${result.error.code}`)
        observerTokens.set(observer, session.access_token)
    }
}

export type Input = Parameters<typeof import('@/local-db/orders').createSalesOrder>[1]
export type StepExpectation = {
    denied?: boolean; interrupted?: boolean; unchanged?: boolean; atomic?: boolean; status?: string; total?: number; paid?: number
    stockDelta?: number; paymentDelta?: number; returns?: number; check?: (after: Graph, before: Graph) => void
}
export class HostedScenario {
    readonly scope: Scope
    readonly evidence: HostedEvidence[] = []
    readonly requests: RequestEvidence[] = []
    readonly payloads = new Map<string, Row>()
    private emittedEvidence = 0
    private failureGraphs?: { before: Graph; after: Graph }
    auditOnly = false
    variant?: Row
    order: SalesOrder | null = null
    baseline!: Graph
    fault: { path: string; occurrence: number; mode: 'before' | 'after'; seen: number } | null = null
    constructor(readonly family: Family, readonly fixture: LiveSaleOrderFixture, readonly observer: HostedClient) {
        this.scope = { workspaceId: liveWorkspaceId, tag: fixture.tag, orderIds: new Set(), productIds: new Set([fixture.product.id]), partnerIds: new Set([fixture.partner.id]), accountIds: new Set(), operationIds: new Set(), marketplaceIds: new Set() }
    }
    async start() {
        // Production captures the workspace's commission mode from its cache. Hydrate that prerequisite from Supabase.
        const { db } = await import('@/local-db/database')
        const { toCamelCase } = await import('@/lib/utils')
        const workspace = requireLiveData<Row>(await this.observer.from('workspaces').select('*').eq('id', liveWorkspaceId).single(), 'hosted workspace metadata')
        await db.workspaces.put(toCamelCase(workspace) as any)
        this.baseline = await readGraph(this.observer, this.scope); assertGraph(this.baseline)
    }
    input(options: { method?: SalesOrder['paymentMethod']; currency?: CurrencyCode; quantity?: number; price?: number; paid?: boolean; initial?: number; free?: number; factor?: number; approval?: boolean } = {}): Input {
        const input = saleOrderInput(this.fixture.partner.id, this.fixture.product, this.fixture.storage.id, options.method ?? 'cash', {
            currency: options.currency ?? 'usd', quantity: options.quantity ?? 2, unitPrice: options.price ?? 100,
            paid: options.paid ?? false, initialPayment: options.initial ?? 0
        })
        const line = input.items[0]
        line.unit = options.factor && options.factor !== 1 ? 'carton' : this.fixture.product.unit
        line.unitRef = `builtin:${line.unit}`
        line.baseUnitRef = `builtin:${this.fixture.product.unit}`
        line.baseUnitCode = this.fixture.product.unit
        line.unitFactor = options.factor ?? 1
        line.inventoryQuantity = quantity(line.quantity * line.unitFactor)
        line.freeBonusQuantity = options.free ?? 0
        line.freeBonusInventoryQuantity = quantity((options.free ?? 0) * line.unitFactor)
        input.customerName = this.fixture.partner.partnerName
        input.notes = this.fixture.tag
        input.firstDueDate = input.nextDueDate = new Date(Date.now() + 30 * 86_400_000).toISOString()
        input.paidAt = input.paidAmount > 0 ? new Date().toISOString() : null
        if (options.approval) { input.approvalStatus = 'requested'; input.approvalRequestedAt = new Date().toISOString() }
        return input
    }
    async step<T>(name: string, action: () => Promise<T>, expected: StepExpectation = {}): Promise<T | undefined> {
        let before: Graph
        try { await synchronizeObserverSession(this.observer); before = await readGraph(this.observer, this.scope) }
        catch (error) { await this.recordReadFailure(name, error); throw error }
        const startRequest = this.requests.length
        let result: T | undefined
        let failure: unknown
        try { result = await action() } catch (error) { failure = error }
        // Capture the committed prefix even when the action throws; observation is never retried into a pass.
        let after: Graph
        try { after = await readGraph(this.observer, this.scope) }
        catch (error) { await this.recordReadFailure(name, error, before, startRequest); throw error }
        const record: HostedEvidence = { caseId: this.family.id, variant: this.variant, fixtureTag: this.fixture.tag, step: name, outcome: 'failed', requests: this.requests.slice(startRequest), before: graphHash(before), after: graphHash(after), rowCounts: Object.fromEntries(Object.entries(after.tables).map(([key, rows]) => [key, rows.length])), invariants: [] }
        this.evidence.push(record)
        try {
            if (expected.denied) expect(failure, `${name} must be rejected`).toBeTruthy()
            else if (failure && !expected.interrupted) throw failure
            if (this.fault && (expected.denied || expected.interrupted)) expect(record.requests.some(request => request.fault), `${name} did not reach the configured transport boundary`).toBe(true)
            if (expected.unchanged || (expected.denied && expected.atomic)) expect(canonical(after), `${name} changed database graph`).toBe(canonical(before))
            record.invariants = this.auditOnly ? ['complete-independent-reads'] : assertGraph(after, this.baseline)
            if (expected.unchanged) record.invariants.push('immutable-step-graph')
            if (expected.atomic && expected.denied) record.invariants.push('atomic-rejection')
            const order = this.order ? after.tables.orders.find(row => row.id === this.order!.id) : after.tables.orders.at(-1)
            if (expected.status) expect(order?.status).toBe(expected.status)
            if (expected.total !== undefined) expect(Number(order?.total)).toBeCloseTo(expected.total, 3)
            if (expected.paid !== undefined) expect(Number(order?.paid_amount)).toBeCloseTo(expected.paid, 3)
            if (expected.stockDelta !== undefined) expect(quantity(sum(after.tables.inventory, 'quantity') - sum(before.tables.inventory, 'quantity'))).toBeCloseTo(expected.stockDelta, 6)
            if (expected.paymentDelta !== undefined) expect(money(sum(active(after.tables.payments), 'amount') - sum(active(before.tables.payments), 'amount'))).toBeCloseTo(expected.paymentDelta, 3)
            if (expected.returns !== undefined) expect(after.tables.returns.length - before.tables.returns.length).toBe(expected.returns)
            expected.check?.(after, before)
            record.outcome = 'passed'
            await this.save()
            return result
        } catch (error) {
            record.outcome = error instanceof HostedBlocked ? 'blocked' : 'failed'
            record.error = error instanceof Error ? error.message : String(error)
            await this.save({ before, after })
            throw error
        }
    }
    private async recordReadFailure(step: string, error: unknown, before?: Graph, startRequest = this.requests.length) {
        this.evidence.push({ caseId: this.family.id, variant: this.variant, fixtureTag: this.fixture.tag, step, outcome: 'failed', requests: this.requests.slice(startRequest),
            before: before ? graphHash(before) : 'unavailable', after: 'unavailable', rowCounts: {}, invariants: [],
            error: error instanceof Error ? error.message : String(error) })
        await this.save()
    }
    async create(input = this.input(), entry: 'regular' | 'quick' = 'regular', target: 'draft' | 'pending' | 'completed' = 'draft') {
        const orders = await import('@/local-db/orders')
        await this.step(`create ${entry}/${target}`, async () => {
            const actor = (await liveSupabase.auth.getUser()).data.user?.id
            this.order = entry === 'quick'
                ? await orders.createQuickSalesOrder(liveWorkspaceId, { ...input, status: target }, actor)
                : await orders.createSalesOrder(liveWorkspaceId, input, actor, { requireRemoteConfirmation: true })
            this.scope.orderIds.add(this.order.id)
            this.fixture.ids.orderId = this.order.id
            recordLiveFixture(this.fixture.ids)
            return this.order
        }, { status: entry === 'quick' ? target : input.status, total: input.total })
        return this.order!
    }
    async status(status: 'pending' | 'completed' | 'cancelled', expected: StepExpectation = {}) {
        const orders = await import('@/local-db/orders')
        return this.step(`transition ${status}`, async () => {
            this.order = await orders.updateSalesOrderStatus(this.order!.id, status)
            return this.order
        }, { status: expected.denied ? undefined : status, ...expected })
    }
    async complete(input = this.input({ paid: true })) {
        await this.create(input)
        await this.status('pending', { stockDelta: 0 })
        await this.status('completed')
        return this.order!
    }
    async pay(amount: number, method: SalesOrder['paymentMethod'] = 'cash', accountId: string | null = null, expected: StepExpectation = {}) {
        const orders = await import('@/local-db/orders')
        return this.step(`collect ${amount}/${method}`, () => orders.recordOrderPayment(liveWorkspaceId, {
            orderType: 'sales', orderId: this.order!.id, amount, paymentMethod: method as any,
            paidAt: new Date().toISOString(), accountId, accountNameSnapshot: accountId ? `${this.fixture.tag} account` : null
        }), expected)
    }
    async returned(paidQuantity?: number, freeQuantity = 0, expected: StepExpectation = {}, extra: Row = {}) {
        const orders = await import('@/local-db/orders')
        const line = this.order!.items[0]
        return this.step(`return paid=${paidQuantity ?? line.quantity}, free=${freeQuantity}`, async () => {
            const result = await orders.returnSalesOrder({
                orderId: this.order!.id, items: [{ orderItemId: line.id, paidQuantity: paidQuantity ?? line.quantity, freeQuantity }],
                reason: 'customer_returned', actorRole: 'admin', ...extra
            })
            this.fixture.ids.returnId = result.return.id
            recordLiveFixture(this.fixture.ids)
            this.order = result.order
            return result
        }, { returns: expected.denied || expected.interrupted ? undefined : 1, ...expected })
    }
    async edit(patch: Partial<SalesOrder>, expected: StepExpectation = {}) {
        const orders = await import('@/local-db/orders')
        return this.step('edit draft', async () => { this.order = await orders.updateSalesOrder(this.order!.id, patch, { requireRemoteConfirmation: true }); return this.order }, expected)
    }
    async approve(expected: StepExpectation = {}) {
        const orders = await import('@/local-db/orders')
        return this.step('approve request', async () => { this.order = await orders.approveSalesOrderRequest(this.order!.id); return this.order }, expected)
    }
    async account(options: { type?: 'cash_drawer' | 'bank_account' | 'digital_wallet' | 'other'; method?: 'fib' | 'qicard' | 'zaincash' | 'fastpay' } = {}) {
        const accounts = await import('@/local-db/paymentAccounts')
        const { fetchTableFromSupabase } = await import('@/local-db/hooks')
        const { db } = await import('@/local-db/database')
        if (!await fetchTableFromSupabase('payment_accounts', db.payment_accounts, liveWorkspaceId, { force: true })) throw new Error('hosted_account_hydration_failed')
        if (options.method) {
            const linked = (await db.payment_accounts.where('workspaceId').equals(liveWorkspaceId).toArray()).filter(row => !row.isDeleted && row.isActive && row.linkedPaymentMethod === options.method)
            // savePaymentAccount reassigns an existing wallet link. Never modify an account owned by another run.
            if (linked.length) throw new HostedBlocked(`a ${options.method} wallet is already linked; an independently configured test wallet is required`)
        }
        const account = await accounts.savePaymentAccount(liveWorkspaceId, { name: `${this.fixture.tag} account`, accountType: options.type ?? 'cash_drawer', linkedPaymentMethod: options.method, openingBalances: [] })
        this.scope.accountIds.add(account.id)
        this.fixture.ids.accountId = account.id
        recordLiveFixture(this.fixture.ids)
        return account
    }
    async extraProduct(service = false, currency: CurrencyCode = 'usd') {
        const { createProduct } = await import('@/local-db/hooks')
        const product = await createProduct(liveWorkspaceId, {
            sku: service ? '' : `DT-${crypto.randomUUID().slice(0, 12)}`, name: `${this.fixture.tag} ${service ? 'service' : 'product'} ${this.scope.productIds.size}`,
            description: '', categoryId: null, category: null, storageId: service ? null : this.fixture.storage.id,
            storageName: service ? undefined : this.fixture.storage.name, price: 50, costPrice: service ? 0 : 20,
            quantity: service ? 0 : 100, minStockLevel: 0, unit: service ? '' : 'pcs', currency, barcode: '', barcodes: [],
            imageUrl: '', canBeReturned: !service, returnRules: '', createdBy: null, isService: service
        })
        this.scope.productIds.add(product.id)
        this.fixture.ids[`product${this.scope.productIds.size}Id`] = product.id
        recordLiveFixture(this.fixture.ids)
        this.baseline = await readGraph(this.observer, this.scope)
        return product
    }
    line(product: Product, count = 1, price = 50): SalesOrderItem {
        const line = this.input({ quantity: count, price }).items[0]
        return { ...line, id: crypto.randomUUID(), productId: product.id, productName: product.name, productSku: product.sku,
            storageId: product.isService ? null : this.fixture.storage.id, costPrice: Number(product.costPrice ?? 0), convertedCostPrice: Number(product.costPrice ?? 0),
            unit: product.unit, unitRef: product.unit ? `builtin:${product.unit}` : null,
            baseUnitCode: product.unit, baseUnitRef: product.unit ? `builtin:${product.unit}` : null }
    }
    recalc(input: Input) {
        input.subtotal = money(input.items.reduce((sum, line) => sum + Number(line.lineTotal), 0))
        const adjustment = (input.orderAdjustments ?? []).filter(row => row.scope !== 'post_return').reduce((sum, row) => sum + (row.type === 'addition' ? 1 : -1) * row.convertedAmount, 0)
        input.total = money(Math.max(0, input.subtotal - input.discount + input.tax + adjustment))
        input.paidAmount = input.isPaid ? input.total : input.initialPaymentAmount ?? 0
        input.balanceAmount = money(input.total - input.paidAmount)
        return input
    }
    async rpc(client: HostedClient, name: string, payload: Row) {
        const result = await client.rpc(name, payload)
        if (result.error) throw new Error(`hosted_rpc:${name}:${result.error.code}:${result.error.message}`)
        if (result.data?.conflict === true) throw new Error(`hosted_conflict:${name}:${result.data.conflict_reason}`)
        return result.data
    }
    async rawOrder(client: HostedClient, patch: Row) {
        const result = await client.schema('crm').from('sales_orders').update(patch).eq('id', this.order!.id).select('id').single()
        if (result.error || !result.data) throw new Error(`hosted_write_denied:${result.error?.code ?? 'zero_rows'}:${result.error?.message ?? ''}`)
        return result.data
    }
    async terminal() {
        await this.step('terminal independent database reconciliation', async () => undefined, { unchanged: true })
        await this.save()
    }
    async save(graphs?: { before: Graph; after: Graph }) {
        if (graphs) this.failureGraphs = graphs
        const root = join(process.cwd(), '.atlas-test-runs', process.env.ATLAS_LIVE_RUN_ID!, 'hosted', this.family.id)
        await mkdir(root, { recursive: true })
        await writeFile(join(root, `${this.fixture.tag.replace(/[^a-zA-Z0-9-]/g, '_')}.json`), JSON.stringify({
            caseId: this.family.id, name: this.family.name, path: this.family.path, integrity: this.family.integrity,
            seed: process.env.ATLAS_TEST_SEED, variant: this.variant, fixture: this.fixture.ids, evidence: this.evidence, ...this.failureGraphs
        }, null, 2))
        for (const evidence of this.evidence.slice(this.emittedEvidence)) process.stdout.write(`ATLAS_TEST_EVENT ${JSON.stringify({ type: 'evidence', evidence })}\n`)
        this.emittedEvidence = this.evidence.length
    }
}

/** Observe the transport only; no business result is fabricated by the test adapter. */
const scenarioContext = new AsyncLocalStorage<HostedScenario>()
let transportInstalled = false
function installTransport() {
    if (transportInstalled) return
    transportInstalled = true
    const symbol = Symbol.for('atlas.hosted.fetch')
    const previous = (globalThis as any)[symbol]
    ;(globalThis as any)[symbol] = async (input: RequestInfo | URL, init: RequestInit, actual: () => Promise<Response>) => {
        const scenario = scenarioContext.getStore()
        if (!scenario) return typeof previous === 'function' ? previous(input, init, actual) : actual()
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
        const method = init.method ?? (input instanceof Request ? input.method : 'GET')
        const event: RequestEvidence = { method, path: url.pathname }
        scenario.requests.push(event)
        if (method !== 'GET' && method !== 'HEAD' && typeof init.body === 'string') {
            try {
                const payload = JSON.parse(init.body)
                if (url.pathname.startsWith('/rest/v1/')) scenario.payloads.set(url.pathname, payload)
                const documents = Array.isArray(payload) ? payload : [payload.order ?? payload.payload?.order ?? payload]
                for (const document of documents) {
                    if (url.pathname.endsWith('/sales_orders') || url.pathname.endsWith('/complete_quick_sales_order')) if (document.id) scenario.scope.orderIds.add(document.id)
                    if (document.p_operation_id) scenario.scope.operationIds.add(document.p_operation_id)
                    if (document.source_type === 'sales_order' && document.source_record_id) scenario.scope.orderIds.add(document.source_record_id)
                }
            } catch { /* malformed payloads are observed through their actual server outcome */ }
        }
        const fault = scenario.fault
        const fire = method !== 'GET' && fault && url.pathname.endsWith(fault.path) && ++fault.seen === fault.occurrence
        if (fire && fault.mode === 'before') { event.fault = 'request-interrupted'; throw new TypeError('hosted_injected_network_failure_before_commit') }
        const response = await actual()
        event.status = response.status
        if (fire && fault.mode === 'after') { event.fault = 'response-lost'; throw new TypeError('hosted_injected_response_loss_after_commit') }
        return response
    }
}

export async function withScenario(family: Family, run: (scenario: HostedScenario) => Promise<void>, options: { currency?: CurrencyCode; stock?: number } = {}) {
    const observer = await freshObserver()
    return withLiveSaleOrderFixture(async fixture => {
        const scenario = new HostedScenario(family, fixture, observer)
        installTransport()
        await scenarioContext.run(scenario, async () => {
            try {
                await scenario.start(); await run(scenario); await scenario.terminal()
                const { deleteProduct } = await import('@/local-db/hooks')
                await scenario.step('retire owned main product with independent cleanup verification', () => deleteProduct(fixture.product.id), { paymentDelta: 0, check: (graph, before) => {
                    expect(graph.tables.products.find(row => row.id === fixture.product.id)?.is_deleted).toBe(true)
                    const owned = graph.tables.inventory.filter(row => row.product_id === fixture.product.id)
                    expect(owned.every(row => row.is_deleted && Number(row.quantity) === 0)).toBe(true)
                    const oldQuantity = sum(before.tables.inventory.filter(row => row.product_id === fixture.product.id), 'quantity')
                    expect(sum(graph.tables.inventory, 'quantity') - sum(before.tables.inventory, 'quantity')).toBeCloseTo(-oldQuantity, 6)
                    for (const table of ['orders', 'payments', 'returns', 'returnItems', 'loans', 'loanPayments', 'loanInstallments', 'commissions', 'productCommissions', 'accountMovements', 'accountBalances']) expect(canonical(graph.tables[table])).toBe(canonical(before.tables[table]))
                } })
            }
            finally { await scenario.save(); observer.auth.stopAutoRefresh() }
        })
    }, { stock: 100, ...options, retirePassedProduct: false })
}
