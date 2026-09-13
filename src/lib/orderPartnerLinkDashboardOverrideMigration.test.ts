import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationSql = readFileSync(
  new URL('../../supabase/migrations/20260913053153_limit_partner_link_validation_to_link_changes.sql', import.meta.url),
  'utf8',
)

describe('order partner-link dashboard override migration', () => {
  it('allows privileged Dashboard and server-side corrections without an Atlas identity', () => {
    expect(migrationSql).toContain('IF auth.uid() IS NULL OR auth.role() = \'service_role\' THEN')
    expect(migrationSql).toContain('RETURN NEW;')
  })

  it('retains partner-visibility validation for authenticated Atlas users', () => {
    expect(migrationSql).toContain('AND NOT crm.can_access_business_partner(NEW.workspace_id, partner_id, partner_scope) THEN')
    expect(migrationSql).toContain("RAISE EXCEPTION 'Business partner is unavailable' USING ERRCODE = '42501';")
  })
})
