import { describe, expect, it } from 'vitest'
import {
  normalizePostalDashboardSummary,
  sanitizePostalSearch,
} from './postalSummary'
import { queryKeys } from '@/query/queryKeys'

const result = {
  total_shipments: 10,
  active_shipments: 5,
  delivered_shipments: 3,
  in_transit_shipments: 2,
  cod_balance: '9007199254740993123',
  collection_records: 4,
}
describe('Post Service dashboard contract', () => {
  it('preserves exact IQD totals, including negative and very large balances', () => {
    expect(normalizePostalDashboardSummary(result)).toEqual(result)
    expect(
      BigInt(
        normalizePostalDashboardSummary({
          ...result,
          cod_balance: '-9007199254740993123',
        }).cod_balance,
      ),
    ).toBe(-9007199254740993123n)
  })
  it('rejects malformed totals rather than rendering them as zero', () => {
    for (const value of [
      null,
      {},
      { ...result, cod_balance: 1 },
      { ...result, cod_balance: '1.5' },
      { ...result, active_shipments: NaN },
      { ...result, delivered_shipments: -1 },
      { ...result, active_shipments: 12 },
    ]) {
      expect(() => normalizePostalDashboardSummary(value)).toThrow(
        'postal_invalid_result',
      )
    }
  })
  it('uses the same search normalization for shipment pages and totals', () => {
    expect(sanitizePostalSearch(' Al%p_ha(),.\\ ')).toBe('Alpha')
  })
  it('scopes summary caches by workspace, viewer, permissions and every filter', () => {
    const input = {
      workspaceId: 'workspace',
      userId: 'merchant-a',
      role: 'merchant' as const,
      permissionScope: 'postService.merchant',
      search: '',
      status: 'all',
      start: '2026-10-01',
      end: '2026-11-01',
    }
    const key = queryKeys.postal.summary(input)
    for (const changes of [
      { userId: 'merchant-b' },
      { workspaceId: 'other' },
      { role: 'office' as const },
      { permissionScope: 'changed' },
      { search: 'recipient' },
      { status: 'delivered' },
      { start: '2026-10-02' },
      { end: '2026-11-02' },
    ]) {
      expect(queryKeys.postal.summary({ ...input, ...changes })).not.toEqual(
        key,
      )
    }
  })
})
