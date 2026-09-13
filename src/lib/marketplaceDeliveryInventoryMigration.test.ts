import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationSql = readFileSync(
    new URL('../../supabase/migrations/20260913015801_fix_marketplace_delivery_existing_inventory_deduction.sql', import.meta.url),
    'utf8'
)

describe('marketplace delivery inventory deduction migration', () => {
    it('deducts an existing locked inventory position with an update instead of a negative upsert', () => {
        expect(migrationSql).toContain('Leave the already-correct procedure')
        expect(migrationSql).toContain('UPDATE public.inventory')
        expect(migrationSql).toContain('quantity = COALESCE(quantity, 0) - v_requested_qty')
        expect(migrationSql).toContain("position('ON CONFLICT (workspace_id, product_id, storage_id)' IN updated_definition) > 0")
    })

    it('rejects a missing or insufficient inventory position before finalizing delivery', () => {
        expect(migrationSql).toContain('IF NOT FOUND OR COALESCE(v_inventory_quantity, 0) < v_requested_qty THEN')
        expect(migrationSql).toContain("RAISE EXCEPTION 'Insufficient inventory for % in storage %'")
        expect(migrationSql).toContain("USING ERRCODE = '23514'")
    })
})
