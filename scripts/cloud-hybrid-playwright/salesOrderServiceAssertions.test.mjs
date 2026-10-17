import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPersistedServiceDraft } from './salesOrderDriver.mjs'

const customerId = 'customer-run-owned'
const customerFacetId = 'customer-facet-run-owned'
const serviceId = 'service-run-owned'
const productId = 'product-run-owned'
const storageId = 'storage-run-owned'

test('service-only persisted drafts verify service relationships, null storage, totals, and unpaid state', () => {
  const order = {
    status: 'draft',
    is_paid: false,
    business_partner_id: customerId,
    customer_id: customerFacetId,
    total: 70,
    items: [{
      product_id: serviceId,
      quantity: 1,
      converted_unit_price: 70,
      line_total: 70,
      storage_id: null
    }]
  }

  assert.equal(assertPersistedServiceDraft(order, {
    businessPartnerId: customerId,
    customerId: customerFacetId,
    storageId,
    expectedLines: [{ productId: serviceId, isService: true, quantity: 1, unitPrice: 70 }]
  }).length, 1)
})

test('mixed persisted drafts verify physical and service lines independently', () => {
  const order = {
    status: 'draft',
    is_paid: false,
    businessPartnerId: customerId,
    customerId: customerFacetId,
    total: 270,
    items: [
      { productId: productId, quantity: 2, convertedUnitPrice: 100, lineTotal: 200, storageId },
      { productId: serviceId, quantity: 1, convertedUnitPrice: 70, lineTotal: 70, storageId: null }
    ]
  }

  assert.equal(assertPersistedServiceDraft(order, {
    businessPartnerId: customerId,
    customerId: customerFacetId,
    storageId,
    expectedLines: [
      { productId: serviceId, isService: true, quantity: 1, unitPrice: 70 },
      { productId, isService: false, quantity: 2, unitPrice: 100 }
    ]
  }).length, 2)
})

test('service draft assertions reject virtual storage leakage and unintended extra lines', () => {
  const base = {
    status: 'draft',
    is_paid: false,
    business_partner_id: customerId,
    customer_id: customerFacetId,
    total: 70,
    items: [{
      product_id: serviceId,
      quantity: 1,
      converted_unit_price: 70,
      line_total: 70,
      storage_id: '__atlas_services__'
    }]
  }
  const expected = { businessPartnerId: customerId, customerId: customerFacetId, storageId, expectedLines: [{ productId: serviceId, isService: true, quantity: 1, unitPrice: 70 }] }

  assert.throws(() => assertPersistedServiceDraft(base, expected), /storage reference/)
  assert.throws(() => assertPersistedServiceDraft({ ...base, total: 140, items: [...base.items, ...base.items] }, expected), /Expected 1 persisted order lines/)
})
