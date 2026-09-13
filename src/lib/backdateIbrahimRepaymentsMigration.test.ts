import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const correctionSql = readFileSync(
  new URL('../../supabase/migrations/20260913064824_backdate_ibrahim_repayments_before_so_00054.sql', import.meta.url),
  'utf8',
)
const rollbackSql = readFileSync(
  new URL('../../supabase/manual-rollbacks/20260913064824_rollback_backdate_ibrahim_repayments_before_so_00054.sql', import.meta.url),
  'utf8',
)

describe('Ibrahim repayment chronology correction migration', () => {
  it('moves only the two verified repayments immediately before SO-2026-00054', () => {
    expect(correctionSql).toContain('BEGIN;')
    expect(correctionSql).toContain('COMMIT;')
    expect(correctionSql).toContain("order_number = 'SO-2026-00054'")
    expect(correctionSql).toContain("'ea9a7a7a-77f5-47d7-869f-ac66130a8c4a'::uuid")
    expect(correctionSql).toContain("'a0134bbd-134b-4749-93dc-0db5a48caf34'::uuid")
    expect(correctionSql).toContain("'2026-09-12 04:49:50.516+00'::timestamptz")
    expect(correctionSql).toContain("'2026-09-12 04:49:51.516+00'::timestamptz")
    expect(correctionSql).toContain('payment.paid_at < v_order_created_at')
    expect(correctionSql).toContain('Ibrahim repayment chronology correction failed verification')
  })

  it('keeps the rollback manual and restores the exact original repayment timestamps', () => {
    expect(rollbackSql).toContain('MANUAL ROLLBACK')
    expect(rollbackSql).toContain('outside supabase/migrations')
    expect(rollbackSql).toContain("'2026-09-12 04:53:00+00'::timestamptz")
    expect(rollbackSql).toContain('The Ibrahim repayment correction is not in its expected state; refusing rollback')
    expect(rollbackSql).toContain('Ibrahim repayment rollback failed verification')
    expect(rollbackSql).toContain('BEGIN;')
    expect(rollbackSql).toContain('COMMIT;')
  })
})
