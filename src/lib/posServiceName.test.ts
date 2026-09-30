import { describe, expect, it } from 'vitest'
import {
  createPosServiceNameMetadata,
  formatPosServiceName,
  getPosServiceDisplayName,
  normalizePosServiceNameSuffix,
  readPosServiceNameSnapshot,
} from './posServiceName'

describe('POS service line names', () => {
  it('adds the app-owned separator and trims the optional suffix', () => {
    expect(formatPosServiceName('Services1', '  NewService  ')).toBe('Services1 - NewService')
    expect(formatPosServiceName('Services1', '')).toBe('Services1')
    expect(normalizePosServiceNameSuffix('   ')).toBe('')
  })

  it('stores a stable base-name snapshot and suffix in line metadata', () => {
    const metadata = createPosServiceNameMetadata(' Services1 ', ' NewService ')

    expect(metadata).toEqual({
      posServiceName: {
        baseNameSnapshot: 'Services1',
        suffix: 'NewService',
        displayNameSnapshot: 'Services1 - NewService',
      },
    })
    expect(getPosServiceDisplayName('Renamed catalog service', metadata!)).toBe('Services1 - NewService')
    expect(createPosServiceNameMetadata('Services1', '  ')).toBeUndefined()
  })

  it('ignores malformed historical metadata and empty snapshots', () => {
    expect(readPosServiceNameSnapshot({ posServiceName: { baseNameSnapshot: 'Service', suffix: ' ' } })).toBeNull()
    expect(readPosServiceNameSnapshot({ posServiceName: {
      baseNameSnapshot: 'Service', suffix: 'Extra', displayNameSnapshot: 'Service - Other'
    } })).toBeNull()
    expect(getPosServiceDisplayName('Services1', { posServiceName: 'invalid' })).toBe('Services1')
  })
})
