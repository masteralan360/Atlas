import type { CurrencyCode, ExchangeRateSnapshot } from '@/local-db/models'

export const CACHED_EXCHANGE_RATES_SNAPSHOT_KEY = 'atlas:cached-exchange-rates-snapshot'

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

function normalizeAmount(amount: number, currency: CurrencyCode) {
    if (currency === 'iqd') {
        return Math.round(amount)
    }

    return Math.round(amount * 100) / 100
}

function normalizeSnapshot(snapshot?: ExchangeRateSnapshot[] | null) {
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
    const ratesByPair = new Map((snapshot ?? []).map((entry) => [entry.pair.toUpperCase(), entry.rate / 100]))

    return convertCurrencyAmountInternal(amount, from, to, (pair) => ratesByPair.get(pair) ?? null)
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
