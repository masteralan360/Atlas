import { describe, expect, it } from 'vitest'
import { canReadPostalStatement, normalizePostalStatement } from './postalStatementData'

const scope = { workspaceId: 'workspace', userId: 'viewer', role: 'office' as const, permissionScope: 'postService.officeEmployee' }
const fixture = () => ({
  organization: { id: 'organization', workspace_id: 'workspace', name: 'Merchant', code: 'ABCDEFGH', leader_id: 'leader' },
  total: 1,
  entries: [{ id: 'record', kind: 'collection', created_at: '2026-10-01T12:00:00Z', shipment_id: 'shipment',
    shipment_number: 1, shipment_created_at: '2026-10-01T00:00:00Z', recipient_name: 'Recipient', primary_phone: '07501234567', shipment_state: 'delivered',
    signed_amount: '999999999999', debit: '0', credit: '999999999999', balance: '10000999999999999',
    payment_transaction_id: 'payment', payment_direction: 'incoming', payment_method: 'cash', account_name_snapshot: null, notes: null }],
  summary: { opening_balance: '10000000000000000', debit_total: '0', credit_total: '999999999999', closing_balance: '10000999999999999',
    collections: '999999999999', settlements: '0', delivery_fees: '0', current_due_to: '10000999999999999', current_due_from: '0', recipient_due: '0', recipient_refund_due: '0', missing_tariffs: 0 },
})
describe('postal statement validation', () => {
  it('preserves exact IQD amounts beyond JavaScript safe numeric precision', () => {
    const result = normalizePostalStatement(fixture(), 'workspace', 'organization')
    expect(result.summary.closing_balance).toBe('10000999999999999')
    expect(result.entries[0].balance).toBe('10000999999999999')
  })
  it('rejects foreign scopes, malformed amounts, invalid dates and inconsistent totals', () => {
    expect(() => normalizePostalStatement(fixture(), 'other-workspace', 'organization')).toThrow()
    expect(() => normalizePostalStatement(fixture(), 'workspace', 'other-organization')).toThrow()
    for (const change of [
      (d: ReturnType<typeof fixture>) => { d.summary.closing_balance = '2' },
      (d: ReturnType<typeof fixture>) => { d.summary.debit_total = '0.1' },
      (d: ReturnType<typeof fixture>) => { d.entries[0].credit = '0' },
      (d: ReturnType<typeof fixture>) => { d.entries[0].created_at = 'not-a-date' },
      (d: ReturnType<typeof fixture>) => { d.total = 0 },
      (d: ReturnType<typeof fixture>) => { d.entries[0].shipment_number = 0 },
    ]) {
      const data = fixture(); change(data)
      expect(() => normalizePostalStatement(data, 'workspace', 'organization')).toThrow('postal_invalid_result')
    }
  })
  it('fails closed for merchants, missing permission, missing viewer and workspace', () => {
    expect(canReadPostalStatement(scope)).toBe(true)
    expect(canReadPostalStatement({ ...scope, role: 'admin', permissionScope: '' })).toBe(true)
    expect(canReadPostalStatement({ ...scope, role: 'merchant', permissionScope: 'postService.merchant' })).toBe(false)
    expect(canReadPostalStatement({ ...scope, permissionScope: '' })).toBe(false)
    expect(canReadPostalStatement({ ...scope, userId: '' })).toBe(false)
    expect(canReadPostalStatement({ ...scope, workspaceId: '' })).toBe(false)
  })
})
