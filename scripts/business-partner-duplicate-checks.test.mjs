import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const migration = readFileSync(new URL('../supabase/migrations/20261021110901_optimize_business_partner_duplicate_checks.sql', import.meta.url), 'utf8')
const workspaceId = '00000000-0000-4000-8000-000000000001'
const otherWorkspaceId = '00000000-0000-4000-8000-000000000002'
const partnerId = '00000000-0000-4000-8000-000000000010'
let pg

async function check(name, phone = '', excludeId = null, workspace = workspaceId) {
    const { rows } = await pg.query('SELECT crm.check_business_partner_duplicates($1::uuid, $2, $3, $4::uuid) AS result', [workspace, name, phone, excludeId])
    return rows[0].result
}

describe('business partner duplicate check SQL', () => {
    beforeAll(async () => {
        pg = new PGlite()
        await pg.exec(`
          CREATE ROLE authenticated;
          CREATE SCHEMA crm;
          CREATE SCHEMA auth;
          CREATE SCHEMA delivery;
          CREATE TABLE public.workspaces (id uuid PRIMARY KEY, plan text);
          CREATE FUNCTION public.workspace_module_allowed(uuid,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT COALESCE(current_setting('test.agents',true),'') = 'grant' $$;
          CREATE FUNCTION delivery.module_allowed(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
          CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-4000-8000-000000000003'::uuid $$;
          CREATE FUNCTION public.current_workspace_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${workspaceId}'::uuid $$;
          CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql AS $$ SELECT COALESCE(NULLIF(current_setting('test.role', true), ''), 'staff') $$;
          CREATE FUNCTION public.workspace_get_override_value(uuid,text,text) RETURNS text LANGUAGE sql AS $$ SELECT COALESCE(NULLIF(current_setting('test.privacy', true), ''), 'revoke') $$;
          CREATE TABLE crm.business_partners (id uuid PRIMARY KEY, workspace_id uuid, partner_name text, phone text, role text DEFAULT 'customer', is_deleted boolean DEFAULT false, merged_into_business_partner_id uuid);
          CREATE TABLE crm.business_partner_groups (id uuid PRIMARY KEY, workspace_id uuid, access_type text, is_deleted boolean DEFAULT false);
          CREATE TABLE crm.business_partner_group_users (group_id uuid, workspace_id uuid, user_id uuid, is_deleted boolean DEFAULT false);
          CREATE TABLE crm.business_partner_group_partners (group_id uuid, workspace_id uuid, business_partner_id uuid, is_deleted boolean DEFAULT false);
          ALTER TABLE crm.business_partners ENABLE ROW LEVEL SECURITY;
          CREATE POLICY workspace_read ON crm.business_partners TO authenticated USING (workspace_id = public.current_workspace_id());
          GRANT USAGE ON SCHEMA crm, auth TO authenticated;
          GRANT SELECT ON ALL TABLES IN SCHEMA crm TO authenticated;
          INSERT INTO crm.business_partners(id,workspace_id,partner_name,phone) VALUES
            ('${partnerId}', '${workspaceId}', '  Acme  ', '٠٧٧٠-١٢٣-٤٥٦٧'),
            ('00000000-0000-4000-8000-000000000011', '${otherWorkspaceId}', 'Other workspace', '111');
          INSERT INTO crm.business_partners(id,workspace_id,partner_name,is_deleted,merged_into_business_partner_id,role) VALUES
            ('00000000-0000-4000-8000-000000000012', '${workspaceId}', 'Deleted', true, null, 'customer'),
            ('00000000-0000-4000-8000-000000000013', '${workspaceId}', 'Merged', false, '${partnerId}', 'customer'),
            ('00000000-0000-4000-8000-000000000014', '${workspaceId}', 'Witness', false, null, 'witness');
          INSERT INTO crm.business_partners(id,workspace_id,partner_name,phone)
            SELECT gen_random_uuid(), '${workspaceId}', 'Extra ' || n, '12345' || n FROM generate_series(1, 10000) n;
        `)
        await pg.exec(migration)
        await pg.exec('ANALYZE crm.business_partners')
        // Production exposes the scoped reader instead of granting raw table
        // access. The existence check must work through that same boundary.
        await pg.exec('REVOKE SELECT ON crm.business_partners FROM authenticated')
        await pg.exec('SET ROLE authenticated')
    }, 60_000)
    afterAll(async () => pg?.close())

    it('normalizes names, separators, Arabic and Persian digits, and excludes the edited partner', async () => {
        expect(await check('ACME', '07701234567')).toEqual({ name: true, phone: true })
        expect(await check(' acme ', '۰۷۷۰۱۲۳۴۵۶۷')).toEqual({ name: true, phone: true })
        expect(await check('Acme', '07701234567', partnerId)).toEqual({ name: false, phone: false })
        expect(await check('', '')).toEqual({ name: false, phone: false })
    })

    it('keeps the raw partner table inaccessible to the caller', async () => {
        await expect(pg.query('SELECT * FROM crm.business_partners')).rejects.toThrow('permission denied')
        expect(await check('Acme')).toEqual({ name: true, phone: false })
    })

    it('omits inactive identities and rejects another workspace', async () => {
        for (const name of ['Deleted', 'Merged', 'Witness', 'Other workspace']) {
            expect(await check(name)).toEqual({ name: false, phone: false })
        }
        await expect(check('Other workspace', '', null, otherWorkspaceId)).rejects.toThrow('Workspace access denied')
    })

    it('does not reveal agent identities without the module access required by the directory', async () => {
        await pg.exec(`RESET ROLE;
          INSERT INTO crm.business_partners(id,workspace_id,partner_name,role) VALUES
            ('00000000-0000-4000-8000-000000000015','${workspaceId}','Agent','agent');
          SET ROLE authenticated;`)
        expect(await check('Agent')).toEqual({ name: false, phone: false })
        await pg.exec("SET test.agents = 'grant'")
        expect(await check('Agent')).toEqual({ name: true, phone: false })
        await pg.exec('RESET test.agents')
    })

    it('preserves group visibility including the non-grouped fallback and administrator access', async () => {
        await pg.exec("SET test.privacy = 'grant'")
        expect(await check('Acme')).toEqual({ name: false, phone: false })
        await pg.exec(`RESET ROLE;
          INSERT INTO crm.business_partner_groups VALUES ('00000000-0000-4000-8000-000000000020','${workspaceId}','non_grouped',false);
          INSERT INTO crm.business_partner_group_partners VALUES ('00000000-0000-4000-8000-000000000020','${workspaceId}','${partnerId}',false);
          SET ROLE authenticated;`)
        expect(await check('Acme')).toEqual({ name: true, phone: false })
        await pg.exec(`RESET ROLE;
          INSERT INTO crm.business_partner_groups VALUES ('00000000-0000-4000-8000-000000000021','${workspaceId}','grouped',false);
          INSERT INTO crm.business_partner_group_users VALUES ('00000000-0000-4000-8000-000000000021','${workspaceId}',auth.uid(),false);
          SET ROLE authenticated;`)
        expect(await check('Acme')).toEqual({ name: false, phone: false })
        await pg.exec("SET test.role = 'admin'")
        expect(await check('Acme')).toEqual({ name: true, phone: false })
        await pg.exec("RESET test.role; RESET test.privacy")
    })

    it('authorizes its scoped read and uses the normalized indexes inside the function', async () => {
        const { rows } = await pg.query(`SELECT prosecdef FROM pg_proc WHERE oid = 'crm.check_business_partner_duplicates(uuid,text,text,uuid)'::regprocedure`)
        expect(rows[0].prosecdef).toBe(true)
        await pg.exec('RESET ROLE; SET enable_seqscan = off')
        const namePlan = await pg.query(`EXPLAIN (COSTS OFF) SELECT id FROM crm.business_partners
          WHERE workspace_id = '${workspaceId}' AND LOWER(BTRIM(partner_name)) = 'acme'
            AND COALESCE(is_deleted,false) = false AND merged_into_business_partner_id IS NULL`)
        expect(JSON.stringify(namePlan.rows)).toContain('business_partners_duplicate_name_idx')
        const phonePlan = await pg.query(`EXPLAIN (COSTS OFF) SELECT id FROM crm.business_partners
          WHERE workspace_id = '${workspaceId}' AND REGEXP_REPLACE(TRANSLATE(COALESCE(phone,''),'٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'),'[^0-9]','','g') = '07701234567'
            AND COALESCE(is_deleted,false) = false AND merged_into_business_partner_id IS NULL`)
        expect(JSON.stringify(phonePlan.rows)).toContain('business_partners_duplicate_phone_idx')
        await pg.exec('SET ROLE authenticated')
    })
})
