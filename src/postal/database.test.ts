import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
const w = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const admin = '00000000-0000-4000-8000-000000000010'
const merchant = '00000000-0000-4000-8000-000000000011'
const merchant2 = '00000000-0000-4000-8000-000000000012'
const staff = '00000000-0000-4000-8000-000000000013'
const outsider = '00000000-0000-4000-8000-000000000014'
let pg: PGlite
let shipment: Record<string, unknown>
let branchA: Record<string, unknown>
let branchB: Record<string, unknown>
let createRequest: string
async function enroll(id: string, enrollment: object) {
  const email = `${id}@postal.test`
  await pg.query('SELECT public.postal_prepare_registration($1,$2,$3::jsonb)', [
    id,
    email,
    JSON.stringify(enrollment),
  ])
  return pg.query(
    `INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,'{"name":"Merchant"}')`,
    [id, email],
  )
}
const form = {
  recipient_name: 'Recipient',
  primary_phone: '07501234567',
  backup_phone: '07701234567',
  governorate: 'erbil',
  area: 'ankawa',
  address: '',
  cod_amount: -25000,
  pieces: null,
  fragile: false,
  delivery_notes: '',
}
async function actor(id: string, workspace = w) {
  await pg.exec('RESET ROLE')
  await pg.query(
    `SELECT set_config('test.uid',$1,false),set_config('test.workspace',$2,false)`,
    [id, workspace],
  )
  await pg.exec('SET ROLE authenticated')
}
async function command(
  type: string,
  payload: object,
  request: string = crypto.randomUUID(),
) {
  const result = await pg.query<{ result: Record<string, unknown> }>(
    'SELECT public.postal_command($1,$2::jsonb,$3::uuid) AS result',
    [type, JSON.stringify({ workspace_id: w, ...payload }), request],
  )
  return result.rows[0].result
}
async function move(type: string, payload = {}) {
  shipment = await command(type, {
    id: shipment.id,
    revision: shipment.revision,
    ...payload,
  })
  return shipment
}
describe('Post Service PostgreSQL authorization and transactions', () => {
  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE PUBLICATION supabase_realtime;
      CREATE SCHEMA crm; CREATE TABLE crm.business_partners(id uuid PRIMARY KEY,workspace_id uuid,partner_name text,is_deleted boolean DEFAULT false); CREATE TABLE crm.agents(id uuid PRIMARY KEY,workspace_id uuid,business_partner_id uuid,agent_type text,status text,is_deleted boolean DEFAULT false);
      CREATE FUNCTION public.workspace_module_allowed(uuid,text,text) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated,anon;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
      CREATE FUNCTION public.current_workspace_id() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.workspace',true),'')::uuid$$;
      CREATE TABLE public.workspaces(id uuid PRIMARY KEY,name text DEFAULT 'Workspace',data_mode text DEFAULT 'cloud',plan text DEFAULT 'enterprise',deleted_at timestamptz);
      CREATE TABLE public.profiles(id uuid PRIMARY KEY,name text,role text,workspace_id uuid,current_workspace uuid);
      CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql SECURITY DEFINER AS $$SELECT role FROM public.profiles WHERE id=auth.uid()$$;
      CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb DEFAULT '{}',raw_app_meta_data jsonb DEFAULT '{}');
      CREATE SCHEMA sorl_private; CREATE TABLE sorl_private.actor_permits(user_id uuid,email text,role text,workspace_id uuid,expires_at timestamptz,run_id uuid);
      CREATE TABLE public.keys(key_name text,key_value text); INSERT INTO public.keys VALUES('admin','admin-key'),('staff','staff-key'),('viewer','viewer-key');
      CREATE FUNCTION public.rotate_registration_keys() RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
      CREATE TABLE public.workspace_access_overrides(workspace_id uuid,type text,key text,value text,UNIQUE(workspace_id,type,key));
      CREATE TABLE public.workspace_permissions(workspace_id uuid,user_uuid uuid,key text NOT NULL,module text NOT NULL,UNIQUE(workspace_id,user_uuid,key),
        CONSTRAINT workspace_permissions_no_retired_modules CHECK(COALESCE(key,'') NOT LIKE 'postService.%' AND COALESCE(module,'')<>'postService'));
      ALTER TABLE public.workspace_permissions ENABLE ROW LEVEL SECURITY;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public.workspace_permissions TO authenticated;
      CREATE TABLE public.payment_transactions(id uuid PRIMARY KEY,workspace_id uuid,source_module text,source_type text,source_record_id uuid,source_subrecord_id uuid,direction text,amount numeric,currency text,payment_method text,paid_at timestamptz,counterparty_name text,reference_label text,note text,created_by uuid,account_id uuid,account_name_snapshot text,metadata jsonb);
      ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public.payment_transactions TO authenticated;
      CREATE POLICY existing_payment_read ON public.payment_transactions FOR SELECT TO authenticated USING(workspace_id=public.current_workspace_id());
      CREATE POLICY existing_payment_insert ON public.payment_transactions FOR INSERT TO authenticated WITH CHECK(workspace_id=public.current_workspace_id());
      INSERT INTO public.workspaces(id) VALUES('${w}'),('${other}');
      INSERT INTO public.workspace_access_overrides VALUES('${w}','module','postal_service','grant'),('${other}','module','postal_service','grant');
      INSERT INTO public.profiles VALUES('${admin}','Admin','admin','${w}','${w}'),('${staff}','Office','staff','${w}','${w}'),('${outsider}','Other','staff','${other}','${other}');`)
    await pg.exec(
      readFileSync(
        new URL(
          '../../supabase/migrations/20261024003737_postal_service.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    await pg.exec(
      readFileSync(
        new URL(
          '../../supabase/migrations/20261024004656_postal_registration_permission_keys.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    await pg.exec(
      readFileSync(
        new URL(
          '../../supabase/migrations/20261024094518_postal_dashboard_summary.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    await pg.exec(
      readFileSync(
        new URL(
          '../../supabase/migrations/20261024174745_add_postal_shipment_numbers.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    await pg.exec(
      readFileSync(
        new URL(
          '../../supabase/migrations/20261024181523_postal_shipment_id_display_format.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    const registrationSql = readFileSync(
      new URL(
        '../../supabase/migrations/20261002000858_scope_resilience_actor_permits.sql',
        import.meta.url,
      ),
      'utf8',
    )
    await pg.exec(
      registrationSql.slice(
        registrationSql.indexOf(
          'CREATE OR REPLACE FUNCTION public.check_registration_passkey()',
        ),
      ),
    )
    await pg.exec(
      'CREATE TRIGGER existing_registration_guard BEFORE INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.check_registration_passkey();',
    )
    await pg.exec(
      `INSERT INTO public.workspace_permissions VALUES('${w}','${staff}','postService.officeEmployee','postService')`,
    )
    await enroll(merchant, {
      workspace_id: w,
      actor_id: admin,
      mode: 'create',
      name: 'Merchant One',
    })
    await enroll(merchant2, {
      workspace_id: w,
      actor_id: admin,
      mode: 'create',
      name: 'Merchant Two',
    })
  }, 60000)
  afterAll(async () => {
    await pg?.close()
  })
  it('aggregates filtered shipments across the workspace while isolating merchant organizations', async () => {
    await pg.exec('RESET ROLE; BEGIN')
    try {
      const orgs = await pg.query<{ user_id: string; organization_id: string }>(
        'SELECT user_id,organization_id FROM public.postal_memberships WHERE user_id IN ($1,$2)',
        [merchant, merchant2],
      )
      const orgA = orgs.rows.find(
        (row) => row.user_id === merchant,
      )!.organization_id
      const orgB = orgs.rows.find(
        (row) => row.user_id === merchant2,
      )!.organization_id
      const otherOrg = crypto.randomUUID()
      await pg.query(
        "INSERT INTO public.postal_organizations(id,workspace_id,name,code,leader_id) VALUES($1,$2,'Other organization','OTHR2345',$3)",
        [otherOrg, other, outsider],
      )
      await pg.query(
        'INSERT INTO public.postal_memberships(user_id,workspace_id,organization_id) VALUES($1,$2,$3)',
        [outsider, other, otherOrg],
      )
      await pg.query(
        "INSERT INTO public.workspace_permissions VALUES($1,$2,'postService.merchant','postService')",
        [other, outsider],
      )
      const rows = [
        [orgA, 'draft', 10000, '2026-10-02'],
        [orgA, 'received', 20000, '2026-10-03'],
        [orgA, 'in_transit', 30000, '2026-10-04'],
        [orgA, 'delivered', 10000, '2026-10-05'],
        [orgA, 'delivered', -4000, '2026-10-06'],
        [orgA, 'cancelled', 500, '2026-10-07'],
        [orgA, 'delivered', 9999, '2026-10-05'],
        [orgB, 'delivered', 12000, '2026-10-05'],
        [orgB, 'out_for_delivery', 5000, '2026-10-04'],
        [orgB, 'in_transit', 1000, '2026-09-30'],
        [otherOrg, 'delivered', 1000000, '2026-10-05'],
      ] as const
      const ids = rows.map(() => crypto.randomUUID())
      for (const [index, [org, state, amount, date]] of rows.entries()) {
        await pg.query(
          `INSERT INTO public.postal_shipments(id,workspace_id,organization_id,recipient_name,primary_phone,backup_phone,governorate,area,cod_amount,state,created_by,created_at,deleted_at)
          VALUES($1,$2,$3,$4,$5,'07701234567','erbil','ankawa',$6,$7,$8,$9,$10)`,
          [
            ids[index],
            org === otherOrg ? other : w,
            org,
            org === orgA ? 'Alpha recipient' : 'Beta recipient',
            org === orgA ? '07501234567' : '07701234567',
            amount,
            state,
            org === otherOrg ? outsider : merchant,
            date + 'T00:00:00Z',
            index === 6 ? '2026-10-08T00:00:00Z' : null,
          ],
        )
      }
      for (const [index, amount, kind] of [
        [3, 2000, 'collection'],
        [3, 3000, 'collection'],
        [4, -1000, 'collection'],
        [7, 4000, 'collection'],
        [3, 3000, 'settlement'],
      ] as const) {
        const payment = crypto.randomUUID()
        await pg.query(
          "INSERT INTO public.payment_transactions(id,workspace_id,source_module,source_type,source_record_id,direction,amount,currency) VALUES($1,$2,'postal_service',$3,$4,$5,$6,'iqd')",
          [
            payment,
            w,
            kind === 'collection' ? 'postal_cod' : 'postal_settlement',
            ids[index],
            kind === 'settlement' || amount < 0 ? 'outgoing' : 'incoming',
            Math.abs(amount),
          ],
        )
        await pg.query(
          "INSERT INTO public.postal_cod_records(workspace_id,shipment_id,organization_id,kind,signed_amount,payment_transaction_id,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'2026-11-01T00:00:00Z')",
          [w, ids[index], rows[index][0], kind, amount, payment, staff],
        )
      }
      const summary = async (
        search = '',
        status = 'all',
        start: string | null = null,
        end: string | null = null,
        workspace = w,
      ) =>
        (
          await pg.query<{ result: Record<string, unknown> }>(
            'SELECT public.postal_dashboard_summary($1,$2,$3,$4,$5) AS result',
            [workspace, search, status, start, end],
          )
        ).rows[0].result
      const rejectSummary = async (
        read: () => Promise<unknown>,
        message: string,
      ) => {
        await pg.exec('SAVEPOINT rejected_summary')
        await expect(read()).rejects.toThrow(message)
        await pg.exec(
          'ROLLBACK TO SAVEPOINT rejected_summary; RELEASE SAVEPOINT rejected_summary',
        )
      }
      const all = {
        total_shipments: 9,
        active_shipments: 5,
        delivered_shipments: 3,
        in_transit_shipments: 2,
        cod_balance: '10000',
        collection_records: 4,
      }
      await actor(admin)
      expect(await summary()).toEqual(all)
      expect(
        await summary(
          '',
          'all',
          '2026-10-01T00:00:00Z',
          '2026-11-01T00:00:00Z',
        ),
      ).toEqual({
        ...all,
        total_shipments: 8,
        active_shipments: 4,
        in_transit_shipments: 1,
      })
      expect(
        await summary(
          '',
          'all',
          '2026-10-04T00:00:00Z',
          '2026-10-06T00:00:00Z',
        ),
      ).toEqual({
        total_shipments: 4,
        active_shipments: 2,
        delivered_shipments: 2,
        in_transit_shipments: 1,
        cod_balance: '13000',
        collection_records: 3,
      })
      expect(await summary('', 'delivered')).toEqual({
        ...all,
        total_shipments: 3,
        active_shipments: 0,
        in_transit_shipments: 0,
      })
      const merchantTotal = {
        total_shipments: 6,
        active_shipments: 3,
        delivered_shipments: 2,
        in_transit_shipments: 1,
        cod_balance: '2000',
        collection_records: 3,
      }
      expect(await summary('Alpha')).toEqual(merchantTotal)
      expect(await summary('Al%p_ha\\()')).toEqual(merchantTotal)
      expect(await summary('0750')).toEqual(merchantTotal)
      expect(await summary('no match')).toEqual({
        total_shipments: 0,
        active_shipments: 0,
        delivered_shipments: 0,
        in_transit_shipments: 0,
        cod_balance: '0',
        collection_records: 0,
      })
      await actor(staff)
      expect(await summary()).toEqual(all)
      await actor(merchant)
      expect(await summary()).toEqual(merchantTotal)
      expect(await summary('Beta')).toMatchObject({
        total_shipments: 0,
        cod_balance: '0',
      })
      await rejectSummary(
        () => summary('', 'all', null, null, other),
        'postal_not_authorized',
      )
      await actor(merchant2)
      expect(await summary()).toMatchObject({
        total_shipments: 3,
        cod_balance: '8000',
      })
      await actor(outsider, other)
      expect(await summary('', 'all', null, null, other)).toMatchObject({
        total_shipments: 1,
        cod_balance: '1000000',
      })
      await rejectSummary(() => summary(), 'postal_not_authorized')
      await actor(admin)
      await rejectSummary(() => summary('', 'invalid'), 'postal_invalid_filter')
      await rejectSummary(
        () => summary('', 'all', '2026-11-01', '2026-10-01'),
        'postal_invalid_filter',
      )
      await pg.exec('RESET ROLE; SET ROLE anon')
      await rejectSummary(() => summary(), 'permission denied')
      await pg.exec('RESET ROLE')
      await pg.query(
        "SELECT set_config('request.jwt.claim.role','service_role',true)",
      )
      await pg.query(
        "UPDATE public.workspace_access_overrides SET value='revoke' WHERE workspace_id=$1 AND key='postal_service'",
        [w],
      )
      await actor(admin)
      await rejectSummary(() => summary(), 'postal_not_authorized')
    } finally {
      await pg.exec('ROLLBACK; RESET ROLE')
    }
  })
  it('allows the two new permission keys while keeping other namespace keys blocked', async () => {
    await pg.exec('RESET ROLE')
    for (const [key, module] of [
      ['postService.unrecognized', 'postService'],
      ['postService.merchant', 'unrecognized'],
      ['unrecognized.read', 'postService'],
    ]) {
      await expect(
        pg.query(
          'INSERT INTO public.workspace_permissions(workspace_id,user_uuid,key,module) VALUES($1,$2,$3,$4)',
          [w, staff, key, module],
        ),
      ).rejects.toThrow('workspace_permissions_no_retired_modules')
    }
    const permissions = await pg.query<{ key: string }>(
      "SELECT DISTINCT key FROM public.workspace_permissions WHERE module='postService' ORDER BY key",
    )
    expect(permissions.rows.map((row) => row.key)).toEqual([
      'postService.merchant',
      'postService.officeEmployee',
    ])
  })
  it('creates organizations and leaders atomically and allows valid joins', async () => {
    const org = (
      await pg.query<{ id: string; code: string; leader_id: string }>(
        'SELECT * FROM public.postal_organizations WHERE leader_id=$1',
        [merchant],
      )
    ).rows[0]
    expect(org.code).toMatch(/^[A-Z0-9]{8}$/)
    const joiner = crypto.randomUUID()
    await enroll(joiner, {
      workspace_id: w,
      actor_id: admin,
      mode: 'join',
      code: `${org.code.slice(0, 4)}-${org.code.slice(4)}`,
    })
    expect(
      (
        await pg.query<{ organization_id: string }>(
          'SELECT * FROM public.postal_memberships WHERE user_id=$1',
          [joiner],
        )
      ).rows[0].organization_id,
    ).toBe(org.id)
    const invalid = crypto.randomUUID()
    await expect(
      enroll(invalid, {
        workspace_id: other,
        actor_id: admin,
        mode: 'join',
        code: org.code,
      }),
    ).rejects.toThrow('postal_not_authorized')
    expect(
      (await pg.query('SELECT * FROM auth.users WHERE id=$1', [invalid])).rows,
    ).toHaveLength(0)
    await expect(
      pg.query('DELETE FROM public.postal_memberships WHERE user_id=$1', [
        merchant,
      ]),
    ).rejects.toThrow()
    await expect(
      pg.query(
        `INSERT INTO public.workspace_permissions VALUES($1,$2,'postService.merchant','postService')`,
        [w, staff],
      ),
    ).rejects.toThrow('postal_invalid_membership')
    expect(
      (
        await pg.query(
          'SELECT * FROM postal_private.registration_permits WHERE user_id=$1',
          [merchant],
        )
      ).rows,
    ).toHaveLength(0)
    const stored = await pg.query<{
      raw_user_meta_data: Record<string, unknown>
    }>('SELECT * FROM auth.users WHERE id=$1', [merchant])
    expect(stored.rows[0].raw_user_meta_data).not.toHaveProperty('passkey')
    await pg.exec('DROP TRIGGER existing_registration_guard ON auth.users')
    const withoutGuard = crypto.randomUUID()
    await enroll(withoutGuard, {
      workspace_id: w,
      actor_id: admin,
      mode: 'join',
      code: org.code,
    })
    expect(
      (
        await pg.query<{ raw_user_meta_data: Record<string, unknown> }>(
          'SELECT * FROM auth.users WHERE id=$1',
          [withoutGuard],
        )
      ).rows[0].raw_user_meta_data,
    ).not.toHaveProperty('passkey')
    await pg.exec(
      'CREATE TRIGGER existing_registration_guard BEFORE INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.check_registration_passkey()',
    )
    await expect(
      pg.query(
        `INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES(gen_random_uuid(),'forged@postal.test','{"postal_enrollment":{}}')`,
      ),
    ).rejects.toThrow('postal_registration_permit_required')
  })
  it('creates drafts with permanent unique QR identities, retries once and copies with fresh identity', async () => {
    await actor(merchant)
    const request = crypto.randomUUID()
    createRequest = request
    shipment = await command('create_shipment', form, request)
    expect(shipment.state).toBe('draft')
    expect(shipment.cod_amount).toBe(-25000)
    expect(await command('create_shipment', form, request)).toEqual(shipment)
    await expect(
      command('create_shipment', { ...form, cod_amount: 1 }, request),
    ).rejects.toThrow('postal_request_conflict')
    const copy = await command('create_shipment', form)
    expect(copy.qr_id).not.toBe(shipment.qr_id)
    const qr = shipment.qr_id
    await move('edit_shipment', { ...form, recipient_name: 'Edited' })
    expect(shipment.qr_id).toBe(qr)
    expect(
      (
        await pg.query('SELECT * FROM public.postal_shipments WHERE qr_id=$1', [
          qr,
        ])
      ).rows,
    ).toHaveLength(1)
  })
  it('enforces workspace and organization privacy including QR and payment metadata', async () => {
    await actor(merchant2)
    expect(
      (
        await pg.query('SELECT * FROM public.postal_shipments WHERE qr_id=$1', [
          shipment.qr_id,
        ])
      ).rows,
    ).toHaveLength(0)
    await expect(move('edit_shipment', form)).rejects.toThrow(
      'postal_unavailable',
    )
    await actor(outsider, other)
    expect(
      (await pg.query('SELECT * FROM public.postal_shipments')).rows,
    ).toHaveLength(0)
    await expect(command('create_shipment', form)).rejects.toThrow(
      'postal_not_authorized',
    )
    await actor(merchant)
    await expect(
      command('create_shipment', { ...form, workspace_id: other }),
    ).rejects.toThrow('postal_workspace_changed')
    await expect(
      pg.query(
        'UPDATE public.postal_shipments SET qr_id=gen_random_uuid() WHERE id=$1',
        [shipment.id],
      ),
    ).rejects.toThrow('permission denied')
    await expect(move('receive', {})).rejects.toThrow('postal_not_authorized')
  })
  it('allows office receipt but reserves branch management and routing for admins', async () => {
    await actor(admin)
    branchA = await command('save_branch', {
      name: 'A',
      governorate: 'erbil',
      area: 'ankawa',
      active: true,
    })
    branchB = await command('save_branch', {
      name: 'B',
      governorate: 'baghdad',
      area: 'karrada',
      active: true,
    })
    await actor(staff)
    await expect(
      command('save_branch', {
        name: 'C',
        governorate: 'erbil',
        area: 'ankawa',
      }),
    ).rejects.toThrow('postal_not_authorized')
    await expect(move('deliver')).rejects.toThrow('postal_invalid_transition')
    await move('receive', { branch_id: branchA.id })
    await expect(move('receive', { branch_id: branchA.id })).rejects.toThrow(
      'postal_invalid_transition',
    )
    await expect(
      move('authorize_transfer', { branch_id: branchB.id }),
    ).rejects.toThrow('postal_invalid_transition')
    await actor(merchant)
    await expect(move('edit_shipment', form)).rejects.toThrow(
      'postal_invalid_transition',
    )
  })
  it('supports repeat transfers, revisits, destination validation and direct delivery', async () => {
    for (const destination of [branchB.id, branchA.id, branchB.id]) {
      await actor(admin)
      await move('authorize_transfer', { branch_id: destination })
      await actor(staff)
      await move('dispatch')
      await expect(
        move('arrive', {
          branch_id: destination === branchA.id ? branchB.id : branchA.id,
        }),
      ).rejects.toThrow('postal_invalid_transition')
      await move('arrive', { branch_id: destination })
    }
    await move('out_for_delivery')
    await move('deliver')
    expect(shipment.state).toBe('delivered')
    expect(
      (
        await pg.query(
          "SELECT * FROM public.postal_events WHERE shipment_id=$1 AND event_type='arrive'",
          [shipment.id],
        )
      ).rows,
    ).toHaveLength(3)
    await actor(merchant)
    const direct = await command('create_shipment', { ...form, cod_amount: 0 })
    await actor(staff)
    let s = await command('receive', {
      id: direct.id,
      revision: direct.revision,
      branch_id: branchA.id,
    })
    s = await command('out_for_delivery', { id: s.id, revision: s.revision })
    s = await command('deliver', { id: s.id, revision: s.revision })
    expect(s.state).toBe('delivered')
  })
  it('keeps delivery and signed COD settlement separate, requiring a real payment transaction', async () => {
    await actor(staff)
    expect(
      (
        await pg.query(
          'SELECT * FROM public.postal_cod_records WHERE shipment_id=$1',
          [shipment.id],
        )
      ).rows,
    ).toHaveLength(0)
    await expect(
      move('collection', {
        signed_amount: -25000,
        direction: 'incoming',
        payment_method: 'cash',
      }),
    ).rejects.toThrow('postal_invalid_payment')
    await move('collection', {
      signed_amount: -25000,
      direction: 'outgoing',
      payment_method: 'cash',
    })
    await expect(
      move('settlement', {
        signed_amount: -25000,
        direction: 'incoming',
        payment_method: 'cash',
      }),
    ).rejects.toThrow('postal_invalid_transition')
    await actor(admin)
    await move('settlement', {
      signed_amount: -25000,
      direction: 'incoming',
      payment_method: 'cash',
    })
    expect(shipment.state).toBe('delivered')
    const payments = await pg.query<{
      direction: string
      amount: string
      currency: string
    }>(
      'SELECT * FROM public.payment_transactions WHERE source_record_id=$1 ORDER BY source_type',
      [shipment.id],
    )
    expect(
      payments.rows.map((x) => [x.direction, Number(x.amount), x.currency]),
    ).toEqual([
      ['outgoing', 25000, 'iqd'],
      ['incoming', 25000, 'iqd'],
    ])
    await expect(
      move('settlement', {
        signed_amount: -1,
        direction: 'incoming',
        payment_method: 'cash',
      }),
    ).rejects.toThrow('postal_invalid_payment')
    await actor(merchant2)
    expect(
      (
        await pg.query(
          'SELECT * FROM public.payment_transactions WHERE source_record_id=$1',
          [shipment.id],
        )
      ).rows,
    ).toHaveLength(0)
  })
  it('rejects history changes, anonymous API access and client-side grant escalation', async () => {
    await pg.exec('RESET ROLE')
    await expect(
      pg.query(
        "UPDATE public.postal_events SET event_type='forged' WHERE shipment_id=$1",
        [shipment.id],
      ),
    ).rejects.toThrow('postal_history_is_immutable')
    await expect(
      pg.query(
        `UPDATE public.workspace_access_overrides SET value='revoke' WHERE workspace_id=$1`,
        [w],
      ),
    ).rejects.toThrow('postal_platform_grant_required')
    const privilege = await pg.query<{ allowed: boolean }>(
      `SELECT has_function_privilege('anon','public.postal_command(text,jsonb,uuid)','EXECUTE') AS allowed`,
    )
    expect(privilege.rows[0].allowed).toBe(false)
    await actor(admin)
    await expect(
      move('edit_shipment', { ...form, cod_amount: -5, reason: 'Correction' }),
    ).rejects.toThrow('postal_cod_locked')
    await expect(
      command('deliver', { id: shipment.id, revision: 1 }),
    ).rejects.toThrow('postal_stale_shipment')
  })
  it('records positive partial payments and database totals without changing delivery', async () => {
    await actor(merchant)
    let positive = await command('create_shipment', {
      ...form,
      cod_amount: 10000,
    })
    await actor(staff)
    const request = crypto.randomUUID()
    const receive = {
      id: positive.id,
      revision: positive.revision,
      branch_id: branchA.id,
    }
    positive = await command('receive', receive, request)
    expect(await command('receive', receive, request)).toEqual(positive)
    await expect(
      command('out_for_delivery', {
        id: positive.id,
        revision: positive.revision,
        driver_id: crypto.randomUUID(),
      }),
    ).rejects.toThrow('postal_driver_unavailable')
    await pg.exec('RESET ROLE')
    const driver = crypto.randomUUID(),
      partner = crypto.randomUUID()
    await pg.query(
      "INSERT INTO crm.business_partners(id,workspace_id,partner_name) VALUES($1,$2,'Delivery Driver')",
      [partner, w],
    )
    await pg.query(
      "INSERT INTO crm.agents(id,workspace_id,business_partner_id,agent_type,status) VALUES($1,$2,$3,'driver','active')",
      [driver, w, partner],
    )
    await actor(staff)
    positive = await command('out_for_delivery', {
      id: positive.id,
      revision: positive.revision,
      driver_id: driver,
    })
    expect(positive.driver_name).toBe('Delivery Driver')
    positive = await command('deliver', {
      id: positive.id,
      revision: positive.revision,
    })
    positive = await command('collection', {
      id: positive.id,
      revision: positive.revision,
      signed_amount: 7000,
      direction: 'incoming',
      payment_method: 'cash',
    })
    await actor(admin)
    positive = await command('settlement', {
      id: positive.id,
      revision: positive.revision,
      signed_amount: 3000,
      direction: 'outgoing',
      payment_method: 'cash',
    })
    const summary = await pg.query<{
      total: { collected: number; settled: number; record_count: number }
    }>('SELECT public.postal_financial_summary($1) AS total', [positive.id])
    expect(summary.rows[0].total).toEqual({
      collected: 7000,
      settled: 3000,
      record_count: 2,
    })
    expect(positive.state).toBe('delivered')
    await expect(
      command('settlement', {
        id: positive.id,
        revision: positive.revision,
        signed_amount: 5000,
        direction: 'outgoing',
        payment_method: 'cash',
      }),
    ).rejects.toThrow('postal_invalid_payment')
    await actor(merchant2)
    expect(
      (
        await pg.query<{ total: unknown }>(
          'SELECT public.postal_financial_summary($1) AS total',
          [positive.id],
        )
      ).rows[0].total,
    ).toBeNull()
  })
  it('rolls back the Auth user, organization, membership and profile if the Auth transaction fails', async () => {
    await pg.exec('RESET ROLE')
    const userId = crypto.randomUUID()
    const before = (
      await pg.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM public.postal_organizations',
      )
    ).rows[0].count
    await pg.exec(`CREATE FUNCTION public.postal_test_auth_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.id='${userId}'::uuid THEN RAISE EXCEPTION 'test_auth_rollback'; END IF; RETURN NEW; END$$;
      CREATE TRIGGER zzzzzzz_postal_test_failure AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.postal_test_auth_failure();`)
    await expect(
      enroll(userId, {
        workspace_id: w,
        actor_id: admin,
        mode: 'create',
        name: 'Rollback organization',
      }),
    ).rejects.toThrow('test_auth_rollback')
    expect(
      (
        await pg.query<{ count: number }>(
          'SELECT count(*)::integer AS count FROM public.postal_organizations',
        )
      ).rows[0].count,
    ).toBe(before)
    expect(
      (await pg.query('SELECT * FROM public.profiles WHERE id=$1', [userId]))
        .rows,
    ).toHaveLength(0)
    expect(
      (await pg.query('SELECT * FROM auth.users WHERE id=$1', [userId])).rows,
    ).toHaveLength(0)
    const grants = await pg.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('authenticated','public.postal_prepare_registration(uuid,text,jsonb)','EXECUTE') AS allowed",
    )
    expect(grants.rows[0].allowed).toBe(false)
    await pg.query('SELECT public.postal_cancel_registration($1)', [userId])
  })
  it('moves merchants with atomic leader reassignment and retains audit history', async () => {
    await actor(admin)
    const organizations = await pg.query<{
      id: string
      code: string
      leader_id: string
    }>('SELECT * FROM public.postal_organizations ORDER BY leader_id')
    const source = organizations.rows.find((x) => x.leader_id === merchant)!
    const destination = organizations.rows.find(
      (x) => x.leader_id === merchant2,
    )!
    await expect(
      command('move_member', { user_id: merchant2, code: source.code }),
    ).rejects.toThrow('postal_replacement_leader_required')
    const replacement = (
      await pg.query<{ user_id: string }>(
        'SELECT user_id FROM public.postal_memberships WHERE organization_id=$1 AND user_id<>$2',
        [source.id, merchant],
      )
    ).rows[0].user_id
    await command('move_member', {
      user_id: merchant,
      code: destination.code,
      replacement_leader_id: replacement,
    })
    const membership = await pg.query<{ organization_id: string }>(
      'SELECT * FROM public.postal_memberships WHERE user_id=$1',
      [merchant],
    )
    expect(membership.rows[0].organization_id).toBe(destination.id)
    const leader = await pg.query<{ leader_id: string }>(
      'SELECT leader_id FROM public.postal_organizations WHERE id=$1',
      [source.id],
    )
    expect(leader.rows[0].leader_id).toBe(replacement)
    expect(
      (
        await pg.query(
          "SELECT * FROM public.postal_admin_audit WHERE action='move_member'",
        )
      ).rows,
    ).toHaveLength(1)
    await actor(merchant)
    await expect(
      command('create_shipment', form, createRequest),
    ).rejects.toThrow('postal_unavailable')
    expect(
      (
        await pg.query('SELECT * FROM public.postal_shipments WHERE id=$1', [
          shipment.id,
        ])
      ).rows,
    ).toHaveLength(0)
  })
  it('cannot create orphaned organizations, mutate payment history or operate after grant revocation', async () => {
    await pg.exec('RESET ROLE')
    const invalid = crypto.randomUUID()
    await expect(
      enroll(invalid, {
        workspace_id: w,
        actor_id: admin,
        mode: 'join',
        code: 'ZZZZZZZZ',
      }),
    ).rejects.toThrow('postal_invalid_organization')
    expect(
      (await pg.query('SELECT * FROM public.profiles WHERE id=$1', [invalid]))
        .rows,
    ).toHaveLength(0)
    await expect(
      pg.query(
        'UPDATE public.payment_transactions SET amount=1 WHERE source_record_id=$1',
        [shipment.id],
      ),
    ).rejects.toThrow('postal_history_is_immutable')
    await pg.query(
      "SELECT set_config('request.jwt.claim.role','service_role',false)",
    )
    await pg.query(
      "UPDATE public.workspace_access_overrides SET value='revoke' WHERE workspace_id=$1",
      [w],
    )
    await actor(staff)
    expect(
      (await pg.query('SELECT * FROM public.postal_shipments')).rows,
    ).toHaveLength(0)
    await expect(
      command('receive', {
        id: shipment.id,
        revision: shipment.revision,
        branch_id: branchA.id,
      }),
    ).rejects.toThrow('postal_not_authorized')
  })
  it('keeps every module table protected and exposes only invoker RPC wrappers', async () => {
    await pg.exec('RESET ROLE')
    const tables = await pg.query<{
      relname: string
      relrowsecurity: boolean
      anonymous: boolean
      writes: boolean
    }>(`SELECT c.relname,c.relrowsecurity,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS anonymous,
      has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE') AS writes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'postal_%'`)
    expect(tables.rows.length).toBeGreaterThan(8)
    expect(
      tables.rows.every((x) => x.relrowsecurity && !x.anonymous && !x.writes),
    ).toBe(true)
    const rpc = await pg.query<{ prosecdef: boolean; anonymous: boolean }>(
      `SELECT p.prosecdef,has_function_privilege('anon',p.oid,'EXECUTE') AS anonymous FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('postal_command','postal_financial_summary','postal_prepare_registration','postal_cancel_registration','postal_dashboard_summary')`,
    )
    expect(
      (
        await pg.query(
          "SELECT * FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename LIKE 'postal_%'",
        )
      ).rows,
    ).toHaveLength(7)
    expect(rpc.rows).toHaveLength(5)
    expect(rpc.rows.every((x) => !x.prosecdef && !x.anonymous)).toBe(true)
  })
})
