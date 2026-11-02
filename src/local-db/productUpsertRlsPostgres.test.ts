import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const workspace = '00000000-0000-4000-8000-000000000901'
const otherWorkspace = '00000000-0000-4000-8000-000000000902'
const product = '00000000-0000-4000-8000-000000000903'
const storage = '00000000-0000-4000-8000-000000000904'
const migration = readFileSync(new URL('../../supabase/migrations/20261102092306_fix_admin_product_upsert_visibility.sql', import.meta.url), 'utf8')
const storageMigration = readFileSync(new URL('../../supabase/migrations/20261022000842_persistent_product_storage_assignments.sql', import.meta.url), 'utf8')
const helperStart = storageMigration.indexOf('CREATE OR REPLACE FUNCTION public.current_user_can_access_product_storage(')
const storageHelper = storageMigration.slice(helperStart, storageMigration.indexOf('$function$;', helperStart) + '$function$;'.length)
const originalSelect = `workspace_id = public.current_workspace_id()
  AND (NOT COALESCE(is_service, false) OR public.services_module_allowed(workspace_id))
  AND (COALESCE(is_service, false) OR public.current_user_can_access_product_storage(workspace_id, id, storage_id))`
let pg: PGlite

async function upsert(scope = 'workspace', workspaceId = workspace, service = false) {
  return pg.query(`INSERT INTO public.products(id,workspace_id,storage_scope,is_service,name)
    VALUES($1,$2,$3,$4,'Queued product') ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
  [product, workspaceId, scope, service])
}

describe('PostgreSQL admin product sync visibility', () => {
  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(`CREATE ROLE authenticated;
      CREATE FUNCTION public.current_workspace_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT '${workspace}'::uuid$$;
      CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('test.actor_role')$$;
      CREATE FUNCTION public.services_module_allowed(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.services')::boolean$$;
      CREATE FUNCTION public.current_user_can_access_storage(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.storage_access')::boolean$$;
      CREATE TABLE public.products(id uuid PRIMARY KEY,workspace_id uuid,storage_scope text,storage_id uuid,
        is_service boolean DEFAULT false,is_deleted boolean DEFAULT false,name text);
      CREATE TABLE public.inventory(workspace_id uuid,product_id uuid,storage_id uuid,is_deleted boolean DEFAULT false);
      CREATE TABLE public.product_storage_assignments(workspace_id uuid,product_id uuid,storage_id uuid,is_deleted boolean DEFAULT false);
      GRANT USAGE ON SCHEMA public TO authenticated;
      GRANT SELECT,INSERT,UPDATE ON public.products TO authenticated;
      ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;`)
    await pg.exec(storageHelper)
    await pg.exec(`
      CREATE POLICY products_select ON public.products FOR SELECT TO authenticated USING (${originalSelect});
      CREATE POLICY products_insert ON public.products FOR INSERT TO authenticated WITH CHECK(workspace_id=public.current_workspace_id());
      CREATE POLICY products_update ON public.products FOR UPDATE TO authenticated
        USING(workspace_id=public.current_workspace_id()) WITH CHECK(workspace_id=public.current_workspace_id());`)
    await pg.exec(migration)
  }, 60_000)
  afterAll(async () => { await pg?.close() })
  beforeEach(async () => {
    await pg.exec(`RESET ROLE; TRUNCATE public.products,public.inventory,public.product_storage_assignments;
      SET test.actor_role='admin'; SET test.services='false'; SET test.storage_access='true'; SET ROLE authenticated;`)
  })

  it('reproduces the original upsert rejection before the policy repair', async () => {
    await pg.exec(`RESET ROLE; ALTER POLICY products_select ON public.products USING (${originalSelect}); SET ROLE authenticated`)
    try {
      await expect(upsert()).rejects.toThrow('row-level security')
    } finally {
      await pg.exec('RESET ROLE')
      await pg.exec(migration)
      await pg.exec('SET ROLE authenticated')
    }
    expect((await upsert()).rows).toEqual([{ id: product }])
  })

  it.each(['workspace', 'storage'])('creates and retries an admin product with %s scope', async scope => {
    expect((await upsert(scope)).rows).toEqual([{ id: product }])
    expect((await upsert(scope)).rows).toEqual([{ id: product }])
    expect((await pg.query('SELECT count(*)::int count FROM public.products')).rows).toEqual([{ count: 1 }])
  })

  it('keeps admin upserts scoped to the current workspace', async () => {
    await expect(upsert('workspace', otherWorkspace)).rejects.toThrow('row-level security')
  })

  it('does not expose existing products from another workspace to an admin', async () => {
    await pg.exec(`RESET ROLE; INSERT INTO public.products(id,workspace_id,storage_scope)
      VALUES('${product}','${otherWorkspace}','workspace'); SET ROLE authenticated`)
    expect((await pg.query('SELECT id FROM public.products')).rows).toEqual([])
  })

  it('retains service entitlement checks for admins', async () => {
    await expect(upsert('workspace', workspace, true)).rejects.toThrow('row-level security')
  })

  it('preserves staff storage visibility and hides restricted stock', async () => {
    await upsert()
    await pg.exec(`RESET ROLE; INSERT INTO public.inventory VALUES('${workspace}','${product}','${storage}',false);
      SET test.actor_role='staff'; SET test.storage_access='false'; SET ROLE authenticated`)
    expect((await pg.query('SELECT id FROM public.products')).rows).toEqual([])
    await pg.exec("SET test.storage_access='true'")
    expect((await pg.query('SELECT id FROM public.products')).rows).toEqual([{ id: product }])
  })
})
