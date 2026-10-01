import { expect } from 'vitest'
import { executeMarketplaceOrderTransition } from '@/ui/components/ecommerce/MarketplaceOrderTransition'
import type { MarketplaceOrderStatus } from '@/ui/components/ecommerce/MarketplaceOrderTypes'
import { liveSupabase } from '../../liveSupabase'
import { liveWorkspaceId, requireLiveData } from '../../fixtures/saleOrdersLive'
import { HostedScenario, requireFixture } from './harness'
import { HostedBlocked, type Row } from './types'
import { readGraph } from './graph'

const stages: MarketplaceOrderStatus[] = ['pending', 'confirmed', 'processing', 'shipped', 'delivered']
const denied = { denied: true, unchanged: true }
export async function marketplace(s: HostedScenario) {
    const i = Number(s.family.id.slice(-2))
    // Storefront configuration and delivery identities are user-owned workspace setup, never guessed or edited by a test.
    const fixture = requireFixture(s.family.id)
    if (!fixture.marketplaceOrderId) throw new HostedBlocked(`${s.family.id} marketplaceOrderId fixture`)
    const orderId = fixture.marketplaceOrderId
    s.scope.marketplaceIds.add(orderId)
    const original = requireLiveData<Row>(await s.observer.from('marketplace_orders').select('*').eq('workspace_id', liveWorkspaceId).eq('id', orderId).single(), 'marketplace DEV TEST fixture')
    if (!/^DEV TEST\b/i.test(original.customer_notes ?? original.customer_name ?? '')) throw new Error('hosted_marketplace_fixture_identity_invalid')
    if (original.sales_order_id) s.scope.orderIds.add(original.sales_order_id)
    if (Array.isArray(original.items)) original.items.forEach((line: Row) => { if (line.product_id ?? line.productId) s.scope.productIds.add(line.product_id ?? line.productId) })
    s.baseline = await readGraph(s.observer, s.scope)
    const transition = async (target: MarketplaceOrderStatus, negative = false) => {
        await s.step(`marketplace ${target}`, async () => {
            const data = await executeMarketplaceOrderTransition({ rpc: liveSupabase.rpc.bind(liveSupabase) as any, orderId, nextStatus: target, cancelReason: target === 'cancelled' ? 'DEV TEST cancellation' : undefined })
            if (data?.sales_order_id) s.scope.orderIds.add(data.sales_order_id)
            const saved = requireLiveData<Row>(await s.observer.from('marketplace_orders').select('*').eq('id', orderId).single(), 'marketplace transition')
            expect(saved.status).toBe(target)
            if (saved.sales_order_id) s.scope.orderIds.add(saved.sales_order_id)
            return data
        }, negative ? denied : {})
    }
    if (i === 3) {
        for (const target of ['pending', 'bogus', ''] as MarketplaceOrderStatus[]) await transition(target, true)
        return
    }
    if (i === 5) { await transition('cancelled', true); return }
    if (i === 4) { await transition('cancelled'); return }
    if (i === 6 || i === 7) {
        const input = i === 7 ? [{ product_id: crypto.randomUUID(), quantity: -1 }] : fixture.items
        if (!input) throw new HostedBlocked('marketplace edited items fixture')
        await s.step('marketplace item-edit production RPC', () => s.rpc(liveSupabase, 'edit_marketplace_order_items', { order_id: orderId, items: input }), i === 7 ? denied : {})
        return
    }
    if (i === 14) {
        if (!fixture.placementRequest) throw new HostedBlocked('storefront placement payload fixture')
        const request = fixture.placementRequest as Row
        if (typeof request.functionName !== 'string' || !['place-inquiry-order', 'place-bound-storefront-order'].includes(request.functionName)) throw new Error('hosted_marketplace_function_not_allowlisted')
        const body = structuredClone(request.body)
        if (!body?.customer) throw new HostedBlocked('prepared storefront customer and item payload')
        body.customer.notes = `${s.fixture.tag} placement`
        if (request.functionName === 'place-inquiry-order') {
            const workspace = requireLiveData<Row>(await s.observer.from('workspaces').select('store_slug').eq('id', liveWorkspaceId).single(), 'test workspace storefront')
            if (workspace.store_slug !== body.store_slug) {
                const own = requireLiveData<Row[]>(await s.observer.from('workspace_storefronts').select('id').eq('workspace_id', liveWorkspaceId).eq('slug', body.store_slug), 'test storefront ownership')
                if (own.length !== 1) throw new HostedBlocked('placement storefront ownership cannot be verified in DEV TEST')
            }
        } else {
            const config = await s.observer.from('website_storefront_configs').select('workspace_id,is_enabled').eq('site_key', 'jumla-khaleej').maybeSingle()
            if (config.error || config.data?.workspace_id !== liveWorkspaceId || !config.data.is_enabled) throw new HostedBlocked('bound website storefront is not configured for DEV TEST')
        }
        await s.step('real storefront Edge Function contract', async () => {
            const result = await liveSupabase.functions.invoke(request.functionName, { body, headers: request.headers })
            if (result.error) throw result.error
            expect(result.data?.order_number).toEqual(expect.any(String))
            const saved = requireLiveData<Row>(await s.observer.from('marketplace_orders').select('*').eq('workspace_id', liveWorkspaceId).eq('order_number', result.data.order_number).single(), 'persisted placement order')
            expect(saved.customer_notes).toBe(body.customer.notes)
            if (result.data.id) expect(saved.id).toBe(result.data.id)
            expect(saved.status).toBe('pending')
            s.scope.marketplaceIds.add(saved.id)
            for (const item of saved.items) s.scope.productIds.add(item.product_id ?? item.productId)
        }, { check: graph => expect(graph.tables.marketplace.some(row => row.customer_notes === body.customer.notes)).toBe(true) }); return
    }
    if (i === 9) {
        await s.step('simultaneous delivery creates one CRM order', async () => {
            const outcomes = await Promise.allSettled([transition('delivered'), transition('delivered')])
            expect(outcomes.some(row => row.status === 'fulfilled')).toBe(true)
        }); return
    }
    if (i === 2) { await transition('delivered') }
    else for (const target of stages.slice(stages.indexOf(original.status) + 1)) await transition(target)
    if (i === 11 || i === 12) {
        const saved = requireLiveData<Row>(await s.observer.from('marketplace_orders').select('sales_order_id').eq('id', orderId).single(), 'delivered marketplace source')
        if (!saved.sales_order_id) throw new Error('hosted_marketplace_sales_order_missing')
        const { existingFixture } = await import('./security')
        await existingFixture(s, { orderId: saved.sales_order_id })
        if (i === 12) await s.pay(Number(fixture.collectionAmount ?? 50), 'ecommerce' as any)
        await s.returned(1)
    }
    if (i === 8 || i === 10 || i === 13) {
        const graph = await readGraph(s.observer, s.scope)
        const orders = graph.tables.orders.filter(row => row.marketplace_order_id === orderId)
        expect(orders).toHaveLength(1); expect(orders[0]).toMatchObject({ source_channel: 'marketplace', payment_method: 'ecommerce', status: 'completed' })
        if (i === 10) expect(orders[0].items.some((line: Row) => line.priceBookId === fixture.priceBookId)).toBe(true)
        if (i === 13) expect(graph.tables.assignments.some(row => row.assignment_source === 'marketplace_delivery_product' && row.agent_id === fixture.agentId)).toBe(true)
    }
    if (i === 15) {
        const saved = requireLiveData<Row>(await s.observer.from('marketplace_orders').select('status,inventory_deducted,sales_order_id').eq('id', orderId).single(), 'marketplace committed prefix')
        expect(saved.status).toBe(fixture.expectedStatus)
        expect(saved.inventory_deducted).toBe(fixture.expectedInventoryDeducted)
    }
}
