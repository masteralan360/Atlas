import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationSql = readFileSync(
  new URL('../../supabase/migrations/20260913053803_clear_order_partner_balance_snapshots_for_dashboard_correction.sql', import.meta.url),
  'utf8',
)

describe('clear requested order partner balance snapshots migration', () => {
  it('is an atomic, strictly scoped correction for the two requested orders', () => {
    expect(migrationSql).toContain('BEGIN;')
    expect(migrationSql).toContain('COMMIT;')
    expect(migrationSql).toContain("workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid")
    expect(migrationSql).toContain("order_number IN ('SO-2026-00053', 'SO-2026-00054')")
    expect(migrationSql).toContain('Expected exactly two requested sales orders')
  })

  it('restores the exact guards and verifies both snapshots are null before committing', () => {
    expect(migrationSql).toContain('DISABLE TRIGGER enforce_visible_partner_link_on_sales_orders')
    expect(migrationSql).toContain('DISABLE TRIGGER sales_orders_partner_balance_snapshot_immutable')
    expect(migrationSql).toContain('ENABLE TRIGGER sales_orders_partner_balance_snapshot_immutable')
    expect(migrationSql).toContain('ENABLE TRIGGER enforce_visible_partner_link_on_sales_orders')
    expect(migrationSql).toContain('partner_balance_snapshot = NULL')
    expect(migrationSql).toContain('Requested sales-order partner balance snapshots were not cleared')
  })
})
