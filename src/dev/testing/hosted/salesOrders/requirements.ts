import { extendedConfig, requireFixture } from './harness'
import { HostedBlocked, type Family } from './types'
import type { QuickTuple } from './choices'

/** Prerequisites are reported before disposable business fixtures are created. No missing persona is impersonated. */
const prepared: Record<string, number[]> = {
    '01': [5, 7, 8, 10], '02': [2, 4, 7, 8], '03': [6, 7, 8, 9, 10, 12], '05': [3],
    '07': [9, 12], '09': [11], '10': [12], '14': [11, 14, 15], '15': [5, 6, 7, 9, 10],
    '13': [14], '16': [10, 11, 12, 14], '18': [8, 9], '20': [12, 13], '22': [9, 10, 13, 14], '23': [2, 3, 5, 11],
    '24': Array.from({ length: 15 }, (_, i) => i + 1), '26': [11, 14], '27': [5, 8],
    '29': Array.from({ length: 11 }, (_, i) => i + 1), '30': [4, 8]
}
const personas: Record<string, string> = {
    'SO-H01-02': 'staff', 'SO-H01-03': 'viewer', 'SO-H01-06': 'revoked-member',
    'SO-H01-07': 'foreign-workspace', 'SO-H01-08': 'foreign-workspace', 'SO-H01-09': 'staff', 'SO-H01-10': 'foreign-workspace', 'SO-H01-12': 'viewer',
    'SO-H02-03': 'orders-disabled', 'SO-H02-09': 'own-only', 'SO-H02-10': 'storage-restricted',
    'SO-H02-11': 'revoked-permission', 'SO-H02-12': 'commission-restricted',
    'SO-H06-08': 'staff', 'SO-H06-10': 'staff', 'SO-H10-07': 'staff', 'SO-H15-07': 'restricted-staff',
    'SO-H21-06': 'staff',
    'SO-H27-05': 'foreign-workspace', 'SO-H27-07': 'viewer', 'SO-H27-12': 'viewer'
}
export function ensurePreconditions(family: Family, tuple?: QuickTuple) {
    const domain = family.id.slice(4, 6), ordinal = Number(family.id.slice(-2))
    const persona = personas[family.id]
    if (persona && !extendedConfig().personas?.[persona]) throw new HostedBlocked(`persona ${persona} is not configured`)
    if (family.id === 'SO-H21-06' && !extendedConfig().personas?.viewer) throw new HostedBlocked('persona viewer is not configured')
    if (prepared[domain]?.includes(ordinal)) requireFixture(family.id)
    if (domain === '12' && [12, 13].includes(ordinal) && !extendedConfig().observer) throw new HostedBlocked('read-only private receipt observer is not configured')
    if (tuple?.unit === 'custom' && typeof requireFixture(family.id).customUnitId !== 'string') throw new HostedBlocked('Quick custom-unit fixture')
    if ((tuple?.lines === 'service' || tuple?.lines === 'mixed') && process.env.ATLAS_LIVE_SERVICES_ENABLED !== 'true') throw new HostedBlocked('services capability unavailable')
}

export function requirementsFor(caseId: string): string[] {
    const domain = caseId.slice(4, 6), ordinal = Number(caseId.slice(-2))
    return [
        ...(personas[caseId] ? [`persona:${personas[caseId]}`] : []),
        ...(prepared[domain]?.includes(ordinal) ? [`fixture:${caseId}`] : []),
        ...(caseId === 'SO-H12-12' || caseId === 'SO-H12-13' ? ['private-read-only-observer'] : [])
    ]
}
