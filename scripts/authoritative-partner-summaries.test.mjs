import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'

const workspace = '00000000-0000-4000-8000-000000000001'
const otherWorkspace = '00000000-0000-4000-8000-000000000002'
const partner = '00000000-0000-4000-8000-000000000010'
const facet = '00000000-0000-4000-8000-000000000011'
const fxPartner = '00000000-0000-4000-8000-000000000012'
const hiddenPartner = '00000000-0000-4000-8000-000000000013'
const loanId = '00000000-0000-4000-8000-000000000020'
let pg
const read = (file) => readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8')
const migration = read('20261021210509_authoritative_partner_summaries.sql')
  + read('20261021212325_optimize_partner_summary_visibility_checks.sql')
const financing = read('20260625120000_order_linked_financing.sql')
const conversion = financing.slice(financing.indexOf('CREATE OR REPLACE FUNCTION public.convert_financed_amount('))
  .split('$function$;')[0] + '$function$;'
const privacy = read('20261021113501_enforce_business_partner_group_visibility.sql')
const visibility = privacy.slice(privacy.indexOf('CREATE OR REPLACE FUNCTION crm.can_access_business_partner('))
  .split('$function$;')[0] + '$function$;'

async function summary(id = partner) {
  const { rows } = await pg.query('SELECT value FROM crm.read_business_partner_summaries($1::uuid,$2::uuid[]) value', [workspace, [id]])
  return rows[0]?.value
}
async function page(search = null, number = 1, size = 20, metadata = true) {
  const { rows } = await pg.query(`SELECT crm.list_business_partner_directory_page($1::uuid,
    NULL,false,false,false,true,$2,$3,$4,$5) value`, [workspace,search,number,size,metadata])
  return rows[0].value
}

describe('authoritative partner summary SQL', () => {
  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(`
      CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE anon;
      CREATE SCHEMA crm; CREATE SCHEMA delivery; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT CASE WHEN current_setting('test.anonymous',true)='true' THEN NULL ELSE '${workspace}'::uuid END $$;
      CREATE FUNCTION public.current_workspace_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${workspace}'::uuid $$;
      CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql AS $$ SELECT COALESCE(NULLIF(current_setting('test.role',true),''),'admin') $$;
      CREATE FUNCTION public.workspace_get_override_value(uuid,text,text) RETURNS text LANGUAGE sql AS $$ SELECT current_setting('test.privacy',true) $$;
      CREATE TABLE crm.business_partner_groups (id uuid,workspace_id uuid,access_type text,is_deleted boolean DEFAULT false);
      CREATE TABLE crm.business_partner_group_users (group_id uuid,workspace_id uuid,user_id uuid,is_deleted boolean DEFAULT false);
      CREATE TABLE crm.business_partner_group_partners (group_id uuid,workspace_id uuid,business_partner_id uuid,is_deleted boolean DEFAULT false);
      CREATE TABLE crm.business_partners (
        id uuid PRIMARY KEY,workspace_id uuid,partner_name text,phone text,city text,role text DEFAULT 'both',
        default_currency text DEFAULT 'usd',customer_facet_id uuid,supplier_facet_id uuid,agent_facet_id uuid,
        is_deleted boolean DEFAULT false,merged_into_business_partner_id uuid,is_ecommerce boolean DEFAULT false,
        total_sales_orders integer DEFAULT 999,total_sales_value numeric DEFAULT 999,receivable_balance numeric DEFAULT 999,
        total_purchase_orders integer DEFAULT 999,total_purchase_value numeric DEFAULT 999,payable_balance numeric DEFAULT 999,
        total_loan_count integer DEFAULT 999,loan_outstanding_balance numeric DEFAULT 999,net_exposure numeric DEFAULT 999
      );
      CREATE TABLE crm.sales_orders (id uuid DEFAULT gen_random_uuid(),workspace_id uuid DEFAULT '${workspace}',business_partner_id uuid,
        customer_id uuid,status text,total numeric,currency text DEFAULT 'usd',exchange_rates jsonb,linked_loan_id uuid,
        paid_amount numeric DEFAULT 0,balance_amount numeric,is_paid boolean DEFAULT false,is_deleted boolean DEFAULT false);
      CREATE TABLE crm.purchase_orders (LIKE crm.sales_orders INCLUDING DEFAULTS);
      ALTER TABLE crm.purchase_orders RENAME customer_id TO supplier_id;
      CREATE TABLE public.loans (id uuid DEFAULT gen_random_uuid(),workspace_id uuid DEFAULT '${workspace}',linked_party_id uuid,
        linked_party_type text DEFAULT 'business_partner',status text DEFAULT 'active',balance_amount numeric,
        direction text DEFAULT 'lent',settlement_currency text DEFAULT 'usd',exchange_rate_snapshot jsonb,is_deleted boolean DEFAULT false);
      CREATE TABLE public.installment_sales (workspace_id uuid DEFAULT '${workspace}',customer_business_partner_id uuid,
        customer_balance_amount numeric,currency text DEFAULT 'usd',status text DEFAULT 'active',is_deleted boolean DEFAULT false);
      CREATE TABLE public.payment_transactions (workspace_id uuid DEFAULT '${workspace}',metadata jsonb,amount numeric,
        currency text DEFAULT 'usd',source_type text DEFAULT 'direct_transaction',is_deleted boolean DEFAULT false);
      CREATE TABLE crm.agents (id uuid,workspace_id uuid,business_partner_id uuid,is_deleted boolean DEFAULT false,zone text,agent_type text,status text);
      CREATE TABLE delivery.delivery_merchant_profiles (id uuid,workspace_id uuid,business_partner_id uuid,is_deleted boolean DEFAULT false);
      CREATE TABLE delivery.delivery_ledger_entries (workspace_id uuid,merchant_profile_id uuid,agent_id uuid,currency text,amount numeric,is_deleted boolean DEFAULT false);
      GRANT USAGE ON SCHEMA crm,auth TO authenticated;
      INSERT INTO crm.business_partners(id,workspace_id,partner_name,customer_facet_id,agent_facet_id) VALUES
        ('${partner}','${workspace}','A partner','${facet}','${facet}'),
        ('${hiddenPartner}','${workspace}','Hidden',NULL,NULL),
        (gen_random_uuid(),'${otherWorkspace}','Foreign',NULL,NULL);
      INSERT INTO crm.business_partners(id,workspace_id,partner_name,default_currency) VALUES ('${fxPartner}','${workspace}','FX','iqd');
      INSERT INTO crm.sales_orders(business_partner_id,customer_id,status,total,paid_amount,linked_loan_id) VALUES
        ('${partner}','${facet}','draft',999,0,NULL),('${partner}','${facet}','completed',100,20,NULL),
        ('${partner}',NULL,'pending',60,10,NULL),('${partner}',NULL,'cancelled',100,0,NULL),
        ('${partner}',NULL,'completed',200,0,'${loanId}'),(NULL,'${facet}','completed',50,0,NULL),
        ('${hiddenPartner}',NULL,'completed',10000,0,NULL);
      INSERT INTO crm.sales_orders(workspace_id,business_partner_id,status,total) VALUES ('${otherWorkspace}','${partner}','completed',100000);
      INSERT INTO public.loans(id,linked_party_id,balance_amount,direction,status) VALUES
        ('${loanId}','${partner}',200,'lent','active'),(gen_random_uuid(),'${partner}',30,'lent','active'),
        (gen_random_uuid(),'${partner}',40,'borrowed','active'),(gen_random_uuid(),'${partner}',0,'lent','completed'),
        (gen_random_uuid(),'${partner}',900,'lent','cancelled');
      INSERT INTO public.installment_sales(customer_business_partner_id,customer_balance_amount) VALUES ('${partner}',25);
      INSERT INTO crm.purchase_orders(business_partner_id,status,total,paid_amount,linked_loan_id) VALUES
        ('${hiddenPartner}','draft',999,0,NULL),('${hiddenPartner}','received',40,10,NULL),
        ('${hiddenPartner}','completed',50,20,NULL),('${hiddenPartner}','ordered',60,10,NULL),
        ('${hiddenPartner}','received',100,0,'${facet}'),('${hiddenPartner}','cancelled',900,0,NULL);
      INSERT INTO crm.purchase_orders(business_partner_id,status,total,is_deleted) VALUES ('${hiddenPartner}','received',1000,true);
      INSERT INTO public.loans(id,linked_party_id,balance_amount,direction) VALUES ('${facet}','${hiddenPartner}',40,'borrowed');
      INSERT INTO crm.agents(id,workspace_id,business_partner_id) VALUES ('${facet}','${workspace}','${partner}');
      INSERT INTO delivery.delivery_merchant_profiles(id,workspace_id,business_partner_id) VALUES ('${facet}','${workspace}','${partner}');
      INSERT INTO delivery.delivery_ledger_entries(workspace_id,merchant_profile_id,currency,amount) VALUES ('${workspace}','${facet}','usd',-12);
      INSERT INTO delivery.delivery_ledger_entries(workspace_id,agent_id,currency,amount) VALUES ('${workspace}','${facet}','usd',-3);
      INSERT INTO public.payment_transactions(metadata,amount) VALUES
        ('{"businessPartnerId":"${partner}","partnerAccountEffect":"increase_receivable"}',10),
        ('{"businessPartnerId":"${partner}","partnerAccountEffect":"increase_receivable"}',-4),
        ('{"businessPartnerId":"${partner}","partnerAccountEffect":"decrease_receivable"}',5),
        ('{"businessPartnerId":"${partner}","partnerAccountEffect":"increase_payable"}',7),
        ('{"businessPartnerId":"${partner}","partnerAccountEffect":"increase_payable"}',-2),
        ('{"businessPartnerId":"${partner}"}',9999);
      INSERT INTO crm.sales_orders(business_partner_id,status,total,paid_amount,currency,exchange_rates)
        VALUES ('${fxPartner}','completed',10,2,'usd','[{"pair":"USD/IQD","rate":150000,"priceBasisAmount":100}]');
      INSERT INTO public.loans(linked_party_id,balance_amount,exchange_rate_snapshot)
        VALUES ('${fxPartner}',5,'[{"pair":"USD/IQD","rate":150000,"priceBasisAmount":100}]');
      INSERT INTO public.payment_transactions(metadata,amount,currency)
        VALUES ('{"businessPartnerId":"${fxPartner}","partnerAccountEffect":"increase_receivable"}',20,'iqd');
    `)
    await pg.exec(conversion)
    await pg.exec(visibility)
    await pg.exec(migration)
    await pg.exec('SET ROLE authenticated')
  }, 60_000)
  afterAll(async () => pg?.close())

  it('derives balances from every authoritative source, excludes cancelled/deleted rows, and counts financed debt once', async () => {
    expect(await summary()).toMatchObject({ total_sales_orders:5,total_sales_value:350,
      total_purchase_orders:0,total_purchase_value:0,total_loan_count:5,loan_outstanding_balance:230,
      receivable_balance:448,payable_balance:48,net_exposure:400,
      receivable_currency_totals:[{currency:'USD',amount:448}],payable_currency_totals:[{currency:'USD',amount:48}],summary_source:'server' })
    await expect(pg.query('SELECT * FROM crm.sales_orders')).rejects.toThrow('permission denied')
    await expect(pg.query('SELECT * FROM crm.business_partners')).rejects.toThrow('permission denied')
  })

  it('uses recorded conversion rates and returns independent native-currency balances', async () => {
    expect(await summary(fxPartner)).toMatchObject({total_sales_value:15000,receivable_balance:19520,
      loan_outstanding_balance:7500,receivable_currency_totals:[{currency:'IQD',amount:20},{currency:'USD',amount:13}]})
  })

  it('counts purchase activity, unpaid obligations and borrowed financing without duplication', async () => {
    expect(await summary(hiddenPartner)).toMatchObject({total_purchase_orders:5,total_purchase_value:190,
      payable_balance:150,total_loan_count:1,loan_outstanding_balance:0})
    const directory = await page()
    expect(directory.summary.totalPurchaseOrders).toBe(5)
    expect(directory.summary.suppliersWithPurchases).toBe(1)
  })

  it('preserves exact filtered counts, stable pages and full-scope directory totals', async () => {
    const result = await page('A partner',1,1)
    expect(result.totalCount).toBe(1)
    expect(result.items.map(row=>row.id)).toEqual([partner])
    expect(result.items[0].receivable_balance).toBe(448)
    expect(result.summary.totalSalesOrders).toBe(7)
    expect((await page(null,2,1)).items.map(row=>row.id)).toEqual([fxPartner])
    expect((await page('A partner',1,1,false)).items[0].net_exposure).toBe(400)
  })

  it('rejects cross-workspace/anonymous access and respects the actual group-visibility helper', async () => {
    await expect(pg.query('SELECT * FROM crm.read_business_partner_summaries($1)',[otherWorkspace])).rejects.toThrow('Workspace access denied')
    await pg.exec("SET test.anonymous='true'")
    await expect(summary()).rejects.toThrow('Workspace access denied')
    await pg.exec("RESET test.anonymous; SET test.role='staff'; SET test.privacy='grant'")
    expect(await summary()).toBeUndefined()
    expect((await page()).summary.partnerCount).toBe(0)
    await pg.exec(`RESET ROLE; INSERT INTO crm.business_partner_groups(id,workspace_id,access_type) VALUES ('${facet}','${workspace}','non_grouped');
      INSERT INTO crm.business_partner_group_partners VALUES ('${facet}','${workspace}','${partner}',false); SET ROLE authenticated;`)
    expect((await summary()).net_exposure).toBe(400)
    expect(await summary(hiddenPartner)).toBeUndefined()
    expect((await page()).summary.partnerCount).toBe(1)
    expect((await page()).summary.totalPurchaseOrders).toBe(0)
    await pg.exec('RESET test.role; RESET test.privacy')
  })

  it('reflects a committed payment immediately without any stored-summary update', async () => {
    await pg.exec(`RESET ROLE; UPDATE crm.sales_orders SET paid_amount=total,is_paid=true,balance_amount=0
      WHERE business_partner_id='${partner}' AND status='pending'; SET ROLE authenticated;`)
    expect((await summary()).receivable_balance).toBe(398)
    const {rows}=await pg.query('SELECT receivable_balance FROM crm.list_visible_business_partners($1) WHERE id=$2',[workspace,partner])
    expect(Number(rows[0].receivable_balance)).toBe(398)
  })
})
