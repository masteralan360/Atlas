import { useEffect, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import i18n from '@/i18n/config'
import { isOnline } from '@/lib/network'
import {
  getPaymentAccountMovementPresentation,
  PAYMENT_ACCOUNT_REVERSAL_EPSILON
} from '@/lib/paymentAccountMovementPresentation'
import { getSupabaseClientForTable, getSupabaseRemoteTableName } from '@/lib/supabaseSchema'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { canReconcileCloudWorkspaceData } from './cloudReconciliation'

import { db } from './database'
import { addToOfflineMutations } from './offlineMutations'
import type {
  CapitalPool,
  CurrencyCode,
  PaymentAccount,
  PaymentAccountBalance,
  PaymentAccountMovement,
  PaymentTransaction
} from './models'

const CAPITAL_POOL_NAME_MAX_LENGTH = 120
const DETERMINISTIC_REMOTE_ERROR_CODES = new Set([
  '23502',
  '23503',
  '23505',
  '23514',
  '42501',
  'P0001'
])
const capitalPoolMutationQueues = new Map<string, Promise<void>>()

interface CapitalPoolConflictDetails {
  account_name?: string
  pool_name?: string
  currency?: string
}

interface RemoteErrorLike {
  code?: unknown
  message?: unknown
  details?: unknown
}

async function withCapitalPoolMutationLock<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
  const previous = capitalPoolMutationQueues.get(workspaceId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => gate)
  capitalPoolMutationQueues.set(workspaceId, queued)

  await previous
  try {
    return await task()
  } finally {
    release()
    if (capitalPoolMutationQueues.get(workspaceId) === queued) {
      capitalPoolMutationQueues.delete(workspaceId)
    }
  }
}

function syncMeta(workspaceId: string, now: string) {
  return isLocalWorkspaceMode(workspaceId)
    ? { syncStatus: 'synced' as const, lastSyncedAt: now }
    : { syncStatus: 'pending' as const, lastSyncedAt: null }
}

function remotePayload(pool: CapitalPool) {
  return toSnakeCase({
    ...pool,
    syncStatus: undefined,
    lastSyncedAt: undefined
  })
}

function parseConflictDetails(error: unknown): CapitalPoolConflictDetails | null {
  if (!error || typeof error !== 'object') return null
  const details = (error as RemoteErrorLike).details
  if (typeof details !== 'string' || !details.trim().startsWith('{')) return null

  try {
    return JSON.parse(details) as CapitalPoolConflictDetails
  } catch {
    return null
  }
}

function isDeterministicRemoteError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const code = (error as RemoteErrorLike).code
  return typeof code === 'string' && DETERMINISTIC_REMOTE_ERROR_CODES.has(code)
}

export function isCapitalPoolAccountInUseError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const message = (error as RemoteErrorLike).message
  return typeof message === 'string' && message.includes('CAPITAL_POOL_ACCOUNT_IN_USE')
}

/** Converts database constraint errors into localized, user-facing messages. */
export function getCapitalPoolRemoteErrorMessage(error: unknown) {
  const record = error && typeof error === 'object' ? (error as RemoteErrorLike) : null
  const message = typeof record?.message === 'string' ? record.message : ''
  const details = parseConflictDetails(error)

  if (message.includes('CAPITAL_POOL_ACCOUNT_CONFLICT')) {
    return i18n.t('paymentAccounts.capitalPools.errors.accountConflict', {
      account: details?.account_name || i18n.t('paymentAccounts.account'),
      pool: details?.pool_name || i18n.t('paymentAccounts.capitalPools.title'),
      defaultValue: '{{account}} already belongs to {{pool}} for this currency.'
    })
  }
  if (message.includes('CAPITAL_POOL_ACCOUNT_IN_USE')) {
    return i18n.t('paymentAccounts.capitalPools.errors.accountInUse', {
      pool: details?.pool_name || i18n.t('paymentAccounts.capitalPools.title'),
      defaultValue: 'Remove this account from {{pool}} before deactivating or deleting it.'
    })
  }
  if (message.includes('CAPITAL_POOL_CURRENCY_DISABLED')) {
    return i18n.t('paymentAccounts.capitalPools.errors.currencyDisabled', {
      defaultValue: 'This currency is not enabled for the workspace.'
    })
  }
  if (record?.code === '23505') {
    return i18n.t('paymentAccounts.capitalPools.errors.duplicateName', {
      defaultValue: 'A capital pool with this name already exists.'
    })
  }
  if (record?.code === '42501') {
    return i18n.t('paymentAccounts.capitalPools.errors.noPermission', {
      defaultValue: 'You are not allowed to manage capital pools.'
    })
  }
  if (isDeterministicRemoteError(error)) {
    return i18n.t('paymentAccounts.capitalPools.errors.saveRejected', {
      defaultValue: 'The capital pool could not be saved. Refresh the accounts and try again.'
    })
  }
  return null
}

export function useCapitalPools(workspaceId?: string) {
  const online = useNetworkStatus()
  const rows = useLiveQuery(
    () => workspaceId
      ? db.capital_pools.where('workspaceId').equals(workspaceId).toArray()
      : Promise.resolve([] as CapitalPool[]),
    [workspaceId]
  )

  useEffect(() => {
    if (!workspaceId || !online || isLocalWorkspaceMode(workspaceId)) return
    void hydrateCapitalPoolsFromSupabase(workspaceId)
  }, [online, workspaceId])

  return useMemo(
    () => (rows ?? [])
      .filter((pool) => !pool.isDeleted)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
    [rows]
  )
}

async function hydrateCapitalPoolsFromSupabase(workspaceId: string) {
  if (!await canReconcileCloudWorkspaceData(workspaceId)) return

  const client = getSupabaseClientForTable('capital_pools')
  const remoteRows: Record<string, unknown>[] = []
  const pageSize = 1_000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from(getSupabaseRemoteTableName('capital_pools'))
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('is_deleted', false)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error || !data || !await canReconcileCloudWorkspaceData(workspaceId)) return
    remoteRows.push(...data as Record<string, unknown>[])
    if (data.length < pageSize) break
  }

  const syncedAt = new Date().toISOString()
  const remoteIds = new Set(remoteRows.map((row) => String(row.id)))
  const remotePools = remoteRows.map((row) => ({
    ...toCamelCase(row),
    syncStatus: 'synced' as const,
    lastSyncedAt: syncedAt
  } as unknown as CapitalPool))

  await db.transaction('rw', db.capital_pools, async () => {
    const localPools = await db.capital_pools.where('workspaceId').equals(workspaceId).toArray()
    const deletedIds = localPools
      .filter((pool) => pool.syncStatus === 'synced' && !remoteIds.has(pool.id))
      .map((pool) => pool.id)
    if (deletedIds.length) await db.capital_pools.bulkDelete(deletedIds)
    if (remotePools.length) await db.capital_pools.bulkPut(remotePools)
  })
}

export interface SaveCapitalPoolInput {
  id?: string
  name: string
  currency: CurrencyCode
  accountIds: string[]
  enabledCurrencies: readonly CurrencyCode[]
  createdBy?: string | null
  canManage: boolean
}

export interface ValidatedCapitalPoolInput {
  name: string
  currency: CurrencyCode
  accountIds: string[]
}

export async function validateCapitalPoolInput(
  workspaceId: string,
  input: SaveCapitalPoolInput,
  existing?: CapitalPool
): Promise<ValidatedCapitalPoolInput> {
  if (!input.canManage) {
    throw new Error(i18n.t('paymentAccounts.capitalPools.errors.noPermission'))
  }

  const name = input.name.trim()
  if (!name) throw new Error(i18n.t('paymentAccounts.capitalPools.errors.nameRequired'))
  if (name.length > CAPITAL_POOL_NAME_MAX_LENGTH) {
    throw new Error(i18n.t('paymentAccounts.capitalPools.errors.nameTooLong', { count: CAPITAL_POOL_NAME_MAX_LENGTH }))
  }

  const accountIds = input.accountIds.filter((accountId) => typeof accountId === 'string' && !!accountId)
  const uniqueAccountIds = [...new Set(accountIds)]
  if (uniqueAccountIds.length !== accountIds.length) {
    throw new Error(i18n.t('paymentAccounts.capitalPools.errors.duplicateAccount'))
  }
  if (uniqueAccountIds.length < 2) {
    throw new Error(i18n.t('paymentAccounts.capitalPools.errors.minimumAccounts'))
  }

  if (input.currency !== existing?.currency && !input.enabledCurrencies.includes(input.currency)) {
    throw new Error(i18n.t('paymentAccounts.capitalPools.errors.currencyDisabled'))
  }

  const [accounts, pools] = await Promise.all([
    db.payment_accounts.bulkGet(uniqueAccountIds),
    db.capital_pools.where('workspaceId').equals(workspaceId).toArray()
  ])
  const hasUnavailableAccount = accounts.some(
    (account) => !account || account.workspaceId !== workspaceId || account.isDeleted || !account.isActive
  )
  if (hasUnavailableAccount || accounts.length !== uniqueAccountIds.length) {
    throw new Error(i18n.t('paymentAccounts.capitalPools.errors.activeAccountsOnly'))
  }

  const normalizedName = name.toLocaleLowerCase()
  const duplicateName = pools.find(
    (pool) => !pool.isDeleted && pool.id !== existing?.id && pool.name.trim().toLocaleLowerCase() === normalizedName
  )
  if (duplicateName) throw new Error(i18n.t('paymentAccounts.capitalPools.errors.duplicateName'))

  const selectedIds = new Set(uniqueAccountIds)
  const conflictingPool = pools.find(
    (pool) =>
      !pool.isDeleted &&
      pool.id !== existing?.id &&
      pool.currency === input.currency &&
      pool.accountIds.some((accountId) => selectedIds.has(accountId))
  )
  if (conflictingPool) {
    const accountId = conflictingPool.accountIds.find((id) => selectedIds.has(id))
    const account = accounts.find((item) => item?.id === accountId)
    throw new Error(i18n.t('paymentAccounts.capitalPools.errors.accountConflict', {
      account: account?.name || i18n.t('paymentAccounts.account'),
      pool: conflictingPool.name
    }))
  }

  return { name, currency: input.currency, accountIds: uniqueAccountIds }
}

async function persistCapitalPool(pool: CapitalPool, operation: 'create' | 'update') {
  if (isLocalWorkspaceMode(pool.workspaceId)) {
    await db.capital_pools.put(pool)
    return pool
  }

  if (!isOnline()) {
    await addToOfflineMutations('capital_pools', pool.id, operation, pool as unknown as Record<string, unknown>, pool.workspaceId)
    await db.capital_pools.put(pool)
    return pool
  }

  const client = getSupabaseClientForTable('capital_pools')
  const { error } = await client
    .from(getSupabaseRemoteTableName('capital_pools'))
    .upsert(remotePayload(pool))
  if (error) {
    const friendlyMessage = getCapitalPoolRemoteErrorMessage(error)
    if (friendlyMessage) throw new Error(friendlyMessage)

    await addToOfflineMutations('capital_pools', pool.id, operation, pool as unknown as Record<string, unknown>, pool.workspaceId)
    await db.capital_pools.put(pool)
    return pool
  }

  const synced = {
    ...pool,
    syncStatus: 'synced' as const,
    lastSyncedAt: new Date().toISOString()
  }
  await db.capital_pools.put(synced)
  return synced
}

export async function saveCapitalPool(workspaceId: string, input: SaveCapitalPoolInput) {
  return withCapitalPoolMutationLock(workspaceId, async () => {
    const performSave = async () => {
      const existing = input.id ? await db.capital_pools.get(input.id) : undefined
      if (input.id && (!existing || existing.workspaceId !== workspaceId || existing.isDeleted)) {
        throw new Error(i18n.t('paymentAccounts.capitalPools.errors.notFound'))
      }

      const validated = await validateCapitalPoolInput(workspaceId, input, existing)
      const now = new Date().toISOString()
      const pool: CapitalPool = {
        id: existing?.id ?? generateId(),
        workspaceId,
        ...validated,
        createdBy: existing?.createdBy ?? input.createdBy ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        version: (existing?.version ?? 0) + 1,
        isDeleted: false,
        ...syncMeta(workspaceId, now)
      }

      return persistCapitalPool(pool, existing ? 'update' : 'create')
    }

    // Cloud Sync grants one browser/PWA owner for this workspace SQLite file,
    // while the in-process lock serializes validation and writes in that owner.
    return performSave()
  })
}

export async function deleteCapitalPool(workspaceId: string, poolId: string, canManage: boolean) {
  return withCapitalPoolMutationLock(workspaceId, async () => {
    const performDelete = async () => {
      if (!canManage) throw new Error(i18n.t('paymentAccounts.capitalPools.errors.noPermission'))
      const existing = await db.capital_pools.get(poolId)
      if (!existing || existing.workspaceId !== workspaceId || existing.isDeleted) {
        throw new Error(i18n.t('paymentAccounts.capitalPools.errors.notFound'))
      }

      const now = new Date().toISOString()
      return persistCapitalPool({
        ...existing,
        isDeleted: true,
        updatedAt: now,
        version: existing.version + 1,
        ...syncMeta(workspaceId, now)
      }, 'update')
    }

    return performDelete()
  })
}

export async function assertPaymentAccountNotInCapitalPool(workspaceId: string, accountId: string) {
  const pools = await db.capital_pools.where('workspaceId').equals(workspaceId).toArray()
  const pool = pools.find((item) => !item.isDeleted && item.accountIds.includes(accountId))
  if (pool) {
    throw new Error(i18n.t('paymentAccounts.capitalPools.errors.accountInUse', { pool: pool.name }))
  }

  // A remote read closes the brief startup window before the Dexie cache has
  // hydrated. Offline work still uses the last synchronized local snapshot.
  if (isLocalWorkspaceMode(workspaceId) || !isOnline()) return
  const client = getSupabaseClientForTable('capital_pools')
  const { data, error } = await client
    .from(getSupabaseRemoteTableName('capital_pools'))
    .select('name,currency')
    .eq('workspace_id', workspaceId)
    .eq('is_deleted', false)
    .contains('account_ids', [accountId])
    .limit(1)

  if (error || !data?.[0]) return

  throw new Error(i18n.t('paymentAccounts.capitalPools.errors.accountInUse', {
    pool: String((data[0] as { name?: unknown }).name || i18n.t('paymentAccounts.capitalPools.title'))
  }))
}

export interface CapitalPoolMemberBreakdown {
  accountId: string
  accountName: string
  balanceAmount: number
  shareBasisPoints: number
  sharePercent: number
}

export interface CapitalPoolBreakdown {
  totalCapital: number
  members: CapitalPoolMemberBreakdown[]
}

/**
 * Allocates hundredths of a percent by largest remainder. A positive pool
 * therefore always renders exactly 100.00%, including awkward thirds.
 */
export function buildCapitalPoolBreakdown(
  pool: Pick<CapitalPool, 'currency' | 'accountIds'>,
  accounts: readonly PaymentAccount[],
  balances: readonly PaymentAccountBalance[]
): CapitalPoolBreakdown {
  const accountById = new Map(accounts.map((account) => [account.id, account]))
  const balanceByAccountId = new Map<string, number>()
  for (const balance of balances) {
    if (balance.isDeleted || balance.currency !== pool.currency || !pool.accountIds.includes(balance.accountId)) continue
    balanceByAccountId.set(
      balance.accountId,
      (balanceByAccountId.get(balance.accountId) ?? 0) + Math.max(0, Number(balance.balanceAmount) || 0)
    )
  }

  const rows = pool.accountIds.flatMap((accountId) => {
    const account = accountById.get(accountId)
    if (!account) return []
    return [{
      accountId,
      accountName: account.name,
      balanceAmount: balanceByAccountId.get(accountId) ?? 0,
      shareBasisPoints: 0,
      sharePercent: 0
    } satisfies CapitalPoolMemberBreakdown]
  })
  const totalCapital = rows.reduce((sum, row) => sum + row.balanceAmount, 0)

  if (totalCapital > 0) {
    const allocations = rows.map((row, index) => {
      const rawBasisPoints = (row.balanceAmount / totalCapital) * 10_000
      const floorBasisPoints = Math.floor(rawBasisPoints)
      row.shareBasisPoints = floorBasisPoints
      return { index, remainder: rawBasisPoints - floorBasisPoints, row }
    })
    const remaining = 10_000 - allocations.reduce((sum, allocation) => sum + allocation.row.shareBasisPoints, 0)
    allocations.sort((left, right) =>
      right.remainder - left.remainder ||
      right.row.balanceAmount - left.row.balanceAmount ||
      left.row.accountName.localeCompare(right.row.accountName) ||
      left.row.accountId.localeCompare(right.row.accountId)
    )
    for (let index = 0; index < remaining; index += 1) {
      allocations[index % allocations.length].row.shareBasisPoints += 1
    }
    for (const row of rows) row.sharePercent = row.shareBasisPoints / 100
  }

  rows.sort((left, right) =>
    right.balanceAmount - left.balanceAmount ||
    left.accountName.localeCompare(right.accountName) ||
    left.accountId.localeCompare(right.accountId)
  )

  return { totalCapital, members: rows }
}

export type CapitalPoolCashFlowGranularity = 'day' | 'week' | 'month'

export interface CapitalPoolCashFlowPoint {
  bucketKey: string
  bucketStart: string
  incoming: number
  outgoing: number
  net: number
  transactionCount: number
}

export interface CapitalPoolAccountCashFlow {
  accountId: string
  granularity: CapitalPoolCashFlowGranularity
  incoming: number
  outgoing: number
  net: number
  transactionCount: number
  points: CapitalPoolCashFlowPoint[]
}

export interface CapitalPoolTotalsByCurrency {
  currency: CurrencyCode
  pools: Array<{
    poolId: string
    poolName: string
    totalCapital: number
    accountCount: number
  }>
}

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000

function toLocalDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getCashFlowBucketStart(date: Date, granularity: CapitalPoolCashFlowGranularity) {
  const bucket = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  if (granularity === 'month') {
    bucket.setDate(1)
  } else if (granularity === 'week') {
    const mondayOffset = (bucket.getDay() + 6) % 7
    bucket.setDate(bucket.getDate() - mondayOffset)
  }
  return toLocalDateKey(bucket)
}

export function resolveCapitalPoolCashFlowGranularity(
  range: { start?: Date; end?: Date },
  movementDates: readonly string[] = []
): CapitalPoolCashFlowGranularity {
  const validMovementTimes = movementDates
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite)
  const inferredStart = validMovementTimes.length > 0 ? Math.min(...validMovementTimes) : Date.now()
  const inferredEnd = validMovementTimes.length > 0 ? Math.max(...validMovementTimes) : inferredStart
  const start = range.start?.getTime() ?? inferredStart
  const end = range.end?.getTime() ?? inferredEnd
  const spanInDays = Math.max(1, Math.ceil(Math.max(0, end - start) / DAY_IN_MILLISECONDS))

  if (spanInDays <= 45) return 'day'
  if (spanInDays <= 240) return 'week'
  return 'month'
}

/**
 * Builds reversal-aware cash-flow series for every account in a pool. The
 * movement rows provide account attribution while payment transactions supply
 * the immutable reversal relationship used by Ledger and Payment Accounts.
 */
export function buildCapitalPoolAccountCashFlows(
  pool: Pick<CapitalPool, 'currency' | 'accountIds'>,
  movements: readonly PaymentAccountMovement[],
  transactions: readonly PaymentTransaction[],
  range: { start?: Date; end?: Date } = {}
): CapitalPoolAccountCashFlow[] {
  const poolAccountIds = new Set(pool.accountIds)
  const transactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]))
  const reversalAmounts = new Map<string, number>()

  for (const transaction of transactions) {
    if (transaction.isDeleted || !transaction.reversalOfTransactionId) continue
    reversalAmounts.set(
      transaction.reversalOfTransactionId,
      (reversalAmounts.get(transaction.reversalOfTransactionId) ?? 0) + Math.abs(Number(transaction.amount) || 0)
    )
  }

  const relevantMovements = movements.filter((movement) => {
    if (movement.isDeleted || movement.currency !== pool.currency || !poolAccountIds.has(movement.accountId)) return false
    const occurredAt = new Date(movement.occurredAt)
    if (Number.isNaN(occurredAt.getTime())) return false
    if (range.start && occurredAt < range.start) return false
    if (range.end && occurredAt >= range.end) return false
    return true
  })
  const granularity = resolveCapitalPoolCashFlowGranularity(
    range,
    relevantMovements.map((movement) => movement.occurredAt)
  )
  const pointsByAccount = new Map<string, Map<string, CapitalPoolCashFlowPoint>>()
  for (const accountId of pool.accountIds) pointsByAccount.set(accountId, new Map())

  for (const movement of relevantMovements) {
    const transaction = transactionById.get(movement.paymentTransactionId) ?? null
    if (transaction?.reversalOfTransactionId) continue
    const presentation = getPaymentAccountMovementPresentation(movement, transaction, reversalAmounts)
    if (Math.abs(presentation.deltaAmount) <= PAYMENT_ACCOUNT_REVERSAL_EPSILON) continue

    const occurredAt = new Date(movement.occurredAt)
    const bucketStart = getCashFlowBucketStart(occurredAt, granularity)
    const accountPoints = pointsByAccount.get(movement.accountId)
    if (!accountPoints) continue
    const point = accountPoints.get(bucketStart) ?? {
      bucketKey: bucketStart,
      bucketStart,
      incoming: 0,
      outgoing: 0,
      net: 0,
      transactionCount: 0
    }
    const amount = Math.abs(presentation.deltaAmount)
    if (presentation.deltaAmount > 0) point.incoming += amount
    else point.outgoing += amount
    point.net += presentation.deltaAmount
    point.transactionCount += 1
    accountPoints.set(bucketStart, point)
  }

  return pool.accountIds.map((accountId) => {
    const points = Array.from(pointsByAccount.get(accountId)?.values() ?? [])
      .sort((left, right) => left.bucketKey.localeCompare(right.bucketKey))
    return {
      accountId,
      granularity,
      incoming: points.reduce((sum, point) => sum + point.incoming, 0),
      outgoing: points.reduce((sum, point) => sum + point.outgoing, 0),
      net: points.reduce((sum, point) => sum + point.net, 0),
      transactionCount: points.reduce((sum, point) => sum + point.transactionCount, 0),
      points
    }
  })
}

export function buildCapitalPoolTotalsByCurrency(
  pools: readonly CapitalPool[],
  accounts: readonly PaymentAccount[],
  balances: readonly PaymentAccountBalance[]
): CapitalPoolTotalsByCurrency[] {
  const groups = new Map<CurrencyCode, CapitalPoolTotalsByCurrency['pools']>()

  for (const pool of pools) {
    if (pool.isDeleted) continue
    const breakdown = buildCapitalPoolBreakdown(pool, accounts, balances)
    const entries = groups.get(pool.currency) ?? []
    entries.push({
      poolId: pool.id,
      poolName: pool.name,
      totalCapital: breakdown.totalCapital,
      accountCount: breakdown.members.length
    })
    groups.set(pool.currency, entries)
  }

  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, groupedPools]) => ({
      currency,
      pools: groupedPools.sort((left, right) =>
        right.totalCapital - left.totalCapital ||
        left.poolName.localeCompare(right.poolName) ||
        left.poolId.localeCompare(right.poolId)
      )
    }))
}
