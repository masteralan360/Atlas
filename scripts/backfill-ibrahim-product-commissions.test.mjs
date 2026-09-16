import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const migration = readFileSync(new URL('../supabase/migrations/20260916011840_backfill_ibrahim_missing_product_commissions.sql', import.meta.url), 'utf8')
const targets = [
  ['SO-2026-00010', 20, 40, 12700, '2026-09-03T05:40:30.510Z'],
  ['SO-2026-00013', 20, 37, 12300, '2026-09-03T13:14:07.470Z'],
  ['SO-2026-00029', 24, 40, 11700, '2026-09-06T12:24:41.092Z'],
  ['SO-2026-00033', 11, 17, 4600, '2026-09-07T05:18:56.954Z'],
  ['SO-2026-00039', 19, 30, 10350, '2026-09-08T09:10:32.356Z'],
  ['SO-2026-00041', 28, 60, 18750, '2026-09-09T05:15:32.620Z'],
]
let pg
let workspaceId
let agentId
let actorId

// Exercise the real migration SQL on PostgreSQL. The isolated reconciler is
// an explicit test boundary; the deployed reconciler is separately verified
// with the same migration and rollback-only transactions before application.
const fixtureSchema = `
  CREATE SCHEMA crm;
  CREATE SCHEMA auth;
  CREATE TABLE workspaces (id uuid PRIMARY KEY, name text, deleted_at timestamptz, data_mode text, sales_agent_commission_mode text, plan text);
  CREATE TABLE profiles (id uuid PRIMARY KEY, current_workspace uuid, role text);
  CREATE TABLE crm.business_partners (id uuid PRIMARY KEY, workspace_id uuid, partner_name text, is_deleted boolean DEFAULT false, balance numeric DEFAULT 0);
  CREATE TABLE crm.agents (id uuid PRIMARY KEY, workspace_id uuid, business_partner_id uuid, agent_type text, status text, is_deleted boolean DEFAULT false);
  CREATE TABLE crm.sales_orders (id uuid PRIMARY KEY, workspace_id uuid, order_number text, items jsonb, status text, commission_enabled boolean, commission_mode text, currency text, return_status text, sales_account_agent_id uuid, actual_delivery_date timestamptz, paid_at timestamptz, updated_at timestamptz, created_by uuid, is_deleted boolean DEFAULT false, version integer DEFAULT 1, sync_status text DEFAULT 'synced');
  CREATE TABLE crm.sales_order_agent_assignments (id uuid PRIMARY KEY, workspace_id uuid, order_id uuid, agent_id uuid, assigned_at timestamptz, unassigned_at timestamptz, assignment_source text, manual_commission_type text, is_deleted boolean DEFAULT false);
  CREATE TABLE crm.product_commission_rules (id uuid PRIMARY KEY, workspace_id uuid, product_id uuid, commission_type text, fixed_amount numeric, fixed_currency text, recipient_scope text, effective_from timestamptz, effective_to timestamptz, is_active boolean DEFAULT true, is_deleted boolean DEFAULT false);
  CREATE TABLE crm.agent_commission_memberships (id uuid PRIMARY KEY, workspace_id uuid, agent_id uuid, effective_from timestamptz, effective_to timestamptz, is_deleted boolean DEFAULT false);
  CREATE TABLE crm.agent_product_commission_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid, order_id uuid, assignment_id uuid, agent_id uuid, order_item_id text, product_id uuid, rule_id uuid, unit_snapshot text, quantity numeric, commission_per_unit numeric, amount numeric, occurred_at timestamptz, kind text DEFAULT 'accrual', status text DEFAULT 'earned', commission_mode text DEFAULT 'tracked', currency text DEFAULT 'iqd', order_return_id uuid, is_deleted boolean DEFAULT false);
  CREATE TABLE crm.agent_commission_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid, order_id uuid, assignment_id uuid, agent_id uuid, amount numeric, product_commission_amount numeric, plan_commission_amount numeric DEFAULT 0, occurred_at timestamptz, kind text DEFAULT 'accrual', status text DEFAULT 'earned', commission_mode text DEFAULT 'tracked', currency text DEFAULT 'iqd', is_deleted boolean DEFAULT false);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE FUNCTION workspace_module_allowed(uuid,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  CREATE FUNCTION backfill_test_order_update() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF current_setting('backfill.test_failure', true) = 'id_payment' THEN
      INSERT INTO payment_transactions (id,workspace_id,amount) VALUES (gen_random_uuid(),NEW.workspace_id,1);
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER backfill_test_order_update BEFORE UPDATE ON crm.sales_orders FOR EACH ROW EXECUTE FUNCTION backfill_test_order_update();
  CREATE FUNCTION reconcile_sales_agent_commission(p_order_id uuid,p_return_id uuid) RETURNS integer LANGUAGE plpgsql AS $$
  DECLARE o crm.sales_orders%ROWTYPE; s crm.sales_order_agent_assignments%ROWTYPE;
  BEGIN
    IF current_setting('backfill.test_failure', true) = 'server' THEN RAISE EXCEPTION 'Reconciliation unavailable'; END IF;
    SELECT * INTO STRICT o FROM crm.sales_orders WHERE id = p_order_id;
    SELECT * INTO STRICT s FROM crm.sales_order_agent_assignments WHERE order_id = o.id;
    IF auth.uid() IS DISTINCT FROM o.created_by THEN RAISE EXCEPTION 'Incorrect administrator context'; END IF;
    INSERT INTO crm.agent_product_commission_entries (workspace_id,order_id,assignment_id,agent_id,order_item_id,product_id,rule_id,unit_snapshot,quantity,commission_per_unit,amount,occurred_at)
      SELECT o.workspace_id,o.id,s.id,s.agent_id,i.value->>'id',r.product_id,r.id,i.value->>'unit',
        (i.value->>'quantity')::numeric,round(r.fixed_amount,6),round((i.value->>'quantity')::numeric*round(r.fixed_amount,6),6),
        greatest(s.assigned_at,o.actual_delivery_date)
      FROM jsonb_array_elements(o.items) i(value) JOIN crm.product_commission_rules r ON r.product_id::text=i.value->>'productId'
      WHERE r.is_active AND NOT r.is_deleted AND r.effective_from<=o.actual_delivery_date
        AND (r.effective_to IS NULL OR r.effective_to>o.actual_delivery_date);
    INSERT INTO crm.agent_commission_entries (workspace_id,order_id,assignment_id,agent_id,amount,product_commission_amount,occurred_at)
      SELECT o.workspace_id,o.id,s.id,s.agent_id,sum(amount),sum(amount),greatest(s.assigned_at,o.actual_delivery_date)
      FROM crm.agent_product_commission_entries WHERE order_id=o.id;
    IF current_setting('backfill.test_failure', true) = 'payment' THEN
      INSERT INTO payment_transactions (id,workspace_id,amount) VALUES (gen_random_uuid(),o.workspace_id,1);
    ELSIF current_setting('backfill.test_failure', true) = 'inventory' THEN
      UPDATE inventory_transactions SET amount=amount-1 WHERE workspace_id=o.workspace_id;
    ELSIF current_setting('backfill.test_failure', true) = 'balance' THEN
      UPDATE crm.business_partners SET balance=balance+1 WHERE workspace_id=o.workspace_id;
    ELSIF current_setting('backfill.test_failure', true) = 'wrong_amount' THEN
      UPDATE crm.agent_commission_entries SET amount=amount+1 WHERE order_id=o.id;
    END IF;
    RETURN 1;
  END $$;
`
const protectedTables = ['crm.purchase_orders', 'crm.product_commission_rule_agents', 'products', 'inventory_transactions', 'payment_transactions', 'loans', 'loan_payments', 'loan_installments', 'order_returns', 'order_return_items']

beforeAll(async () => {
  pg = await PGlite.create()
  await pg.exec(fixtureSchema)
  for (const table of protectedTables) await pg.exec(`CREATE TABLE ${table} (id uuid PRIMARY KEY, workspace_id uuid, amount numeric DEFAULT 0);`)
}, 30000)
afterAll(async () => { await pg?.close() })
beforeEach(async () => {
  await pg.exec(`TRUNCATE workspaces,profiles,crm.business_partners,crm.agents,crm.sales_orders,crm.sales_order_agent_assignments,crm.product_commission_rules,crm.agent_commission_memberships,crm.agent_product_commission_entries,crm.agent_commission_entries,${protectedTables.join(',')};`)
  await pg.exec(`SELECT set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claims','',false),set_config('request.jwt.claim.role','',false),set_config('backfill.test_failure','',false);`)
  workspaceId = randomUUID(); agentId = randomUUID(); actorId = randomUUID()
  const partnerId = randomUUID()
  await pg.query('INSERT INTO workspaces VALUES ($1,$2,NULL,$3,$4,$5)', [workspaceId, 'کۆگای حەسەن مامەد', 'hybrid', 'tracked', 'enterprise'])
  await pg.query('INSERT INTO profiles VALUES ($1,$2,$3)', [actorId, workspaceId, 'admin'])
  await pg.query('INSERT INTO crm.business_partners (id,workspace_id,partner_name,balance) VALUES ($1,$2,$3,30000)', [partnerId, workspaceId, 'مندوب ابراهيم'])
  await pg.query('INSERT INTO crm.agents (id,workspace_id,business_partner_id,agent_type,status) VALUES ($1,$2,$3,$4,$5)', [agentId, workspaceId, partnerId, 'field_agent', 'active'])
  for (const [reference, count, quantity, total, fulfilledAt] of targets) {
    const items = []
    const baseRate = 200
    for (let index = 0; index < count; index++) {
      const productId = randomUUID()
      const lineQuantity = index === 0 ? quantity - count + 1 : 1
      const rate = index === 1 ? total - (quantity - 1) * baseRate : baseRate
      items.push({ id: `legacy-${productId}-storage-${index}`, productId, quantity: lineQuantity, fulfilledQuantity: lineQuantity, unit: 'carton' })
      await pg.query('INSERT INTO crm.product_commission_rules (id,workspace_id,product_id,commission_type,fixed_amount,fixed_currency,recipient_scope,effective_from) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), workspaceId, productId, 'fixed_amount', rate, 'iqd', 'all_assigned', '2026-08-29T00:00:00Z'])
    }
    const orderId = randomUUID()
    await pg.query(`INSERT INTO crm.sales_orders (id,workspace_id,order_number,items,status,commission_enabled,commission_mode,currency,return_status,sales_account_agent_id,actual_delivery_date,updated_at,created_by) VALUES ($1,$2,$3,$4,'completed',true,'tracked','iqd','none',$5,$6,$6,$7)`, [orderId, workspaceId, reference, JSON.stringify(items), agentId, fulfilledAt, actorId])
    await pg.query(`INSERT INTO crm.sales_order_agent_assignments (id,workspace_id,order_id,agent_id,assigned_at,assignment_source) VALUES ($1,$2,$3,$4,$5,'sales_account')`, [randomUUID(), workspaceId, orderId, agentId, '2026-09-01T00:00:00Z'])
  }
  for (const table of protectedTables) await pg.query(`INSERT INTO ${table} (id,workspace_id,amount) VALUES ($1,$2,100)`, [randomUUID(), workspaceId])
  // An unrelated recorded commission must retain its exact values.
  await pg.query('INSERT INTO crm.agent_commission_entries (workspace_id,order_id,agent_id,amount) VALUES ($1,$2,$3,158100)', [workspaceId, randomUUID(), agentId])
})

async function apply(sql = migration) { await pg.exec(sql) }
async function counts() {
  return (await pg.query('SELECT (SELECT count(*)::int FROM crm.agent_product_commission_entries) AS lines,(SELECT count(*)::int FROM crm.agent_commission_entries) AS aggregates')).rows[0]
}

describe('Ibrahim targeted product commission backfill', () => {
  it('records 122 lines and six tracked accruals at historical rates, preserving payments, balances and inventory', async () => {
    await apply()
    expect(await counts()).toEqual({ lines: 122, aggregates: 7 })
    const totals = (await pg.query('SELECT o.order_number,sum(c.amount)::float AS amount FROM crm.agent_product_commission_entries c JOIN crm.sales_orders o ON o.id=c.order_id GROUP BY o.order_number ORDER BY o.order_number')).rows
    expect(totals).toEqual(targets.map(([order_number,,,amount]) => ({ order_number, amount })))
    expect((await pg.query('SELECT sum(amount)::float AS amount FROM crm.agent_commission_entries')).rows[0].amount).toBe(228500)
    expect((await pg.query('SELECT balance::float AS balance FROM crm.business_partners')).rows[0].balance).toBe(30000)
    for (const table of protectedTables) expect((await pg.query(`SELECT amount::float AS amount FROM ${table}`)).rows[0].amount).toBe(100)
  })
  it('replays without any new or changed commission entries, including within one transaction', async () => {
    await apply(`BEGIN; ${migration} ${migration} COMMIT;`)
    const before = (await pg.query('SELECT jsonb_agg(to_jsonb(c) ORDER BY id) AS entries FROM crm.agent_product_commission_entries c')).rows[0].entries
    await apply()
    expect(await counts()).toEqual({ lines: 122, aggregates: 7 })
    expect((await pg.query('SELECT jsonb_agg(to_jsonb(c) ORDER BY id) AS entries FROM crm.agent_product_commission_entries c')).rows[0].entries).toEqual(before)
  })
  it('restores the previous actor and claims after reconciliation', async () => {
    const previous = randomUUID()
    await pg.query(`SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false),set_config('request.jwt.claim.role','service_role',false)`, [previous, JSON.stringify({ sub: previous, role: 'service_role' })])
    await apply()
    expect((await pg.query(`SELECT current_setting('request.jwt.claim.sub') AS sub,current_setting('request.jwt.claim.role') AS role`)).rows[0]).toEqual({ sub: previous, role: 'service_role' })
  })
  it('is a no-op when the target workspace is absent', async () => {
    await pg.exec('DELETE FROM workspaces')
    await apply()
    expect(await counts()).toEqual({ lines: 0, aggregates: 1 })
  })
  it.each([
    ['ambiguous workspace', `INSERT INTO workspaces SELECT gen_random_uuid(),name,deleted_at,data_mode,sales_agent_commission_mode,plan FROM workspaces`, 'one target workspace'],
    ['payable mode', `UPDATE workspaces SET sales_agent_commission_mode='payable'`, 'enabled tracked commissions'],
    ['missing order', `DELETE FROM crm.sales_orders WHERE order_number='SO-2026-00010'`, 'one audited order'],
    ['unavailable actor', `UPDATE profiles SET current_workspace=gen_random_uuid()`, 'administrator context'],
    ['changed rate', `UPDATE crm.product_commission_rules SET fixed_amount=fixed_amount+1`, 'Historical product commission terms'],
    ['expired rule', `UPDATE crm.product_commission_rules SET effective_to='2026-09-02'`, 'Historical product commission terms'],
    ['future rule', `UPDATE crm.product_commission_rules SET effective_from='2026-10-01'`, 'Historical product commission terms'],
    ['recipient changed', `UPDATE crm.product_commission_rules SET recipient_scope='selected_assigned'`, 'Historical product commission terms'],
    ['return', `UPDATE crm.sales_orders SET return_status='partial' WHERE order_number='SO-2026-00010'`, 'Audited order state changed'],
    ['fractional quantity drift', `UPDATE crm.sales_orders SET items=jsonb_set(items,'{0,quantity}','1.000001') WHERE order_number='SO-2026-00010'`, 'Historical product commission terms'],
    ['bonus product', `UPDATE crm.sales_orders SET items=jsonb_set(items,'{0,freeBonusQuantity}','1') WHERE order_number='SO-2026-00010'`, 'Historical product commission terms'],
    ['unfulfilled quantity', `UPDATE crm.sales_orders SET items=jsonb_set(items,'{0,fulfilledQuantity}','0') WHERE order_number='SO-2026-00010'`, 'Historical product commission terms'],
  ])('rejects %s before recording commissions', async (_, setup, error) => {
    await pg.exec(setup)
    await expect(apply()).rejects.toThrow(error)
    expect(await counts()).toEqual({ lines: 0, aggregates: 1 })
  })
  it.each(['payment', 'inventory', 'balance'])('rolls back a reconciliation that changes protected %s records', async failure => {
    await pg.query(`SELECT set_config('backfill.test_failure',$1,false)`, [failure])
    await expect(apply()).rejects.toThrow('changed protected records')
    expect(await counts()).toEqual({ lines: 0, aggregates: 1 })
    expect((await pg.query('SELECT balance::float AS balance FROM crm.business_partners')).rows[0].balance).toBe(30000)
    expect((await pg.query('SELECT sum(amount)::float AS amount FROM payment_transactions')).rows[0].amount).toBe(100)
    expect((await pg.query('SELECT sum(amount)::float AS amount FROM inventory_transactions')).rows[0].amount).toBe(100)
  })
  it.each(['server', 'wrong_amount'])('rolls back when reconciliation fails: %s', async failure => {
    await pg.query(`SELECT set_config('backfill.test_failure',$1,false)`, [failure])
    await expect(apply()).rejects.toThrow(failure === 'server' ? 'Reconciliation unavailable' : 'aggregate commission does not match')
    expect(await counts()).toEqual({ lines: 0, aggregates: 1 })
  })
  it('rejects a partial recovery instead of adding commissions to it', async () => {
    await pg.exec(`INSERT INTO crm.agent_product_commission_entries (workspace_id,order_id,agent_id,order_item_id) SELECT workspace_id,id,sales_account_agent_id,'unrelated' FROM crm.sales_orders WHERE order_number='SO-2026-00010'`)
    await expect(apply()).rejects.toThrow('product entries do not match')
    expect(await counts()).toEqual({ lines: 1, aggregates: 1 })
  })
  it('rounds the locked fixed rate to six places before multiplying', async () => {
    await pg.exec('UPDATE crm.product_commission_rules SET fixed_amount=fixed_amount+0.0000004')
    await apply()
    expect((await pg.query('SELECT sum(amount)::float AS amount FROM crm.agent_product_commission_entries')).rows[0].amount).toBe(70400)
  })
  it('repairs the audited duplicate ID while preserving both rows, quantities, and business data on replay', async () => {
    // Replace two synthetic one-carton lines with an identical product/ID.
    // Their equal rates leave this order's audited 4,600 IQD unchanged.
    await pg.exec(`UPDATE crm.sales_orders SET items=jsonb_set(items,'{3}',items->2) WHERE order_number='SO-2026-00033'`)
    const before = (await pg.query(`SELECT items FROM crm.sales_orders WHERE order_number='SO-2026-00033'`)).rows[0].items
    await apply()
    const after = (await pg.query(`SELECT items,version FROM crm.sales_orders WHERE order_number='SO-2026-00033'`)).rows[0]
    expect(after.version).toBe(2)
    expect(new Set(after.items.map(item => item.id)).size).toBe(11)
    const businessFields = item => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'id'))
    expect(after.items.map(businessFields)).toEqual(before.map(businessFields))
    expect((await pg.query(`SELECT sum(amount)::float AS amount FROM crm.agent_product_commission_entries c JOIN crm.sales_orders o ON o.id=c.order_id WHERE o.order_number='SO-2026-00033'`)).rows[0].amount).toBe(4600)
    await apply()
    expect((await pg.query(`SELECT items,version FROM crm.sales_orders WHERE order_number='SO-2026-00033'`)).rows[0]).toEqual(after)
  })
  it('rejects duplicate IDs on any other order', async () => {
    await pg.exec(`UPDATE crm.sales_orders SET items=jsonb_set(items,'{3}',items->2) WHERE order_number='SO-2026-00010'`)
    await expect(apply()).rejects.toThrow('Unexpected duplicate product line IDs')
    expect(await counts()).toEqual({ lines: 0, aggregates: 1 })
  })
  it('rolls back the ID repair if subsequent reconciliation fails', async () => {
    await pg.exec(`UPDATE crm.sales_orders SET items=jsonb_set(items,'{3}',items->2) WHERE order_number='SO-2026-00033'`)
    const before = (await pg.query(`SELECT items,version FROM crm.sales_orders WHERE order_number='SO-2026-00033'`)).rows[0]
    await pg.exec(`SELECT set_config('backfill.test_failure','server',false)`)
    await expect(apply()).rejects.toThrow('Reconciliation unavailable')
    expect((await pg.query(`SELECT items,version FROM crm.sales_orders WHERE order_number='SO-2026-00033'`)).rows[0]).toEqual(before)
  })
  it('rolls back an unexpected payment caused by a line-ID update trigger', async () => {
    await pg.exec(`UPDATE crm.sales_orders SET items=jsonb_set(items,'{3}',items->2) WHERE order_number='SO-2026-00033'`)
    const before = (await pg.query(`SELECT items,version FROM crm.sales_orders WHERE order_number='SO-2026-00033'`)).rows[0]
    await pg.exec(`SELECT set_config('backfill.test_failure','id_payment',false)`)
    await expect(apply()).rejects.toThrow('changed protected records')
    expect(await counts()).toEqual({ lines: 0, aggregates: 1 })
    expect((await pg.query('SELECT sum(amount)::float AS amount FROM payment_transactions')).rows[0].amount).toBe(100)
    expect((await pg.query(`SELECT items,version FROM crm.sales_orders WHERE order_number='SO-2026-00033'`)).rows[0]).toEqual(before)
  })
})
