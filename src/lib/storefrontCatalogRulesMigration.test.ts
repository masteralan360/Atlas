import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationSql = readFileSync(new URL('../../supabase/migrations/20260927180000_add_storefront_catalog_storage_rules.sql', import.meta.url), 'utf8')

describe('storefront catalog storage rule migration', () => {
    it('backfills legacy targets and constrains the supported target shapes', () => {
        expect(migrationSql).toContain("WHEN price_book_id IS NOT NULL THEN 'price_book'")
        expect(migrationSql).toContain("ELSE 'native'")
        expect(migrationSql).toContain("(target_type = 'storage' AND price_book_id IS NULL AND storage_id IS NOT NULL)")
        expect(migrationSql).toContain('uq_storefront_catalog_rules_storage')
    })

    it('validates storage and storefront ownership before saving a rule', () => {
        expect(migrationSql).toContain('storage.workspace_id = NEW.workspace_id')
        expect(migrationSql).toContain('storefront.workspace_id = NEW.workspace_id')
        expect(migrationSql).toContain('COALESCE(storage.is_deleted, false) = false')
    })
})
