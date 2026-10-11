import { useEffect } from 'react'
import Dexie from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { addToOfflineMutations, fetchTableFromSupabase } from './hooks'
import type {
    CurrencyCode,
    ExchangeAcquisitionRateSource,
    ExchangeFeeRule,
    ExchangeFeeRuleSnapshot,
    ExchangeFeeRuleTransactionScope,
    ExchangeFeeType,
    ExchangePaymentMethod,
    ExchangePairPrice,
    ExchangeRateSnapshot,
    ExchangeSafe,
    ExchangeSafeBalance,
    ExchangeSafeMovement,
    ExchangeTransaction,
    ExchangeTransactionType
} from './models'

const TRANSACTIONS_TABLE = 'exchange_transactions'
const FEE_RULES_TABLE = 'exchange_fee_rules'
const PAIR_PRICES_TABLE = 'exchange_pair_prices'
const SAFES_TABLE = 'fx_safes'
const SAFE_BALANCES_TABLE = 'fx_safe_balances'
const SAFE_MOVEMENTS_TABLE = 'fx_safe_movements'

type ExchangeTableName =
    | typeof TRANSACTIONS_TABLE
    | typeof FEE_RULES_TABLE
    | typeof PAIR_PRICES_TABLE
    | typeof SAFES_TABLE
    | typeof SAFE_BALANCES_TABLE
    | typeof SAFE_MOVEMENTS_TABLE
type ExchangeSyncEntity = Record<string, unknown> & {
    id: string
    workspaceId: string
    version: number
}

const tableByName = {
    [TRANSACTIONS_TABLE]: db.exchange_transactions,
    [FEE_RULES_TABLE]: db.exchange_fee_rules,
    [PAIR_PRICES_TABLE]: db.exchange_pair_prices,
    [SAFES_TABLE]: db.fx_safes,
    [SAFE_BALANCES_TABLE]: db.fx_safe_balances,
    [SAFE_MOVEMENTS_TABLE]: db.fx_safe_movements
} as const

export const EXCHANGE_SAFE_CURRENCIES: CurrencyCode[] = ['iqd', 'usd', 'eur', 'try']
export const DEFAULT_EXCHANGE_PAIR_PRICE_BASIS = 100

export type ExchangePairPriceSide = 'buy' | 'sell'
export type ExchangePairPriceQuote = Pick<ExchangePairPrice, 'id' | 'baseCurrency' | 'quoteCurrency' | 'buyPrice' | 'sellPrice' | 'priceBasisAmount' | 'updatedAt'>

export interface ExchangeCalculationInput {
    transactionType: ExchangeTransactionType
    pairPrice: ExchangePairPriceQuote
    customerGivesAmount: number
    feeType?: ExchangeFeeType | null
    feeCurrency?: CurrencyCode | null
    feeValue?: number | null
    feeBasisAmount?: number | null
}

export interface ExchangeCalculationResult {
    baseReceivesAmount: number
    customerReceivesAmount: number
    feeAmount: number
    feeAmountInToCurrency: number
}

export interface CreateExchangeTransactionInput {
    transactionType: ExchangeTransactionType
    transactionDate?: string
    safeId: string
    pairPrice: ExchangePairPriceQuote
    customerGivesAmount: number
    exchangeRateUsed: number
    exchangeRateSource: string
    exchangeRateManuallyEdited: boolean
    marketRateSnapshot: ExchangeRateSnapshot[]
    feeRuleId?: string | null
    feeRuleSnapshot?: ExchangeFeeRuleSnapshot | null
    feeType?: ExchangeFeeType | null
    feeCurrency?: CurrencyCode | null
    originalFeeValue?: number | null
    finalFeeValue?: number | null
    feeBasisAmount?: number | null
    acquisitionRate?: number | null
    acquisitionRateSource?: ExchangeAcquisitionRateSource | null
    acquisitionRateSnapshot?: ExchangeRateSnapshot[] | null
    paymentMethod: ExchangePaymentMethod
    employeeUserId?: string | null
    employeeName?: string | null
    notes?: string | null
    createdBy?: string | null
}

export interface CreateExchangeSafeInput {
    name: string
    openingBalances?: Partial<Record<CurrencyCode, number>>
    notes?: string | null
    createdBy?: string | null
    isAdmin: boolean
}

export interface CreateExchangeSafeAdjustmentInput {
    safeId: string
    currency: CurrencyCode
    amount: number
    notes?: string | null
    createdBy?: string | null
    isAdmin: boolean
}

export interface SaveExchangeFeeRuleInput {
    name: string
    transactionScope: ExchangeFeeRuleTransactionScope
    feeType: ExchangeFeeType
    currency: CurrencyCode
    value: number
    customerGivesBasisAmount: number
    effectiveStartDate: string
    effectiveEndDate?: string | null
    isActive: boolean
    isLocked: boolean
    notes?: string | null
    createdBy?: string | null
}

export interface SaveExchangePairPriceInput {
    baseCurrency: CurrencyCode
    quoteCurrency: CurrencyCode
    buyPrice?: number | null
    sellPrice?: number | null
    priceBasisAmount?: number | null
    createdBy?: string | null
    updatedBy?: string | null
}

export type ExchangeFeeRuleTemporalStatus = 'inactive' | 'pending' | 'effective' | 'ended'

function shouldUseCloudBusinessData(workspaceId?: string | null) {
    return !!workspaceId && !isLocalWorkspaceMode(workspaceId)
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return {
            syncStatus: 'synced' as const,
            lastSyncedAt: timestamp
        }
    }

    return {
        syncStatus: 'pending' as const,
        lastSyncedAt: null
    }
}

function roundCurrencyAmount(value: number, currency: CurrencyCode) {
    const precision = currency === 'iqd' ? 0 : 2
    const multiplier = 10 ** precision
    return Math.round((Number(value) || 0) * multiplier) / multiplier
}

export function getDefaultExchangeFeeBasisAmount(currency: CurrencyCode) {
    return currency === 'iqd' ? 100000 : 100
}

export function getExchangeFeeBasisAmount(rule: { currency?: CurrencyCode | null; customerGivesBasisAmount?: number | null } | null | undefined, fallbackCurrency: CurrencyCode = 'iqd') {
    const currency = rule?.currency || fallbackCurrency
    const basisAmount = Number(rule?.customerGivesBasisAmount || 0)
    return basisAmount > 0 ? basisAmount : getDefaultExchangeFeeBasisAmount(currency)
}

export function getExchangeRateBasisAmount(currency: CurrencyCode) {
    return getDefaultExchangeFeeBasisAmount(currency)
}

function roundSafeAmount(value: number, currency: CurrencyCode) {
    return roundCurrencyAmount(value, currency)
}

function calculateAcquisitionRateFromBuy(
    buy: ExchangeTransaction,
    soldCurrency: CurrencyCode,
    profitCurrency: CurrencyCode
) {
    const basis = getExchangeRateBasisAmount(soldCurrency)
    const soldAmount = Number(buy.customerGivesAmount || 0)
    const paidAmount = Number(buy.customerReceivesAmount || 0)
    if (soldAmount <= 0 || paidAmount <= 0) {
        return 0
    }

    const paidPerBasis = paidAmount * basis / soldAmount
    if (buy.toCurrency === profitCurrency) {
        return roundSafeAmount(paidPerBasis, profitCurrency)
    }

    return 0
}

export async function findLatestSafeBuyForAcquisitionRate({
    workspaceId,
    safeId,
    soldCurrency,
    profitCurrency,
    beforeTransactionDate
}: {
    workspaceId: string
    safeId: string
    soldCurrency: CurrencyCode
    profitCurrency: CurrencyCode
    beforeTransactionDate?: string | null
}) {
    if (!workspaceId || !safeId) {
        return null
    }

    const parsedBefore = beforeTransactionDate ? new Date(beforeTransactionDate) : null
    const beforeIso = parsedBefore && !Number.isNaN(parsedBefore.getTime())
        ? parsedBefore.toISOString()
        : null

    const buys = await db.exchange_transactions
        .where('workspaceId')
        .equals(workspaceId)
        .and((transaction) =>
            !transaction.isDeleted
            && !transaction.isReversed
            && !transaction.reversedTransactionId
            && transaction.transactionType === 'buy'
            && transaction.safeId === safeId
            && transaction.fromCurrency === soldCurrency
            && transaction.toCurrency === profitCurrency
            && (!beforeIso || transaction.transactionDate <= beforeIso)
        )
        .toArray()

    const latest = buys.sort((left, right) =>
        right.transactionDate.localeCompare(left.transactionDate)
        || right.createdAt.localeCompare(left.createdAt)
    )[0]

    if (!latest) {
        return null
    }

    const acquisitionRate = calculateAcquisitionRateFromBuy(latest, soldCurrency, profitCurrency)
    if (acquisitionRate <= 0) {
        return null
    }

    return {
        transaction: latest,
        acquisitionRate,
        source: 'last_buy' as const
    }
}

export function calculateExchangeProfit({
    transactionType,
    fromCurrency,
    toCurrency,
    customerGivesAmount,
    customerReceivesAmount,
    acquisitionRate
}: {
    transactionType: ExchangeTransactionType
    fromCurrency: CurrencyCode
    toCurrency: CurrencyCode
    customerGivesAmount: number
    customerReceivesAmount: number
    acquisitionRate?: number | null
}) {
    if (transactionType !== 'sell') {
        return {
            acquisitionRate: null,
            acquisitionRateSource: null,
            profitAmount: null,
            profitCurrency: null
        }
    }

    const rate = Number(acquisitionRate || 0)
    if (rate <= 0) {
        throw new Error('Acquisition rate is required for sell transactions')
    }

    const cost = Number(customerReceivesAmount || 0) * rate / getExchangeRateBasisAmount(toCurrency)
    const profitAmount = roundSafeAmount(Number(customerGivesAmount || 0) - cost, fromCurrency)
    return {
        acquisitionRate: rate,
        profitAmount,
        profitCurrency: fromCurrency
    }
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function parseDateTimeBoundary(value?: string | null, boundary: 'start' | 'end' = 'start') {
    if (!value) {
        return new Date()
    }

    const dateOnlyMatch = value.match(DATE_ONLY_PATTERN)
    if (dateOnlyMatch) {
        const [, year, month, day] = dateOnlyMatch
        return new Date(
            Number(year),
            Number(month) - 1,
            Number(day),
            boundary === 'end' ? 23 : 0,
            boundary === 'end' ? 59 : 0,
            boundary === 'end' ? 59 : 0,
            boundary === 'end' ? 999 : 0
        )
    }

    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
        return parsed
    }

    return new Date()
}

function normalizeDateTimeBoundary(value?: string | null, boundary: 'start' | 'end' = 'start') {
    return parseDateTimeBoundary(value, boundary).toISOString()
}

function getDateTimeBoundaryMs(value?: string | null, boundary: 'start' | 'end' = 'start') {
    return parseDateTimeBoundary(value, boundary).getTime()
}

function normalizeOptionalText(value?: string | null) {
    const text = String(value || '').trim()
    return text || null
}

export function getExchangePairKey(baseCurrency: CurrencyCode, quoteCurrency: CurrencyCode) {
    return `${baseCurrency}:${quoteCurrency}`
}

export function getExchangePairLabel(baseCurrency: CurrencyCode, quoteCurrency: CurrencyCode) {
    return `${baseCurrency.toUpperCase()}/${quoteCurrency.toUpperCase()}`
}

export function parseExchangePairKey(value: string | null | undefined) {
    const [baseCurrency, quoteCurrency] = String(value || '').split(':') as CurrencyCode[]
    if (
        EXCHANGE_SAFE_CURRENCIES.includes(baseCurrency)
        && EXCHANGE_SAFE_CURRENCIES.includes(quoteCurrency)
        && baseCurrency !== quoteCurrency
    ) {
        return { baseCurrency, quoteCurrency }
    }

    return null
}

export function buildExchangePairOptions(currencies: CurrencyCode[] = EXCHANGE_SAFE_CURRENCIES) {
    const allowed = currencies.filter((currency, index, list) =>
        EXCHANGE_SAFE_CURRENCIES.includes(currency) && list.indexOf(currency) === index
    )
    return allowed.flatMap((baseCurrency) =>
        allowed
            .filter((quoteCurrency) => quoteCurrency !== baseCurrency)
            .map((quoteCurrency) => ({ baseCurrency, quoteCurrency, key: getExchangePairKey(baseCurrency, quoteCurrency) }))
    )
}

export function findExchangePairPrice(
    prices: ExchangePairPrice[],
    baseCurrency: CurrencyCode,
    quoteCurrency: CurrencyCode
) {
    return prices.find((price) =>
        !price.isDeleted
        && price.baseCurrency === baseCurrency
        && price.quoteCurrency === quoteCurrency
    ) || null
}

export function getExchangePairTransactionCurrencies(
    pairPrice: Pick<ExchangePairPriceQuote, 'baseCurrency' | 'quoteCurrency'>,
    transactionType: ExchangeTransactionType
) {
    return transactionType === 'buy'
        ? { fromCurrency: pairPrice.baseCurrency, toCurrency: pairPrice.quoteCurrency }
        : { fromCurrency: pairPrice.quoteCurrency, toCurrency: pairPrice.baseCurrency }
}

export function getExchangePairSidePrice(
    pairPrice: Pick<ExchangePairPriceQuote, 'buyPrice' | 'sellPrice'>,
    transactionType: ExchangeTransactionType
) {
    return transactionType === 'buy' ? Number(pairPrice.buyPrice || 0) : Number(pairPrice.sellPrice || 0)
}

export function convertExchangePairAmount(
    amount: number,
    pairPrice: ExchangePairPriceQuote,
    transactionType: ExchangeTransactionType
) {
    const sidePrice = getExchangePairSidePrice(pairPrice, transactionType)
    const basisAmount = Number(pairPrice.priceBasisAmount || 0)
    if (sidePrice <= 0) {
        throw new Error('Exchange pair price is required')
    }
    if (basisAmount <= 0) {
        throw new Error('Exchange pair price basis is required')
    }

    const rawAmount = Number(amount) || 0
    return transactionType === 'buy'
        ? rawAmount * sidePrice / basisAmount
        : rawAmount * basisAmount / sidePrice
}

export function calculateExchangeTransaction(input: ExchangeCalculationInput): ExchangeCalculationResult {
    const { fromCurrency, toCurrency } = getExchangePairTransactionCurrencies(input.pairPrice, input.transactionType)
    const customerGivesAmount = Math.max(0, Number(input.customerGivesAmount || 0))
    const feeValue = Math.max(0, Number(input.feeValue || 0))
    const feeCurrency = input.feeCurrency || fromCurrency
    const feeBasisAmount = Math.max(0, Number(input.feeBasisAmount || 0)) || getDefaultExchangeFeeBasisAmount(feeCurrency)

    if (feeCurrency !== fromCurrency) {
        throw new Error('Exchange fees must use the customer-gives currency')
    }

    const baseReceivesAmount = convertExchangePairAmount(customerGivesAmount, input.pairPrice, input.transactionType)

    let feeAmount = 0
    if (input.feeType === 'fixed') {
        feeAmount = roundCurrencyAmount(feeValue * customerGivesAmount / feeBasisAmount, feeCurrency)
    } else if (input.feeType === 'percentage') {
        feeAmount = roundCurrencyAmount(customerGivesAmount * feeValue / 100, feeCurrency)
    }

    const feeAmountInToCurrency = feeAmount > 0
        ? convertExchangePairAmount(feeAmount, input.pairPrice, input.transactionType)
        : 0
    const customerReceivesAmount = Math.max(0, baseReceivesAmount - feeAmountInToCurrency)

    return {
        baseReceivesAmount: roundCurrencyAmount(baseReceivesAmount, toCurrency),
        customerReceivesAmount: roundCurrencyAmount(customerReceivesAmount, toCurrency),
        feeAmount: roundCurrencyAmount(feeAmount, feeCurrency),
        feeAmountInToCurrency: roundCurrencyAmount(feeAmountInToCurrency, toCurrency)
    }
}

export function buildExchangeFeeRuleSnapshot(rule: ExchangeFeeRule): ExchangeFeeRuleSnapshot {
    return {
        id: rule.id,
        name: rule.name,
        transactionScope: rule.transactionScope,
        feeType: rule.feeType,
        currency: rule.currency,
        value: rule.value,
        customerGivesBasisAmount: getExchangeFeeBasisAmount(rule),
        effectiveStartDate: rule.effectiveStartDate,
        effectiveEndDate: rule.effectiveEndDate ?? null,
        isLocked: rule.isLocked
    }
}

async function generateExchangeTransactionNo(workspaceId: string, createdAt: string) {
    const year = createdAt.slice(0, 4)
    const rows = await db.exchange_transactions.where('workspaceId').equals(workspaceId).toArray()
    const sequence = rows.filter((row) => row.createdAt.startsWith(`${year}-`)).length + 1
    return `FX-${year}-${String(sequence).padStart(5, '0')}`
}

function sanitizeSyncPayload(entity: Record<string, unknown>) {
    const payload = toSnakeCase(entity)
    delete payload.sync_status
    delete payload.last_synced_at

    for (const key of Object.keys(payload)) {
        if (payload[key] === undefined) {
            delete payload[key]
        }
    }

    return payload
}

async function markEntitiesSynced(tableName: ExchangeTableName, ids: string[]) {
    if (ids.length === 0) {
        return
    }

    const table = tableByName[tableName]
    const syncedAt = new Date().toISOString()
    await Promise.all(ids.map((id) =>
        table.update(id, {
            syncStatus: 'synced',
            lastSyncedAt: syncedAt
        } as never)
    ))
}

async function queueOfflineUpserts(tableName: ExchangeTableName, entities: ExchangeSyncEntity[]) {
    await Promise.all(entities.map((entity) =>
        addToOfflineMutations(
            tableName,
            entity.id,
            entity.version > 1 ? 'update' : 'create',
            entity,
            entity.workspaceId
        )
    ))
}

async function syncUpsertEntities(tableName: ExchangeTableName, entities: ExchangeSyncEntity[], workspaceId: string) {
    if (!entities.length || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (!isOnline(workspaceId)) {
        await queueOfflineUpserts(tableName, entities)
        return
    }

    try {
        const client = getSupabaseClientForTable(tableName)
        const payload = entities.map((entity) => sanitizeSyncPayload(entity))
        const { error } = await runSupabaseAction(`${tableName}.sync`, () =>
            client.from(tableName).upsert(payload)
        ) as any
        if (error) {
            throw error
        }

        await markEntitiesSynced(tableName, entities.map((entity) => entity.id))
    } catch (error) {
        console.error(`[CurrencyExchange] Failed to sync ${tableName}:`, error)
        await queueOfflineUpserts(tableName, entities)
    }
}

async function syncSoftDelete(tableName: ExchangeTableName, entityId: string, workspaceId: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (!isOnline(workspaceId)) {
        await addToOfflineMutations(tableName, entityId, 'delete', { id: entityId }, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable(tableName)
        const { error } = await runSupabaseAction(`${tableName}.delete`, () =>
            client
                .from(tableName)
                .update({ is_deleted: true, updated_at: new Date().toISOString() })
                .eq('id', entityId)
        ) as any

        if (error) {
            throw error
        }

        await markEntitiesSynced(tableName, [entityId])
    } catch (error) {
        console.error(`[CurrencyExchange] Failed to delete ${tableName}:`, error)
        await addToOfflineMutations(tableName, entityId, 'delete', { id: entityId }, workspaceId)
    }
}

export function resolveEffectiveExchangeFeeRule(
    rules: ExchangeFeeRule[],
    transactionType: ExchangeTransactionType,
    transactionDate: string,
    feeCurrency?: CurrencyCode
) {
    return rules
        .filter((rule) => isExchangeFeeRuleEffectiveForTransaction(rule, transactionType, transactionDate, feeCurrency))
        .sort((left, right) =>
            getDateTimeBoundaryMs(right.effectiveStartDate) - getDateTimeBoundaryMs(left.effectiveStartDate)
            || right.updatedAt.localeCompare(left.updatedAt)
        )[0] || null
}

export function isExchangeFeeRuleEffectiveForTransaction(
    rule: ExchangeFeeRule,
    transactionType: ExchangeTransactionType,
    transactionDate: string,
    feeCurrency?: CurrencyCode
) {
    const transactionTime = getDateTimeBoundaryMs(transactionDate)
    return !rule.isDeleted
        && rule.isActive
        && (rule.transactionScope === 'both' || rule.transactionScope === transactionType)
        && (!feeCurrency || rule.currency === feeCurrency)
        && getDateTimeBoundaryMs(rule.effectiveStartDate, 'start') <= transactionTime
        && (!rule.effectiveEndDate || getDateTimeBoundaryMs(rule.effectiveEndDate, 'end') >= transactionTime)
}

export function getExchangeFeeRuleTemporalStatus(
    rule: Pick<ExchangeFeeRule, 'isActive' | 'isDeleted' | 'effectiveStartDate' | 'effectiveEndDate'>,
    referenceDate: string = new Date().toISOString()
): ExchangeFeeRuleTemporalStatus {
    if (rule.isDeleted || !rule.isActive) {
        return 'inactive'
    }

    const referenceTime = getDateTimeBoundaryMs(referenceDate)
    if (getDateTimeBoundaryMs(rule.effectiveStartDate, 'start') > referenceTime) {
        return 'pending'
    }

    if (rule.effectiveEndDate && getDateTimeBoundaryMs(rule.effectiveEndDate, 'end') < referenceTime) {
        return 'ended'
    }

    return 'effective'
}

function createBaseEntity(workspaceId: string, now: string) {
    return {
        workspaceId,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }
}

async function getSafeBalance(safeId: string, currency: CurrencyCode) {
    return await db.fx_safe_balances
        .where('[safeId+currency]')
        .equals([safeId, currency])
        .first()
}

async function ensureSafeBalance(
    workspaceId: string,
    safeId: string,
    currency: CurrencyCode,
    now: string
) {
    const existing = await getSafeBalance(safeId, currency)
    if (existing) {
        return existing
    }

    const balance: ExchangeSafeBalance = {
        id: generateId(),
        safeId,
        currency,
        balanceAmount: 0,
        ...createBaseEntity(workspaceId, now)
    }
    await db.fx_safe_balances.put(balance)
    return balance
}

function makeSafeMovement({
    workspaceId,
    safe,
    currency,
    movementType,
    sourceType,
    sourceId,
    deltaAmount,
    balanceBefore,
    balanceAfter,
    notes,
    createdBy,
    now
}: {
    workspaceId: string
    safe: ExchangeSafe
    currency: CurrencyCode
    movementType: ExchangeSafeMovement['movementType']
    sourceType: ExchangeSafeMovement['sourceType']
    sourceId?: string | null
    deltaAmount: number
    balanceBefore: number
    balanceAfter: number
    notes?: string | null
    createdBy?: string | null
    now: string
}): ExchangeSafeMovement {
    return {
        id: generateId(),
        safeId: safe.id,
        safeNameSnapshot: safe.name,
        currency,
        movementType,
        sourceType,
        sourceId: sourceId ?? null,
        deltaAmount: roundSafeAmount(deltaAmount, currency),
        balanceBefore: roundSafeAmount(balanceBefore, currency),
        balanceAfter: roundSafeAmount(balanceAfter, currency),
        notes: normalizeOptionalText(notes),
        createdBy: createdBy || null,
        ...createBaseEntity(workspaceId, now)
    }
}

async function applySafeDelta({
    workspaceId,
    safe,
    currency,
    deltaAmount,
    movementType,
    sourceType,
    sourceId,
    notes,
    createdBy,
    now
}: {
    workspaceId: string
    safe: ExchangeSafe
    currency: CurrencyCode
    deltaAmount: number
    movementType: ExchangeSafeMovement['movementType']
    sourceType: ExchangeSafeMovement['sourceType']
    sourceId?: string | null
    notes?: string | null
    createdBy?: string | null
    now: string
}) {
    const balance = await ensureSafeBalance(workspaceId, safe.id, currency, now)
    const before = Number(balance.balanceAmount || 0)
    const roundedDelta = roundSafeAmount(deltaAmount, currency)
    const after = roundSafeAmount(before + roundedDelta, currency)
    if (after < -0.000001) {
        throw new Error(`Insufficient ${currency.toUpperCase()} balance in ${safe.name}`)
    }

    const updatedBalance: ExchangeSafeBalance = {
        ...balance,
        balanceAmount: after,
        updatedAt: now,
        version: balance.version + 1,
        ...getSyncMetadata(workspaceId, now)
    }
    const movement = makeSafeMovement({
        workspaceId,
        safe,
        currency,
        movementType,
        sourceType,
        sourceId,
        deltaAmount: roundedDelta,
        balanceBefore: before,
        balanceAfter: after,
        notes,
        createdBy,
        now
    })

    await db.fx_safe_balances.put(updatedBalance)
    await db.fx_safe_movements.put(movement)
    return { balance: updatedBalance, movement }
}

export async function createExchangeSafe(workspaceId: string, input: CreateExchangeSafeInput) {
    const now = new Date().toISOString()
    const name = input.name.trim()
    const changedBalances: ExchangeSafeBalance[] = []
    const movements: ExchangeSafeMovement[] = []

    if (!workspaceId) {
        throw new Error('Workspace is required')
    }
    if (!name) {
        throw new Error('Safe name is required')
    }

    const openingBalances = input.openingBalances || {}
    const hasOpeningBalances = EXCHANGE_SAFE_CURRENCIES.some((currency) => Number(openingBalances[currency] || 0) > 0)
    if (hasOpeningBalances && !input.isAdmin) {
        throw new Error('Only admins can set opening balances')
    }

    const safe: ExchangeSafe = {
        id: generateId(),
        name,
        isActive: true,
        notes: normalizeOptionalText(input.notes),
        createdBy: input.createdBy || null,
        ...createBaseEntity(workspaceId, now)
    }

    await db.transaction('rw', [db.fx_safes, db.fx_safe_balances, db.fx_safe_movements], async () => {
        await db.fx_safes.put(safe)
        for (const currency of EXCHANGE_SAFE_CURRENCIES) {
            const amount = roundSafeAmount(Math.max(0, Number(openingBalances[currency] || 0)), currency)
            const balance: ExchangeSafeBalance = {
                id: generateId(),
                safeId: safe.id,
                currency,
                balanceAmount: amount,
                ...createBaseEntity(workspaceId, now)
            }
            await db.fx_safe_balances.put(balance)
            changedBalances.push(balance)

            if (amount > 0) {
                const movement = makeSafeMovement({
                    workspaceId,
                    safe,
                    currency,
                    movementType: 'opening_balance',
                    sourceType: 'opening_balance',
                    deltaAmount: amount,
                    balanceBefore: 0,
                    balanceAfter: amount,
                    notes: input.notes,
                    createdBy: input.createdBy,
                    now
                })
                await db.fx_safe_movements.put(movement)
                movements.push(movement)
            }
        }
    })

    await syncUpsertEntities(SAFES_TABLE, [safe as unknown as ExchangeSyncEntity], workspaceId)
    await syncUpsertEntities(SAFE_BALANCES_TABLE, changedBalances as unknown as ExchangeSyncEntity[], workspaceId)
    await syncUpsertEntities(SAFE_MOVEMENTS_TABLE, movements as unknown as ExchangeSyncEntity[], workspaceId)
    return await db.fx_safes.get(safe.id) || safe
}

export async function createExchangeSafeAdjustment(workspaceId: string, input: CreateExchangeSafeAdjustmentInput) {
    const now = new Date().toISOString()
    if (!workspaceId) {
        throw new Error('Workspace is required')
    }
    if (!input.isAdmin) {
        throw new Error('Only admins can adjust safe balances')
    }

    const amount = roundSafeAmount(Number(input.amount || 0), input.currency)
    if (!amount) {
        throw new Error('Adjustment amount is required')
    }

    const safe = await db.fx_safes.get(input.safeId)
    if (!safe || safe.isDeleted || safe.workspaceId !== workspaceId) {
        throw new Error('Safe not found')
    }

    let changedBalance: ExchangeSafeBalance | null = null
    let movement: ExchangeSafeMovement | null = null
    await db.transaction('rw', [db.fx_safe_balances, db.fx_safe_movements], async () => {
        const result = await applySafeDelta({
            workspaceId,
            safe,
            currency: input.currency,
            deltaAmount: amount,
            movementType: 'adjustment',
            sourceType: 'adjustment',
            notes: input.notes,
            createdBy: input.createdBy,
            now
        })
        changedBalance = result.balance
        movement = result.movement
    })

    if (changedBalance) {
        await syncUpsertEntities(SAFE_BALANCES_TABLE, [changedBalance as unknown as ExchangeSyncEntity], workspaceId)
    }
    if (movement) {
        await syncUpsertEntities(SAFE_MOVEMENTS_TABLE, [movement as unknown as ExchangeSyncEntity], workspaceId)
    }
    return { balance: changedBalance, movement }
}

export async function hasCurrencyExchangeAccountingData(workspaceId: string | undefined | null) {
    if (!workspaceId) return false
    const [transactions, safes, balances, movements] = await Promise.all([
        db.exchange_transactions.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).count(),
        db.fx_safes.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).count(),
        db.fx_safe_balances.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).count(),
        db.fx_safe_movements.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).count()
    ])
    return transactions + safes + balances + movements > 0
}

export async function upsertExchangePairPrice(workspaceId: string, input: SaveExchangePairPriceInput) {
    const now = new Date().toISOString()
    const baseCurrency = input.baseCurrency
    const quoteCurrency = input.quoteCurrency

    if (!workspaceId) {
        throw new Error('Workspace is required')
    }
    if (!EXCHANGE_SAFE_CURRENCIES.includes(baseCurrency) || !EXCHANGE_SAFE_CURRENCIES.includes(quoteCurrency)) {
        throw new Error('Unsupported exchange pair currency')
    }
    if (baseCurrency === quoteCurrency) {
        throw new Error('Exchange pair currencies must be different')
    }

    const existing = await db.exchange_pair_prices
        .where('workspaceId')
        .equals(workspaceId)
        .and((price) =>
            !price.isDeleted
            && price.baseCurrency === baseCurrency
            && price.quoteCurrency === quoteCurrency
        )
        .first()

    const priceBasisAmount = input.priceBasisAmount !== undefined
        ? Math.max(0, Number(input.priceBasisAmount || 0))
        : Number(existing?.priceBasisAmount || DEFAULT_EXCHANGE_PAIR_PRICE_BASIS)
    if (priceBasisAmount <= 0) {
        throw new Error('Exchange pair price basis must be greater than zero')
    }

    const buyPrice = input.buyPrice !== undefined
        ? Math.max(0, Number(input.buyPrice || 0))
        : Number(existing?.buyPrice || 0)
    const sellPrice = input.sellPrice !== undefined
        ? Math.max(0, Number(input.sellPrice || 0))
        : Number(existing?.sellPrice || 0)

    const price: ExchangePairPrice = existing
        ? {
            ...existing,
            buyPrice,
            sellPrice,
            priceBasisAmount,
            updatedBy: input.updatedBy ?? input.createdBy ?? existing.updatedBy ?? null,
            updatedAt: now,
            version: existing.version + 1,
            ...getSyncMetadata(workspaceId, now)
        }
        : {
            id: generateId(),
            workspaceId,
            baseCurrency,
            quoteCurrency,
            buyPrice,
            sellPrice,
            priceBasisAmount,
            createdBy: input.createdBy || null,
            updatedBy: input.updatedBy ?? input.createdBy ?? null,
            createdAt: now,
            updatedAt: now,
            version: 1,
            isDeleted: false,
            ...getSyncMetadata(workspaceId, now)
        }

    await db.exchange_pair_prices.put(price)
    await syncUpsertEntities(PAIR_PRICES_TABLE, [price as unknown as ExchangeSyncEntity], workspaceId)
    return await db.exchange_pair_prices.get(price.id) || price
}

export async function createExchangeTransaction(
    workspaceId: string,
    input: CreateExchangeTransactionInput
) {
    const now = new Date().toISOString()
    const transactionDate = input.transactionDate ? new Date(input.transactionDate).toISOString() : now
    const pairPrice = input.pairPrice
    const { fromCurrency, toCurrency } = getExchangePairTransactionCurrencies(pairPrice, input.transactionType)
    const customerGivesAmount = roundCurrencyAmount(Math.max(0, Number(input.customerGivesAmount || 0)), fromCurrency)
    const feeType = input.feeType ?? input.feeRuleSnapshot?.feeType ?? null
    const feeCurrency = input.feeCurrency ?? input.feeRuleSnapshot?.currency ?? null
    const originalFeeValue = input.originalFeeValue ?? input.feeRuleSnapshot?.value ?? null
    const finalFeeValue = Math.max(0, Number(input.finalFeeValue ?? originalFeeValue ?? 0))
    const feeBasisAmount = Math.max(0, Number(input.feeBasisAmount ?? input.feeRuleSnapshot?.customerGivesBasisAmount ?? 0))
    const safeId = input.safeId

    if (!workspaceId) {
        throw new Error('Workspace is required')
    }
    if (!safeId) {
        throw new Error('Safe is required')
    }
    if (fromCurrency === toCurrency) {
        throw new Error('From currency and To currency must be different')
    }
    if (customerGivesAmount <= 0) {
        throw new Error('Customer gives amount must be greater than zero')
    }
    const sidePrice = getExchangePairSidePrice(pairPrice, input.transactionType)
    if (!pairPrice.id || sidePrice <= 0 || Number(pairPrice.priceBasisAmount || 0) <= 0) {
        throw new Error('Manual exchange pair price is required')
    }
    if (!input.exchangeRateUsed || input.exchangeRateUsed <= 0 || Math.abs(Number(input.exchangeRateUsed) - sidePrice) > 0.000001) {
        throw new Error('Exchange pair price is required')
    }
    if (!input.marketRateSnapshot.length) {
        throw new Error('Exchange price snapshot is required')
    }

    const safe = await db.fx_safes.get(safeId)
    if (!safe || safe.isDeleted || safe.workspaceId !== workspaceId) {
        throw new Error('Safe not found')
    }
    if (!safe.isActive) {
        throw new Error('Safe is inactive')
    }

    const calculation = calculateExchangeTransaction({
        transactionType: input.transactionType,
        pairPrice,
        customerGivesAmount,
        feeType,
        feeCurrency,
        feeValue: finalFeeValue,
        feeBasisAmount
    })

    let acquisitionRate: number | null = null
    let acquisitionRateSource: ExchangeAcquisitionRateSource | null = null
    let acquisitionRateSnapshot: ExchangeRateSnapshot[] | null = null
    let profitAmount: number | null = null
    let profitCurrency: CurrencyCode | null = null

    if (input.transactionType === 'sell') {
        const manualRate = Number(input.acquisitionRate || 0)
        if (manualRate > 0) {
            acquisitionRate = manualRate
            acquisitionRateSource = input.acquisitionRateSource || 'manual'
        } else {
            const latestBuy = await findLatestSafeBuyForAcquisitionRate({
                workspaceId,
                safeId,
                soldCurrency: toCurrency,
                profitCurrency: fromCurrency,
                beforeTransactionDate: transactionDate
            })
            if (latestBuy) {
                acquisitionRate = latestBuy.acquisitionRate
                acquisitionRateSource = latestBuy.source
            }
        }

        if (!acquisitionRate || acquisitionRate <= 0) {
            throw new Error('Acquisition rate is required for sell transactions')
        }

        const profit = calculateExchangeProfit({
            transactionType: input.transactionType,
            fromCurrency,
            toCurrency,
            customerGivesAmount,
            customerReceivesAmount: calculation.customerReceivesAmount,
            acquisitionRate
        })
        profitAmount = profit.profitAmount
        profitCurrency = profit.profitCurrency
        acquisitionRateSnapshot = input.acquisitionRateSnapshot ?? input.marketRateSnapshot
    }

    const transactionId = generateId()
    const transactionNo = await generateExchangeTransactionNo(workspaceId, now)
    const feeEdited = Boolean(
        input.feeRuleSnapshot
        && !input.feeRuleSnapshot.isLocked
        && originalFeeValue !== null
        && Math.abs(Number(originalFeeValue) - finalFeeValue) > 0.000001
    )
    const transaction: ExchangeTransaction = {
        id: transactionId,
        workspaceId,
        transactionNo,
        transactionType: input.transactionType,
        transactionDate,
        fromCurrency,
        toCurrency,
        customerGivesAmount,
        customerReceivesAmount: calculation.customerReceivesAmount,
        exchangeRateUsed: input.exchangeRateUsed,
        exchangeRateSource: input.exchangeRateSource,
        exchangeRateManuallyEdited: input.exchangeRateManuallyEdited,
        marketRateSnapshot: input.marketRateSnapshot,
        feeRuleId: input.feeRuleId ?? input.feeRuleSnapshot?.id ?? null,
        feeRuleSnapshot: input.feeRuleSnapshot ?? null,
        feeType,
        feeCurrency,
        originalFeeValue,
        finalFeeValue,
        feeAmount: calculation.feeAmount,
        feeEdited,
        safeId: safe.id,
        safeNameSnapshot: safe.name,
        acquisitionRate,
        acquisitionRateSource,
        acquisitionRateSnapshot,
        profitAmount,
        profitCurrency,
        paymentMethod: input.paymentMethod,
        employeeUserId: input.employeeUserId ?? null,
        employeeName: normalizeOptionalText(input.employeeName),
        notes: normalizeOptionalText(input.notes),
        createdBy: input.createdBy || null,
        isReversed: false,
        reversalTransactionId: null,
        reversedTransactionId: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }

    const changedBalances: ExchangeSafeBalance[] = []
    const movements: ExchangeSafeMovement[] = []
    await db.transaction('rw', [db.exchange_transactions, db.fx_safe_balances, db.fx_safe_movements], async () => {
        await db.exchange_transactions.put(transaction)

        const incoming = await applySafeDelta({
            workspaceId,
            safe,
            currency: fromCurrency,
            deltaAmount: customerGivesAmount,
            movementType: 'exchange_in',
            sourceType: 'exchange_transaction',
            sourceId: transactionId,
            notes: transactionNo,
            createdBy: input.createdBy,
            now
        })
        changedBalances.push(incoming.balance)
        movements.push(incoming.movement)

        const outgoing = await applySafeDelta({
            workspaceId,
            safe,
            currency: toCurrency,
            deltaAmount: -calculation.customerReceivesAmount,
            movementType: 'exchange_out',
            sourceType: 'exchange_transaction',
            sourceId: transactionId,
            notes: transactionNo,
            createdBy: input.createdBy,
            now
        })
        changedBalances.push(outgoing.balance)
        movements.push(outgoing.movement)
    })

    await syncUpsertEntities(TRANSACTIONS_TABLE, [transaction as unknown as ExchangeSyncEntity], workspaceId)
    await syncUpsertEntities(SAFE_BALANCES_TABLE, changedBalances as unknown as ExchangeSyncEntity[], workspaceId)
    await syncUpsertEntities(SAFE_MOVEMENTS_TABLE, movements as unknown as ExchangeSyncEntity[], workspaceId)

    const savedTransaction = await db.exchange_transactions.get(transaction.id)
    return savedTransaction || transaction
}

export async function createExchangeFeeRule(workspaceId: string, input: SaveExchangeFeeRuleInput) {
    const now = new Date().toISOString()
    const name = input.name.trim()
    const value = Math.max(0, Number(input.value || 0))
    const customerGivesBasisAmount = Math.max(0, Number(input.customerGivesBasisAmount || 0))

    if (!workspaceId) {
        throw new Error('Workspace is required')
    }
    if (!name) {
        throw new Error('Rule name is required')
    }
    if (value <= 0) {
        throw new Error('Fee value must be greater than zero')
    }
    if (customerGivesBasisAmount <= 0) {
        throw new Error('Customer gives basis amount must be greater than zero')
    }
    if (!input.effectiveStartDate) {
        throw new Error('Effective start date is required')
    }

    const rule: ExchangeFeeRule = {
        id: generateId(),
        workspaceId,
        name,
        transactionScope: input.transactionScope,
        feeType: input.feeType,
        currency: input.currency,
        value,
        customerGivesBasisAmount,
        effectiveStartDate: normalizeDateTimeBoundary(input.effectiveStartDate, 'start'),
        effectiveEndDate: input.effectiveEndDate ? normalizeDateTimeBoundary(input.effectiveEndDate, 'end') : null,
        isActive: input.isActive,
        isLocked: input.isLocked,
        notes: normalizeOptionalText(input.notes),
        createdBy: input.createdBy || null,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }

    await db.exchange_fee_rules.put(rule)
    await syncUpsertEntities(FEE_RULES_TABLE, [rule as unknown as ExchangeSyncEntity], workspaceId)
    return await db.exchange_fee_rules.get(rule.id) || rule
}

export async function updateExchangeFeeRule(ruleId: string, input: Partial<SaveExchangeFeeRuleInput>) {
    const existing = await db.exchange_fee_rules.get(ruleId)
    if (!existing || existing.isDeleted) {
        throw new Error('Fee rule not found')
    }

    const now = new Date().toISOString()
    const nextValue = input.value !== undefined
        ? Math.max(0, Number(input.value || 0))
        : existing.value
    const nextBasisAmount = input.customerGivesBasisAmount !== undefined
        ? Math.max(0, Number(input.customerGivesBasisAmount || 0))
        : getExchangeFeeBasisAmount(existing)

    if (input.name !== undefined && !input.name.trim()) {
        throw new Error('Rule name is required')
    }
    if (nextValue <= 0) {
        throw new Error('Fee value must be greater than zero')
    }
    if (nextBasisAmount <= 0) {
        throw new Error('Customer gives basis amount must be greater than zero')
    }

    const updated: ExchangeFeeRule = {
        ...existing,
        ...input,
        name: input.name !== undefined ? input.name.trim() : existing.name,
        value: nextValue,
        customerGivesBasisAmount: nextBasisAmount,
        effectiveStartDate: input.effectiveStartDate ? normalizeDateTimeBoundary(input.effectiveStartDate, 'start') : existing.effectiveStartDate,
        effectiveEndDate: input.effectiveEndDate !== undefined
            ? (input.effectiveEndDate ? normalizeDateTimeBoundary(input.effectiveEndDate, 'end') : null)
            : existing.effectiveEndDate,
        notes: input.notes !== undefined ? normalizeOptionalText(input.notes) : existing.notes,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    await db.exchange_fee_rules.put(updated)
    await syncUpsertEntities(FEE_RULES_TABLE, [updated as unknown as ExchangeSyncEntity], existing.workspaceId)
    return updated
}

export async function deleteExchangeFeeRule(ruleId: string) {
    const existing = await db.exchange_fee_rules.get(ruleId)
    if (!existing || existing.isDeleted) {
        return
    }

    const now = new Date().toISOString()
    const deleted: ExchangeFeeRule = {
        ...existing,
        isDeleted: true,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    await db.exchange_fee_rules.put(deleted)
    await syncSoftDelete(FEE_RULES_TABLE, existing.id, existing.workspaceId)
}

export async function deleteExchangeTransaction(transactionId: string) {
    const existing = await db.exchange_transactions.get(transactionId)
    if (!existing || existing.isDeleted) {
        return
    }

    const now = new Date().toISOString()
    const deleted: ExchangeTransaction = {
        ...existing,
        isDeleted: true,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    await db.exchange_transactions.put(deleted)
    await syncSoftDelete(TRANSACTIONS_TABLE, existing.id, existing.workspaceId)
}

export async function reverseExchangeTransaction(
    transactionId: string,
    createdBy?: string | null
) {
    const existing = await db.exchange_transactions.get(transactionId)
    if (!existing || existing.isDeleted) {
        throw new Error('Transaction not found')
    }
    if (existing.isReversed) {
        throw new Error('Transaction is already reversed')
    }
    if (existing.reversedTransactionId) {
        throw new Error('Cannot reverse a reversal transaction')
    }

    const workspaceId = existing.workspaceId
    const now = new Date().toISOString()
    const reversalId = generateId()
    const transactionNo = await generateExchangeTransactionNo(workspaceId, now)
    const reversedType = existing.transactionType === 'buy' ? 'sell' : 'buy'

    const reversal: ExchangeTransaction = {
        id: reversalId,
        workspaceId,
        transactionNo,
        transactionType: reversedType,
        transactionDate: now,
        fromCurrency: existing.toCurrency,
        toCurrency: existing.fromCurrency,
        customerGivesAmount: existing.customerReceivesAmount,
        customerReceivesAmount: existing.customerGivesAmount,
        exchangeRateUsed: existing.exchangeRateUsed,
        exchangeRateSource: existing.exchangeRateSource,
        exchangeRateManuallyEdited: existing.exchangeRateManuallyEdited,
        marketRateSnapshot: existing.marketRateSnapshot,
        feeRuleId: null,
        feeRuleSnapshot: null,
        feeType: null,
        feeCurrency: null,
        originalFeeValue: null,
        finalFeeValue: 0,
        feeAmount: 0,
        feeEdited: false,
        safeId: existing.safeId,
        safeNameSnapshot: existing.safeNameSnapshot,
        acquisitionRate: null,
        acquisitionRateSource: null,
        acquisitionRateSnapshot: null,
        profitAmount: null,
        profitCurrency: null,
        paymentMethod: existing.paymentMethod,
        employeeUserId: existing.employeeUserId,
        employeeName: existing.employeeName,
        notes: `Reversal of ${existing.transactionNo}`,
        createdBy: createdBy || null,
        isReversed: false,
        reversalTransactionId: null,
        reversedTransactionId: existing.id,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }

    const updatedOriginal: ExchangeTransaction = {
        ...existing,
        isReversed: true,
        reversalTransactionId: reversalId,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(workspaceId, now)
    }

    const safeId = existing.safeId
    if (!safeId) {
        throw new Error('Transaction has no safe')
    }

    const safe = await db.fx_safes.get(safeId)
    if (!safe || safe.isDeleted) {
        throw new Error('Safe not found')
    }

    const changedBalances: ExchangeSafeBalance[] = []
    const movements: ExchangeSafeMovement[] = []

    await db.transaction('rw', [db.exchange_transactions, db.fx_safe_balances, db.fx_safe_movements], async () => {
        await db.exchange_transactions.put(reversal)
        await db.exchange_transactions.put(updatedOriginal)

        const incoming = await applySafeDelta({
            workspaceId,
            safe,
            currency: reversal.fromCurrency,
            deltaAmount: reversal.customerGivesAmount,
            movementType: 'exchange_in',
            sourceType: 'exchange_transaction',
            sourceId: reversalId,
            notes: transactionNo,
            createdBy,
            now
        })
        changedBalances.push(incoming.balance)
        movements.push(incoming.movement)

        const outgoing = await applySafeDelta({
            workspaceId,
            safe,
            currency: reversal.toCurrency,
            deltaAmount: -reversal.customerReceivesAmount,
            movementType: 'exchange_out',
            sourceType: 'exchange_transaction',
            sourceId: reversalId,
            notes: transactionNo,
            createdBy,
            now
        })
        changedBalances.push(outgoing.balance)
        movements.push(outgoing.movement)
    })

    await syncUpsertEntities(TRANSACTIONS_TABLE, [reversal as unknown as ExchangeSyncEntity, updatedOriginal as unknown as ExchangeSyncEntity], workspaceId)
    await syncUpsertEntities(SAFE_BALANCES_TABLE, changedBalances as unknown as ExchangeSyncEntity[], workspaceId)
    await syncUpsertEntities(SAFE_MOVEMENTS_TABLE, movements as unknown as ExchangeSyncEntity[], workspaceId)

    return { reversal, original: updatedOriginal }
}

export function useExchangeTransactions(workspaceId: string | undefined, startDate?: string, endDate?: string) {
    const online = useNetworkStatus()

    const transactions = useLiveQuery(
        () => workspaceId
            ? (startDate || endDate
                ? db.exchange_transactions.where('[workspaceId+transactionDate]').between(
                    [workspaceId, startDate || Dexie.minKey],
                    [workspaceId, endDate || Dexie.maxKey],
                    true,
                    true
                )
                : db.exchange_transactions.where('workspaceId').equals(workspaceId))
                .and((item) => !item.isDeleted)
                .reverse()
                .sortBy('createdAt')
            : [],
        [workspaceId, startDate, endDate]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void fetchTableFromSupabase(TRANSACTIONS_TABLE, db.exchange_transactions, workspaceId)
        }
    }, [online, workspaceId])

    return transactions ?? []
}

export function useExchangeTransaction(transactionId: string | undefined) {
    return useLiveQuery(
        () => transactionId ? db.exchange_transactions.get(transactionId) : undefined,
        [transactionId]
    )
}

export function useExchangePairPrices(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const prices = useLiveQuery(
        () => workspaceId
            ? db.exchange_pair_prices
                .where('workspaceId')
                .equals(workspaceId)
                .and((item) => !item.isDeleted)
                .sortBy('updatedAt')
            : [],
        [workspaceId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void fetchTableFromSupabase(PAIR_PRICES_TABLE, db.exchange_pair_prices, workspaceId)
        }
    }, [online, workspaceId])

    return prices ?? []
}

export function useExchangeSafes(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const safes = useLiveQuery(
        () => workspaceId
            ? db.fx_safes
                .where('workspaceId')
                .equals(workspaceId)
                .and((item) => !item.isDeleted)
                .sortBy('createdAt')
            : [],
        [workspaceId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void Promise.all([
                fetchTableFromSupabase(SAFES_TABLE, db.fx_safes, workspaceId),
                fetchTableFromSupabase(SAFE_BALANCES_TABLE, db.fx_safe_balances, workspaceId),
                fetchTableFromSupabase(SAFE_MOVEMENTS_TABLE, db.fx_safe_movements, workspaceId)
            ])
        }
    }, [online, workspaceId])

    return safes ?? []
}

export function useExchangeSafeBalances(workspaceId: string | undefined, safeId?: string | null) {
    return useLiveQuery(
        () => {
            if (!workspaceId) return []
            return db.fx_safe_balances
                .where('workspaceId')
                .equals(workspaceId)
                .and((item) => !item.isDeleted && (!safeId || item.safeId === safeId))
                .toArray()
        },
        [workspaceId, safeId]
    ) ?? []
}

export function useExchangeSafeMovements(workspaceId: string | undefined, safeId?: string | null) {
    return useLiveQuery(
        () => {
            if (!workspaceId) return []
            return db.fx_safe_movements
                .where('workspaceId')
                .equals(workspaceId)
                .and((item) => !item.isDeleted && (!safeId || item.safeId === safeId))
                .reverse()
                .sortBy('createdAt')
        },
        [workspaceId, safeId]
    ) ?? []
}

export function useExchangeFeeRules(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const rules = useLiveQuery(
        () => workspaceId
            ? db.exchange_fee_rules
                .where('workspaceId')
                .equals(workspaceId)
                .and((item) => !item.isDeleted)
                .reverse()
                .sortBy('updatedAt')
            : [],
        [workspaceId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void fetchTableFromSupabase(FEE_RULES_TABLE, db.exchange_fee_rules, workspaceId)
        }
    }, [online, workspaceId])

    return rules ?? []
}
