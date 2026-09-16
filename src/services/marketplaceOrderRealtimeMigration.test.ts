import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationSql = readFileSync(
    new URL('../../supabase/migrations/20260916093328_enable_marketplace_order_realtime.sql', import.meta.url),
    'utf8'
)

describe('marketplace order Realtime migration', () => {
    it('publishes marketplace orders without weakening the table RLS policy', () => {
        expect(migrationSql).toContain("pubname = 'supabase_realtime'")
        expect(migrationSql).toContain("schemaname = 'public'")
        expect(migrationSql).toContain("tablename = 'marketplace_orders'")
        expect(migrationSql).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE public.marketplace_orders;')
        expect(migrationSql).not.toMatch(/DISABLE ROW LEVEL SECURITY|DROP POLICY|CREATE POLICY/i)
    })
})
