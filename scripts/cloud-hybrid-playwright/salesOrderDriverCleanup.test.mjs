import test from 'node:test'
import assert from 'node:assert/strict'
import { SalesOrderHybridDriver } from './salesOrderDriver.mjs'

class FakeQuery {
  constructor(state, table) {
    this.state = state
    this.table = table
    this.filters = []
    this.patch = null
  }
  select() { return this }
  limit() { return this }
  update(value) { this.patch = value; return this }
  eq(key, value) { this.filters.push((row) => row[key] === value); return this }
  in(key, values) { this.filters.push((row) => values.includes(row[key])); return this }
  like(key, value) {
    const prefix = value.endsWith('%') ? value.slice(0, -1) : value
    this.filters.push((row) => String(row[key] ?? '').startsWith(prefix))
    return this
  }
  rows() { return this.state[this.table] ?? [] }
  matches() { return this.rows().filter((row) => this.filters.every((filter) => filter(row))) }
  async execute() {
    const rows = this.matches()
    if (this.patch) for (const row of rows) Object.assign(row, this.patch)
    return { data: structuredClone(rows), error: null }
  }
  async maybeSingle() {
    const { data, error } = await this.execute()
    return { data: data[0] ?? null, error }
  }
  then(resolve, reject) { return this.execute().then(resolve, reject) }
}

function fakeSupabase(state) {
  return {
    from: (table) => new FakeQuery(state, table),
    schema: (schemaName) => ({
      from: (table) => new FakeQuery(state, `${schemaName}.${table}`),
      rpc: (functionName, args = {}) => {
        if (functionName === 'list_visible_business_partners') return new FakeQuery(state, `${schemaName}.business_partners`)
        if (args.p_operation === 'soft_delete') {
          const table = `${schemaName}.${functionName === 'sync_business_partner' ? 'business_partners' : 'customers'}`
          const row = state[table]?.find((item) => item.id === args.p_entity_id && item.workspace_id === args.p_workspace_id)
          if (row) row.is_deleted = true
          return Promise.resolve({ data: null, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      }
    })
  }
}

function fixtureState({ productOwner = 'user-1', serviceOwner = 'user-1', includeOrder = false } = {}) {
  const createdAt = '2026-10-01T12:00:00.000Z'
  const prefix = 'Atlas SO Hybrid run-1234'
  const order = {
    id: 'order-1', workspace_id: 'workspace-1', created_by: 'user-1', notes: `${prefix} SO-HYB-005 service-only-draft run-1234`,
    status: 'draft', is_paid: false, is_deleted: false, version: 1
  }
  return {
    prefix,
    rows: {
      'crm.sales_orders': includeOrder ? [order] : [],
      'crm.business_partners': [{ id: 'customer-1', workspace_id: 'workspace-1', name: `${prefix} Customer`, created_at: createdAt, is_deleted: false }],
      'crm.customers': [{ id: 'customer-facet-1', workspace_id: 'workspace-1', business_partner_id: 'customer-1', is_deleted: false }],
      products: [
        { id: 'product-1', workspace_id: 'workspace-1', created_by: productOwner, name: `${prefix} Product`, description: `${prefix} owned fixture`, created_at: createdAt, is_deleted: false, is_service: false, storage_id: 'storage-1' },
        { id: 'service-1', workspace_id: 'workspace-1', created_by: serviceOwner, name: `${prefix} Service`, description: `${prefix} run-owned service fixture`, created_at: createdAt, is_deleted: false, is_service: true, storage_id: null }
      ],
      storages: [{ id: 'storage-1', workspace_id: 'workspace-1', name: `${prefix} Storage`, created_at: createdAt, is_deleted: false, is_system: false, is_protected: false, is_primary: true, is_marketplace: true }]
    },
    fixture: {
      runId: 'run-1234', namePrefix: prefix,
      customer: { id: 'customer-1', customerFacetId: 'customer-facet-1', name: `${prefix} Customer`, createdAt },
      product: { id: 'product-1', name: `${prefix} Product`, description: `${prefix} owned fixture`, createdAt },
      service: { id: 'service-1', name: `${prefix} Service`, description: `${prefix} run-owned service fixture`, createdAt },
      storage: { id: 'storage-1', name: `${prefix} Storage`, createdAt, created: true },
      orderIds: includeOrder ? [order.id] : []
    }
  }
}

function driverFor(state) {
  const driver = new SalesOrderHybridDriver({ baseUrl: 'http://127.0.0.1:5173', email: '', password: '', artifactDirectory: '' })
  driver.workspaceId = 'workspace-1'
  driver.userId = 'user-1'
  driver.loggedIn = true
  driver.fixtures = state.fixture
  driver.page = {
    async evaluate(callback, id) {
      const source = callback.toString()
      const table = source.includes('deleteSalesOrder') ? 'crm.sales_orders'
        : source.includes('deleteProduct') ? 'products'
          : 'crm.business_partners'
      const targetId = typeof id === 'string' ? id : id?.customerId
      const row = state.rows[table].find((item) => item.id === targetId)
      if (row) row.is_deleted = true
    }
  }
  return driver
}

test('fixture cleanup verifies and retires only run-owned records, and is idempotent', async () => {
  const state = fixtureState()
  const driver = driverFor(state)
  const result = await driver.cleanup(fakeSupabase(state.rows))
  assert.equal(result.completed, true, JSON.stringify(result))
  assert.deepEqual(result.errors, [])
  assert.deepEqual(new Set(result.removed), new Set(['product:product-1', 'service:service-1', 'customer-facet:customer-facet-1', 'customer:customer-1', 'storage:storage-1']))
  assert.equal(state.rows.products[0].is_deleted, true)
  assert.equal(state.rows.products[1].is_deleted, true)
  assert.equal(state.rows['crm.business_partners'][0].is_deleted, true)
  assert.equal(state.rows['crm.customers'][0].is_deleted, true)
  assert.equal(state.rows.storages[0].is_deleted, true)
  assert.deepEqual(await driver.cleanup(fakeSupabase(state.rows)), { completed: true, errors: [], removed: [] })
})

test('cleanup soft-deletes only run-owned unpaid drafts without payment or inventory effects', async () => {
  const state = fixtureState({ includeOrder: true })
  const driver = driverFor(state)
  const result = await driver.cleanup(fakeSupabase(state.rows))

  assert.equal(result.completed, true, JSON.stringify(result))
  assert.equal(state.rows['crm.sales_orders'][0].is_deleted, true)
  assert.ok(result.removed.includes('order:order-1'))
})

test('cleanup preserves a run-owned draft when a payment transaction exists', async () => {
  const state = fixtureState({ includeOrder: true })
  state.rows.payment_transactions = [{ id: 'payment-1', workspace_id: 'workspace-1', source_record_id: 'order-1' }]
  const driver = driverFor(state)
  const result = await driver.cleanup(fakeSupabase(state.rows))

  assert.equal(result.completed, false)
  assert.match(result.errors.join('\n'), /payment or inventory effects/)
  assert.equal(state.rows['crm.sales_orders'][0].is_deleted, false)
  assert.equal(state.rows.products[0].is_deleted, false)
})

test('cleanup preserves dependent fixtures when product ownership cannot be proven', async () => {
  const state = fixtureState({ productOwner: 'another-user' })
  const driver = driverFor(state)
  const result = await driver.cleanup(fakeSupabase(state.rows))
  assert.equal(result.completed, false)
  assert.match(result.errors.join('\n'), /ownership check failed/)
  assert.equal(state.rows.products[0].is_deleted, false)
  assert.equal(state.rows.products[1].is_deleted, true)
  assert.equal(state.rows['crm.business_partners'][0].is_deleted, false)
  assert.equal(state.rows.storages[0].is_deleted, false)
  assert.ok(driver.fixtures, 'failed cleanup retains its ownership manifest for a retry')
})

test('service cleanup preserves an unowned service fixture and reports the ownership failure', async () => {
  const state = fixtureState({ serviceOwner: 'another-user' })
  const driver = driverFor(state)
  const result = await driver.cleanup(fakeSupabase(state.rows))

  assert.equal(result.completed, false)
  assert.match(result.errors.join('\n'), /service cleanup ownership check failed/)
  assert.equal(state.rows.products[1].is_deleted, false)
  assert.ok(driver.fixtures, 'failed cleanup retains its ownership manifest for a retry')
})
