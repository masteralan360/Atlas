import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const w = id(1), other = id(2), admin = id(10), merchant = id(11), office = id(12), merchant2 = id(13), org = id(20)
let pg: PGlite
const form = { recipient_name: 'QR Recipient', primary_phone: '07501234567', backup_phone: '07701234567',
  governorate: 'erbil', area: 'ankawa', cod_amount: 12000, fragile: false, tariff_size: 'small_package', delivery_fee: 6000 }
async function actor(user = admin, workspace = w) {
  await pg.exec('RESET ROLE')
  await pg.query("SELECT set_config('test.uid',$1,false),set_config('test.workspace',$2,false)", [user, workspace])
  await pg.exec('SET ROLE authenticated')
}
async function command(command: string, payload: object, request: string = crypto.randomUUID()) {
  const { rows } = await pg.query<{ result: Record<string, any> }>('SELECT public.postal_command($1,$2::jsonb,$3) AS result',
    [command, JSON.stringify({ workspace_id: w, ...payload }), request])
  return rows[0].result
}
async function batch(quantity = 3, organization_id: string | null = null) {
  await actor()
  const b = await command('generate_qr_batch', { quantity, organization_id })
  const qrs = await pg.query<{ id: string }>('SELECT id FROM public.postal_generated_qrs WHERE batch_id=$1 ORDER BY id', [b.id])
  return { ...b, id: String(b.id), codes: qrs.rows.map((q) => q.id) }
}
async function validate(qr: string, workspace = w) {
  return pg.query('SELECT public.postal_validate_generated_qr($1,$2)', [workspace, qr])
}
async function claim(qr: string, extra = {}, request?: string) {
  return command('create_shipment', { ...form, generated_qr_id: qr, ...extra }, request)
}
async function qrRow(qr: string) {
  await actor()
  return (await pg.query<Record<string, any>>('SELECT * FROM public.postal_generated_qrs WHERE id=$1', [qr])).rows[0]
}

describe('generated QR batches: PostgreSQL integrity, authorization and shipment transactions', () => {
  beforeAll(async () => {
    pg = new PGlite()
    const read = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8')
    await pg.exec(read('scripts/postal-browser/statement-fixture.sql'))
    for (const name of [
      '20261024003737_postal_service', '20261024004656_postal_registration_permission_keys',
      '20261024174745_add_postal_shipment_numbers', '20261024181523_postal_shipment_id_display_format',
      '20261027223702_postal_shipment_tariffs_and_delivery_fees',
      '20261031164557_postal_organizations_without_members',
      '20261031173159_postal_create_shipments_for_admin_and_office', '20261031203510_postal_assign_tariff_during_creation',
      '20261031213902_postal_backup_phone_optional', '20261101232108_postal_extra_large_carton_tariff',
      '20261101232111_postal_governorate_bulk_branches', '20261101232114_postal_branch_area_optional',
      '20261102160133_postal_generated_qr_batches',
      '20261102160411_postal_generated_qr_shipment_index',
      '20261102231139_postal_optional_shipment_size_and_manual_delivery_fee',
      '20261102231146_postal_additive_shipment_delivery_fee',
    ]) await pg.exec(read(`supabase/migrations/${name}.sql`))
    await pg.exec(read('scripts/postal-browser/statement-seed.sql'))
    await pg.exec(`BEGIN;
      INSERT INTO public.postal_organizations(id,workspace_id,name,code,leader_id) VALUES('${id(21)}','${w}','Second Merchant','SCND2345','${merchant2}');
      INSERT INTO public.postal_memberships(user_id,workspace_id,organization_id) VALUES('${merchant2}','${w}','${id(21)}');
      INSERT INTO public.workspace_permissions VALUES('${w}','${merchant2}','postService.merchant','postService');
      COMMIT;`)
  }, 60000)
  afterAll(async () => { await pg?.close() })

  it('generates the exact quantity atomically, with stable unique identities and idempotent retry', async () => {
    await actor()
    const request = crypto.randomUUID(), payload = { quantity: 23, organization_id: null }
    const b = await command('generate_qr_batch', payload, request)
    expect(await command('generate_qr_batch', payload, request)).toEqual(b)
    await expect(command('generate_qr_batch', { quantity: 24 }, request)).rejects.toThrow('postal_request_conflict')
    const { rows } = await pg.query<{ count: number; unique_count: number; claimed: number }>(
      'SELECT count(*)::int AS count,count(DISTINCT id)::int AS unique_count,count(claimed_at)::int AS claimed FROM public.postal_generated_qrs WHERE batch_id=$1', [b.id])
    expect(rows[0]).toEqual({ count: 23, unique_count: 23, claimed: 0 })
    await actor(office); await actor()
    expect((await pg.query('SELECT * FROM public.postal_qr_batches WHERE id=$1', [b.id])).rows).toHaveLength(1)
    const before = (await pg.query('SELECT id FROM public.postal_qr_batches')).rows.length
    for (const quantity of [0, -1, 1.5, 10001, null, '5'])
      await expect(command('generate_qr_batch', { quantity })).rejects.toThrow('postal_qr_invalid_quantity')
    await expect(command('generate_qr_batch', { quantity: 3, organization_id: id(999) })).rejects.toThrow('postal_invalid_organization')
    expect((await pg.query('SELECT id FROM public.postal_qr_batches')).rows).toHaveLength(before)
  })
  it('rolls back a whole batch if even one generated code cannot be inserted', async () => {
    await pg.exec(`RESET ROLE;
      CREATE FUNCTION public.test_qr_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF (SELECT count(*) FROM public.postal_generated_qrs WHERE batch_id=NEW.batch_id)>=2 THEN RAISE EXCEPTION 'test_generation_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_qr_insert_failure BEFORE INSERT ON public.postal_generated_qrs FOR EACH ROW EXECUTE FUNCTION public.test_qr_insert_failure();`)
    await actor()
    const before = (await pg.query('SELECT id FROM public.postal_qr_batches')).rows.length
    await expect(command('generate_qr_batch', { quantity: 4 })).rejects.toThrow('test_generation_failure')
    expect((await pg.query('SELECT id FROM public.postal_qr_batches')).rows).toHaveLength(before)
    await pg.exec('RESET ROLE; DROP TRIGGER test_qr_insert_failure ON public.postal_generated_qrs; DROP FUNCTION public.test_qr_insert_failure();')
  })
  it('keeps scans and abandoned forms unclaimed, and allows unrestricted authorized merchants', async () => {
    const b = await batch()
    await actor(merchant)
    await validate(b.codes[0]); await validate(b.codes[0])
    expect((await qrRow(b.codes[0])).claimed_at).toBeNull()
    await actor(merchant2); await validate(b.codes[0])
    const shipment = await claim(b.codes[0])
    expect(shipment.qr_id).toBe(b.codes[0])
    const qr = await qrRow(b.codes[0])
    expect(qr).toMatchObject({ batch_id: b.id, shipment_id: shipment.id, claimed_by: merchant2, claimed_organization_id: id(21), organization_name: 'Second Merchant' })
    expect(qr.claimed_at).not.toBeNull()
  })
  it('rejects inactive codes at scan and submit, then permits reactivation', async () => {
    const b = await batch()
    await actor(merchant); await validate(b.codes[0])
    await actor(); await command('set_qr_batch_active', { id: b.id, active: false })
    await actor(merchant)
    await expect(validate(b.codes[0])).rejects.toThrow('postal_qr_inactive')
    await expect(claim(b.codes[0])).rejects.toThrow('postal_qr_inactive')
    expect((await qrRow(b.codes[0])).claimed_at).toBeNull()
    await command('set_qr_batch_active', { id: b.id, active: true })
    await actor(merchant); expect((await claim(b.codes[0])).qr_id).toBe(b.codes[0])
    await actor(); await command('set_qr_batch_active', { id: b.id, active: false })
    expect((await qrRow(b.codes[0])).claimed_at).not.toBeNull()
  })
  it('enforces organization restrictions again on submission and ignores forged organization payloads', async () => {
    const b = await batch(2, org)
    await actor(merchant2)
    await expect(validate(b.codes[0])).rejects.toThrow('postal_qr_organization_restricted')
    await expect(claim(b.codes[0], { organization_id: org })).rejects.toThrow('postal_qr_organization_restricted')
    await actor(merchant); await validate(b.codes[0]); expect((await claim(b.codes[0])).organization_id).toBe(org)
  })
  it('rolls back the shipment, event, request and claim if a later shipment validation fails', async () => {
    const b = await batch()
    await actor(merchant)
    const request = crypto.randomUUID()
    // Tariff validation runs after INSERT and its claim trigger.
    await expect(claim(b.codes[0], { delivery_fee: 1 }, request)).rejects.toThrow('postal_invalid_tariff')
    expect((await qrRow(b.codes[0])).claimed_at).toBeNull()
    expect((await pg.query('SELECT id FROM public.postal_shipments WHERE qr_id=$1', [b.codes[0]])).rows).toHaveLength(0)
    await actor(merchant); expect((await claim(b.codes[0], {}, request)).qr_id).toBe(b.codes[0])
  })
  it('rejects duplicate claim requests and keeps normal idempotent shipment retries', async () => {
    const b = await batch()
    await actor(merchant)
    const request = crypto.randomUUID(), shipment = await claim(b.codes[0], {}, request)
    expect((await claim(b.codes[0], {}, request)).id).toBe(shipment.id)
    await expect(claim(b.codes[0])).rejects.toThrow('postal_qr_already_claimed')
    await expect(validate(b.codes[0])).rejects.toThrow('postal_qr_already_claimed')
    // PGlite serializes connections; independent in-flight requests still must
    // produce one successful transaction and one conflict, never two shipments.
    const outcomes = await Promise.allSettled([claim(b.codes[1]), claim(b.codes[1])])
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1)
    await actor()
    expect((await pg.query('SELECT id FROM public.postal_shipments WHERE qr_id=$1', [b.codes[1]])).rows).toHaveLength(1)
  })
  it('deletes only wholly unclaimed batches and preserves the permanent history after draft deletion', async () => {
    const empty = await batch()
    await command('delete_qr_batch', { id: empty.id })
    expect((await pg.query('SELECT id FROM public.postal_generated_qrs WHERE batch_id=$1', [empty.id])).rows).toHaveLength(0)
    const used = await batch()
    await actor(merchant)
    const shipment = await claim(used.codes[0])
    await command('delete_draft', { id: shipment.id, revision: shipment.revision })
    await actor()
    await expect(command('delete_qr_batch', { id: used.id })).rejects.toThrow('postal_qr_batch_has_claims')
    expect((await qrRow(used.codes[0])).shipment_id).toBe(shipment.id)
    const summary = (await pg.query<{ claimed_count: number }>('SELECT claimed_count FROM public.postal_qr_batch_summaries WHERE id=$1', [used.id])).rows[0]
    expect(summary.claimed_count).toBe(1)
    await pg.exec('RESET ROLE')
    await expect(pg.query('DELETE FROM public.postal_generated_qrs WHERE id=$1', [used.codes[0]])).rejects.toThrow('postal_qr_claim_is_immutable')
    await expect(pg.query('UPDATE public.postal_generated_qrs SET claimed_at=NULL WHERE id=$1', [used.codes[0]])).rejects.toThrow('postal_qr_claim_is_immutable')
    await expect(pg.query('DELETE FROM public.postal_qr_batches WHERE id=$1', [used.id])).rejects.toThrow('postal_qr_batch_has_claims')
    await expect(pg.query('DELETE FROM public.postal_generated_qrs WHERE id=$1', [used.codes[1]])).rejects.toThrow('postal_qr_requires_batch')
  })
  it('denies office staff, viewers, anonymous access, cross-workspace access and direct writes', async () => {
    const b = await batch()
    for (const user of [merchant, office, id(14), id(15)]) {
      await actor(user, user === id(15) ? other : w)
      await expect(command('generate_qr_batch', { quantity: 1 })).rejects.toThrow('postal_not_authorized')
      await expect(command('delete_qr_batch', { id: b.id })).rejects.toThrow('postal_not_authorized')
      await expect(command('set_qr_batch_active', { id: b.id, active: false })).rejects.toThrow('postal_not_authorized')
      expect((await pg.query('SELECT * FROM public.postal_qr_batch_summaries')).rows).toHaveLength(0)
      expect((await pg.query('SELECT * FROM public.postal_generated_qrs')).rows).toHaveLength(0)
      if (user !== merchant) await expect(validate(b.codes[0])).rejects.toThrow('postal_qr_not_authorized')
    }
    await actor(merchant)
    await expect(validate(b.codes[0], other)).rejects.toThrow('postal_qr_not_authorized')
    await expect(validate(crypto.randomUUID())).rejects.toThrow('postal_qr_unknown')
    await actor()
    await expect(claim(b.codes[0], { organization_id: org })).rejects.toThrow('postal_qr_not_authorized')
    await expect(pg.query('UPDATE public.postal_qr_batches SET active=false WHERE id=$1', [b.id])).rejects.toThrow('permission denied')
    await expect(pg.query('UPDATE public.postal_generated_qrs SET claimed_at=now() WHERE id=$1', [b.codes[0]])).rejects.toThrow('permission denied')
    await pg.exec('RESET ROLE; SET ROLE anon')
    await expect(validate(b.codes[0])).rejects.toThrow('permission denied')
    await expect(command('generate_qr_batch', { quantity: 1 })).rejects.toThrow('permission denied')
  })
  it('keeps ordinary shipment creation, QR reading, copying and immutable shipment identity', async () => {
    await actor(merchant)
    const original = await command('create_shipment', form), copy = await command('create_shipment', form)
    expect(original.qr_id).not.toBe(copy.qr_id)
    expect((await pg.query('SELECT id FROM public.postal_shipments WHERE qr_id=$1', [original.qr_id])).rows).toHaveLength(1)
    await actor()
    expect((await pg.query('SELECT id FROM public.postal_generated_qrs WHERE id=$1', [original.qr_id])).rows).toHaveLength(0)
    await pg.exec('RESET ROLE')
    await expect(pg.query('UPDATE public.postal_shipments SET qr_id=$1 WHERE id=$2', [crypto.randomUUID(), original.id])).rejects.toThrow('postal_identity_is_immutable')
  })
})
