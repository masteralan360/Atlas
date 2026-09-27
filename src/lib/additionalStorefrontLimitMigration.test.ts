import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const originalMigrationSql = readFileSync(
    new URL('../../supabase/migrations/20260927183728_limit_additional_storefronts_per_workspace.sql', import.meta.url),
    'utf8'
)
const fiveStorefrontMigrationSql = readFileSync(
    new URL('../../supabase/migrations/20260927194537_allow_five_additional_storefronts_per_workspace.sql', import.meta.url),
    'utf8'
)

describe('additional storefront workspace limit migration', () => {
    it('preserves the original two-storefront migration and adds an upgrade to five', () => {
        expect(originalMigrationSql).toContain('v_existing_storefront_count >= 2')
        expect(originalMigrationSql).toContain('A workspace can have no more than two additional storefronts')
        expect(fiveStorefrontMigrationSql).toContain('v_existing_storefront_count >= 5')
        expect(fiveStorefrontMigrationSql).toContain('A workspace can have no more than five additional storefronts')
    })

    it('serializes storefront creation and leaves existing storefront edits alone', () => {
        expect(fiveStorefrontMigrationSql).toContain('pg_advisory_xact_lock(7821, hashtext(NEW.workspace_id::text))')
        expect(fiveStorefrontMigrationSql).toContain('FROM public.workspace_storefronts AS storefront')
        expect(fiveStorefrontMigrationSql).toContain('storefront.workspace_id = NEW.workspace_id')
        expect(fiveStorefrontMigrationSql).toContain('NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id')
        expect(fiveStorefrontMigrationSql).toContain('CREATE OR REPLACE FUNCTION public.enforce_workspace_additional_storefront_limit()')
    })
})
