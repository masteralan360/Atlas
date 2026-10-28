import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { normalizePostalStatement } from '@/local-db/postalStatementData'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const w = id(1), org = id(20)
let pg: PGlite
async function actor(n: number, workspace = w) {
  await pg.exec('RESET ROLE')
  await pg.query(`SELECT set_config('test.uid',$1,false),set_config('test.workspace',$2,false)`, [id(n), workspace])
  await pg.exec('SET ROLE authenticated')
}
async function statement(options: { page?: number; size?: number; start?: string | null; end?: string | null; search?: string; kind?: string; workspace?: string; organization?: string } = {}) {
  const { rows } = await pg.query<{ result: unknown }>(
    'SELECT public.postal_organization_statement($1,$2,$3,$4,$5,$6,$7,$8) AS result',
    [options.workspace ?? w, options.organization ?? org, options.page ?? 1, options.size ?? 20,
      options.start ?? null, options.end ?? null, options.search ?? '', options.kind ?? 'all'])
  return normalizePostalStatement(rows[0].result, w, org)
}
async function organizations(search: string, workspace = w) {
  return pg.query<{ result: Array<{ id: string }> }>('SELECT public.postal_statement_organizations($1,$2) AS result', [workspace, search])
}
describe('organization statement: real PostgreSQL authorization and accounting', () => {
  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(readFileSync(new URL('../../scripts/postal-browser/statement-fixture.sql', import.meta.url), 'utf8'))
    for (const name of [
      '20261024003737_postal_service', '20261024004656_postal_registration_permission_keys',
      '20261024094518_postal_dashboard_summary', '20261024174745_add_postal_shipment_numbers',
      '20261024181523_postal_shipment_id_display_format', '20261025123951_postal_settlement_direction_guard',
      '20261027223702_postal_shipment_tariffs_and_delivery_fees', '20261028021022_postal_organization_account_statement',
    ]) await pg.exec(readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'))
    await pg.exec(readFileSync(new URL('../../scripts/postal-browser/statement-seed.sql', import.meta.url), 'utf8'))
  }, 30000)
  afterAll(async () => { await pg?.close() })
  it('includes signed partial collections, settlements, refunds and separate fees', async () => {
    await actor(12)
    const result = await statement()
    expect(result.total).toBe(6)
    expect(result.entries.map((e) => e.balance)).toEqual(['100000', '60000', '30000', '40000', '40000', '60000'])
    expect(result.summary).toMatchObject({ opening_balance: '0', debit_total: '70000', credit_total: '130000',
      closing_balance: '60000', collections: '90000', settlements: '30000', delivery_fees: '5000',
      current_due_to: '80000', current_due_from: '20000', recipient_due: '80000', recipient_refund_due: '20000', missing_tariffs: 2 })
    expect(result.entries.find((e) => e.kind === 'delivery_fee')).toMatchObject({ debit: '0', credit: '0', balance: '40000', signed_amount: '5000' })
  })
  it('uses an inclusive start, exclusive end, and the full prior history for opening', async () => {
    await actor(10)
    const result = await statement({ start: '2026-10-02T12:00:00Z', end: '2026-10-04T00:00:00Z' })
    expect(result.total).toBe(4)
    expect(result.summary).toMatchObject({ opening_balance: '100000', closing_balance: '40000', debit_total: '70000', credit_total: '10000' })
    expect(result.summary.current_due_to).toBe('80000')
    expect((await statement({ end: '2026-10-01T00:00:00Z' })).summary.closing_balance).toBe('0')
  })
  it('keeps accounting balances and totals intact when search or type hides rows', async () => {
    await actor(12)
    const all = await statement()
    const filtered = await statement({ kind: 'settlement', search: 'Negative Recipient' })
    expect(filtered.total).toBe(1)
    expect(filtered.entries[0]).toMatchObject({ balance: '40000', credit: '10000' })
    expect(filtered.summary).toEqual(all.summary)
    expect((await statement({ search: 'no such recipient' })).total).toBe(0)
    expect((await statement({ search: 'PS-2026-000001' })).total).toBe(4)
  })
  it('searches organizations by name/code without clearing selection or exposing broad reads', async () => {
    await actor(12)
    expect((await organizations('stm')).rows[0].result).toHaveLength(1)
    expect((await organizations('statement')).rows[0].result[0].id).toBe(org)
    expect((await organizations('%_')).rows[0].result).toHaveLength(0)
    expect((await organizations('no match')).rows[0].result).toHaveLength(0)
  })
  it('denies merchants, unpermitted staff, viewers, anonymous users and cross-workspace requests', async () => {
    for (const n of [11, 13, 14, 15, 999]) {
      await actor(n, n === 15 ? id(2) : w)
      await expect(statement()).rejects.toThrow('postal_not_authorized')
      await expect(organizations('Statement')).rejects.toThrow('postal_not_authorized')
    }
    await actor(10)
    await expect(statement({ workspace: id(2) })).rejects.toThrow('postal_not_authorized')
    await expect(statement({ organization: id(999) })).rejects.toThrow('postal_unavailable')
    await pg.exec('SET ROLE anon')
    await expect(statement()).rejects.toThrow(/permission denied/)
    await expect(organizations('Statement')).rejects.toThrow(/permission denied/)
  })
  it('fails closed after office permission or module grant revocation and in Local mode', async () => {
    for (const change of [
      `DELETE FROM public.workspace_permissions WHERE user_uuid='${id(12)}'`,
      `UPDATE public.workspaces SET data_mode='local' WHERE id='${w}'`,
      `DELETE FROM public.workspace_access_overrides WHERE workspace_id='${w}'`,
    ]) {
      await pg.exec('RESET ROLE; BEGIN')
      await pg.exec(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
      await pg.exec(change)
      await pg.query(`SELECT set_config('test.uid',$1,true),set_config('test.workspace',$2,true)`, [id(12), w])
      await pg.exec('SET LOCAL ROLE authenticated; SAVEPOINT denied')
      await expect(statement()).rejects.toThrow('postal_not_authorized')
      await pg.exec('ROLLBACK TO SAVEPOINT denied; ROLLBACK')
    }
  })
  it('validates pagination and filter input and keeps public functions invokers', async () => {
    await actor(12)
    for (const options of [{ page: -1 }, { size: 1000 }, { kind: 'unknown' }, { start: '2026-10-02', end: '2026-10-01' }])
      await expect(statement(options)).rejects.toThrow('postal_invalid_filter')
    const { rows } = await pg.query<{ prosecdef: boolean; anonymous: boolean }>(`SELECT p.prosecdef, has_function_privilege('anon',p.oid,'EXECUTE') AS anonymous FROM pg_proc p WHERE p.proname IN ('postal_organization_statement','postal_statement_organizations')`)
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => !row.prosecdef && !row.anonymous)).toBe(true)
  })
  it('pages large histories with stable ties and running balances across page boundaries', async () => {
    await pg.exec('RESET ROLE; BEGIN')
    // Insert many bounded individual payments with the same timestamp.
    for (let i = 0; i < 45; i++) {
      await pg.query(`INSERT INTO public.payment_transactions(id,workspace_id,source_module,source_type,source_record_id,direction,amount,currency,payment_method,paid_at) VALUES($1,$2,'postal_service','postal_cod',$3,'incoming',1,'iqd','cash','2026-10-05')`, [id(100 + i), w, id(30)])
      await pg.query(`INSERT INTO public.postal_cod_records(id,workspace_id,shipment_id,organization_id,kind,signed_amount,payment_transaction_id,actor_id,created_at) VALUES($1,$2,$3,$4,'collection',1,$5,$6,'2026-10-05')`, [id(200 + i), w, id(30), org, id(100 + i), id(12)])
    }
    await pg.query(`SELECT set_config('test.uid',$1,true),set_config('test.workspace',$2,true)`, [id(12), w])
    await pg.exec('SET LOCAL ROLE authenticated')
    const first = await statement(), second = await statement({ page: 2 }), third = await statement({ page: 3 })
    expect([first.entries.length, second.entries.length, third.entries.length]).toEqual([20, 20, 11])
    expect(first.total).toBe(51)
    expect(new Set([...first.entries, ...second.entries, ...third.entries].map((e) => e.id)).size).toBe(51)
    expect(BigInt(second.entries[0].balance) - BigInt(first.entries.at(-1)!.balance)).toBe(1n)
    expect(third.summary.closing_balance).toBe('60045')
    expect((await statement({ page: 9 })).entries).toHaveLength(0)
    await pg.exec('ROLLBACK')
  })
})
