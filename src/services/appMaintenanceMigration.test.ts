import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationSql = readFileSync(
    new URL('../../supabase/migrations/20260929175358_app_maintenance_mode.sql', import.meta.url),
    'utf8'
)

describe('app maintenance migration', () => {
    it('creates one global state row with a required defaulted value and read-only access', () => {
        expect(migrationSql).toContain('create table if not exists public.app_maintenance')
        expect(migrationSql).toMatch(/id boolean primary key default true check \(id\)/i)
        expect(migrationSql).toMatch(/maintenance boolean not null default false/i)
        expect(migrationSql).toMatch(/on conflict \(id\) do nothing/i)
        expect(migrationSql).toContain('alter table public.app_maintenance enable row level security')
        expect(migrationSql).toContain('grant select on table public.app_maintenance to anon, authenticated')
        expect(migrationSql).toContain('alter publication supabase_realtime add table public.app_maintenance')
    })
})
