import { describe, expect, it } from 'vitest'
import { convertPosPrice, hasPosConversionRate, type PosRates } from '@/lib/posCart'
import { buildCheckoutRatesSnapshot } from '@/lib/currencyRates'
import { exchangeSnapshotsToPayloads } from '@/lib/salesExchange'
import type { CurrencyCode } from '@/local-db/models'

const entry = (rate: number) => ({ rate, source: 'isolated central-rate snapshot', timestamp: '2026-09-18T09:00:00.000Z' })
const rates = { usdIqd: entry(150000), eurIqd: entry(160000), usdEur: entry(95), tryIqd: entry(4000), usdTry: entry(3750) }
const examples: [CurrencyCode, CurrencyCode, number, number][] = [
    ['usd', 'iqd', 1.2345, 1852], ['iqd', 'usd', 1852, 1.23], ['eur', 'iqd', 1.2, 1920],
    ['iqd', 'eur', 2000, 1.25], ['try', 'iqd', 1.234, 49], ['iqd', 'try', 50, 1.25],
    ['usd', 'eur', 10, 9.5], ['eur', 'usd', 9.5, 10], ['usd', 'try', 10, 375],
    ['try', 'usd', 375, 10], ['eur', 'try', 2, 80], ['try', 'eur', 80, 2]
]
describe('POS currencies and immutable checkout rates', () => {
    for (const [from, to, amount, expected] of examples) it(`${from} → ${to} uses the correct direction and currency rounding`, () => {
        expect(hasPosConversionRate(from, to, rates)).toBe(true)
        expect(convertPosPrice(amount, from, to, rates)).toBe(expected)
    })
    for (const currency of ['usd', 'iqd', 'eur', 'try'] as const) it(`${currency}: same-currency fractions are preserved`, () => {
        expect(convertPosPrice(1.2345, currency, currency, rates)).toBe(1.2345)
        expect(convertPosPrice(0, currency, currency, rates)).toBe(0)
    })
    for (const invalid of [0, -1, NaN, Infinity]) it(`invalid rate ${invalid} cannot authorize checkout`, () => {
        const bad: PosRates = { ...rates, usdIqd: { rate: invalid } }
        expect(hasPosConversionRate('usd', 'iqd', bad)).toBe(false)
        expect(hasPosConversionRate('iqd', 'usd', bad)).toBe(false)
        expect(convertPosPrice(10, 'usd', 'iqd', bad)).toBe(10)
    })
    it('a base USD rate cannot substitute for a missing EUR or TRY rate', () => {
        expect(hasPosConversionRate('eur', 'iqd', { ...rates, eurIqd: null })).toBe(false)
        expect(hasPosConversionRate('try', 'eur', { ...rates, tryIqd: null })).toBe(false)
    })
    it('stores each used pair with rate basis, source and capture time', () => {
        const snapshots = buildCheckoutRatesSnapshot(new Set<CurrencyCode>(['usd', 'eur', 'iqd']), 'iqd', rates)
        const rows = exchangeSnapshotsToPayloads(snapshots)
        expect(rows).toMatchObject([
            { base_currency: 'usd', quote_currency: 'iqd', base_amount: 100, quote_amount: 150000, source: rates.usdIqd.source, captured_at: rates.usdIqd.timestamp },
            { base_currency: 'eur', quote_currency: 'iqd', base_amount: 100, quote_amount: 160000 }
        ])
        rates.usdIqd.rate = 160000
        expect(rows[0].quote_amount).toBe(150000)
        rates.usdIqd.rate = 150000
    })
})
