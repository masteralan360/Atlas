import type { CurrencyCode, ExchangeRateSnapshot } from '@/local-db/models'

export interface RateEntry {
  rate: number
  source: string
  timestamp: string
}

export interface KnownRates {
  usdIqd: RateEntry | null
  eurIqd: RateEntry | null
  tryIqd: RateEntry | null
  usdEur?: RateEntry | null
  usdTry?: RateEntry | null
}


function baseRate(currency: CurrencyCode, rates: KnownRates): RateEntry | null {
  if (currency === 'usd') return rates.usdIqd
  if (currency === 'eur') return rates.eurIqd
  if (currency === 'try') return rates.tryIqd
  return null
}

// Exchange rates are quoted as the amount of `to` currency for 100 units of
// `from`. Keep the same basis when reversing a pair: 10000 / directRate.
function inverseRate(rate: number): number | null {
  if (!Number.isFinite(rate) || rate <= 0) return null
  return Math.round((10000 / rate) * 1_000_000) / 1_000_000
}

export function computePairRate(
  from: CurrencyCode,
  to: CurrencyCode,
  rates: KnownRates,
): { rate: number; source: string; timestamp: string } | null {
  if (from === to) return null
  const now = new Date().toISOString()

  const direct = pairFromRates(from, to, rates)
  if (direct) return direct

  const fromIqd = baseRate(from, rates)
  const toIqd = baseRate(to, rates)
  if (fromIqd && toIqd && toIqd.rate > 0) {
    const crossRate = Math.round(fromIqd.rate / toIqd.rate * 10000) / 100
    return {
      rate: crossRate,
      source: `${fromIqd.source}/${toIqd.source}`,
      timestamp: now,
    }
  }

  return null
}

function pairFromRates(from: CurrencyCode, to: CurrencyCode, rates: KnownRates): { rate: number; source: string; timestamp: string } | null {
  if (from === 'usd' && to === 'iqd' && rates.usdIqd) return rates.usdIqd
  if (from === 'eur' && to === 'iqd' && rates.eurIqd) return rates.eurIqd
  if (from === 'try' && to === 'iqd' && rates.tryIqd) return rates.tryIqd
  if (from === 'usd' && to === 'eur' && rates.usdEur) return rates.usdEur
  if (from === 'usd' && to === 'try' && rates.usdTry) return rates.usdTry

  if (from === 'iqd' && to === 'usd' && rates.usdIqd) {
    const rate = inverseRate(rates.usdIqd.rate)
    return rate != null
      ? { rate, source: rates.usdIqd.source, timestamp: rates.usdIqd.timestamp }
      : null
  }
  if (from === 'iqd' && to === 'eur' && rates.eurIqd) {
    const rate = inverseRate(rates.eurIqd.rate)
    return rate != null
      ? { rate, source: rates.eurIqd.source, timestamp: rates.eurIqd.timestamp }
      : null
  }
  if (from === 'iqd' && to === 'try' && rates.tryIqd) {
    const rate = inverseRate(rates.tryIqd.rate)
    return rate != null
      ? { rate, source: rates.tryIqd.source, timestamp: rates.tryIqd.timestamp }
      : null
  }
  if (from === 'eur' && to === 'usd' && rates.usdEur) {
    const rate = inverseRate(rates.usdEur.rate)
    return rate != null
      ? { rate, source: rates.usdEur.source, timestamp: rates.usdEur.timestamp }
      : null
  }
  if (from === 'try' && to === 'usd' && rates.usdTry) {
    const rate = inverseRate(rates.usdTry.rate)
    return rate != null
      ? { rate, source: rates.usdTry.source, timestamp: rates.usdTry.timestamp }
      : null
  }

  const fromIqd = baseRate(from, rates)
  const toIqd = baseRate(to, rates)
  if (fromIqd && toIqd && toIqd.rate > 0) {
    const crossRate = Math.round(fromIqd.rate / toIqd.rate * 10000) / 100
    return {
      rate: crossRate,
      source: `${fromIqd.source}/${toIqd.source}`,
      timestamp: new Date().toISOString(),
    }
  }

  return null
}

export function buildExchangeRateSnapshot(
  from: CurrencyCode,
  to: CurrencyCode,
  rates: KnownRates,
): ExchangeRateSnapshot | null {
  if (from === to) return null
  const computed = computePairRate(from, to, rates)
  if (!computed) return null

  // Store IQD market snapshots in the provider's canonical foreign/IQD
  // direction. This keeps the snapshot readable and avoids persisting the
  // lossy inverse direction for future sales.
  const snapshotFrom = from === 'iqd' ? to : from
  const snapshotTo = from === 'iqd' ? 'iqd' : to
  const snapshotRate = from === 'iqd'
    ? computePairRate(to, 'iqd', rates)
    : computed
  if (!snapshotRate) return null

  return {
    pair: `${snapshotFrom.toUpperCase()}/${snapshotTo.toUpperCase()}`,
    rate: snapshotRate.rate,
    source: snapshotRate.source,
    timestamp: snapshotRate.timestamp,
    priceBasisAmount: 100,
  }
}

export function buildCheckoutRatesSnapshot(
  itemCurrencies: Set<CurrencyCode>,
  settlementCurrency: CurrencyCode,
  rates: KnownRates,
): ExchangeRateSnapshot[] {
  const snapshot: ExchangeRateSnapshot[] = []

  for (const itemCurrency of itemCurrencies) {
    if (itemCurrency === settlementCurrency) continue
    const entry = buildExchangeRateSnapshot(itemCurrency, settlementCurrency, rates)
    if (entry) snapshot.push(entry)
  }

  if (snapshot.length === 0 && itemCurrencies.size > 0) {
    const firstCurrency = itemCurrencies.values().next().value
    if (firstCurrency) {
      const entry = buildExchangeRateSnapshot(firstCurrency, 'iqd', rates)
      if (entry) snapshot.push(entry)
    }
  }

  return snapshot
}

export function getPrimaryCheckoutRate(
  itemCurrencies: Set<CurrencyCode>,
  settlementCurrency: CurrencyCode,
  rates: KnownRates,
): { rate: number; source: string; timestamp: string } | null {
  for (const itemCurrency of itemCurrencies) {
    if (itemCurrency === settlementCurrency) continue
    const computed = computePairRate(itemCurrency, settlementCurrency, rates)
    if (computed) return computed
  }

  for (const itemCurrency of itemCurrencies) {
    const computed = computePairRate(itemCurrency, 'iqd', rates)
    if (computed) return computed
  }

  return null
}
