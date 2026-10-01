import { describe, expect, it } from 'vitest'
import { quickTuples } from '../../src/dev/testing/hosted/salesOrders/matrix'
import { assertGraph, graphHash, readRows } from '../../src/dev/testing/hosted/salesOrders/graph'
import { hostedCatalog, hostedTestCount, selectedDenominator } from './salesOrdersManifest.mjs'
import { readFileSync, existsSync } from 'node:fs'

const names = ['orders', 'products', 'inventory', 'batches', 'movements', 'payments', 'returns', 'returnItems',
  'loans', 'loanPayments', 'loanInstallments', 'orderInstallments', 'assignments', 'commissions', 'productCommissions',
  'trackedCommissions', 'trackedProductCommissions', 'accounts', 'accountMovements', 'accountBalances', 'invoices', 'invoiceVersions', 'marketplace']
function graph() {
  return { workspaceId: 'workspace', tables: Object.fromEntries(names.map(name => [name, []])) }
}
function orderGraph() {
  const g = graph()
  g.tables.products.push({ id: 'product', workspace_id: 'workspace' })
  g.tables.orders.push({ id: 'order', workspace_id: 'workspace', order_number: 'SO-1', version: 1, currency: 'usd', status: 'draft', payment_method: 'cash', total: 200, subtotal: 200, discount: 0, tax: 0, paid_amount: 0, balance_amount: 200,
    items: [{ id: 'line', productId: 'product', unitFactor: 20, quantity: 2, inventoryQuantity: 40, freeBonusQuantity: 1, freeBonusInventoryQuantity: 20, convertedUnitPrice: 100, lineTotal: 200 }] })
  return g
}
describe('hosted Sales Orders enumeration and independent verifier', () => {
  it('exposes all 418 families and the exact finite product without sampled choices', () => {
    expect(hostedCatalog).toHaveLength(30)
    const families = hostedCatalog.flatMap(domain => domain.cases)
    expect(families).toHaveLength(418)
    expect(new Set(families.map(family => family.id)).size).toBe(418)
    expect(quickTuples(11)).toHaveLength(9600)
    expect(hostedTestCount).toBe(12159)
    expect(selectedDenominator(['SO-H12-01', 'SO-H13-03'])).toBe(33)
    for (const family of Array.from({ length: 11 }, (_, i) => i + 1)) {
      const tuples = quickTuples(family)
      expect(new Set(tuples.map(tuple => JSON.stringify(tuple))).size).toBe(tuples.length)
    }
    const all = quickTuples(11)
    const choices = new Set(all.map(tuple => JSON.stringify(tuple)))
    for (const method of ['cash', 'fib', 'qicard', 'zaincash', 'fastpay', 'bank_transfer', 'loan', 'installments'])
      for (const target of ['draft', 'pending', 'completed']) for (const currency of ['usd', 'eur', 'iqd', 'try'])
        for (const paid of [false, true]) for (const account of [false, true]) for (const approval of [false, true])
          for (const lines of ['physical', 'mixed', 'free', 'service']) for (const unit of lines === 'service' ? ['base'] : ['base', 'carton', 'custom'])
            for (const initial of ['loan', 'installments'].includes(method) ? [0, 25] : [0])
              expect(choices.has(JSON.stringify({ method, target, currency, paid, initial, lines, unit, account, approval }))).toBe(true)
  })

  it('detects independent monetary, quantity, tenant, orphan, stock and batch corruption', () => {
    const clean = orderGraph()
    expect(assertGraph(clean)).not.toContain('idempotency')
    expect(graphHash(clean)).toHaveLength(64)
    const changes = [
      [g => { g.tables.orders[0].total = 199 }, /commercial-arithmetic/],
      [g => { g.tables.orders[0].items[0].inventoryQuantity = 2 }, /unit-quantities/],
      [g => { g.tables.products[0].workspace_id = 'other' }, /tenant-graph/],
      [g => { g.tables.payments.push({ id: 'orphan', workspace_id: 'workspace', source_type: 'sales_order', source_record_id: 'missing', currency: 'usd', amount: 20 }) }, /no-orphans/],
      [g => { g.tables.inventory.push({ id: 'position', workspace_id: 'workspace', product_id: 'product', storage_id: 'storage', quantity: -1 }) }, /stock-conservation/],
      [g => { g.tables.inventory.push({ id: 'position', workspace_id: 'workspace', product_id: 'product', storage_id: 'storage', quantity: 1 }); g.tables.batches.push({ id: 'batch', workspace_id: 'workspace', product_id: 'product', storage_id: 'storage', quantity: 2 }) }, /batch-conservation/]
    ]
    for (const [change, pattern] of changes) { const broken = structuredClone(clean); change(broken); expect(() => assertGraph(broken)).toThrow(pattern) }
  })

  it('reads every page and fails on read denial or repeated pages', async () => {
    const pages = []
    const client = { schema: () => ({ from: () => ({ select() { return this }, eq() { return this }, in() { return this }, order() { return this }, range(start, end) { pages.push([start, end]); return Promise.resolve({ data: Array.from({ length: start === 0 ? 200 : 3 }, (_, i) => ({ id: `${start + i}` })), error: null }) } }) }) }
    expect(await readRows(client, 'orders', 'workspace', 'id', ['order'])).toHaveLength(203)
    expect(pages).toEqual([[0, 199], [200, 399]])
    const repeated = { schema: () => ({ from: () => ({ select() { return this }, eq() { return this }, in() { return this }, order() { return this }, range() { return Promise.resolve({ data: Array.from({ length: 200 }, (_, i) => ({ id: `${i}` })), error: null }) } }) }) }
    await expect(readRows(repeated, 'orders', 'workspace', 'id', ['order'])).rejects.toThrow('hosted_pagination_unstable')
    const denied = { schema: () => ({ from: () => ({ select() { return this }, eq() { return this }, in() { return this }, order() { return this }, range() { return Promise.resolve({ data: null, error: { message: 'denied' } }) } }) }) }
    await expect(readRows(denied, 'orders', 'workspace', 'id', ['order'])).rejects.toThrow('hosted_read_failed')
  })

  it('keeps immutable original receipts while verifying the net remaining loan repayment', () => {
    const g = orderGraph()
    Object.assign(g.tables.orders[0], { payment_method: 'loan', status: 'pending', linked_loan_id: 'loan', paid_amount: 100, balance_amount: 100 })
    g.tables.loans.push({ id: 'loan', workspace_id: 'workspace', order_id: 'order', order_type: 'sales', principal_amount: 200, balance_amount: 100, total_paid_amount: 100 })
    g.tables.loanInstallments.push({ id: 'installment', workspace_id: 'workspace', loan_id: 'loan', installment_no: 1, balance_amount: 100 })
    g.tables.payments.push({ id: 'payment', workspace_id: 'workspace', source_type: 'loan', source_record_id: 'loan', amount: 150, currency: 'usd' },
      { id: 'counter-entry', workspace_id: 'workspace', source_type: 'loan', source_record_id: 'loan', amount: -50, currency: 'usd', reversal_of_transaction_id: 'payment' })
    g.tables.loanPayments.push({ id: 'receipt', workspace_id: 'workspace', loan_id: 'loan', payment_transaction_id: 'payment', amount: 100 })
    expect(() => assertGraph(g)).not.toThrow()
    const stale = structuredClone(g); stale.tables.loanPayments[0].amount = 150
    expect(() => assertGraph(stale)).toThrow('remaining amount')
    const missing = structuredClone(g); missing.tables.payments.pop()
    expect(() => assertGraph(missing)).toThrow('remaining amount')
  })

  it('does not lose a posted draft installment down payment from the order summary', () => {
    const g = orderGraph()
    Object.assign(g.tables.orders[0], { payment_method: 'installments', paid_amount: 25, balance_amount: 175 })
    g.tables.payments.push({ id: 'down-payment', workspace_id: 'workspace', source_type: 'sales_order', source_record_id: 'order', amount: 25, currency: 'usd' })
    expect(() => assertGraph(g)).not.toThrow()
    Object.assign(g.tables.orders[0], { paid_amount: 0, balance_amount: 200 })
    expect(() => assertGraph(g)).toThrow('posted installment down payment')
  })

  it('registers live domains and paired isolated/live purchase receipt coverage', () => {
    const registry = JSON.parse(readFileSync(new URL('../../src/dev/testing/suites.json', import.meta.url), 'utf8'))['sale-orders']
    const locales = ['en', 'ar', 'ku'].map(locale => JSON.parse(readFileSync(new URL(`../../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')))
    const liveDomains = registry.liveGroups.filter(group => group.domainId)
    expect(liveDomains).toHaveLength(hostedCatalog.length)
    const purchaseReceiptGroup = registry.liveGroups.find(group => group.id === 'purchase-receipt-rounding')
    expect(purchaseReceiptGroup).toMatchObject({
      isolatedGroupId: 'purchase-receipt-rounding',
      files: ['src/dev/testing/suites/purchaseReceiptRoundingLive.test.ts']
    })
    expect(registry.groups.find(group => group.id === 'purchase-receipt-rounding')).toMatchObject({
      files: expect.arrayContaining(['src/dev/testing/suites/orderUomTransactions.test.ts', 'src/lib/productUomMigration.test.ts'])
    })
    for (const locale of locales) expect(purchaseReceiptGroup.titleKey.split('.').reduce((value, key) => value?.[key], locale)).toEqual(expect.any(String))
    for (const group of registry.liveGroups) {
      expect(group.isolatedOnly).toBeUndefined()
      expect(group.files).toHaveLength(1)
      expect(existsSync(new URL(`../../${group.files[0]}`, import.meta.url))).toBe(true)
      if (group.domainId) {
        expect(group.isolatedGroupId).toBeUndefined()
        const wrapper = readFileSync(new URL(`../../${group.files[0]}`, import.meta.url), 'utf8')
        expect(wrapper).toContain(`registerHostedSalesOrderDomain('${group.domainId}')`)
      } else {
        expect(registry.groups.some(isolated => isolated.id === group.isolatedGroupId)).toBe(true)
      }
      for (const locale of locales) expect(group.titleKey.split('.').reduce((value, key) => value?.[key], locale)).toEqual(expect.any(String))
    }
    for (const locale of locales) { expect(locale.devTesting.status.blocked).toEqual(expect.any(String)); expect(locale.devTesting.runStatus.blocked).toEqual(expect.any(String)) }
  })

  it('rejects unexplained fulfillment and stock restoration without a posted return', () => {
    const g = orderGraph()
    Object.assign(g.tables.orders[0], { status: 'completed', actual_delivery_date: '2026-01-01' })
    g.tables.movements.push({ id: 'sale', workspace_id: 'workspace', product_id: 'product', storage_id: undefined, reference_id: 'order', reference_type: 'sales_order', previous_quantity: 100, new_quantity: 40, quantity_delta: -60 })
    expect(() => assertGraph(g)).not.toThrow()
    const missing = structuredClone(g); missing.tables.movements = []
    expect(() => assertGraph(missing)).toThrow('fulfillment')
    const restored = structuredClone(g)
    restored.tables.movements.push({ id: 'return', workspace_id: 'workspace', product_id: 'product', reference_id: 'missing-return', reference_type: 'sales_order_return', previous_quantity: 40, new_quantity: 60, quantity_delta: 20 })
    expect(() => assertGraph(restored)).toThrow('stock restored without posted return')
  })
})
