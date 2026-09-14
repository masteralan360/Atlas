import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationSql = readFileSync(
  new URL('../../supabase/migrations/20260914170018_add_marketplace_delivery_attribution.sql', import.meta.url),
  'utf8',
)

describe('marketplace delivery attribution migration', () => {
  it('records the delivery actor and immutable name snapshot in the delivery transaction', () => {
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS delivered_by uuid')
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS delivered_by_name text')
    expect(migrationSql).toContain('v_delivery_actor_id uuid := auth.uid();')
    expect(migrationSql).toContain('LEFT JOIN public.profiles p ON p.id = u.id')
    expect(migrationSql).toContain("delivered_by = COALESCE(delivered_by, v_delivery_actor_id)")
    expect(migrationSql).toContain("delivered_by_name = COALESCE(NULLIF(delivered_by_name, ''), v_delivery_actor_name)")
  })

  it('signs the created sales order with the same authenticated delivery actor', () => {
    expect(migrationSql).toContain('marketplace_order_id,\n      created_by,\n      created_at,')
    expect(migrationSql).toContain('v_order.id,\n      v_delivery_actor_id,\n      v_order.created_at,')
    expect(migrationSql).toContain("RAISE EXCEPTION\n      'Marketplace sales order creator value could not be added.'")
  })
})
