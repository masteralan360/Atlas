import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const migration = readFileSync(new URL('../supabase/migrations/20260916023724_recover_other_agents_product_commissions.sql', import.meta.url), 'utf8')
const targets = JSON.parse(readFileSync(new URL('./fixtures/other-agents-commission-recovery.json', import.meta.url), 'utf8'))
const creatorFunction = migration.slice(0, migration.indexOf('-- Creator/delivery assignments'))
const productReconciler = readFileSync(new URL('./fixtures/product-commission-reconciler-before-recovery.sql', import.meta.url), 'utf8')
let pg, workspace, admin
const agents = new Map()
const protectedTables = ['crm.purchase_orders', 'crm.product_commission_rule_agents', 'products',
  'inventory', 'inventory_transactions', 'inventory_transfer_transactions', 'payment_transactions',
  'loans', 'loan_payments', 'loan_installments', 'order_returns', 'order_return_items',
  'sale_returns', 'sale_return_items', 'installment_sale_payments']

// Run the actual SQL migration and actual creator-assignment helper on PostgreSQL.
// Run the deployed product reconciler snapshot as well as its actual migration patch.
// The public wrapper below is the normal-plan boundary with failure injection.
// The complete deployed engine is also rehearsed with this migration under ROLLBACK.
const schema = `
CREATE SCHEMA crm; CREATE SCHEMA private; CREATE SCHEMA auth;
CREATE TABLE workspaces (id uuid PRIMARY KEY,name text,deleted_at timestamptz,data_mode text,sales_agent_commission_mode text,plan text);
CREATE TABLE profiles (id uuid PRIMARY KEY,current_workspace uuid,role text);
CREATE TABLE crm.business_partners (id uuid PRIMARY KEY,workspace_id uuid,partner_name text,is_deleted boolean DEFAULT false,balance numeric DEFAULT 30000);
CREATE TABLE crm.agents (id uuid PRIMARY KEY,workspace_id uuid,business_partner_id uuid,linked_user_id uuid,agent_type text,status text,is_deleted boolean DEFAULT false);
CREATE TABLE crm.sales_orders (id uuid PRIMARY KEY,workspace_id uuid,order_number text,items jsonb,status text,commission_enabled boolean,commission_mode text,currency text,return_status text,sales_account_agent_id uuid,actual_delivery_date timestamptz,paid_at timestamptz,updated_at timestamptz,created_at timestamptz,created_by uuid,is_paid boolean,payment_status text,is_deleted boolean DEFAULT false,version integer DEFAULT 1,sync_status text DEFAULT 'synced');
CREATE TABLE crm.sales_order_agent_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid,order_id uuid,agent_id uuid,assigned_at timestamptz,unassigned_at timestamptz,assignment_source text,manual_commission_type text,assigned_by uuid,reassignment_reason text,previous_assignment_id uuid,created_at timestamptz,updated_at timestamptz,sync_status text,version integer,is_deleted boolean DEFAULT false);
CREATE UNIQUE INDEX active_assignment ON crm.sales_order_agent_assignments (workspace_id,order_id,agent_id) WHERE unassigned_at IS NULL AND is_deleted=false;
CREATE TABLE crm.product_commission_rules (id uuid PRIMARY KEY,workspace_id uuid,product_id uuid,commission_type text,fixed_amount numeric,fixed_currency text,recipient_scope text,effective_from timestamptz,effective_to timestamptz,is_active boolean DEFAULT true,is_deleted boolean DEFAULT false);
CREATE TABLE crm.agent_commission_memberships (id uuid PRIMARY KEY,workspace_id uuid,agent_id uuid,effective_from timestamptz,effective_to timestamptz,is_deleted boolean DEFAULT false);
CREATE TABLE crm.agent_product_commission_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid,order_id uuid,assignment_id uuid,agent_id uuid,order_item_id text,product_id uuid,rule_id uuid,unit_snapshot text,quantity numeric,commission_per_unit numeric,amount numeric,occurred_at timestamptz,kind text DEFAULT 'accrual',status text DEFAULT 'earned',commission_mode text DEFAULT 'tracked',currency text DEFAULT 'iqd',order_return_id uuid,is_deleted boolean DEFAULT false);
CREATE TABLE crm.agent_commission_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid,order_id uuid,assignment_id uuid,agent_id uuid,amount numeric,product_commission_amount numeric,plan_commission_amount numeric DEFAULT 0,occurred_at timestamptz,kind text DEFAULT 'accrual',status text DEFAULT 'earned',commission_mode text DEFAULT 'tracked',currency text DEFAULT 'iqd',is_deleted boolean DEFAULT false);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION workspace_module_allowed(uuid,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION reconcile_sales_agent_commission(p_order_id uuid,p_return_id uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE o crm.sales_orders%ROWTYPE; s crm.sales_order_agent_assignments%ROWTYPE;
BEGIN
  IF current_setting('recovery.test_failure',true)='server' THEN RAISE EXCEPTION 'Reconciliation unavailable'; END IF;
  SELECT * INTO STRICT o FROM crm.sales_orders WHERE id=p_order_id;
  SELECT * INTO STRICT s FROM crm.sales_order_agent_assignments WHERE order_id=o.id;
  IF auth.uid() IS DISTINCT FROM o.created_by THEN RAISE EXCEPTION 'Incorrect original creator context'; END IF;
  PERFORM private.reconcile_product_sales_agent_commission(o.id,NULL);
  CASE current_setting('recovery.test_failure',true)
    WHEN 'payment' THEN INSERT INTO payment_transactions (id,workspace_id,amount) VALUES (gen_random_uuid(),o.workspace_id,1);
    WHEN 'inventory' THEN UPDATE inventory SET amount=amount-1 WHERE workspace_id=o.workspace_id;
    WHEN 'balance' THEN UPDATE crm.business_partners SET balance=balance+1 WHERE workspace_id=o.workspace_id;
    WHEN 'history' THEN UPDATE crm.agent_product_commission_entries SET occurred_at=now() WHERE order_id=o.id AND kind='accrual';
    WHEN 'wrong_amount' THEN UPDATE crm.agent_commission_entries SET amount=amount+1 WHERE order_id=o.id;
    ELSE NULL;
  END CASE;
  RETURN 1;
END $$;
CREATE FUNCTION recovery_test_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('recovery.test_failure',true)='id_payment' THEN INSERT INTO payment_transactions (id,workspace_id,amount) VALUES (gen_random_uuid(),NEW.workspace_id,1); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_test_update BEFORE UPDATE ON crm.sales_orders FOR EACH ROW EXECUTE FUNCTION recovery_test_update();
`

beforeAll(async () => {
  pg = await PGlite.create()
  await pg.exec(schema)
  for (const table of protectedTables) await pg.exec(`CREATE TABLE ${table} (id uuid PRIMARY KEY,workspace_id uuid,amount numeric DEFAULT 0)`)
  // The creator helper's selected-recipient branch uses these columns.
  await pg.exec('ALTER TABLE crm.product_commission_rule_agents ADD COLUMN rule_id uuid,ADD COLUMN agent_id uuid,ADD COLUMN is_deleted boolean DEFAULT false')
  await pg.exec(creatorFunction)
  await pg.exec(`
ALTER TABLE crm.sales_orders ADD COLUMN order_adjustments jsonb,ADD COLUMN discount numeric DEFAULT 0,ADD COLUMN total numeric DEFAULT 1000,ADD COLUMN exchange_rates jsonb;
ALTER TABLE crm.product_commission_rules ADD COLUMN rate_percent numeric DEFAULT 0;
ALTER TABLE crm.agent_product_commission_entries
ADD COLUMN related_entry_id uuid,ADD COLUMN product_name_snapshot text,ADD COLUMN product_sku_snapshot text,
ADD COLUMN commission_type text DEFAULT 'fixed_amount',ADD COLUMN rate_percent numeric DEFAULT 0,
ADD COLUMN fixed_source_amount numeric,ADD COLUMN fixed_source_currency text,ADD COLUMN fixed_conversion_rate numeric,
ADD COLUMN fixed_exchange_rate_source text,ADD COLUMN fixed_exchange_rate_timestamp timestamptz,ADD COLUMN fixed_exchange_rates jsonb,
ADD COLUMN basis_amount_per_unit numeric DEFAULT 0,ADD COLUMN notes text,ADD COLUMN created_by uuid,
ADD COLUMN created_at timestamptz DEFAULT now(),ADD COLUMN updated_at timestamptz DEFAULT now(),ADD COLUMN sync_status text,ADD COLUMN version integer;
ALTER TABLE crm.agent_commission_entries
ADD COLUMN membership_id uuid,ADD COLUMN plan_id uuid,ADD COLUMN order_return_id uuid,ADD COLUMN related_entry_id uuid,
ADD COLUMN calculation_basis text DEFAULT 'net_revenue',ADD COLUMN include_tax boolean DEFAULT false,ADD COLUMN include_delivery_charge boolean DEFAULT false,
ADD COLUMN basis_amount numeric DEFAULT 0,ADD COLUMN revenue_amount numeric DEFAULT 0,ADD COLUMN cost_amount numeric DEFAULT 0,
ADD COLUMN tax_amount numeric DEFAULT 0,ADD COLUMN delivery_charge_amount numeric DEFAULT 0,ADD COLUMN rate_percent numeric DEFAULT 0,
ADD COLUMN payout_reference text,ADD COLUMN settlement_source text,ADD COLUMN notes text,ADD COLUMN created_by uuid,
ADD COLUMN created_at timestamptz DEFAULT now(),ADD COLUMN updated_at timestamptz DEFAULT now(),ADD COLUMN sync_status text,ADD COLUMN version integer;
CREATE FUNCTION public.current_workspace_id() RETURNS uuid LANGUAGE sql AS $$ SELECT current_workspace FROM public.profiles WHERE id=auth.uid() $$;
CREATE FUNCTION private.convert_sales_agent_commission_amount(numeric,text,text,jsonb) RETURNS numeric LANGUAGE sql AS $$ SELECT CASE WHEN $2=$3 THEN $1 END $$;`)
  await pg.exec(productReconciler)
}, 30000)
afterAll(async () => { await pg?.close() })
beforeEach(async () => {
  await pg.exec('ROLLBACK')
  await pg.exec('TRUNCATE workspaces,profiles,crm.agents,crm.business_partners,crm.sales_orders,crm.sales_order_agent_assignments,crm.product_commission_rules,crm.agent_commission_memberships,crm.agent_product_commission_entries,crm.agent_commission_entries,'+protectedTables.join(','))
  await pg.exec("SELECT set_config('recovery.test_failure','',false)")
  workspace=randomUUID(); admin=randomUUID(); agents.clear()
  await pg.query("INSERT INTO workspaces VALUES ($1,'کۆگای حەسەن مامەد',NULL,'hybrid','tracked','enterprise')",[workspace])
  await pg.query("INSERT INTO profiles VALUES ($1,$2,'admin')",[admin,workspace])
  for (const name of new Set(targets.map(t=>t.agent))) {
    const agent=randomUUID(),user=randomUUID(),partner=randomUUID()
    agents.set(name,{agent,user})
    await pg.query('INSERT INTO crm.business_partners (id,workspace_id,partner_name) VALUES ($1,$2,$3)',[partner,workspace,name])
    await pg.query("INSERT INTO crm.agents (id,workspace_id,business_partner_id,linked_user_id,agent_type,status) VALUES ($1,$2,$3,$4,'field_agent','active')",[agent,workspace,partner,user])
    await pg.query("INSERT INTO profiles VALUES ($1,$2,'staff')",[user,workspace])
  }
  for (const t of targets) {
    const {agent,user}=agents.get(t.agent),order=randomUUID(),assignment=randomUUID(),items=[],rates=[]
    const duplicateQty=t.order.endsWith('00068')?5:t.order.endsWith('00073')?2:t.order.endsWith('00071')?3:1
    const duplicateRates=t.order.endsWith('00021')?[300,250]:t.order.endsWith('00071')?[500]:[(t.amount-t.before)/duplicateQty]
    for (let n=0;n<t.duplicates;n++) {
      const product=randomUUID(),item={id:`duplicate-${n}`,productId:product,quantity:duplicateQty,fulfilledQuantity:duplicateQty,unit:'carton',lineTotal:100}
      items.push(item,{...item}); rates.push(duplicateRates[n],duplicateRates[n])
    }
    const remaining=t.lines-items.length,remainingQty=t.quantity-items.reduce((s,i)=>s+i.quantity,0)
    const remainingAmount=t.amount-rates.reduce((s,r,n)=>s+r*items[n].quantity,0)
    for (let n=0;n<remaining;n++) {
      const qty=n===0?remainingQty-remaining+1:1
      const rate=n===1?remainingAmount-(remainingQty-1)*200:200
      items.push({id:`line-${n}`,productId:randomUUID(),quantity:qty,fulfilledQuantity:qty,unit:'carton',lineTotal:100})
      rates.push(rate)
    }
    items[items.length-1].freeBonusQuantity=t.bonus
    items[items.length-1].fulfilledQuantity+=t.bonus
    await pg.query(`INSERT INTO crm.sales_orders (id,workspace_id,order_number,items,status,commission_enabled,commission_mode,currency,return_status,sales_account_agent_id,actual_delivery_date,updated_at,created_at,created_by,is_paid,payment_status)
      VALUES ($1,$2,$3,$4,'completed',true,'tracked','iqd','none',$5,$6,$7,$6,$8,false,'partial')`,[order,workspace,t.order,JSON.stringify(items),t.source==='sales_account'?agent:null,t.fulfilled,t.event,t.source==='sales_account'?admin:user])
    if (!t.creator) await pg.query('INSERT INTO crm.sales_order_agent_assignments (id,workspace_id,order_id,agent_id,assigned_at,assignment_source) VALUES ($1,$2,$3,$4,$5,$6)',[assignment,workspace,order,agent,t.event,t.source])
    const seen=new Set()
    for (let n=0;n<items.length;n++) {
      const i=items[n],rule=randomUUID()
      if (seen.has(i.id)) continue
      seen.add(i.id)
      await pg.query("INSERT INTO crm.product_commission_rules (id,workspace_id,product_id,commission_type,fixed_amount,fixed_currency,recipient_scope,effective_from) VALUES ($1,$2,$3,'fixed_amount',$4,'iqd','all_assigned','2026-08-01')",[rule,workspace,i.productId,rates[n]])
      if (t.before>0 || t.order==='SO-2026-00016') {
        await pg.query(`INSERT INTO crm.agent_product_commission_entries (workspace_id,order_id,assignment_id,agent_id,order_item_id,product_id,rule_id,unit_snapshot,quantity,commission_per_unit,amount,occurred_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'carton',$8,$9,$10,$11)`,[workspace,order,assignment,agent,i.id,i.productId,rule,i.quantity,rates[n],i.quantity*rates[n],t.event])
        if (t.order==='SO-2026-00016') await pg.query(`INSERT INTO crm.agent_product_commission_entries (workspace_id,order_id,assignment_id,agent_id,order_item_id,product_id,rule_id,unit_snapshot,quantity,commission_per_unit,amount,occurred_at,kind,status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'carton',$8,$9,$10,$11,'reversal','reversed')`,[workspace,order,assignment,agent,i.id,i.productId,rule,-i.quantity,rates[n],-i.quantity*rates[n],t.event])
      }
    }
    if (t.before>0 || t.order==='SO-2026-00016') {
      const amount=t.order==='SO-2026-00016'?t.amount:t.before
      await pg.query('INSERT INTO crm.agent_commission_entries (workspace_id,order_id,assignment_id,agent_id,amount,product_commission_amount,occurred_at) VALUES ($1,$2,$3,$4,$5,$5,$6)',[workspace,order,assignment,agent,amount,t.event])
      if (t.order==='SO-2026-00016') await pg.query("INSERT INTO crm.agent_commission_entries (workspace_id,order_id,assignment_id,agent_id,amount,product_commission_amount,occurred_at,kind,status) VALUES ($1,$2,$3,$4,$5,$5,$6,'adjustment','reversed')",[workspace,order,assignment,agent,-amount,t.event])
    }
  }
  await pg.exec("UPDATE crm.agent_commission_entries e SET related_entry_id=(SELECT id FROM crm.agent_commission_entries a WHERE a.order_id=e.order_id AND a.kind='accrual') WHERE e.kind='adjustment'")
  for (const table of protectedTables) await pg.query(`INSERT INTO ${table} (id,workspace_id,amount) VALUES ($1,$2,100)`,[randomUUID(),workspace])
  await pg.query('INSERT INTO crm.agent_commission_entries (workspace_id,order_id,agent_id,amount) VALUES ($1,$2,$3,232700)',[workspace,randomUUID(),randomUUID()])
},30000)

async function entries() { return (await pg.query('SELECT jsonb_agg(to_jsonb(e) ORDER BY id) AS entries FROM crm.agent_product_commission_entries e')).rows[0].entries }
async function totals() { return (await pg.query('SELECT o.order_number,sum(e.amount)::float amount FROM crm.agent_product_commission_entries e JOIN crm.sales_orders o ON o.id=e.order_id GROUP BY o.order_number ORDER BY o.order_number')).rows }
async function reconcileProductOrder(number) {
  await pg.query("SELECT set_config('request.jwt.claim.sub',created_by::text,false) FROM crm.sales_orders WHERE order_number=$1",[number])
  return (await pg.query('SELECT private.reconcile_product_sales_agent_commission(id,NULL) n FROM crm.sales_orders WHERE order_number=$1',[number])).rows[0].n
}
async function apply(sql=migration) {
  try { await pg.exec(sql) }
  catch (error) {
    await pg.exec('ROLLBACK')
    throw new Error([error.message,error.internalQuery,error.internalPosition,error.where].filter(Boolean).join('\n'))
  }
}

describe('Other-agent commission recovery',()=>{
  it('recovers 247,150 IQD, retaining historical entries and protecting financial and inventory records',async()=>{
    const before=await entries()
    await apply()
    expect(await totals()).toEqual(targets.map(t=>({order_number:t.order,amount:t.amount})))
    const after=await entries()
    for (const e of before) expect(after.find(x=>x.id===e.id)).toEqual(e)
    expect((await pg.query('SELECT count(*)::int n FROM crm.sales_order_agent_assignments')).rows[0].n).toBe(18)
    expect(after.every(e=>e.commission_mode==='tracked')).toBe(true)
    for (const table of protectedTables) expect((await pg.query(`SELECT sum(amount)::float a FROM ${table}`)).rows[0].a).toBe(100)
    expect((await pg.query('SELECT DISTINCT balance::float balance FROM crm.business_partners')).rows).toEqual([{balance:30000}])
  })
  it('repairs eight IDs, preserves physical lines and business fields, and replays without new records',async()=>{
    const before=(await pg.query('SELECT order_number,items FROM crm.sales_orders ORDER BY order_number')).rows
    await apply(`BEGIN; ${migration} ${migration} COMMIT;`)
    const after=await entries()
    await apply()
    expect(await entries()).toEqual(after)
    const orders=(await pg.query('SELECT order_number,items FROM crm.sales_orders ORDER BY order_number')).rows
    let changed=0
    for(let n=0;n<orders.length;n++){
      expect(new Set(orders[n].items.map(i=>i.id)).size).toBe(orders[n].items.length)
      orders[n].items.forEach((i,j)=>{
        changed+=i.id!==before[n].items[j].id?1:0
        const {id,...fields}=i; const {id:oldId,...old}=before[n].items[j]
        expect(fields).toEqual(old)
      })
    }
    expect(changed).toBe(8)
  })
  it('restores actor, claims, role and reconciliation context',async()=>{
    const sub=randomUUID(),claims=JSON.stringify({sub,role:'service_role'})
    await pg.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false),set_config('request.jwt.claim.role','service_role',false),set_config('atlas.reconciling_product_commission','previous',false)",[sub,claims])
    await apply()
    expect((await pg.query("SELECT current_setting('request.jwt.claim.sub') sub,current_setting('request.jwt.claims') claims,current_setting('request.jwt.claim.role') role,current_setting('atlas.reconciling_product_commission') context")).rows[0]).toEqual({sub,claims,role:'service_role',context:'previous'})
  })
  it('rounds the locked rate before multiplying, excluding six bonus units',async()=>{
    await pg.exec('UPDATE crm.product_commission_rules SET fixed_amount=fixed_amount+0.0000004')
    await apply()
    expect(await totals()).toEqual(targets.map(t=>({order_number:t.order,amount:t.amount})))
  })
  it.each(['order_creator_product','marketplace_delivery_product'])('leaves an unchanged %s entitlement stable even when product value is below the order total',async source=>{
    await apply()
    await pg.query("UPDATE crm.sales_order_agent_assignments SET assignment_source=$1 WHERE order_id=(SELECT id FROM crm.sales_orders WHERE order_number='SO-2026-00032')",[source])
    await pg.exec("UPDATE crm.sales_orders SET total=999999,items=(SELECT jsonb_agg(value||jsonb_build_object('convertedUnitPrice',100)) FROM jsonb_array_elements(items)) WHERE order_number='SO-2026-00032'")
    const before=(await pg.query('SELECT jsonb_agg(to_jsonb(e) ORDER BY id) entries FROM crm.agent_commission_entries e')).rows[0].entries
    expect(await reconcileProductOrder('SO-2026-00032')).toBe(0)
    expect((await pg.query('SELECT jsonb_agg(to_jsonb(e) ORDER BY id) entries FROM crm.agent_commission_entries e')).rows[0].entries).toEqual(before)
  })
  it('appends a negative product-only delta for a partial return, retaining historical rates and entries',async()=>{
    await apply()
    const before=await entries()
    await pg.exec("UPDATE crm.sales_orders SET return_status='partial',items=jsonb_set(items,'{0,returnedQuantity}','1') WHERE order_number='SO-2026-00032'")
    expect(await reconcileProductOrder('SO-2026-00032')).toBe(2)
    expect((await pg.query("SELECT sum(e.amount)::float amount,sum(e.plan_commission_amount)::float plan,sum(e.product_commission_amount)::float product FROM crm.agent_commission_entries e JOIN crm.sales_orders o ON o.id=e.order_id WHERE order_number='SO-2026-00032'")).rows[0]).toEqual({amount:1750,plan:0,product:1750})
    const after=await entries(); for(const e of before) expect(after.find(x=>x.id===e.id)).toEqual(e)
    expect(await reconcileProductOrder('SO-2026-00032')).toBe(0)
  })
  it('preserves an unrelated standalone manual adjustment without treating it as product entitlement',async()=>{
    await apply()
    await pg.exec("INSERT INTO crm.agent_commission_entries (workspace_id,order_id,assignment_id,agent_id,amount,product_commission_amount,kind) SELECT workspace_id,order_id,id,agent_id,25,0,'adjustment' FROM crm.sales_order_agent_assignments WHERE order_id=(SELECT id FROM crm.sales_orders WHERE order_number='SO-2026-00032')")
    expect(await reconcileProductOrder('SO-2026-00032')).toBe(0)
    expect((await pg.query("SELECT sum(e.amount)::float amount FROM crm.agent_commission_entries e JOIN crm.sales_orders o ON o.id=e.order_id WHERE order_number='SO-2026-00032'")).rows[0].amount).toBe(2125)
  })
  it.each(['order_creator_product','marketplace_delivery_product'])('reverses a fully returned %s commission to zero and preserves its original accrual',async source=>{
    await apply()
    const before=await entries()
    await pg.query("UPDATE crm.sales_order_agent_assignments SET assignment_source=$1 WHERE order_id=(SELECT id FROM crm.sales_orders WHERE order_number='SO-2026-00032')",[source])
    await pg.exec("UPDATE crm.sales_orders SET return_status='full' WHERE order_number='SO-2026-00032'")
    expect(await reconcileProductOrder('SO-2026-00032')).toBe(7)
    expect((await pg.query("SELECT sum(e.amount)::float amount,sum(e.plan_commission_amount)::float plan,sum(e.product_commission_amount)::float product FROM crm.agent_commission_entries e JOIN crm.sales_orders o ON o.id=e.order_id WHERE order_number='SO-2026-00032'")).rows[0]).toEqual({amount:0,plan:0,product:0})
    const after=await entries(); for(const e of before) expect(after.find(x=>x.id===e.id)).toEqual(e)
    expect(await reconcileProductOrder('SO-2026-00032')).toBe(0)
  })
  it.each([
    ['workspace ambiguity',"INSERT INTO workspaces SELECT gen_random_uuid(),name,deleted_at,data_mode,sales_agent_commission_mode,plan FROM workspaces",'one target workspace'],
    ['payable workspace',"UPDATE workspaces SET sales_agent_commission_mode='payable'",'enabled tracked'],
    ['unfulfilled order',"UPDATE crm.sales_orders SET status='pending' WHERE order_number='SO-2026-00025'",'order state changed'],
    ['missing actor',"UPDATE profiles SET current_workspace=gen_random_uuid()",'creator context unavailable'],
    ['changed rate','UPDATE crm.product_commission_rules SET fixed_amount=fixed_amount+1','Historical product commission terms changed'],
    ['returned product',"UPDATE crm.sales_orders SET items=jsonb_set(items,'{0,returnedQuantity}','1') WHERE order_number='SO-2026-00025'",'Historical product commission terms changed'],
    ['unfulfilled bonus',"UPDATE crm.sales_orders SET items=jsonb_set(items,'{5,fulfilledQuantity}','1') WHERE order_number='SO-2026-00025'",'Historical product commission terms changed'],
    ['different duplicate',"UPDATE crm.sales_orders SET items=jsonb_set(items,'{1,lineTotal}','101') WHERE order_number='SO-2026-00021'",'Unexpected duplicate line IDs'],
    ['partial recovery',"UPDATE crm.agent_product_commission_entries SET quantity=quantity-0.01,amount=(quantity-0.01)*commission_per_unit WHERE order_id=(SELECT id FROM crm.sales_orders WHERE order_number='SO-2026-00021') AND order_item_id='duplicate-0'",'partial recovery'],
  ])('rejects %s and rolls back all writes',async(_,setup,message)=>{
    await pg.exec(setup)
    const before=await entries()
    await expect(apply()).rejects.toThrow(message)
    expect(await entries()).toEqual(before)
  })
  it.each(['payment','inventory','balance','history','wrong_amount','server','id_payment'])('rolls back reconciliation failure: %s',async failure=>{
    const before=await entries()
    await pg.query("SELECT set_config('recovery.test_failure',$1,false)",[failure])
    await expect(apply()).rejects.toThrow()
    expect(await entries()).toEqual(before)
    for(const table of protectedTables) expect((await pg.query(`SELECT sum(amount)::float a FROM ${table}`)).rows[0].a).toBe(100)
  })
  it.each(['pending','cancelled'])('does not auto-attribute a %s unpaid creator sale',async status=>{
    await pg.query("UPDATE crm.sales_orders SET status=$1 WHERE order_number='SO-2026-00025'",[status])
    expect((await pg.query("SELECT private.ensure_order_creator_product_commission_assignment(id) n FROM crm.sales_orders WHERE order_number='SO-2026-00025'")).rows[0].n).toBe(0)
  })
  it('skips absent target workspace without touching any data',async()=>{
    await pg.exec('DELETE FROM workspaces')
    const before=await entries(); await apply(); expect(await entries()).toEqual(before)
  })
})
