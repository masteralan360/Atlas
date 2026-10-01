import { expect } from 'vitest'
import type { CurrencyCode } from '@/local-db/models'
import { STANDARD_PAYMENT_METHODS } from '@/lib/paymentMethods'
import { liveSupabase } from '../../liveSupabase'
import { liveWorkspaceId, requireLiveData } from '../../fixtures/saleOrdersLive'
import { active, canonical, readGraph } from './graph'
import { HostedScenario, requireFixture, type Input } from './harness'
import { HostedBlocked, type Row } from './types'

import { CURRENCIES, type QuickTuple } from './matrix'
export { CURRENCIES, quickTuples } from './matrix'
export type { QuickTuple } from './matrix'
const denied = { denied: true, unchanged: true }
function ordinal(s: HostedScenario) { return Number(s.family.id.slice(-2)) }
async function invalidCreate(s: HostedScenario, patch: Row) {
    const orders = await import('@/local-db/orders')
    await s.step('invalid order save has no hosted effects', () => orders.createSalesOrder(liveWorkspaceId, { ...s.input(), ...patch } as Input, undefined, { requireRemoteConfirmation: true }), denied)
}
export async function uom(s: HostedScenario, factor = 20) {
    const { replaceProductUoms } = await import('@/local-db/productUoms')
    const rows = await replaceProductUoms(liveWorkspaceId, s.fixture.product.id, [
        { unitRef: 'builtin:pcs', unitCode: 'pcs', coefficient: 1, isBase: true, isActive: true, isDefaultSelling: false, sellingPrice: 100, costPrice: 40, minimumSellingPrice: null },
        { unitRef: 'builtin:carton', unitCode: 'carton', coefficient: factor, isBase: false, isActive: true, isDefaultSelling: true, sellingPrice: 100, costPrice: 40, minimumSellingPrice: 35 }
    ])
    const carton = rows.find(row => row.unitCode === 'carton')!
    if (!carton) throw new Error('hosted_uom_fixture_missing')
    return carton
}
function withUnit(input: Input, unit: Awaited<ReturnType<typeof uom>>) {
    input.items[0] = { ...input.items[0], uomId: unit.id, uomNameSnapshot: unit.unitCode, unit: unit.unitCode, unitRef: unit.unitRef,
        unitNameSnapshot: unit.unitCode, unitFactor: unit.coefficient, inventoryQuantity: input.items[0].quantity * unit.coefficient,
        freeBonusInventoryQuantity: Number(input.items[0].freeBonusQuantity ?? 0) * unit.coefficient,
        uomCostPrice: 40, convertedUomCostPrice: 40, minimumSellingPriceSnapshot: 35 }
    return input
}
export async function customerChoices(s: HostedScenario) {
    const i = ordinal(s)
    const partners = await import('@/local-db/businessPartners')
    if ([6, 7, 8, 9, 10, 12].includes(i)) {
        const fixture = requireFixture(s.family.id)
        if (i === 7) return invalidCreate(s, { customerId: fixture.foreignCustomerId, businessPartnerId: fixture.foreignPartnerId })
        if (i === 6) {
            await s.create({ ...s.input(), customerId: String(fixture.mergedPartnerId), businessPartnerId: String(fixture.mergedPartnerId) })
            await s.step('merged source resolves to configured canonical customer', async () => undefined, { unchanged: true, check: graph => expect(graph.tables.orders[0].business_partner_id).toBe(fixture.canonicalPartnerId) })
            return
        }
        if ([8, 9, 10].includes(i)) {
            const input = { ...s.input(), salesAccountAgentId: String(fixture.agentId) }
            if (i === 9) return invalidCreate(s, input)
            await s.create(input)
            if (i === 10) await s.edit({ salesAccountAgentId: null })
            await s.step('sales-account financial attribution', async () => undefined, { unchanged: true, check: graph => expect(graph.tables.orders[0].sales_account_agent_id).toBe(i === 10 ? null : fixture.agentId) })
            return
        }
        const limit = Number(fixture.creditLimit)
        if (!Number.isFinite(limit)) throw new HostedBlocked(`${s.family.id} credit limit fixture`)
        for (const amount of [limit - 0.001, limit, limit + 0.001]) {
            if (amount <= 0) continue
            const orders = await import('@/local-db/orders')
            const input = { ...s.input({ price: amount, quantity: 1 }), customerId: String(fixture.partnerId), businessPartnerId: String(fixture.partnerId) }
            await s.step(`obligation ${amount} against credit limit ${limit}`, () => orders.createSalesOrder(liveWorkspaceId, input, undefined, { requireRemoteConfirmation: true }), amount > limit ? denied : {})
        }
        return
    }
    if (i === 4) return invalidCreate(s, { customerId: '', businessPartnerId: null, customerName: '' })
    if (i === 5) {
        await partners.deleteBusinessPartner(s.fixture.partner.id)
        return invalidCreate(s, { customerId: s.fixture.partner.id, businessPartnerId: s.fixture.partner.id })
    }
    await s.create()
    if (i === 3) {
        const replacement = await partners.createBusinessPartner(liveWorkspaceId, { partnerName: `${s.fixture.tag} replacement`, phone: '', defaultCurrency: 'usd', creditLimit: 0, role: 'customer' })
        s.scope.partnerIds.add(replacement.id)
        await s.edit({ businessPartnerId: replacement.id, customerId: replacement.id, customerName: replacement.partnerName }, { check: graph => expect(graph.tables.orders[0].business_partner_id).toBe(replacement.id) })
    } else if (i === 11) {
        await partners.updateBusinessPartner(s.fixture.partner.id, { partnerName: `${s.fixture.tag} renamed` })
        await s.step('historical customer name stays saved', async () => undefined, { unchanged: true, check: graph => expect(graph.tables.orders[0].customer_name).toBe(s.fixture.partner.partnerName) })
    } else {
        await s.step('linked customer facet persisted', async () => undefined, { unchanged: true, check: graph => {
            expect(graph.tables.orders[0].business_partner_id).toBe(s.fixture.partner.id)
            expect(graph.tables.orders[0].customer_id).toBe(s.fixture.partner.customerFacetId)
        } })
    }
}
export async function lineChoices(s: HostedScenario) {
    const i = ordinal(s)
    const input = s.input({ paid: true })
    if (i === 9) {
        for (const items of [[], null, {}, [null]]) await invalidCreate(s, { items })
        return
    }
    if (i === 10) { input.items.push({ ...input.items[0] }); s.recalc(input); return invalidCreate(s, input) }
    if ([2, 4, 7].includes(i)) input.items.push(s.line(await s.extraProduct(i === 7)))
    if (i === 3) input.items.push({ ...input.items[0], id: crypto.randomUUID(), convertedUnitPrice: 70, originalUnitPrice: 70, lineTotal: 140, note: 'second price' })
    if (i === 4) {
        const hooks = await import('@/local-db/hooks')
        const storage = await hooks.createStorage(liveWorkspaceId, { name: `${s.fixture.tag} second storage` })
        const product = await hooks.createProduct(liveWorkspaceId, { ...s.fixture.product, storageId: storage.id, storageName: storage.name, sku: `DT-${crypto.randomUUID().slice(0, 12)}`, name: `${s.fixture.tag} storage product`, quantity: 100 })
        s.scope.productIds.add(product.id)
        input.items[1] = { ...s.line(product), storageId: storage.id }
        s.baseline = await readGraph(s.observer, s.scope)
    }
    if (i === 5 || i === 6) {
        if (process.env.ATLAS_LIVE_SERVICES_ENABLED !== 'true') throw new HostedBlocked('services capability unavailable')
        input.items = [s.line(await s.extraProduct(true), 1.5)]
        if (i === 6) input.items.push(s.line(await s.extraProduct(true), 2.5, 30))
    }
    if (i === 8) input.items[0].note = 'کوردی / العربية / emoji 📦\nline two'
    s.recalc(input)
    if (i === 11) {
        await s.create(input)
        const hooks = await import('@/local-db/hooks')
        await hooks.deleteProduct(s.fixture.product.id)
        await s.status('pending', denied)
        return
    }
    await s.complete(input)
    if (i === 12) {
        const hooks = await import('@/local-db/hooks')
        await hooks.updateProduct(s.fixture.product.id, { name: `${s.fixture.tag} renamed product`, sku: `DT-${crypto.randomUUID().slice(0, 12)}` })
    }
    await s.step('line snapshot and service exclusion', async () => undefined, { unchanged: true, check: graph => {
        const saved = graph.tables.orders[0]
        expect(saved.items.map((line: Row) => [line.id, line.productName, line.productSku, line.note ?? null])).toEqual(input.items.map(line => [line.id, line.productName, line.productSku, line.note ?? null]))
        for (const product of graph.tables.products.filter(row => row.is_service)) expect(graph.tables.movements.filter(row => row.product_id === product.id)).toHaveLength(0)
    } })
}
export async function unitChoices(s: HostedScenario) {
    const i = ordinal(s)
    if (i === 3) {
        const fixture = requireFixture(s.family.id)
        const unitId = String(fixture.customUnitId)
        const result = await liveSupabase.from('units').select('*').eq('workspace_id', liveWorkspaceId).eq('id', unitId).single()
        requireLiveData(result, 'custom unit fixture')
        const input = s.input({ paid: true })
        input.items[0].unitRef = `custom:${unitId}`
        input.items[0].unitNameSnapshot = String(fixture.unitName)
        await s.complete(input); await s.returned(); return
    }
    if (i === 5) { const input = s.input({ quantity: 0.5 }); await invalidCreate(s, input); return }
    if (i === 12) {
        for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) await invalidCreate(s, s.input({ factor }))
        for (const count of [-0.000001, 0]) await invalidCreate(s, s.input({ quantity: count }))
        return
    }
    let input = s.input({ paid: true, quantity: i === 7 ? 0 : i === 4 ? 1.234567 : 2, free: [6, 7, 8, 9, 13, 14].includes(i) ? 1 : 0 })
    const selected = [2, 10, 11, 13, 14].includes(i) ? await uom(s) : null
    if (selected) input = withUnit(input, selected)
    if (i === 4) input.items[0].unit = 'kg'
    if (i === 8) input.items.push({ ...s.input({ paid: true, quantity: 0, free: 1 }).items[0], id: crypto.randomUUID() })
    if (i === 9) input.items[0].freeBonusUnit = 'carton'
    s.recalc(input)
    if (i === 14) await s.create(input, 'quick', 'completed')
    else await s.complete(input)
    if (i === 10 && selected) {
        const { replaceProductUoms } = await import('@/local-db/productUoms')
        await replaceProductUoms(liveWorkspaceId, s.fixture.product.id, [
            { unitRef: 'builtin:pcs', unitCode: 'pcs', coefficient: 1, isBase: true, isActive: true, isDefaultSelling: true, sellingPrice: 100, costPrice: 40, minimumSellingPrice: null },
            { unitRef: 'builtin:carton', unitCode: 'carton', coefficient: 10, isBase: false, isActive: true, isDefaultSelling: false, sellingPrice: 100, costPrice: 40, minimumSellingPrice: null }
        ])
    }
    if (i === 11 && selected) {
        const result = await liveSupabase.from('product_uoms').update({ is_active: false }).eq('workspace_id', liveWorkspaceId).eq('id', selected.id)
        if (result.error) throw result.error
    }
    if (i === 13) { await s.returned(1, 0); await s.returned(0, 1); await s.returned(1, 0) }
    else if ([1, 2, 4, 6, 7, 9, 10, 11].includes(i)) await s.returned(input.items[0].quantity, Number(input.items[0].freeBonusQuantity ?? 0))
    await s.step('selected-unit and original inventory coefficient persist', async () => undefined, { unchanged: true, check: graph => expect(graph.tables.orders[0].items[0].unitFactor).toBe(input.items[0].unitFactor) })
}

export async function priceChoices(s: HostedScenario) {
    const i = ordinal(s)
    if ([8, 10].includes(i)) {
        const { personaClient } = await import('./harness')
        const staff = await personaClient('staff')
        const selected = await uom(s)
        try {
            if (i === 10) {
                await s.create(withUnit(s.input({ paid: true, price: 40 }), selected))
                const changed = await liveSupabase.from('product_uoms').update({ minimum_selling_price: 45 }).eq('workspace_id', liveWorkspaceId).eq('id', selected.id).select('minimum_selling_price').single()
                expect(requireLiveData<Row>(changed, 'changed hosted selling floor').minimum_selling_price).toBe(45)
                await s.step('saved staff selection revalidated against increased server minimum', async () => {
                    const violations = await s.rpc(staff, 'validate_staff_minimum_selling_prices', { p_workspace_id: liveWorkspaceId, p_items: [{ product_id: s.fixture.product.id, selling_uom_id: selected.id, unit_factor: 20, effective_selling_price: 40, currency: 'usd' }] })
                    expect(violations).toHaveLength(1)
                    expect(violations[0]).toMatchObject({ product_id: s.fixture.product.id, minimum_selling_price: 45 })
                }, { unchanged: true })
                return
            }
            for (const price of [34.999, 35, 35.001]) {
                await s.step(`staff unit floor ${price}`, async () => {
                    const data = await s.rpc(staff, 'validate_staff_minimum_selling_prices', { p_workspace_id: liveWorkspaceId, p_items: [{ product_id: s.fixture.product.id, selling_uom_id: selected.id, unit_factor: 20, effective_selling_price: price, currency: 'usd' }] })
                    expect(Array.isArray(data)).toBe(true)
                    expect(data).toHaveLength(price < 35 ? 1 : 0)
                    if (price < 35) expect(data[0]).toMatchObject({ line_index: 0, product_id: s.fixture.product.id, minimum_selling_price: 35 })
                }, { unchanged: true })
            }
        } finally { await staff.auth.signOut({ scope: 'local' }) }
        return
    }
    if (i === 6) {
        const hooks = await import('@/local-db/hooks')
        for (const cost of [null, 0, -1]) {
            await hooks.updateProduct(s.fixture.product.id, { costPrice: cost as any })
            await invalidCreate(s, s.input())
        }
        return
    }
    if (i === 7) {
        const input = s.input({ paid: true }); input.items = [s.line(await s.extraProduct(true))]; s.recalc(input); await s.complete(input); return
    }
    if ([2, 3, 4, 5, 11, 12].includes(i)) {
        const books = await import('@/local-db/priceBooks')
        const book = await books.createPriceBook(liveWorkspaceId, { name: `${s.fixture.tag} price book` })
        const entries = await books.replaceProductPriceBookItems(liveWorkspaceId, s.fixture.product.id, [{ priceBookId: book.id, costPrice: i === 5 ? null : 20, price: 80, currency: i === 12 ? 'eur' : 'usd' }])
        const input = s.input({ paid: true, price: i === 4 ? 100 : 80 })
        if (i !== 4) input.items[0] = { ...input.items[0], priceBookId: book.id, priceBookItemId: entries[0].id,
            costPrice: i === 5 ? 0 : 20, convertedCostPrice: i === 5 ? 0 : 20 }
        if (i === 3) { const selected = await uom(s); withUnit(input, selected); input.items[0].uomCostPrice = input.items[0].convertedUomCostPrice = 20 }
        if (i === 5) { await invalidCreate(s, input); return }
        if (i === 12) {
            input.items[0].originalCurrency = 'eur'; input.items[0].originalUnitPrice = 40
            input.exchangeRates = [rate('eur', 'usd', 2)] as any
        }
        await s.create(input)
        if (i === 11) await books.hardDeletePriceBook(book.id)
        await s.status('pending'); await s.status('completed')
        await s.step('price-book provenance and saved price', async () => undefined, { unchanged: true, check: graph => expect(graph.tables.orders[0].items[0].convertedUnitPrice).toBe(input.items[0].convertedUnitPrice) })
        return
    }
    const input = s.input({ paid: true, price: i === 9 ? 10 : i === 13 ? 39 : 100 })
    if (i === 14) {
        await s.create(input)
        const hooks = await import('@/local-db/hooks')
        await hooks.updateProduct(s.fixture.product.id, { price: 150 })
        await s.status('pending'); await s.status('completed')
    } else await s.complete(input)
    await s.step('saved commercial/cost prices are exact', async () => undefined, { unchanged: true, check: graph => {
        expect(graph.tables.orders[0].items[0].convertedUnitPrice).toBe(input.items[0].convertedUnitPrice)
        expect(graph.tables.orders[0].items[0].convertedCostPrice).toBe(input.items[0].convertedCostPrice)
    } })
}
export function rate(from: CurrencyCode, to: CurrencyCode, value = 2) {
    const supported = new Set(['USD/IQD', 'USD/EUR', 'EUR/IQD', 'USD/TRY', 'TRY/IQD'])
    const direct = `${from.toUpperCase()}/${to.toUpperCase()}`
    const inverse = `${to.toUpperCase()}/${from.toUpperCase()}`
    return { pair: supported.has(inverse) ? inverse : direct, rate: supported.has(inverse) ? 1 / value : value,
        priceBasisAmount: 1, source: 'hosted-contract-fixture', timestamp: new Date().toISOString() }
}
const currencyValue: Record<CurrencyCode, number> = { usd: 1, eur: 2, iqd: 0.5, try: 0.5 }
export const historicalFactor = (from: CurrencyCode, to: CurrencyCode) => currencyValue[from] / currencyValue[to]
export const historicalRates = () => [rate('usd', 'iqd', 2), rate('usd', 'eur', 0.5), rate('eur', 'iqd', 4), rate('usd', 'try', 2), rate('try', 'iqd', 1)]
export async function currencyChoices(s: HostedScenario) {
    const i = ordinal(s)
    if (i === 9 || i === 12) {
        const f = requireFixture(s.family.id)
        const input = s.input({ paid: true, currency: String(f.currency) as CurrencyCode })
        input.initialPaymentAccountId = String(f.accountId)
        return invalidCreate(s, input)
    }
    const pairs = s.variant ? [[s.variant.from, s.variant.to]] : i === 1 ? CURRENCIES.map(currency => [currency, currency]) : i === 2 || i === 4 ? CURRENCIES.flatMap(from => CURRENCIES.map(to => [from, to])) : [['eur', 'usd']]
    for (const pair of pairs) {
        const [from, to] = pair as [CurrencyCode, CurrencyCode]
        const input = s.input({ currency: to, paid: true, price: i === 11 ? 0.0005 : 100 })
        input.items[0].originalCurrency = from
        const conversion = currencyValue[from] / currencyValue[to]
        input.items[0].originalUnitPrice = input.items[0].convertedUnitPrice / conversion
        input.exchangeRates = from === to ? [] : historicalRates()
        if (i === 7) input.exchangeRates = input.exchangeRates.map(snapshot => ({ ...snapshot, source: s.variant?.source ?? 'manual', ...(s.variant?.side && s.variant.side !== 'mid' ? { side: s.variant.side } : {}), timestamp: '2026-01-01T12:00:00.000Z' }))
        if (i === 5) { input.exchangeRates = []; await invalidCreate(s, input); continue }
        if (i === 6) {
            for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) await invalidCreate(s, { ...input, exchangeRates: [rate(from, to, value)] })
            continue
        }
        if (i === 3) {
            input.items.push(s.line(await s.extraProduct(false, 'try')))
            input.items[1].originalCurrency = 'try'; input.items[1].originalUnitPrice = 100
            input.exchangeRates = historicalRates(); s.recalc(input)
        }
        if (i === 10) input.orderAdjustments = [{ id: crypto.randomUUID(), type: 'addition', name: 'currency adjustment', currency: from, amount: 5, orderCurrency: to, convertedAmount: 10, exchangeRate: 2, exchangeRateSource: 'hosted-contract-fixture', exchangeRateTimestamp: new Date().toISOString(), exchangeRates: input.exchangeRates ?? [] }]
        s.recalc(input)
        if (i === 4) {
            const original = s.input({ currency: from })
            original.items[0].originalCurrency = from
            original.items[0].originalUnitPrice = original.items[0].convertedUnitPrice
            await s.create(original)
            await s.edit({ ...input, isPaid: false, paymentStatus: 'unpaid', paidAmount: 0, balanceAmount: input.total }, { total: input.total })
        } else await s.create(input, 'quick', 'completed')
        const snapshots = canonical(input.exchangeRates)
        if (i === 8) {
            const original = s.order!
            const newer = s.input({ paid: true })
            newer.items[0].originalCurrency = 'eur'; newer.items[0].originalUnitPrice = 100 / 3
            newer.exchangeRates = historicalRates().map(snapshot => ({ ...snapshot, rate: snapshot.pair === 'USD/EUR' ? 1 / 3 : snapshot.rate }))
            await s.create(newer, 'quick', 'completed')
            s.order = original
        }
        await s.step('historical currency conversion evidence', async () => undefined, { unchanged: true, check: graph => {
            const order = graph.tables.orders.find(row => row.id === s.order!.id)!
            expect(order.currency).toBe(to); expect(canonical(order.exchange_rates)).toBe(snapshots)
            expect(order.items[0].originalCurrency).toBe(from)
        } })
        if (s.order!.status === 'completed') await s.returned()
    }
}
export async function totalsChoices(s: HostedScenario) {
    const i = ordinal(s)
    const values = s.variant ? [s.variant.value] : i === 2 || i === 3 ? [0, 0.001, 50, 199.999, 200, 200.001] : [10]
    for (const value of values) {
        const input = s.input({ paid: true, quantity: i === 11 ? 2.5 : 2, price: i === 11 ? 10.125 : 100 })
        if (i === 2) input.discount = value
        if (i === 3) input.tax = value
        if ([4, 5, 6, 7, 8, 9].includes(i)) {
            input.orderAdjustments = [{ id: crypto.randomUUID(), type: i === 5 ? 'deduction' : 'addition', name: i === 9 ? '' : 'Delivery charge', currency: 'usd', amount: value, orderCurrency: 'usd', convertedAmount: value, exchangeRate: 1, exchangeRateSource: 'identity', exchangeRateTimestamp: new Date().toISOString(), exchangeRates: [] }]
            if (i === 6) input.orderAdjustments.push({ ...input.orderAdjustments[0], id: crypto.randomUUID(), name: 'Discount', type: 'deduction', amount: 3, convertedAmount: 3 })
            if (i === 7) { input.orderAdjustments[0].currency = 'eur'; input.orderAdjustments[0].exchangeRate = 2; input.orderAdjustments[0].convertedAmount = 20; input.exchangeRates = [rate('eur', 'usd')] as any }
        }
        if (i === 10) input.discount = input.subtotal
        s.recalc(input)
        if (i === 9) { await invalidCreate(s, input); continue }
        if (i === 12) {
            await invalidCreate(s, { ...input, total: 1, paidAmount: 1, items: [{ ...input.items[0], lineTotal: 999 }] }); continue
        }
        if (i === 8) {
            await s.create({ ...input, isPaid: false, paidAmount: 0, paymentStatus: 'unpaid', balanceAmount: input.total })
            await s.edit({ orderAdjustments: [], total: 200, paidAmount: 0, balanceAmount: 200 }, { total: 200 }); continue
        }
        await s.create(input, 'quick', 'completed')
        if (i === 13) await s.edit({ notes: 'cannot edit posted order' }, denied)
        if (i === 14) { await s.returned(1); await s.returned(1) }
        else if (s.order!.total > 0) await s.returned()
    }
}

export async function creationChoices(s: HostedScenario) {
    const i = ordinal(s)
    const orders = await import('@/local-db/orders')
    if (i === 10) {
        const count = Math.max(4, Number(process.env.ATLAS_TEST_SAMPLES ?? 16))
        await s.step('concurrent real hosted draft creations', async () => {
            const created = await Promise.all(Array.from({ length: count }, () => orders.createSalesOrder(liveWorkspaceId, s.input(), undefined, { requireRemoteConfirmation: true })))
            for (const row of created) s.scope.orderIds.add(row.id)
            s.order = created.at(-1)!
        }, { paymentDelta: 0, stockDelta: 0, check: graph => {
            expect(graph.tables.orders).toHaveLength(count)
            expect(new Set(graph.tables.orders.map(row => row.order_number)).size).toBe(count)
        } })
        return
    }
    if (i === 11) {
        const fixture = requireFixture(s.family.id)
        await s.create({ ...s.input(), createdAt: String(fixture.createdAt) } as Input)
        await s.step('numbering follows configured year/date boundary', async () => undefined, { unchanged: true, check: graph => expect(graph.tables.orders[0].order_number).toMatch(String(fixture.numberPrefix)) }); return
    }
    const input = s.input({ method: i === 3 ? 'loan' : i === 4 || i === 13 ? 'installments' : 'cash', paid: i === 2, initial: i === 3 || i === 4 || i === 13 ? 25 : 0 })
    if (i === 12) {
        s.fault = { path: '/sales_orders', occurrence: 1, seen: 0, mode: 'before' }
        await s.step('interrupted real multi-write save', () => orders.createSalesOrder(liveWorkspaceId, { ...s.input({ paid: true }) }, undefined, { requireRemoteConfirmation: true }), { denied: true })
        s.fault = null; return
    }
    await s.create(input)
    if (i === 5) {
        const patch = s.input({ quantity: 3, price: 90 })
        await s.edit({ ...patch, shippingAddress: 'بغداد / هەولێر', notes: `${s.fixture.tag} changed`, expectedDeliveryDate: new Date(Date.now() + 7 * 86400000).toISOString() }, { total: 270 })
    } else if (i === 6) {
        for (const method of [...STANDARD_PAYMENT_METHODS, 'loan', 'installments'] as const) await s.edit(s.input({ method }))
    } else if (i === 7) {
        await s.status('pending', denied)
        await s.edit({ status: 'completed' }, denied)
    } else if (i === 8 || i === 9) {
        const before = await readGraph(s.observer, s.scope)
        const row = before.tables.orders[0]
        const replay = i === 9 ? { ...row, total: 999 } : row
        await s.step('save same order identity again', async () => {
            const result = await liveSupabase.schema('crm').from('sales_orders').upsert(replay).select('id').single()
            if (result.error) throw result.error
        }, i === 9 ? denied : { unchanged: true })
    } else if (i === 13) {
        await s.step('down payment is posted while order remains draft', async () => undefined, { unchanged: true, check: graph => {
            expect(graph.tables.orders[0].status).toBe('draft')
            expect(active(graph.tables.payments).some(row => row.source_record_id === s.order!.id && Number(row.amount) === 25)).toBe(true)
        } })
        // Down payments are explicitly editable; their already posted money must survive that edit.
        await s.edit({ items: s.input({ quantity: 3 }).items, subtotal: 300, total: 300, balanceAmount: 275 }, { paid: 25, check: (graph, before) => {
            expect(canonical(graph.tables.payments)).toBe(canonical(before.tables.payments))
            expect(Number(graph.tables.orders.find(row => row.id === s.order!.id)!.balance_amount)).toBe(275)
        } })
        await s.create(s.input())
        await s.pay(25)
        await s.edit({ items: s.input({ quantity: 3 }).items, subtotal: 300, total: 300, balanceAmount: 275 }, denied)
    } else if (i === 14) {
        await s.edit({ notes: `${s.fixture.tag} populated`, shippingAddress: 'address', expectedDeliveryDate: new Date().toISOString() })
        await s.edit({ notes: s.fixture.tag, shippingAddress: '', expectedDeliveryDate: null }, { check: graph => expect(graph.tables.orders[0]).toMatchObject({ shipping_address: '', expected_delivery_date: null }) })
    }
}

export async function quickChoice(s: HostedScenario, tuple?: QuickTuple) {
    const i = ordinal(s)
    if (i === 12) {
        const orders = await import('@/local-db/orders')
        for (const target of ['cancelled', 'returned', 'bogus']) await s.step(`invalid Quick target ${target}`, () => orders.createQuickSalesOrder(liveWorkspaceId, { ...s.input(), status: target } as any), denied)
        for (const method of ['bogus', '', 'credit', 'ecommerce']) await s.step(`invalid Quick method ${method}`, () => orders.createQuickSalesOrder(liveWorkspaceId, { ...s.input({ paid: true }), paymentMethod: method, status: 'completed' } as any), denied)
        return
    }
    if (i === 13) {
        const { atomicReplay } = await import('./flows'); await atomicReplay(s, 'quick', false); return
    }
    if (i === 14) { const { commissionCheckout } = await import('./commissions'); await commissionCheckout(s); return }
    if (!tuple) throw new Error('hosted_quick_tuple_missing')
    s.variant = { ...tuple }
    let input = s.input({ method: tuple.method, currency: tuple.currency, paid: tuple.paid, initial: tuple.initial, approval: tuple.approval, quantity: tuple.lines === 'free' ? 0 : 2, free: tuple.lines === 'free' ? 2 : 0 })
    if (tuple.unit === 'carton') input = withUnit(input, await uom(s))
    if (tuple.unit === 'custom') {
        const f = requireFixture(s.family.id)
        if (typeof f.customUnitId !== 'string') throw new HostedBlocked('Quick custom-unit fixture')
        const selected = requireLiveData<Row>(await s.observer.from('units').select('id,name').eq('workspace_id', liveWorkspaceId).eq('id', f.customUnitId).single(), 'Quick custom unit')
        input.items[0].unitRef = `custom:${selected.id}`
        input.items[0].unitNameSnapshot = selected.name
    }
    if (tuple.lines === 'service' || tuple.lines === 'mixed') {
        if (process.env.ATLAS_LIVE_SERVICES_ENABLED !== 'true') throw new HostedBlocked('services module unavailable')
        const line = s.line(await s.extraProduct(true, tuple.currency))
        input.items = tuple.lines === 'service' ? [line] : [...input.items, line]
    }
    if (tuple.account) { const account = await s.account(); input.initialPaymentAccountId = account.id; input.initialPaymentAccountNameSnapshot = account.name ?? null }
    input = s.recalc(input)
    const financingPaid = ['loan', 'installments'].includes(tuple.method) && tuple.paid
    const approvalActive = tuple.approval && tuple.target !== 'draft'
    const cashUnpaid = tuple.method === 'cash' && !tuple.paid && tuple.target !== 'draft' && tuple.lines !== 'free'
    const emptyFinancing = ['loan', 'installments'].includes(tuple.method) && input.total <= 0
    const orders = await import('@/local-db/orders')
    if (financingPaid || approvalActive || cashUnpaid || emptyFinancing) {
        await s.step('incompatible Quick tuple', () => orders.createQuickSalesOrder(liveWorkspaceId, { ...input, status: tuple.target }), { denied: true, atomic: financingPaid })
        return
    }
    await s.create(input, 'quick', tuple.target)
    await s.step('exact Quick tuple persisted', async () => undefined, { unchanged: true, check: graph => {
        const order = graph.tables.orders.find(row => row.id === s.order!.id)!
        expect(order).toMatchObject({ status: tuple.target, currency: tuple.currency, payment_method: tuple.method })
        const stockDemand = input.items.filter(line => line.storageId).reduce((sum, line) => sum + Number(line.inventoryQuantity ?? line.quantity) + Number(line.freeBonusInventoryQuantity ?? 0), 0)
        const old = s.baseline.tables.inventory.reduce((sum, row) => sum + Number(row.quantity), 0)
        expect(graph.tables.inventory.reduce((sum, row) => sum + Number(row.quantity), 0)).toBeCloseTo(old - (tuple.target === 'completed' ? stockDemand : 0), 6)
        if (tuple.approval) expect(active(graph.tables.payments)).toHaveLength(0)
    } })
}
