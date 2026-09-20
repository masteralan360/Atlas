import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationSql = readFileSync(
    new URL('../../supabase/migrations/20260920000000_localize_marketplace_inventory_error_storage.sql', import.meta.url),
    'utf8'
)

describe('marketplace delivery inventory error migration', () => {
    it('resolves the storage name without falling back to its UUID', () => {
        expect(migrationSql).toContain("'public.transition_marketplace_order(uuid,text,text)'::regprocedure")
        expect(migrationSql).toContain('FROM public.storages AS storage')
        expect(migrationSql).toContain('storage.id = v_resolved_storage_id')
        expect(migrationSql).toContain("NULLIF(trim(storage.name), '')")
        expect(migrationSql).toContain("'Unknown storage'")
        expect(migrationSql).toContain("[\\s\\S]*?;")
        expect(migrationSql).not.toContain('v_resolved_storage_id::text')
    })
})
