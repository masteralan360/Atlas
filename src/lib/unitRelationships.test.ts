import { describe, expect, it } from 'vitest'
import {
  assertValidProductUnitFactor,
  assertValidUnitRelationship,
  buildProductUnitSelectionOptions,
  countActiveProductsByRelationship,
  formatHierarchicalQuantity,
  getUnitDescriptors,
  getUnitRefsUsedByProducts,
  soldQuantityToInventoryQuantity,
  splitHierarchicalQuantity,
} from './unitRelationships'

describe('hierarchical unit calculations', () => {
  it('normalizes exact and remainder quantities', () => {
    expect(splitHierarchicalQuantity(120, 20)).toEqual({ parentQuantity: 6, childQuantity: 0 })
    expect(splitHierarchicalQuantity(123, 20)).toEqual({ parentQuantity: 6, childQuantity: 3 })
    expect(splitHierarchicalQuantity(5, 20)).toEqual({ parentQuantity: 0, childQuantity: 5 })
  })

  it('formats only meaningful quantity parts', () => {
    const number = (value: number) => String(value)
    expect(formatHierarchicalQuantity(120, 20, 'Cartons', 'Sheets', 'and', number)).toBe('6 Cartons')
    expect(formatHierarchicalQuantity(123, 20, 'Cartons', 'Sheets', 'and', number)).toBe('6 Cartons and 3 Sheets')
    expect(formatHierarchicalQuantity(5, 20, 'Cartons', 'Sheets', 'and', number)).toBe('5 Sheets')
  })

  it('rounds the canonical stock effect', () => {
    expect(soldQuantityToInventoryQuantity(2, 20)).toBe(40)
    expect(soldQuantityToInventoryQuantity(0.333333, 3)).toBe(0.999999)
  })

  it('rejects invalid whole and dynamic factors', () => {
    expect(() => assertValidProductUnitFactor(2.5, false)).toThrow('unit_factor_whole')
    expect(() => assertValidProductUnitFactor(2.5, true)).not.toThrow()
    expect(() => assertValidProductUnitFactor(0, true)).toThrow('unit_factor_positive')
  })

  it('rejects duplicate, reverse, and cyclic relationships', () => {
    const rows = [
      { id: 'one', parentUnitRef: 'builtin:carton', childUnitRef: 'builtin:box', isDeleted: false, isArchived: false },
      { id: 'two', parentUnitRef: 'builtin:box', childUnitRef: 'builtin:pack', isDeleted: false, isArchived: false },
    ] as any[]
    expect(() => assertValidUnitRelationship({ parentUnitRef: 'builtin:carton', childUnitRef: 'builtin:box' } as any, rows)).toThrow('unit_relationship_duplicate')
    expect(() => assertValidUnitRelationship({ parentUnitRef: 'builtin:box', childUnitRef: 'builtin:carton' } as any, rows)).toThrow('unit_relationship_reverse')
    expect(() => assertValidUnitRelationship({ parentUnitRef: 'builtin:pack', childUnitRef: 'builtin:carton' } as any, rows)).toThrow('unit_relationship_cycle')
  })

  it('shows active relationships as combined choices and hides every reserved endpoint', () => {
    const units = [
      { value: 'carton', isDynamic: false, icon: null },
      { value: 'sheet', isDynamic: false, icon: null },
      { value: 'box', isDynamic: false, icon: null },
      { value: 'pcs', isDynamic: false, icon: null },
    ]
    const relationships = [
      {
        id: 'carton-sheet', parentUnitCode: 'carton', childUnitCode: 'sheet',
        parentUnitRef: 'builtin:carton', childUnitRef: 'builtin:sheet', isDeleted: false, isArchived: false,
      },
      {
        id: 'carton-box', parentUnitCode: 'carton', childUnitCode: 'box',
        parentUnitRef: 'builtin:carton', childUnitRef: 'builtin:box', isDeleted: false, isArchived: false,
      },
    ] as any[]

    const choices = buildProductUnitSelectionOptions(units, relationships)

    expect(choices.filter((choice) => choice.kind === 'relationship').map((choice) => choice.value)).toEqual([
      'relationship:carton-sheet',
      'relationship:carton-box',
    ])
    expect(choices.filter((choice) => choice.kind === 'unit').map((choice) => choice.value)).toEqual(['unit:pcs'])
  })

  it('treats both relationship endpoints as product-used while ignoring deleted products', () => {
    const products = [
      { id: 'active', unit: 'sheet', isDeleted: false },
      { id: 'deleted', unit: 'box', isDeleted: true },
    ] as any[]
    const conversions = [
      { productId: 'active', relationshipId: 'carton-sheet', isDeleted: false },
      { productId: 'deleted', relationshipId: 'case-box', isDeleted: false },
    ] as any[]
    const relationships = [
      {
        id: 'carton-sheet', parentUnitRef: 'builtin:carton', childUnitRef: 'builtin:sheet', isDeleted: false,
      },
      {
        id: 'case-box', parentUnitRef: 'builtin:case', childUnitRef: 'builtin:box', isDeleted: false,
      },
    ] as any[]
    const descriptors = getUnitDescriptors([])

    expect(getUnitRefsUsedByProducts(products, conversions, relationships, descriptors)).toEqual(new Set([
      'builtin:sheet',
      'builtin:carton',
    ]))
    expect(countActiveProductsByRelationship(products, conversions)).toEqual(new Map([
      ['carton-sheet', 1],
    ]))
  })
})
