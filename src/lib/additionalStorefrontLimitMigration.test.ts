import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationSql = readFileSync(
    new URL('../../supabase/migrations/20260927183728_limit_additional_storefronts_per_workspace.sql', import.meta.url),
    'utf8'
)

describe('additional storefront workspace limit migration', () => {
    it('serializes storefront creation per workspace before counting current storefronts', () => {
        expect(migrationSql).toContain('pg_advisory_xact_lock(7821, hashtext(NEW.workspace_id::text))')
        expect(migrationSql).toContain('FROM public.workspace_storefronts AS storefront')
        expect(migrationSql).toContain('storefront.workspace_id = NEW.workspace_id')
    })

    it('rejects a third additional storefront and leaves existing storefront edits alone', () => {
        expect(migrationSql).toContain('v_existing_storefront_count >= 2')
        expect(migrationSql).toContain('A workspace can have no more than two additional storefronts')
        expect(migrationSql).toContain("NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id")
        expect(migrationSql).toContain('BEFORE INSERT OR UPDATE ON public.workspace_storefronts')
    })
})
