import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  allocatePurchaseCostToBaseInventory,
  getOrderLineFreeBonusInventoryQuantity,
  getOrderLineInventoryQuantity,
  getOrderLinePaidInventoryQuantity,
} from '@/lib/orderLineItems'
import {
  buildProductOrderUnitOptions,
  getUnitDescriptors,
} from '@/lib/unitRelationships'

const migrationPath = fileURLToPath(new URL(
  '../../../../supabase/migrations/20260922072647_relational_units_in_orders.sql',
  import.meta.url,
))
const migrationSql = readFileSync(migrationPath, 'utf8')

describe('order related-unit business contract', () => {
  const relationship = {
    id: '00000000-0000-4000-8000-000000000001',
    parentUnitRef: 'builtin:carton',
    parentUnitCode: 'carton',
    childUnitRef: 'builtin:sheet',
    childUnitCode: 'sheet',
    isDeleted: false,
  } as any
  const context = {
    relationship,
    conversion: {
      relationshipId: relationship.id,
      factor: 20,
      parentPrice: 40000,
    } as any,
  }

  it('requires an explicit parent or child choice and keeps their prices independent', () => {
    const options = buildProductOrderUnitOptions(
      { unit: 'sheet' } as any,
      context,
      getUnitDescriptors([]),
    )

    expect(options).toEqual([
      expect.objectContaining({ kind: 'parent', unitCode: 'carton', factor: 20 }),
      expect.objectContaining({ kind: 'child', unitCode: 'sheet', factor: 1 }),
    ])
    expect(context.conversion.parentPrice).toBe(40000)
  })

  it('uses selected-unit quantities commercially and base quantities for inventory', () => {
    const line = {
      quantity: 2,
      freeBonusQuantity: 1,
      unitFactor: 20,
      inventoryQuantity: 40,
      freeBonusInventoryQuantity: 20,
    }

    expect(getOrderLinePaidInventoryQuantity(line)).toBe(40)
    expect(getOrderLineFreeBonusInventoryQuantity(line)).toBe(20)
    expect(getOrderLineInventoryQuantity(line)).toBe(60)
  })

  it('allocates purchase cost across paid and free canonical inventory', () => {
    expect(allocatePurchaseCostToBaseInventory(40000, 2, 60)).toBe(1333.333333)
  })

  it('ships authoritative Cloud validation and historical return snapshots', () => {
    expect(migrationSql).toContain('CREATE OR REPLACE FUNCTION private.validate_order_unit_items()')
    expect(migrationSql).toContain('Order item unit conversion does not match the product configuration')
    expect(migrationSql).toContain('Unchanged historical lines deliberately keep factor-one compatibility')
    expect(migrationSql).toContain('paid_selected_unit_quantity')
    expect(migrationSql).toContain('free_inventory_quantity')
    expect(migrationSql).toContain("TG_TABLE_NAME = 'purchase_orders'")
    expect(migrationSql).toContain("v_item->>'baseUnitNameSnapshot'")
  })
})
