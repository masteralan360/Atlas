import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationPath = fileURLToPath(new URL(
  '../../supabase/migrations/20260920004845_add_hierarchical_packaging_units.sql',
  import.meta.url,
))
const migrationSql = readFileSync(migrationPath, 'utf8')
const relationshipUsageMigrationPath = fileURLToPath(new URL(
  '../../supabase/migrations/20260920035031_enforce_unit_relationship_product_usage.sql',
  import.meta.url,
))
const relationshipUsageMigrationSql = readFileSync(relationshipUsageMigrationPath, 'utf8')

describe('hierarchical packaging database migration', () => {
  it('creates workspace-scoped tables with explicit RLS and API grants', () => {
    for (const table of ['unit_relationships', 'product_unit_conversions', 'price_book_unit_prices']) {
      expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`)
      expect(migrationSql).toContain(`'${table}'`)
    }
    expect(migrationSql).toContain('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY')
    expect(migrationSql).toContain('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon')
  })

  it('guards duplicate directions, cycles, static fractional factors, and cross-workspace links', () => {
    expect(migrationSql).toContain('The reverse unit relationship already exists')
    expect(migrationSql).toContain('Unit relationships cannot contain a cycle')
    expect(migrationSql).toContain('Static child units require a whole-number conversion factor')
    expect(migrationSql).toContain('Product inventory unit must be the relationship child unit')
  })

  it('converts every inventory representation in one database transaction', () => {
    expect(migrationSql).toContain('CREATE OR REPLACE FUNCTION public.convert_product_inventory_to_child_unit')
    expect(migrationSql).toContain('UPDATE public.inventory')
    expect(migrationSql).toContain('UPDATE public.stock_batches')
    expect(migrationSql).toContain('UPDATE public.products')
    expect(migrationSql).toContain('cost_price / p_factor')
  })

  it('patches checkout and returns to use immutable canonical inventory quantities', () => {
    expect(migrationSql).toContain("pg_get_functiondef('private.complete_sale_once(jsonb)'::regprocedure)")
    expect(migrationSql).toContain('selling_unit_ref')
    expect(migrationSql).toContain('inventory_quantity')
    expect(migrationSql).toContain('validate_sale_item_unit_snapshot_on_write')
    expect(migrationSql).toContain('Product does not have an active unit conversion')
    expect(migrationSql).toContain('v_inventory_return_quantity := v_return_quantity * COALESCE(v_item_record.unit_factor, 1)')
    expect(migrationSql).toContain('v_remaining_to_restore := v_inventory_return_quantity')
  })

  it('enforces product-aware relationship creation, restore, archive, and delete rules', () => {
    expect(relationshipUsageMigrationSql).toContain('CREATE OR REPLACE FUNCTION public.enforce_unit_relationship_product_usage()')
    expect(relationshipUsageMigrationSql).toContain('BEFORE INSERT OR UPDATE OR DELETE ON public.unit_relationships')
    expect(relationshipUsageMigrationSql).toContain('product.is_deleted = false')
    expect(relationshipUsageMigrationSql).toContain('linked_relationship.parent_unit_ref IN (NEW.parent_unit_ref, NEW.child_unit_ref)')
    expect(relationshipUsageMigrationSql).toContain('Unit relationship endpoint is already used by a product')
    expect(relationshipUsageMigrationSql).toContain('Unit relationship is used by a product and cannot be archived or deleted')
  })

})
