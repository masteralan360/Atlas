import type { CurrencyCode, ExchangeRateSnapshot } from '@/local-db/models'
import { roundOrderValue } from '@/lib/orderPrecision'

export const CACHED_EXCHANGE_RATES_SNAPSHOT_KEY = 'atlas:cached-exchange-rates-snapshot'
const EXCHANGE_RATE_DECIMAL_PLACES = 8

type RateSnapshot = {
    rate: number
    source: string
    timestamp?: string
} | null

export interface LiveOrderRates {
    exchangeData: RateSnapshot
    eurRates: {
        usd_eur: RateSnapshot
        eur_iqd: RateSnapshot
    }
    tryRates: {
        usd_try: RateSnapshot
        try_iqd: RateSnapshot
    }
}

function normalizeAmount(amount: number, _currency: CurrencyCode) {
    return roundOrderValue(amount)
}

function roundExchangeRate(rate: number) {
    const multiplier = 10 ** EXCHANGE_RATE_DECIMAL_PLACES
    return Math.round(rate * multiplier) / multiplier
}

export interface AppliedCurrencyConversion {
    convertedAmount: number
    /** One unit of `fromCurrency`, expressed in `toCurrency`. */
    exchangeRate: number
    exchangeRateSource: string
    exchangeRateTimestamp: string
    /** Exact rate snapshots used for this conversion, including cross-rate legs. */
    exchangeRates: ExchangeRateSnapshot[]
}

function normalizeSnapshot(snapshot?: readonly ExchangeRateSnapshot[] | null) {
    if (!Array.isArray(snapshot)) {
        return []
    }

    return snapshot.filter((entry): entry is ExchangeRateSnapshot => (
        !!entry
        && typeof entry.pair === 'string'
        && typeof entry.rate === 'number'
        && Number.isFinite(entry.rate)
        && typeof entry.source === 'string'
    ))
}

function mergeSnapshots(...snapshots: Array<ExchangeRateSnapshot[] | null | undefined>) {
    const merged = new Map<string, ExchangeRateSnapshot>()

    for (const snapshot of snapshots) {
        for (const entry of normalizeSnapshot(snapshot)) {
            const key = entry.pair.toUpperCase()
            if (!merged.has(key)) {
                merged.set(key, entry)
            }
        }
    }

    return Array.from(merged.values())
}

function hasConversionPath(from: CurrencyCode, to: CurrencyCode, snapshot?: ExchangeRateSnapshot[] | null) {
    if (from === to) {
        return true
    }

    const pairs = new Set(normalizeSnapshot(snapshot).map((entry) => entry.pair.toUpperCase()))
    const has = (pair: 'USD/IQD' | 'USD/EUR' | 'EUR/IQD' | 'USD/TRY' | 'TRY/IQD') => pairs.has(pair)

    if ((from === 'usd' && to === 'iqd') || (from === 'iqd' && to === 'usd')) return has('USD/IQD')
    if ((from === 'usd' && to === 'eur') || (from === 'eur' && to === 'usd')) return has('USD/EUR')
    if ((from === 'eur' && to === 'iqd') || (from === 'iqd' && to === 'eur')) return has('EUR/IQD')
    if ((from === 'usd' && to === 'try') || (from === 'try' && to === 'usd')) return has('USD/TRY')
    if ((from === 'try' && to === 'iqd') || (from === 'iqd' && to === 'try')) return has('TRY/IQD')
    if ((from === 'try' && to === 'eur') || (from === 'eur' && to === 'try')) return has('TRY/IQD') && has('EUR/IQD')

    return false
}

function convertCurrencyAmountInternal(
    amount: number,
    from: CurrencyCode,
    to: CurrencyCode,
    getRate: (pair: 'USD/IQD' | 'USD/EUR' | 'EUR/IQD' | 'USD/TRY' | 'TRY/IQD') => number | null
) {
    if (from === to) {
        return normalizeAmount(amount, to)
    }

    let converted = amount

    const usdIqd = getRate('USD/IQD')
    const usdEur = getRate('USD/EUR')
    const eurIqd = getRate('EUR/IQD')
    const usdTry = getRate('USD/TRY')
    const tryIqd = getRate('TRY/IQD')

    if (from === 'usd' && to === 'iqd' && usdIqd) converted = amount * usdIqd
    else if (from === 'iqd' && to === 'usd' && usdIqd) converted = amount / usdIqd
    else if (from === 'usd' && to === 'eur' && usdEur) converted = amount * usdEur
    else if (from === 'eur' && to === 'usd' && usdEur) converted = amount / usdEur
    else if (from === 'eur' && to === 'iqd' && eurIqd) converted = amount * eurIqd
    else if (from === 'iqd' && to === 'eur' && eurIqd) converted = amount / eurIqd
    else if (from === 'usd' && to === 'try' && usdTry) converted = amount * usdTry
    else if (from === 'try' && to === 'usd' && usdTry) converted = amount / usdTry
    else if (from === 'try' && to === 'iqd' && tryIqd) converted = amount * tryIqd
    else if (from === 'iqd' && to === 'try' && tryIqd) converted = amount / tryIqd
    else if (from === 'try' && to === 'eur' && tryIqd && eurIqd) converted = (amount * tryIqd) / eurIqd
    else if (from === 'eur' && to === 'try' && eurIqd && tryIqd) converted = (amount * eurIqd) / tryIqd

    return normalizeAmount(converted, to)
}

export function convertCurrencyAmountWithLiveRates(
    amount: number,
    from: CurrencyCode,
    to: CurrencyCode,
    rates: LiveOrderRates
) {
    return convertCurrencyAmountInternal(amount, from, to, (pair) => {
        if (pair === 'USD/IQD') {
            return rates.exchangeData ? rates.exchangeData.rate / 100 : null
        }
        if (pair === 'USD/EUR') {
            return rates.eurRates.usd_eur ? rates.eurRates.usd_eur.rate / 100 : null
        }
        if (pair === 'EUR/IQD') {
            return rates.eurRates.eur_iqd ? rates.eurRates.eur_iqd.rate / 100 : null
        }
        if (pair === 'USD/TRY') {
            return rates.tryRates.usd_try ? rates.tryRates.usd_try.rate / 100 : null
        }
        if (pair === 'TRY/IQD') {
            return rates.tryRates.try_iqd ? rates.tryRates.try_iqd.rate / 100 : null
        }
        return null
    })
}

export function convertCurrencyAmountWithSnapshot(
    amount: number,
    from: CurrencyCode,
    to: CurrencyCode,
    snapshot?: ExchangeRateSnapshot[] | null
) {
    const ratesByPair = new Map((snapshot ?? []).map((entry) => [
        entry.pair.toUpperCase(),
        entry.rate / (entry.priceBasisAmount || 100)
    ]))

    return convertCurrencyAmountInternal(amount, from, to, (pair) => ratesByPair.get(pair) ?? null)
}

/**
 * Resolves and locks a conversion using the order's rate snapshot. Unlike the
 * display conversion helpers, this returns null when no complete path exists
 * so callers never accidentally save an unconverted cross-currency amount.
 */
export function getAppliedCurrencyConversion(
    amount: number,
    fromCurrency: CurrencyCode,
    toCurrency: CurrencyCode,
    snapshot?: readonly ExchangeRateSnapshot[] | null
): AppliedCurrencyConversion | null {
    if (!Number.isFinite(amount) || amount < 0) return null

    const now = new Date().toISOString()
    if (amount === 0) {
        return {
            convertedAmount: 0,
            exchangeRate: 1,
            exchangeRateSource: fromCurrency === toCurrency ? 'native' : 'zero_amount',
            exchangeRateTimestamp: now,
            exchangeRates: []
        }
    }
    if (fromCurrency === toCurrency) {
        return {
            convertedAmount: normalizeAmount(amount, toCurrency),
            exchangeRate: 1,
            exchangeRateSource: 'native',
            exchangeRateTimestamp: now,
            exchangeRates: []
        }
    }

    type Edge = { to: CurrencyCode, factor: number, snapshot: ExchangeRateSnapshot }
    const graph = new Map<CurrencyCode, Edge[]>()
    const addEdge = (from: CurrencyCode, edge: Edge) => {
        const edges = graph.get(from) ?? []
        edges.push(edge)
        graph.set(from, edges)
    }

    for (const entry of normalizeSnapshot(snapshot)) {
        const [base, quote, ...rest] = entry.pair.toLowerCase().split('/')
        const basis = Number(entry.priceBasisAmount || 100)
        if (
            rest.length > 0
            || !base
            || !quote
            || !Number.isFinite(basis)
            || basis <= 0
            || entry.rate <= 0
        ) continue

        const factor = entry.rate / basis
        if (!Number.isFinite(factor) || factor <= 0) continue
        addEdge(base as CurrencyCode, { to: quote as CurrencyCode, factor, snapshot: entry })
        addEdge(quote as CurrencyCode, { to: base as CurrencyCode, factor: 1 / factor, snapshot: entry })
    }

    const queue: Array<{ currency: CurrencyCode, factor: number, snapshots: ExchangeRateSnapshot[] }> = [
        { currency: fromCurrency, factor: 1, snapshots: [] }
    ]
    const visited = new Set<CurrencyCode>([fromCurrency])

    while (queue.length > 0) {
        const current = queue.shift()!
        for (const edge of graph.get(current.currency) ?? []) {
            if (visited.has(edge.to)) continue
            const next = {
                currency: edge.to,
                factor: current.factor * edge.factor,
                snapshots: [...current.snapshots, edge.snapshot]
            }
            if (edge.to === toCurrency) {
                const exchangeRate = roundExchangeRate(next.factor)
                if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) return null
                const sources = Array.from(new Set(next.snapshots.map((rate) => rate.source).filter(Boolean)))
                const timestamps = next.snapshots.map((rate) => rate.timestamp).filter(Boolean).sort()
                return {
                    convertedAmount: normalizeAmount(amount * next.factor, toCurrency),
                    exchangeRate,
                    exchangeRateSource: sources.length === 1 ? sources[0] : sources.length > 1 ? 'mixed' : 'unknown',
                    exchangeRateTimestamp: timestamps.at(-1) || now,
                    exchangeRates: next.snapshots
                }
            }
            visited.add(edge.to)
            queue.push(next)
        }
    }

    return null
}

export function cacheExchangeRatesSnapshot(snapshot?: ExchangeRateSnapshot[] | null) {
    if (typeof window === 'undefined') {
        return
    }

    const normalized = normalizeSnapshot(snapshot)
    if (normalized.length === 0) {
        window.localStorage.removeItem(CACHED_EXCHANGE_RATES_SNAPSHOT_KEY)
        return
    }

    window.localStorage.setItem(CACHED_EXCHANGE_RATES_SNAPSHOT_KEY, JSON.stringify(normalized))
}

export function readCachedExchangeRatesSnapshot(): ExchangeRateSnapshot[] | null {
    if (typeof window === 'undefined') {
        return null
    }

    const rawSnapshot = window.localStorage.getItem(CACHED_EXCHANGE_RATES_SNAPSHOT_KEY)
    if (!rawSnapshot) {
        return null
    }

    try {
        const parsed = JSON.parse(rawSnapshot)
        const normalized = normalizeSnapshot(parsed)
        return normalized.length > 0 ? normalized : null
    } catch {
        return null
    }
}

export function getEffectiveExchangeRatesSnapshot(snapshot?: ExchangeRateSnapshot[] | null) {
    const merged = mergeSnapshots(snapshot, readCachedExchangeRatesSnapshot())
    return merged.length > 0 ? merged : null
}

export function convertCurrencyAmountWithAvailableSnapshot(
    amount: number,
    from: CurrencyCode,
    to: CurrencyCode,
    snapshot?: ExchangeRateSnapshot[] | null
) {
    const effectiveSnapshot = getEffectiveExchangeRatesSnapshot(snapshot)
    if (!hasConversionPath(from, to, effectiveSnapshot)) {
        return from === to ? normalizeAmount(amount, to) : null
    }

    return convertCurrencyAmountWithSnapshot(amount, from, to, effectiveSnapshot)
}

export function buildOrderExchangeRatesSnapshot(rates: LiveOrderRates): ExchangeRateSnapshot[] {
    const now = new Date().toISOString()
    const snapshot: ExchangeRateSnapshot[] = []

    if (rates.exchangeData) {
        snapshot.push({
            pair: 'USD/IQD',
            rate: rates.exchangeData.rate,
            source: rates.exchangeData.source,
            timestamp: rates.exchangeData.timestamp || now
        })
    }

    if (rates.eurRates.usd_eur) {
        snapshot.push({
            pair: 'USD/EUR',
            rate: rates.eurRates.usd_eur.rate,
            source: rates.eurRates.usd_eur.source,
            timestamp: rates.eurRates.usd_eur.timestamp || now
        })
    }

    if (rates.eurRates.eur_iqd) {
        snapshot.push({
            pair: 'EUR/IQD',
            rate: rates.eurRates.eur_iqd.rate,
            source: rates.eurRates.eur_iqd.source,
            timestamp: rates.eurRates.eur_iqd.timestamp || now
        })
    }

    if (rates.tryRates.usd_try) {
        snapshot.push({
            pair: 'USD/TRY',
            rate: rates.tryRates.usd_try.rate,
            source: rates.tryRates.usd_try.source,
            timestamp: rates.tryRates.usd_try.timestamp || now
        })
    }

    if (rates.tryRates.try_iqd) {
        snapshot.push({
            pair: 'TRY/IQD',
            rate: rates.tryRates.try_iqd.rate,
            source: rates.tryRates.try_iqd.source,
            timestamp: rates.tryRates.try_iqd.timestamp || now
        })
    }

    return snapshot
}

export function filterSnapshotByCurrency(snapshot: ExchangeRateSnapshot[] | null, currency: CurrencyCode): ExchangeRateSnapshot[] | null {
    if (!snapshot || snapshot.length === 0) return null
    const code = currency.toUpperCase()
    const filtered = snapshot.filter((entry) => entry.pair.includes(code))
    return filtered.length > 0 ? filtered : null
}

export function getPrimaryExchangeDetails(
    from: CurrencyCode,
    to: CurrencyCode,
    snapshot?: ExchangeRateSnapshot[] | null
) {
    const timestamp = new Date().toISOString()

    if (from === to) {
        return {
            exchangeRate: 100,
            exchangeRateSource: 'native',
            exchangeRateTimestamp: timestamp
        }
    }

    const upperSnapshot = snapshot ?? []
    const directPair = `${from.toUpperCase()}/${to.toUpperCase()}`
    const inversePair = `${to.toUpperCase()}/${from.toUpperCase()}`
    const direct = upperSnapshot.find((entry) => entry.pair.toUpperCase() === directPair)
    if (direct) {
        return {
            exchangeRate: direct.rate,
            exchangeRateSource: direct.source,
            exchangeRateTimestamp: direct.timestamp
        }
    }

    const inverse = upperSnapshot.find((entry) => entry.pair.toUpperCase() === inversePair)
    if (inverse) {
        const actualRate = inverse.rate > 0 ? Math.round((10000 / inverse.rate) * 100) / 100 : 100
        return {
            exchangeRate: actualRate,
            exchangeRateSource: inverse.source,
            exchangeRateTimestamp: inverse.timestamp
        }
    }

    return {
        exchangeRate: Math.round(convertCurrencyAmountWithSnapshot(1, from, to, upperSnapshot) * 100),
        exchangeRateSource: upperSnapshot[0]?.source || 'mixed',
        exchangeRateTimestamp: upperSnapshot[0]?.timestamp || timestamp
    }
}
