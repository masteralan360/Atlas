import { describe, expect, it } from 'vitest'

import { createRelationalConversionDraft } from './productRelationalConversion'

const originalForm = {
  name: 'Panadol 500mg',
  unit: 'pcs',
  quantity: 55,
  storageId: 'storage-original',
  price: '40000',
  costPrice: '32000',
  perQuantity: '1',
}

const originalPriceBooks = [{
  priceBookId: 'wholesale',
  price: '38000',
  costPrice: '30000',
  parentPrice: '700000',
}]

describe('single-unit product relational conversion draft', () => {
  it('requires stock to be re-entered and resets every selling/cost price while keeping unrelated product fields', () => {
    const draft = createRelationalConversionDraft({
      formData: originalForm,
      priceBookRows: originalPriceBooks,
      childUnitCode: 'sheet',
      inventoryRows: [{ storageId: 'storage-a' }],
    })

    expect(draft.formData).toEqual({
      ...originalForm,
      unit: 'sheet',
      quantity: '',
      storageId: 'storage-a',
      price: '',
      costPrice: '',
      perQuantity: '1',
    })
    expect(draft.priceBookRows).toEqual([{
      ...originalPriceBooks[0],
      price: '',
      costPrice: '',
      parentPrice: '',
    }])
  })

  it('falls back to Active Storage when the product has zero or multiple allocations', () => {
    const withoutStorage = createRelationalConversionDraft({
      formData: originalForm,
      priceBookRows: originalPriceBooks,
      childUnitCode: 'sheet',
      inventoryRows: [],
    })
    const multipleStorages = createRelationalConversionDraft({
      formData: originalForm,
      priceBookRows: originalPriceBooks,
      childUnitCode: 'sheet',
      inventoryRows: [{ storageId: 'storage-a' }, { storageId: 'storage-b' }],
    })

    expect(withoutStorage.formData.storageId).toBe('')
    expect(multipleStorages.formData.storageId).toBe('')
  })

  it('does not mutate the original draft, so selecting the original unit can restore it exactly', () => {
    const formSnapshot = structuredClone(originalForm)
    const priceBookSnapshot = structuredClone(originalPriceBooks)

    createRelationalConversionDraft({
      formData: originalForm,
      priceBookRows: originalPriceBooks,
      childUnitCode: 'sheet',
      inventoryRows: [{ storageId: 'storage-a' }],
    })

    expect(originalForm).toEqual(formSnapshot)
    expect(originalPriceBooks).toEqual(priceBookSnapshot)
  })
})
