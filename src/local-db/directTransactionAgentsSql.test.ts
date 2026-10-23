import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const workspace = '00000000-0000-4000-8000-000000000801'
const partner = '00000000-0000-4000-8000-000000000802'
const agent = '00000000-0000-4000-8000-000000000803'
const actor = '00000000-0000-4000-8000-000000000804'
const original = '00000000-0000-4000-8000-000000000805'
let pg: PGlite

describe('direct Agent payments: database boundary', () => {
  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE SCHEMA auth; CREATE SCHEMA crm; CREATE SCHEMA private;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
      CREATE FUNCTION public.current_workspace_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${workspace}'::uuid $$;
      CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql AS $$ SELECT COALESCE(nullif(current_setting('test.role',true),''),'admin') $$;
      CREATE TABLE public.workspaces(id uuid PRIMARY KEY, plan text DEFAULT 'enterprise', deleted_at timestamptz);
      INSERT INTO public.workspaces(id) VALUES('${workspace}');
      CREATE FUNCTION public.workspace_module_allowed(uuid,text,text) RETURNS boolean LANGUAGE sql AS $$
        SELECT COALESCE(nullif(current_setting('test.module.'||$3,true),''),'true')::boolean $$;
      CREATE FUNCTION public.workspace_capability_allowed(uuid,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION private.current_user_has_workspace_permission(uuid,text) RETURNS boolean LANGUAGE sql AS $$
        SELECT COALESCE(nullif(current_setting('test.permission',true),''),'true')::boolean $$;
      CREATE FUNCTION public.workspace_get_override_value(uuid,text,text) RETURNS text LANGUAGE sql AS $$
        SELECT COALESCE(nullif(current_setting('test.privacy',true),''),'revoke') $$;
      CREATE TABLE crm.business_partners(id uuid PRIMARY KEY,workspace_id uuid, partner_name text, phone text, city text,
        role text, agent_facet_id uuid, merged_into_business_partner_id uuid,is_deleted boolean DEFAULT false,
        default_currency text DEFAULT 'usd',version int DEFAULT 1);
      CREATE TABLE crm.agents(id uuid PRIMARY KEY,workspace_id uuid,business_partner_id uuid,agent_type text,
        status text DEFAULT 'active',zone text,custom_agent_type_id uuid,is_deleted boolean DEFAULT false,version int DEFAULT 1);
      CREATE TABLE crm.agent_types(id uuid PRIMARY KEY,workspace_id uuid,name text,mode text,is_deleted boolean DEFAULT false,version int DEFAULT 1);
      CREATE TABLE crm.business_partner_groups(id uuid,workspace_id uuid,access_type text,is_deleted boolean DEFAULT false);
      CREATE TABLE crm.business_partner_group_users(group_id uuid,workspace_id uuid,user_id uuid,is_deleted boolean DEFAULT false);
      CREATE TABLE crm.business_partner_group_partners(group_id uuid,workspace_id uuid,business_partner_id uuid,is_deleted boolean DEFAULT false);
      CREATE FUNCTION crm.can_access_business_partner(uuid,uuid,text) RETURNS boolean LANGUAGE sql AS $$
        SELECT EXISTS(SELECT 1 FROM crm.business_partners WHERE id=$2 AND workspace_id=$1 AND NOT is_deleted)
          AND COALESCE(nullif(current_setting('test.group_access',true),''),'true')::boolean $$;
      CREATE TABLE public.payment_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,
        source_module text DEFAULT 'payments',source_type text DEFAULT 'direct_transaction',source_record_id uuid NOT NULL,
        source_subrecord_id uuid,direction text DEFAULT 'outgoing',amount numeric,currency text DEFAULT 'usd',
        payment_method text DEFAULT 'cash',paid_at timestamptz DEFAULT now(),account_id uuid,
        account_name_snapshot text,counterparty_name text,reference_label text DEFAULT 'Advance',note text,
        reversal_of_transaction_id uuid,voucher_number bigint,metadata jsonb DEFAULT '{}',created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),version int DEFAULT 1,is_deleted boolean DEFAULT false,void_id uuid,created_by uuid);
      INSERT INTO crm.business_partners(id,workspace_id,partner_name,role,agent_facet_id) VALUES
        ('${partner}','${workspace}','Agent Alpha','agent','${agent}');
      INSERT INTO crm.agents(id,workspace_id,business_partner_id,agent_type,zone) VALUES
        ('${agent}','${workspace}','${partner}','driver','North');
    `)
    await pg.exec(readFileSync(new URL('../../supabase/migrations/20261023150110_direct_transaction_agent_counterparties.sql', import.meta.url), 'utf8'))
  }, 60_000)
  afterAll(async () => { await pg?.close() })

  it('pages eligible Agents, independently of CRM, and enforces access before filtering', async () => {
    await pg.exec(`SET test.module.business_partners='false';`)
    const result = await pg.query<{ page: { totalCount: number; items: Array<{ partner: { id: string }; agent: { id: string } }> } }>(
      `SELECT crm.list_direct_transaction_counterparties_page('${workspace}','agents','North',1,1) AS page`)
    expect(result.rows[0].page.totalCount).toBe(1)
    expect(result.rows[0].page.items[0].partner.id).toBe(partner)
    expect(result.rows[0].page.items[0].agent.id).toBe(agent)
    await pg.exec(`UPDATE crm.agents SET status='inactive' WHERE id='${agent}'`)
    const inactive = await pg.query<{ page: { totalCount: number } }>(`SELECT crm.list_direct_transaction_counterparties_page('${workspace}','agents',NULL,1,1) AS page`)
    expect(inactive.rows[0].page.totalCount).toBe(0)
    await pg.exec(`UPDATE crm.agents SET status='active'; SET test.role='staff'; SET test.permission='false';`)
    await expect(pg.query(`SELECT crm.list_direct_transaction_counterparties_page('${workspace}')`)).rejects.toThrow('direct_transaction_access_denied')
    await pg.exec(`SET test.role='admin'; SET test.permission='true';`)
    await expect(pg.query(`SELECT crm.list_direct_transaction_counterparties_page('00000000-0000-4000-8000-000000000899')`)).rejects.toThrow('direct_transaction_access_denied')
  })

  it('resolves canonical identity and rejects forged IDs, inaccessible partners and incompatible effects', async () => {
    const insert = (metadata: object, id: string = crypto.randomUUID()) => pg.query(`INSERT INTO public.payment_transactions
      (id,workspace_id,source_record_id,source_subrecord_id,amount,counterparty_name,metadata)
      VALUES($1,$2,$1,$3,100,'Spoofed name',$4::jsonb) RETURNING *`, [id, workspace, partner, JSON.stringify(metadata)])
    await expect(insert({ businessPartnerId: partner, agentId: partner, partnerAccountEffect: 'increase_receivable' })).rejects.toThrow('direct_counterparty_unavailable')
    await expect(insert({ businessPartnerId: partner, partnerAccountEffect: 'increase_payable' })).rejects.toThrow('invalid_direct_transaction')
    await pg.exec(`SET test.group_access='false'`)
    await expect(insert({ businessPartnerId: partner, partnerAccountEffect: 'none' })).rejects.toThrow('direct_counterparty_unavailable')
    await pg.exec(`SET test.group_access='true'`)
    const result = await insert({ businessPartnerId: partner, partnerAccountEffect: 'increase_receivable' }, original)
    expect(result.rows[0]).toMatchObject({ counterparty_name: 'Agent Alpha', metadata: {
      businessPartnerId: partner, agentId: agent, counterpartyKind: 'agent', agentTypeSnapshot: 'driver', partnerAccountEffect: 'increase_receivable' } })
    await expect(pg.query(`UPDATE public.payment_transactions SET amount=99 WHERE id='${original}'`)).rejects.toThrow('direct_transaction_immutable')
  })

  it('supports exact retries and immutable partial/full reversals after retiring the Agent', async () => {
    await pg.exec(`UPDATE crm.agents SET status='blocked'; SET test.module.agents='false';`)
    await pg.exec(`INSERT INTO public.payment_transactions SELECT * FROM public.payment_transactions WHERE id='${original}' ON CONFLICT(id) DO UPDATE SET amount=EXCLUDED.amount;`)
    const reverse = async (amount: number) => pg.query(`INSERT INTO public.payment_transactions
      (id,workspace_id,source_record_id,source_subrecord_id,direction,amount,currency,reversal_of_transaction_id)
      VALUES(gen_random_uuid(),$1,$2,$3,'outgoing',$4,'usd',$2) RETURNING *`, [workspace, original, partner, -amount])
    expect((await reverse(30)).rows[0]).toMatchObject({ amount: '-30', counterparty_name: 'Agent Alpha',
      metadata: { agentId: agent, counterpartyKind: 'agent', reversal: true } })
    const page = await pg.query<{ page: { totalCount: number; items: Array<{ transaction: { id: string }; reversedAmount: number; canReverse: boolean }> } }>(
      `SELECT crm.list_direct_transactions_page('${workspace}',NULL,'all',NULL,NULL,1,1) AS page`)
    expect(page.rows[0].page.totalCount).toBe(2)
    // Restrict to the original's reason: aggregates still include its off-page reversals.
    const state = await pg.query<{ page: { items: Array<{ reversedAmount: number }> } }>(
      `SELECT crm.list_direct_transactions_page('${workspace}','Advance','all',NULL,NULL,1,100) AS page`)
    expect(state.rows[0].page.items.some(item => item.reversedAmount === 30)).toBe(true)
    await expect(reverse(71)).rejects.toThrow('invalid_direct_transaction_reversal')
    await reverse(70)
    const total = await pg.query<{ total: string }>(`SELECT sum(amount) AS total FROM public.payment_transactions WHERE source_record_id='${original}'`)
    expect(Number(total.rows[0].total)).toBe(0)
    await pg.exec(`UPDATE crm.business_partners SET is_deleted=true WHERE id='${partner}'`)
    expect((await pg.query<{ page: { totalCount: number } }>(`SELECT crm.list_direct_transactions_page('${workspace}') AS page`)).rows[0].page.totalCount).toBe(3)
    await pg.exec(`SET test.privacy='grant'; SET test.role='staff'`)
    expect((await pg.query<{ page: { totalCount: number } }>(`SELECT crm.list_direct_transactions_page('${workspace}') AS page`)).rows[0].page.totalCount).toBe(0)
  })

  it('denies anonymous function execution and keeps implementation helpers outside exposed schemas', async () => {
    const grants = await pg.query<{ allowed: boolean }>(`SELECT has_function_privilege('anon','crm.list_direct_transactions_page(uuid,text,text,timestamptz,timestamptz,integer,integer)','EXECUTE') AS allowed`)
    expect(grants.rows[0].allowed).toBe(false)
    const api = await pg.query<{ definer: boolean }>(`SELECT prosecdef AS definer FROM pg_proc WHERE oid='crm.list_direct_transaction_counterparties_page(uuid,text,text,integer,integer,uuid)'::regprocedure`)
    expect(api.rows[0].definer).toBe(false)
    await pg.exec('GRANT USAGE ON SCHEMA crm TO authenticated; SET ROLE authenticated;')
    expect((await pg.query<{ page: { totalCount: number } }>(`SELECT crm.list_direct_transactions_page('${workspace}') AS page`)).rows[0].page.totalCount).toBe(0)
    await pg.exec('RESET ROLE;')
  })
})
