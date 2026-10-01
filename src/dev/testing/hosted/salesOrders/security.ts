import { createClient } from '@supabase/supabase-js'
import { expect } from 'vitest'
import { liveSupabase } from '../../liveSupabase'
import { liveWorkspaceId, requireLiveData } from '../../fixtures/saleOrdersLive'
import { assertGraph, canonical, readGraph } from './graph'
import { extendedConfig, HostedScenario, personaClient, requireFixture } from './harness'
import { HostedBlocked, type ExtendedConfig, type HostedClient, type Row } from './types'
import { completionPayload } from './flows'

const denied = { denied: true, unchanged: true }
const index = (s: HostedScenario) => Number(s.family.id.slice(-2))
export async function existingFixture(s: HostedScenario, fixture: NonNullable<ExtendedConfig['fixtures']>[string]) {
    if (!fixture.orderId) throw new HostedBlocked(`${s.family.id} orderId fixture`)
    const order = requireLiveData<Row>(await s.observer.schema('crm').from('sales_orders').select('*').eq('workspace_id', liveWorkspaceId).eq('id', fixture.orderId).single(), 'prepared test order')
    if (!/^DEV TEST\b/i.test(order.notes ?? '') || !Array.isArray(order.items)) throw new Error('hosted_fixture_identity_invalid')
    s.scope.orderIds.add(order.id)
    order.items.forEach((line: Row) => s.scope.productIds.add(line.productId))
    const { toCamelCase } = await import('@/lib/utils')
    const { db } = await import('@/local-db/database')
    s.order = toCamelCase(order) as any
    await db.sales_orders.put(s.order!)
    const { fetchTableFromSupabase } = await import('@/local-db/hooks')
    for (const table of ['products', 'inventory', 'stock_batches', 'loans', 'loan_payments', 'loan_installments', 'order_returns', 'order_return_items', 'payment_transactions'] as const) {
        if (!await fetchTableFromSupabase(table, db[table] as any, liveWorkspaceId, { force: true })) throw new Error(`hosted_fixture_hydration_failed:${table}`)
    }
    s.baseline = await readGraph(s.observer, s.scope)
}

async function deniedSurfaces(s: HostedScenario, client: HostedClient, readAllowed = false) {
    await s.create(s.input({ paid: true })); await s.status('pending')
    const g = await readGraph(s.observer, s.scope)
    await s.step('order update permission', () => s.rawOrder(client, { notes: `${s.fixture.tag} forbidden` }), denied)
    await s.step('order delete permission', async () => {
        const result = await client.schema('crm').from('sales_orders').delete().eq('id', s.order!.id).select('id').single()
        if (result.error || !result.data) throw new Error(result.error?.message ?? 'zero rows')
    }, denied)
    await s.step('completion RPC permission', () => s.rpc(client, 'complete_sales_order_with_inventory', completionPayload(s, g)), denied)
    await s.step('read visibility permission', async () => {
        const result = await client.schema('crm').from('sales_orders').select('id').eq('id', s.order!.id)
        if (readAllowed) { expect(result.error).toBeNull(); expect(result.data).toEqual([{ id: s.order!.id }]) }
        else expect(result.error || !result.data?.length).toBeTruthy()
    }, { unchanged: true })
}
export async function authentication(s: HostedScenario) {
    const i = index(s)
    if (i === 1) { await s.complete(); return }
    if (i === 11) {
        await s.create(s.input({ paid: true }), 'quick', 'completed')
        await s.step('refresh session and repeat exact checkout', async () => {
            const session = await liveSupabase.auth.refreshSession()
            if (session.error) throw new Error('hosted_refresh_failed')
            const payload = s.payloads.get('/rest/v1/rpc/complete_quick_sales_order')!
            await s.rpc(liveSupabase, 'complete_quick_sales_order', payload)
        }, { unchanged: true }); return
    }
    if (i === 9) {
        const staff = await personaClient('staff')
        try {
            const actor = (await staff.auth.getUser()).data.user?.id
            if (!actor) throw new Error('hosted_actor_fixture_invalid')
            await s.create()
            await s.step('existing foreign actor stamp rejected by hosted storage', () => s.rawOrder(liveSupabase, { created_by: actor }), denied)
        } finally { await staff.auth.signOut({ scope: 'local' }) }
        return
    }
    if ([7, 8, 10].includes(i)) {
        const f = requireFixture(s.family.id)
        const foreign = await personaClient('foreign-workspace')
        try {
            await s.create(s.input({ paid: true })); await s.status('pending')
            await s.step('cross-workspace order payload', () => s.rawOrder(foreign, { workspace_id: String(f.workspaceId), notes: `${s.fixture.tag} forged` }), denied)
            await s.step('foreign workspace completion payload', async () => s.rpc(foreign, 'complete_sales_order_with_inventory', { ...completionPayload(s, await readGraph(s.observer, s.scope)), p_workspace_id: String(f.workspaceId) }), denied)
        } finally { await foreign.auth.signOut({ scope: 'local' }) }
        return
    }
    if (i === 5) {
        const fixture = requireFixture(s.family.id)
        if (typeof fixture.expiredAccessToken !== 'string') throw new HostedBlocked('expired signed JWT fixture')
        const client = createClient(process.env.ATLAS_LIVE_SUPABASE_URL!, process.env.ATLAS_LIVE_SUPABASE_KEY!, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
            global: { fetch: globalThis.fetch.bind(globalThis), headers: { Authorization: `Bearer ${fixture.expiredAccessToken}` } }
        })
        await deniedSurfaces(s, client); return
    }
    const name = i === 2 ? 'staff' : i === 3 || i === 12 ? 'viewer' : i === 4 ? 'anonymous' : 'revoked-member'
    const client = await personaClient(name)
    try {
        if (i === 2) {
            await s.create(s.input({ paid: true })); await s.status('pending')
            await s.step('staff permitted atomic completion', async () => s.rpc(client, 'complete_sales_order_with_inventory', completionPayload(s, await readGraph(s.observer, s.scope))), { status: 'completed', stockDelta: -2 })
        } else await deniedSurfaces(s, client, name === 'viewer')
    } finally { if (name !== 'anonymous') await client.auth.signOut({ scope: 'local' }) }
}
export async function access(s: HostedScenario) {
    const i = index(s)
    const workspace = requireLiveData<Row>(await s.observer.from('workspaces').select('id,plan').eq('id', liveWorkspaceId).single(), 'entitlement workspace')
    if (i === 1 || i === 2 || i === 4 || i === 5 || i === 6 || i === 7 || i === 8) {
        const field = i === 4 ? 'quickOrder' : i === 8 ? 'freeBonus' : null
        const module = i === 5 ? 'loans' : i === 6 ? 'installments' : i === 7 ? 'services' : 'orders'
        const rpc = field ? 'workspace_capability_allowed' : 'workspace_module_allowed'
        const args = { p_workspace_id: liveWorkspaceId, p_plan: workspace.plan, ...(field ? { p_capability: field } : { p_module: module }) }
        const enabled = await s.rpc(s.observer, rpc, args)
        if (typeof enabled !== 'boolean') throw new Error('hosted_entitlement_contract_invalid')
        if (i === 2) {
            const fixture = requireFixture(s.family.id)
            if (fixture.expectedGrant !== true) throw new HostedBlocked('explicit admin grant fixture')
        }
        if ((i === 5 || i === 6) && enabled) throw new HostedBlocked(`${module} is enabled; feature-disabled target persona required`)
        if (i === 4 || i === 7 || i === 8) {
            const f = requireFixture(s.family.id)
            if (typeof f.expectedAllowed !== 'boolean') throw new HostedBlocked('all capability combinations require configured permission personas')
            expect(enabled).toBe(f.expectedAllowed)
        }
        if (!enabled) {
            await s.step('disabled module order path rejected', async () => {
                const orders = await import('@/local-db/orders')
                await orders.createSalesOrder(liveWorkspaceId, s.input({ method: i === 5 ? 'loan' : i === 6 ? 'installments' : 'cash', free: i === 8 ? 1 : 0 }), undefined, { requireRemoteConfirmation: true })
            }, denied)
        } else await s.complete()
        return
    }
    const name = i === 3 ? 'orders-disabled' : i === 9 ? 'own-only' : i === 10 ? 'storage-restricted' : i === 11 ? 'revoked-permission' : 'commission-restricted'
    const client = await personaClient(name)
    try { await deniedSurfaces(s, client) } finally { await client.auth.signOut({ scope: 'local' }) }
}

export async function remoteContracts(s: HostedScenario) {
    const i = index(s)
    await s.create(s.input({ paid: true })); await s.status('pending')
    const payload = completionPayload(s, await readGraph(s.observer, s.scope))
    if (i === 1 || i === 2) {
        for (const key of i === 1 ? Object.keys(payload) : ['p_items', 'p_changes']) {
            const broken: Row = { ...payload }
            if (i === 1) delete broken[key]
            else broken[key] = key === 'p_items' ? {} : null
            await s.step(`invalid completion argument ${key}`, () => s.rpc(liveSupabase, 'complete_sales_order_with_inventory', broken), denied)
        }
        return
    }
    if (i === 3) {
        for (const value of ['NaN', 'Infinity', 'abc', '', -1, null]) {
            const broken = structuredClone(payload); broken.p_changes[0].quantity = value as any
            await s.step(`invalid numerical representation ${String(value)}`, () => s.rpc(liveSupabase, 'complete_sales_order_with_inventory', broken), denied)
        }
        return
    }
    if (i === 4) { for (const status of ['bogus', '', null]) await s.step('unknown lifecycle enum', () => s.rawOrder(liveSupabase, { status }), denied); return }
    if (i === 5) {
        const f = requireFixture(s.family.id)
        if (typeof f.foreignCustomerId !== 'string' || typeof f.foreignPartnerId !== 'string') throw new HostedBlocked('existing cross-tenant customer fixture')
        const foreign = await personaClient('foreign-workspace')
        try {
            const otherWorkspace = extendedConfig().personas!['foreign-workspace'].workspaceId
            requireLiveData(await foreign.schema('crm').rpc('list_visible_customers', { p_workspace_id: otherWorkspace }).eq('id', f.foreignCustomerId).single(), 'foreign customer positive control')
            await s.step('existing cross-tenant/FK payload', () => s.rawOrder(liveSupabase, { customer_id: f.foreignCustomerId, business_partner_id: f.foreignPartnerId }), denied)
        } finally { await foreign.auth.signOut({ scope: 'local' }) }
        return
    }
    if (i === 6) {
        for (const patch of [{ total: 999 }, { paid_amount: 999 }, { balance_amount: -1 }, { items: [{ ...s.order!.items[0], fulfilledQuantity: 999 }] }]) await s.step('computed snapshot field tampering', () => s.rawOrder(liveSupabase, patch), denied)
        return
    }
    if (i === 7 || i === 12) {
        const viewer = await personaClient('viewer')
        try { await s.step('viewer direct hosted row update', () => s.rawOrder(viewer, { total: 999 }), denied) }
        finally { await viewer.auth.signOut({ scope: 'local' }) }
        return
    }
    if (i === 8) {
        const f = requireFixture(s.family.id)
        if (typeof f.agentId !== 'string' || typeof f.actorId !== 'string') throw new HostedBlocked('existing attribution and actor fixture')
        await s.step('forged existing commission attribution', () => s.rawOrder(liveSupabase, { sales_account_agent_id: f.agentId }), denied)
        await s.step('forged existing actor attribution', () => s.rawOrder(liveSupabase, { created_by: f.actorId }), denied)
        return
    }
    if (i === 9 || i === 10) {
        await s.status('completed'); await s.returned(1)
        const graph = await readGraph(s.observer, s.scope)
        if (i === 9) {
            await s.step('rewrite immutable return history denied', async () => {
                const result = await liveSupabase.from('order_return_items').update({ refund_amount: 999 }).eq('id', graph.tables.returnItems[0].id).select('id').single()
                if (result.error || !result.data) throw new Error(result.error?.message ?? 'zero rows')
            }, denied)
        } else {
            const reversal = graph.tables.payments.find(row => row.reversal_of_transaction_id)!
            await s.step('unlink reversal audit denied', async () => {
                const result = await liveSupabase.from('payment_transactions').update({ reversal_of_transaction_id: null }).eq('id', reversal.id).select('id').single()
                if (result.error || !result.data) throw new Error(result.error?.message ?? 'zero rows')
            }, denied)
        }
        return
    }
    if (i === 11) {
        s.fault = { path: '/rpc/complete_sales_order_with_inventory', occurrence: 1, seen: 0, mode: 'after' }
        await s.step('lost result envelope requires independent commit discovery', () => s.rpc(liveSupabase, 'complete_sales_order_with_inventory', payload), { denied: true, status: 'completed', stockDelta: -2 })
        s.fault = null; return
    }
    if (i === 13) {
        for (const [schema, table, columns] of [['crm', 'sales_orders', 'id,is_archived,approval_status,items,order_adjustments'], ['public', 'order_return_items', 'id,unit_factor,paid_inventory_quantity,free_inventory_quantity'], ['payment_accounts', 'account_movements', 'id,payment_transaction_id,delta_amount']]) {
            const result = await s.observer.schema(schema).from(table).select(columns).limit(0)
            expect(result.error).toBeNull()
        }
        return
    }
    const { executeMarketplaceOrderTransition } = await import('@/ui/components/ecommerce/MarketplaceOrderTransition')
    await s.step('production error normalization receives actual Supabase error', async () => {
        try { await executeMarketplaceOrderTransition({ rpc: liveSupabase.rpc.bind(liveSupabase) as any, orderId: crypto.randomUUID(), nextStatus: 'delivered' }) }
        catch (error) { expect(error).toBeInstanceOf(Error); expect((error as Error).message.length).toBeGreaterThan(0); throw error }
    }, denied)
}

export async function historical(s: HostedScenario) {
    const i = index(s)
    if (i === 12) {
        await s.complete()
        await s.step('assertion never repairs hosted data', async () => { const graph = await readGraph(s.observer, s.scope); assertGraph(graph) }, { unchanged: true })
        expect(s.requests.filter(request => request.path.startsWith('/rest/v1/') && !['GET', 'HEAD'].includes(request.method)).length).toBeGreaterThan(0)
        return
    }
    const fixture = requireFixture(s.family.id)
    s.auditOnly = true
    await existingFixture(s, fixture)
    const graph = await readGraph(s.observer, s.scope)
    const before = canonical(graph)
    if (i <= 4) {
        const { runSalesOrderIntegrityAudit } = await import('@/lib/integrityAudit/salesOrderAudit')
        const audit = await runSalesOrderIntegrityAudit(liveWorkspaceId, s.order!.id, 'cloud')
        expect(audit.checks.length).toBeGreaterThan(0)
        if (i === 4) {
            const returnIds = new Set(graph.tables.returns.filter(row => row.order_id === s.order!.id && row.status === 'posted').map(row => row.id))
            expect(returnIds.size).toBeGreaterThan(0)
            expect(graph.tables.movements.some(row => returnIds.has(row.reference_id)
                && ['sales_order_return', 'order_return'].includes(row.reference_type))).toBe(true)
            expect(s.order!.items.some(item => !Object.prototype.hasOwnProperty.call(item, 'returnedQuantity'))).toBe(true)
            expect(audit.checks.filter(row => ['WRONG_INVENTORY_REFERENCE', 'ITEM_RETURNED_QUANTITY_MISMATCH'].includes(row.code)
                && row.status === 'FAIL')).toEqual([])
        }
    } else {
        const pattern = i === 5 ? /commercial-arithmetic|unit-quantities/ : i === 6 ? /no-orphans|financing|payment/ : i === 7 ? /return-links/ : i === 8 ? /identity|commission|financing/ : i === 9 ? /movement-history/ : i === 10 ? /account-effects/ : /commercial-arithmetic|order-money/
        expect(() => assertGraph(graph), 'corruption must be detected').toThrow(pattern)
    }
    expect(canonical(await readGraph(s.observer, s.scope))).toBe(before)
}

export async function privateReceiptWitness(s: HostedScenario) {
    const observer = extendedConfig().observer
    if (!observer) throw new HostedBlocked('read-only private receipt observer is not configured')
    const url = new URL(observer.url)
    if (url.origin !== new URL(process.env.ATLAS_LIVE_SUPABASE_URL!).origin || !url.pathname.startsWith('/functions/v1/')) throw new Error('hosted_observer_origin_invalid')
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${observer.bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: liveWorkspaceId, operationIds: [...s.scope.operationIds] }) })
    if (!response.ok) throw new Error('hosted_private_observer_failed')
    const data = await response.json()
    expect(data.readOnly).toBe(true)
    expect(data.workspaceId).toBe(liveWorkspaceId)
    expect(Array.isArray(data.receipts)).toBe(true)
    expect(data.receipts.length).toBe(s.scope.operationIds.size)
    expect(data.receipts.map((receipt: Row) => receipt.operation_id).sort()).toEqual([...s.scope.operationIds].sort())
    for (const receipt of data.receipts) {
        expect(receipt.workspace_id).toBe(liveWorkspaceId)
        expect(receipt.payload_hash).toMatch(/^[a-f0-9]{64}$/i)
    }
}
