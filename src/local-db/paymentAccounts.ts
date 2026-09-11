import { useEffect, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import i18n from '@/i18n/config'
import { formatCurrency, generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { getSupabaseClientForTable, getSupabaseRemoteTableName } from '@/lib/supabaseSchema'
import { isOnline } from '@/lib/network'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { addToOfflineMutations, fetchTableFromSupabase } from './hooks'
import {
  assertPaymentAccountNotInCapitalPool,
  getCapitalPoolRemoteErrorMessage,
  isCapitalPoolAccountInUseError
} from './capitalPools'
import { DIGITAL_WALLET_PAYMENT_METHODS } from './models'
import type {
  CashierShift,
  CashierShiftCurrencyCount,
  CashierShiftAssignment,
  CashierShiftAssignmentMode,
  CashierShiftEarlyFinishPolicy,
  CashierShiftEarlyFinishRequestStatus,
  CashierShiftOccurrence,
  CashierShiftPauseKind,
  CashierShiftPausePeriod,
  CashierShiftPauseRequest,
  CashierShiftTemplate,
  CurrencyCode,
  DigitalWalletPaymentMethod,
  PaymentAccount,
  PaymentAccountIconKey,
  PaymentAccountBalance,
  PaymentAccountMovement,
  PaymentAccountType,
  PaymentAccountAdjustmentReason,
  PaymentAccountManualOperationKind,
  PaymentTransaction,
  PaymentTransactionDirection,
  WorkspacePaymentMethod
} from './models'

const _PAYMENT_ACCOUNT_TABLES = [
  'payment_accounts',
  'payment_account_balances',
  'payment_account_movements',
  'cashier_shifts',
  'cashier_shift_currency_counts',
  'cashier_shift_templates',
  'cashier_shift_assignments',
  'cashier_shift_occurrences',
  'cashier_shift_pause_requests',
  'cashier_shift_pause_periods'
] as const

type PaymentAccountTable = (typeof _PAYMENT_ACCOUNT_TABLES)[number]

interface PersistOptions {
  localAlreadyPersisted?: boolean
  failOnRemoteConflict?: boolean
  remoteConflictMessage?: string
  rollbackOnCapitalPoolUse?: () => Promise<void>
}

/** Keep floating-point input noise from creating an unusable negative balance. */
const PAYMENT_ACCOUNT_BALANCE_EPSILON = 0.000001
const CASHIER_SHIFT_REASON_MAX_LENGTH = 1_000
const CASHIER_SHIFT_EARLY_FINISH_POLICIES: CashierShiftEarlyFinishPolicy[] = [
  'scheduled_end',
  'time_before_end',
  'request_approval',
  'free_with_reason'
]
const CASHIER_SHIFT_ASSIGNMENT_MODES: CashierShiftAssignmentMode[] = ['scheduled', 'manual', 'login_logout']

/** Older cached rows are scheduled by definition; the migration makes this explicit. */
export function getCashierShiftAssignmentMode(
  value: Pick<CashierShiftAssignment | CashierShiftOccurrence, 'assignmentMode'>
) {
  return value.assignmentMode ?? 'scheduled'
}

function isActiveCashierShiftOccurrence(occurrence: Pick<CashierShiftOccurrence, 'status' | 'isDeleted'>) {
  return !occurrence.isDeleted && (occurrence.status === 'active' || occurrence.status === 'paused')
}

function getLocalizedInsufficientFundsMessage(
  balance: number,
  currency: CurrencyCode,
  accountName?: string | null,
  operation: 'transaction' | 'withdrawal' = 'transaction'
) {
  const formattedBalance = formatCurrency(balance, currency, 'د.ع')
  return operation === 'withdrawal'
    ? i18n.t('paymentAccounts.errors.insufficientFundsWithdrawal', {
        balance: formattedBalance,
        defaultValue:
          'You do not have enough balance in this payment account to make this withdrawal. Current balance: {{balance}}.'
      })
    : i18n.t('paymentAccounts.errors.insufficientFunds', {
        account:
          accountName ||
          i18n.t('paymentAccounts.account', {
            defaultValue: 'this payment account'
          }),
        balance: formattedBalance,
        defaultValue:
          'You do not have enough balance in {{account}} to proceed with this transaction. Current balance: {{balance}}.'
      })
}

function syncMeta(workspaceId: string, now: string) {
  return isLocalWorkspaceMode(workspaceId)
    ? { syncStatus: 'synced' as const, lastSyncedAt: now }
    : { syncStatus: 'pending' as const, lastSyncedAt: null }
}

function cloudWorkspace(workspaceId: string) {
  return !isLocalWorkspaceMode(workspaceId)
}

function payload(row: Record<string, unknown>) {
  return toSnakeCase({
    ...row,
    syncStatus: undefined,
    lastSyncedAt: undefined
  })
}

function isRemoteUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

async function persist<T extends { id: string; workspaceId: string }>(
  tableName: PaymentAccountTable,
  row: T,
  operation: 'create' | 'update' = 'create',
  options: PersistOptions = {}
) {
  const table = db.table(tableName)
  if (!options.localAlreadyPersisted) await table.put(row)

  if (!cloudWorkspace(row.workspaceId)) return row

  if (!isOnline()) {
    await addToOfflineMutations(tableName, row.id, operation, row as Record<string, unknown>, row.workspaceId)
    return row
  }

  try {
    const client = getSupabaseClientForTable(tableName)
    const { error } = await client
      .from(getSupabaseRemoteTableName(tableName))
      .upsert(payload(row as Record<string, unknown>))
    if (error) throw error
    const synced = {
      ...row,
      syncStatus: 'synced' as const,
      lastSyncedAt: new Date().toISOString()
    }
    await table.put(synced)
    return synced
  } catch (error) {
    if (options.rollbackOnCapitalPoolUse && isCapitalPoolAccountInUseError(error)) {
      await options.rollbackOnCapitalPoolUse()
      throw new Error(
        getCapitalPoolRemoteErrorMessage(error) ??
        i18n.t('paymentAccounts.capitalPools.errors.accountInUse')
      )
    }
    if (options.failOnRemoteConflict && isRemoteUniqueViolation(error)) {
      await table.delete(row.id)
      throw new Error(options.remoteConflictMessage ?? 'This record conflicts with an existing record.')
    }

    // Account configuration and shift records follow Atlas's normal offline
    // queue contract. The payment itself remains the financial source of truth.
    await addToOfflineMutations(tableName, row.id, operation, row as Record<string, unknown>, row.workspaceId)
    return row
  }
}

function usePaymentAccountTableState<T extends { id: string; workspaceId: string }>(
  tableName: PaymentAccountTable,
  workspaceId?: string
) {
  const online = useNetworkStatus()
  const rows = useLiveQuery(
    () =>
      workspaceId
        ? (db.table(tableName).where('workspaceId').equals(workspaceId).toArray() as Promise<T[]>)
        : Promise.resolve([] as T[]),
    [tableName, workspaceId]
  )

  useEffect(() => {
    if (!workspaceId || !online || !cloudWorkspace(workspaceId)) return
    void fetchTableFromSupabase(tableName, db.table(tableName), workspaceId)
  }, [online, tableName, workspaceId])

  return {
    rows: rows ?? [],
    // An undefined result means Dexie's first local read has not completed.
    // Do not confuse that with a real, empty account list in payment forms.
    isReady: !workspaceId || rows !== undefined
  }
}

function usePaymentAccountTable<T extends { id: string; workspaceId: string }>(
  tableName: PaymentAccountTable,
  workspaceId?: string
) {
  return usePaymentAccountTableState<T>(tableName, workspaceId).rows
}

function normalizePaymentAccounts(rows: PaymentAccount[]) {
  const accounts = rows.filter((row) => !row.isDeleted)
  const activeAccounts = accounts
    .filter((row) => row.isActive)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
  const needsLegacyPrimary = activeAccounts.length > 0 && !activeAccounts.some((row) => row.isPrimary)
  const derivedPrimaryId = needsLegacyPrimary ? activeAccounts[0].id : null

  return accounts
    .map((account) => (account.id === derivedPrimaryId ? { ...account, isPrimary: true } : account))
    .sort((a, b) => Number(!!b.isPrimary) - Number(!!a.isPrimary) || a.name.localeCompare(b.name))
}

/** Payment forms use this to wait for the local account configuration to resolve. */
export function usePaymentAccountsState(workspaceId?: string) {
  const { rows, isReady } = usePaymentAccountTableState<PaymentAccount>('payment_accounts', workspaceId)
  const accounts = useMemo(() => normalizePaymentAccounts(rows), [rows])

  return { accounts, isReady }
}

export function usePaymentAccounts(workspaceId?: string) {
  return usePaymentAccountsState(workspaceId).accounts
}

export function usePaymentAccountBalancesState(workspaceId?: string) {
  const { rows, isReady } = usePaymentAccountTableState<PaymentAccountBalance>('payment_account_balances', workspaceId)
  const balances = useMemo(() => rows.filter((row) => !row.isDeleted), [rows])

  return { balances, isReady }
}

export function usePaymentAccountBalances(workspaceId?: string) {
  return usePaymentAccountBalancesState(workspaceId).balances
}

export function usePaymentAccountMovements(workspaceId?: string) {
  const rows = usePaymentAccountTable<PaymentAccountMovement>('payment_account_movements', workspaceId)
  return useMemo(
    () => rows.filter((row) => !row.isDeleted && !row.voidId).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
    [rows]
  )
}

export function useCashierShifts(workspaceId?: string) {
  const rows = usePaymentAccountTable<CashierShift>('cashier_shifts', workspaceId)
  return useMemo(
    () => rows.filter((row) => !row.isDeleted).sort((a, b) => b.openedAt.localeCompare(a.openedAt)),
    [rows]
  )
}

export function useCashierShiftCurrencyCounts(workspaceId?: string) {
  const rows = usePaymentAccountTable<CashierShiftCurrencyCount>('cashier_shift_currency_counts', workspaceId)
  return useMemo(() => rows.filter((row) => !row.isDeleted), [rows])
}

export function useCashierShiftTemplates(workspaceId?: string) {
  const rows = usePaymentAccountTable<CashierShiftTemplate>('cashier_shift_templates', workspaceId)
  return useMemo(
    () => rows.filter((row) => !row.isDeleted).sort((left, right) => left.name.localeCompare(right.name)),
    [rows]
  )
}

export function useCashierShiftAssignments(workspaceId?: string) {
  const rows = usePaymentAccountTable<CashierShiftAssignment>('cashier_shift_assignments', workspaceId)
  return useMemo(
    () => rows.filter((row) => !row.isDeleted).sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [rows]
  )
}

export function useCashierShiftOccurrences(workspaceId?: string) {
  const rows = usePaymentAccountTable<CashierShiftOccurrence>('cashier_shift_occurrences', workspaceId)
  return useMemo(
    () =>
      rows
        .filter((row) => !row.isDeleted)
        .sort((left, right) =>
          (right.scheduledStartAt ?? right.startedAt).localeCompare(left.scheduledStartAt ?? left.startedAt)
        ),
    [rows]
  )
}

export function useCashierShiftPauseRequests(workspaceId?: string) {
  const rows = usePaymentAccountTable<CashierShiftPauseRequest>('cashier_shift_pause_requests', workspaceId)
  return useMemo(
    () => rows.filter((row) => !row.isDeleted).sort((left, right) => right.requestedAt.localeCompare(left.requestedAt)),
    [rows]
  )
}

export function useCashierShiftPausePeriods(workspaceId?: string) {
  const rows = usePaymentAccountTable<CashierShiftPausePeriod>('cashier_shift_pause_periods', workspaceId)
  return useMemo(
    () => rows.filter((row) => !row.isDeleted).sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
    [rows]
  )
}

function getEarlyFinishPolicy(value: Pick<CashierShiftAssignment | CashierShiftOccurrence, 'earlyFinishPolicy'>) {
  return value.earlyFinishPolicy ?? 'scheduled_end'
}

function getEarlyFinishRequestStatus(occurrence: CashierShiftOccurrence): CashierShiftEarlyFinishRequestStatus {
  return occurrence.earlyFinishRequestStatus ?? 'not_requested'
}

function normalizeCashierShiftReason(value: string | null | undefined, required: boolean) {
  const reason = value?.trim() || null
  if (required && !reason) throw new Error(i18n.t('paymentAccounts.errors.earlyFinishReasonRequired'))
  if (reason && reason.length > CASHIER_SHIFT_REASON_MAX_LENGTH) {
    throw new Error(i18n.t('paymentAccounts.errors.earlyFinishReasonTooLong'))
  }
  return reason
}

export interface CashierShiftCompletionEligibility {
  canComplete: boolean
  requiresReason: boolean
  requiresApprovalRequest: boolean
  eligibleAt: string | null
}

/**
 * Evaluates an occurrence's immutable early-finish policy. Reaching the
 * scheduled end always permits completion, regardless of the selected policy.
 */
export function getCashierShiftCompletionEligibility(
  occurrence: CashierShiftOccurrence,
  now = new Date()
): CashierShiftCompletionEligibility {
  if (occurrence.status !== 'active') {
    return {
      canComplete: false,
      requiresReason: false,
      requiresApprovalRequest: false,
      eligibleAt: null
    }
  }

  // Unscheduled occurrences are governed by their explicit lifecycle actions,
  // not a fabricated end window or early-finish rule.
  if (getCashierShiftAssignmentMode(occurrence) !== 'scheduled' || !occurrence.scheduledEndAt) {
    return {
      canComplete: true,
      requiresReason: false,
      requiresApprovalRequest: false,
      eligibleAt: null
    }
  }

  const scheduledEnd = new Date(occurrence.scheduledEndAt)
  if (now >= scheduledEnd) {
    return {
      canComplete: true,
      requiresReason: false,
      requiresApprovalRequest: false,
      eligibleAt: occurrence.scheduledEndAt
    }
  }

  const policy = getEarlyFinishPolicy(occurrence)
  if (policy === 'time_before_end') {
    const offsetMinutes = Number(occurrence.earlyFinishOffsetMinutes || 0)
    const eligibleAt = new Date(scheduledEnd.getTime() - offsetMinutes * 60_000)
    return {
      canComplete: offsetMinutes > 0 && now >= eligibleAt,
      requiresReason: false,
      requiresApprovalRequest: false,
      eligibleAt: eligibleAt.toISOString()
    }
  }
  if (policy === 'request_approval') {
    return {
      canComplete: getEarlyFinishRequestStatus(occurrence) === 'approved',
      requiresReason: false,
      requiresApprovalRequest: getEarlyFinishRequestStatus(occurrence) !== 'approved',
      eligibleAt: null
    }
  }
  if (policy === 'free_with_reason') {
    return {
      canComplete: true,
      requiresReason: true,
      requiresApprovalRequest: false,
      eligibleAt: null
    }
  }

  return {
    canComplete: false,
    requiresReason: false,
    requiresApprovalRequest: false,
    eligibleAt: occurrence.scheduledEndAt
  }
}

export interface CashierShiftCurrencySummary {
  currency: CurrencyCode
  incomingAmount: number
  outgoingAmount: number
  netAmount: number
  transactionCount: number
}

function roundCashierShiftAmount(value: number) {
  return Number(value.toFixed(6))
}

/**
 * Builds an audit-friendly per-currency view from transactions explicitly
 * linked to an occurrence. Signed reversals are reflected as the inverse cash
 * movement, so a reversal never inflates either side of the shift summary.
 */
export function summarizeCashierShiftTransactions(
  transactions: PaymentTransaction[],
  cashierShiftOccurrenceId: string
): CashierShiftCurrencySummary[] {
  const summaries = new Map<CurrencyCode, CashierShiftCurrencySummary>()

  for (const transaction of transactions) {
    if (transaction.isDeleted || transaction.cashierShiftOccurrenceId !== cashierShiftOccurrenceId) continue

    const current = summaries.get(transaction.currency) ?? {
      currency: transaction.currency,
      incomingAmount: 0,
      outgoingAmount: 0,
      netAmount: 0,
      transactionCount: 0
    }
    const delta = getPaymentAccountTransactionDelta(transaction)
    if (delta >= 0) current.incomingAmount += delta
    else current.outgoingAmount += Math.abs(delta)
    current.netAmount += delta
    current.transactionCount += 1
    summaries.set(transaction.currency, current)
  }

  return [...summaries.values()]
    .map((summary) => ({
      ...summary,
      incomingAmount: roundCashierShiftAmount(summary.incomingAmount),
      outgoingAmount: roundCashierShiftAmount(summary.outgoingAmount),
      netAmount: roundCashierShiftAmount(summary.netAmount)
    }))
    .sort((left, right) => left.currency.localeCompare(right.currency))
}

export interface SavePaymentAccountInput {
  id?: string
  name: string
  accountType: PaymentAccountType
  iconKey?: PaymentAccountIconKey | null
  /** Optional branded method this Digital Wallet should be proposed for. */
  linkedPaymentMethod?: DigitalWalletPaymentMethod | null
  notes?: string | null
  isActive?: boolean
  /** Switching this also clears the primary flag on the workspace's other accounts. */
  isPrimary?: boolean
  /** Only one active account can be preselected in a new payment form. */
  isDefaultForPaymentSelector?: boolean
  createdBy?: string | null
  /** Optional opening amounts, posted as incoming account movements on creation. */
  openingBalances?: Array<{ currency: CurrencyCode; amount: number }>
}

export async function savePaymentAccount(workspaceId: string, input: SavePaymentAccountInput) {
  const now = new Date().toISOString()
  const existing = input.id ? await db.payment_accounts.get(input.id) : undefined
  if (existing && existing.workspaceId !== workspaceId)
    throw new Error('Payment account does not belong to this workspace.')

  const requestedOpeningBalances = existing ? [] : (input.openingBalances ?? [])
  if (requestedOpeningBalances.length > 4) {
    throw new Error('A payment account can have opening balances in up to four currencies.')
  }

  const seenOpeningCurrencies = new Set<CurrencyCode>()
  const openingBalances = requestedOpeningBalances.filter(({ currency, amount }) => {
    if (seenOpeningCurrencies.has(currency)) {
      throw new Error('An opening balance can be recorded only once per currency.')
    }
    seenOpeningCurrencies.add(currency)
    return Number.isFinite(amount) && amount > 0
  })

  const activeAccounts = (await db.payment_accounts.where('workspaceId').equals(workspaceId).toArray()).filter(
    (item) => !item.isDeleted && item.isActive && item.id !== existing?.id
  )
  const isActive = input.isActive ?? existing?.isActive ?? true
  if (existing?.isActive && !isActive) {
    await assertPaymentAccountNotInCapitalPool(workspaceId, existing.id)
  }
  const linkedPaymentMethod =
    isActive && input.accountType === 'digital_wallet'
      ? input.linkedPaymentMethod === undefined
        ? (existing?.linkedPaymentMethod ?? null)
        : input.linkedPaymentMethod
      : null
  if (linkedPaymentMethod && !DIGITAL_WALLET_PAYMENT_METHODS.includes(linkedPaymentMethod)) {
    throw new Error('Only supported digital payment methods can be linked to a Digital Wallet account.')
  }
  const hasOtherPrimary = activeAccounts.some((item) => item.isPrimary)
  const shouldBePrimary = isActive && (input.isPrimary === true || existing?.isPrimary === true || !hasOtherPrimary)
  const shouldBeDefaultForPaymentSelector =
    isActive && (input.isDefaultForPaymentSelector ?? existing?.isDefaultForPaymentSelector ?? false)
  const account: PaymentAccount = {
    id: input.id ?? generateId(),
    workspaceId,
    name: input.name.trim(),
    accountType: input.accountType,
    linkedPaymentMethod,
    iconKey: input.iconKey ?? existing?.iconKey ?? null,
    notes: input.notes?.trim() || null,
    isActive,
    isPrimary: shouldBePrimary,
    isDefaultForPaymentSelector: shouldBeDefaultForPaymentSelector,
    createdBy: existing?.createdBy ?? input.createdBy ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
    isDeleted: false,
    ...syncMeta(workspaceId, now)
  }

  const relatedUpdates = activeAccounts.reduce<PaymentAccount[]>((updates, other) => {
    const shouldClearPrimary = account.isPrimary && other.isPrimary
    const shouldClearDefault = account.isDefaultForPaymentSelector && other.isDefaultForPaymentSelector
    const shouldClearLinkedPaymentMethod =
      !!account.linkedPaymentMethod &&
      other.accountType === 'digital_wallet' &&
      other.linkedPaymentMethod === account.linkedPaymentMethod
    if (!shouldClearPrimary && !shouldClearDefault && !shouldClearLinkedPaymentMethod) return updates

    updates.push({
      ...other,
      isPrimary: shouldClearPrimary ? false : other.isPrimary,
      isDefaultForPaymentSelector: shouldClearDefault ? false : other.isDefaultForPaymentSelector,
      linkedPaymentMethod: shouldClearLinkedPaymentMethod ? null : other.linkedPaymentMethod,
      updatedAt: now,
      version: other.version + 1,
      ...syncMeta(workspaceId, now)
    })
    return updates
  }, [])

  // Update the local view as one operation, then let normal persistence queue or
  // synchronize each changed record. This keeps a primary/default switch instant offline.
  await db.transaction('rw', db.payment_accounts, async () => {
    await db.payment_accounts.bulkPut([...relatedUpdates, account])
  })
  const rollbackAccountRemoval = existing?.isActive && !account.isActive
    ? async () => {
        await db.transaction('rw', db.payment_accounts, async () => {
          await db.payment_accounts.put(existing)
          const originalRelated = activeAccounts.filter((candidate) =>
            relatedUpdates.some((related) => related.id === candidate.id)
          )
          if (originalRelated.length) await db.payment_accounts.bulkPut(originalRelated)
        })
      }
    : undefined

  // For removals, let the server-side pool guard accept the account change
  // before synchronizing any related primary/default updates. A raced pool
  // creation is surfaced and the optimistic local row is restored.
  const savedAccount = rollbackAccountRemoval
    ? await persist('payment_accounts', account, existing ? 'update' : 'create', {
        rollbackOnCapitalPoolUse: rollbackAccountRemoval
      })
    : await persist('payment_accounts', account, existing ? 'update' : 'create')
  for (const related of relatedUpdates) await persist('payment_accounts', related, 'update')

  if (openingBalances.length) {
    const { appendPaymentTransaction } = await import('./payments')
    for (const openingBalance of openingBalances) {
      await appendPaymentTransaction(workspaceId, {
        sourceModule: 'payments',
        sourceType: 'payment_account_opening_balance',
        sourceRecordId: savedAccount.id,
        direction: 'incoming',
        amount: openingBalance.amount,
        currency: openingBalance.currency,
        paymentMethod: 'unknown',
        paidAt: now,
        createdBy: input.createdBy ?? null,
        accountId: savedAccount.id,
        accountNameSnapshot: savedAccount.name,
        metadata: { paymentAccountOpeningBalance: true }
      })
    }
  }

  return savedAccount
}

/** Soft-delete an account while preserving its historic movements and payment snapshots. */
export async function deletePaymentAccount(workspaceId: string, accountId: string) {
  const account = await db.payment_accounts.get(accountId)
  if (!account || account.workspaceId !== workspaceId || account.isDeleted) {
    throw new Error('Payment account was not found.')
  }

  await assertPaymentAccountNotInCapitalPool(workspaceId, accountId)

  const now = new Date().toISOString()
  const activeRemaining = (await db.payment_accounts.where('workspaceId').equals(workspaceId).toArray())
    .filter((item) => !item.isDeleted && item.isActive && item.id !== accountId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
  const existingPrimary = activeRemaining.find((item) => item.isPrimary)
  const accountActsAsPrimary =
    account.isPrimary ||
    (!existingPrimary &&
      [account, ...activeRemaining].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name)
      )[0]?.id === account.id)
  const fallbackPrimary = accountActsAsPrimary && !existingPrimary ? activeRemaining[0] : undefined
  const deleted: PaymentAccount = {
    ...account,
    isActive: false,
    isPrimary: false,
    isDefaultForPaymentSelector: false,
    isDeleted: true,
    updatedAt: now,
    version: account.version + 1,
    ...syncMeta(workspaceId, now)
  }
  const promoted = fallbackPrimary
    ? {
        ...fallbackPrimary,
        isPrimary: true,
        updatedAt: now,
        version: fallbackPrimary.version + 1,
        ...syncMeta(workspaceId, now)
      }
    : undefined

  await db.transaction('rw', db.payment_accounts, async () => {
    await db.payment_accounts.put(deleted)
    if (promoted) await db.payment_accounts.put(promoted)
  })
  await persist('payment_accounts', deleted, 'update', {
    rollbackOnCapitalPoolUse: async () => {
      await db.transaction('rw', db.payment_accounts, async () => {
        await db.payment_accounts.put(account)
        if (fallbackPrimary) await db.payment_accounts.put(fallbackPrimary)
      })
    }
  })
  if (promoted) await persist('payment_accounts', promoted, 'update')
  return { deleted, fallbackPrimary: promoted ?? null }
}

export function getPaymentAccountBalanceSummary(balances: PaymentAccountBalance[], accountId: string) {
  return balances
    .filter((balance) => balance.accountId === accountId && !balance.isDeleted)
    .sort((a, b) => a.currency.localeCompare(b.currency))
}

export interface RecordPaymentAccountManualOperationInput {
  accountId: string
  kind: PaymentAccountManualOperationKind
  currency: CurrencyCode
  amount: number
  /** Adjustments choose the direction from the counted-versus-posted difference. */
  direction?: PaymentTransactionDirection
  paymentMethod?: WorkspacePaymentMethod
  occurredAt?: string
  reason: string
  notes?: string | null
  createdBy?: string | null
  /** Deposit and withdrawal need an authorized payment-account operator. */
  canPost: boolean
  /** A balance adjustment is intentionally restricted to administrators. */
  isAdmin: boolean
  adjustmentReason?: PaymentAccountAdjustmentReason
  previousBalance?: number
  countedBalance?: number
}

/**
 * Record a real deposit, withdrawal, or audited reconciliation adjustment.
 *
 * This deliberately only appends an authoritative payment transaction. The
 * payment-account movement and balance are then derived by the normal local
 * mirror or the cloud database trigger; callers must never write either table
 * directly.
 */
export async function recordPaymentAccountManualOperation(
  workspaceId: string,
  input: RecordPaymentAccountManualOperationInput
) {
  if (!input.canPost) throw new Error('You are not allowed to post payment-account movements.')
  if (input.kind === 'adjustment' && !input.isAdmin) {
    throw new Error('Only administrators can post a payment-account balance adjustment.')
  }

  const account = await db.payment_accounts.get(input.accountId)
  if (!account || account.workspaceId !== workspaceId || account.isDeleted || !account.isActive) {
    throw new Error('The selected payment account is unavailable.')
  }

  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Enter a positive amount.')
  }
  const reason = input.reason.trim()
  if (!reason) throw new Error('Enter a reason for this account movement.')

  const existingBalance = await db.payment_account_balances
    .where('[accountId+currency]')
    .equals([account.id, input.currency])
    .first()
  const currentBalance = Number(existingBalance?.balanceAmount || 0)

  let direction: PaymentTransactionDirection
  if (input.kind === 'deposit') {
    direction = 'incoming'
  } else if (input.kind === 'withdrawal') {
    direction = 'outgoing'
  } else {
    if (input.direction !== 'incoming' && input.direction !== 'outgoing') {
      throw new Error('A balance adjustment must specify its direction.')
    }
    direction = input.direction
    const countedBalance = Number(input.countedBalance)
    const previousBalance = Number(input.previousBalance)
    if (!Number.isFinite(countedBalance) || countedBalance < 0 || !Number.isFinite(previousBalance)) {
      throw new Error('Enter a valid counted balance for the adjustment.')
    }
    if (Math.abs(previousBalance - currentBalance) > 0.000001) {
      throw new Error(
        'This account changed while you were preparing the adjustment. Review the current posted balance and try again.'
      )
    }
    const expectedDelta = countedBalance - currentBalance
    if (Math.abs(expectedDelta) <= 0.000001 || Math.abs(Math.abs(expectedDelta) - amount) > 0.000001) {
      throw new Error(
        'The adjustment amount must exactly match the difference between the counted and posted balances.'
      )
    }
    if ((expectedDelta > 0 && direction !== 'incoming') || (expectedDelta < 0 && direction !== 'outgoing')) {
      throw new Error('The adjustment direction does not match the counted balance.')
    }
  }

  if (input.kind === 'withdrawal' && currentBalance - amount < -PAYMENT_ACCOUNT_BALANCE_EPSILON) {
    throw new Error(getLocalizedInsufficientFundsMessage(currentBalance, input.currency, null, 'withdrawal'))
  }

  const operationId = generateId()
  const { appendPaymentTransaction } = await import('./payments')
  return appendPaymentTransaction(workspaceId, {
    id: operationId,
    idempotent: true,
    sourceModule: 'payment_accounts',
    sourceType: `payment_account_${input.kind}` as PaymentTransaction['sourceType'],
    sourceRecordId: operationId,
    direction,
    amount,
    currency: input.currency,
    paymentMethod: input.kind === 'adjustment' ? 'unknown' : (input.paymentMethod ?? 'cash'),
    paidAt: input.occurredAt ?? new Date().toISOString(),
    referenceLabel: reason,
    note: input.notes?.trim() || null,
    createdBy: input.createdBy ?? null,
    accountId: account.id,
    accountNameSnapshot: account.name,
    metadata: {
      paymentAccountOperation: input.kind,
      ...(input.kind === 'adjustment'
        ? {
            adjustmentReason: input.adjustmentReason ?? 'other',
            previousBalance: currentBalance,
            countedBalance: Number(input.countedBalance),
            adjustmentAmount: direction === 'incoming' ? amount : -amount
          }
        : {})
    }
  })
}

export interface CreateCashierShiftInput {
  account: PaymentAccount
  cashierUserId: string
  cashierName: string
}

/**
 * V1 cashier shifts are drawer-to-member assignments. Cash counts and
 * reconciliation are intentionally outside this workflow.
 */
export async function createCashierShift(workspaceId: string, input: CreateCashierShiftInput) {
  if (
    input.account.workspaceId !== workspaceId ||
    input.account.accountType !== 'cash_drawer' ||
    !input.account.isActive ||
    input.account.isDeleted
  ) {
    throw new Error('Select an active cash drawer from this workspace.')
  }
  if (!input.cashierUserId || !input.cashierName.trim()) {
    throw new Error('Select a workspace member for this cashier shift.')
  }

  const [cashierUser, cashierProfile] = await Promise.all([
    db.users.get(input.cashierUserId),
    db.profiles.get(input.cashierUserId)
  ])
  const isWorkspaceMember =
    (!cashierUser?.isDeleted && cashierUser?.workspaceId === workspaceId) || cashierProfile?.workspaceId === workspaceId
  if (!isWorkspaceMember) {
    throw new Error('Select a workspace member for this cashier shift.')
  }

  const existingAssignment = await db.cashier_shifts
    .where('[accountId+cashierUserId]')
    .equals([input.account.id, input.cashierUserId])
    .filter((shift) => shift.workspaceId === workspaceId && !shift.isDeleted && shift.status === 'open')
    .first()
  if (existingAssignment) {
    throw new Error('This workspace member already has an active shift for the selected cash drawer.')
  }

  const now = new Date().toISOString()
  const shift: CashierShift = {
    id: generateId(),
    workspaceId,
    accountId: input.account.id,
    accountNameSnapshot: input.account.name,
    cashierUserId: input.cashierUserId,
    cashierNameSnapshot: input.cashierName.trim(),
    status: 'open',
    openedAt: now,
    closedAt: null,
    closedBy: null,
    openingNote: null,
    closingNote: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    ...syncMeta(workspaceId, now)
  }

  return persist('cashier_shifts', shift)
}

function timeToMinutes(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function dateAtLocalTime(date: Date, time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  const next = new Date(date)
  next.setHours(hours, minutes, 0, 0)
  return next
}

export function getCashierShiftOccurrenceBounds(
  assignment: Pick<CashierShiftAssignment, 'startTime' | 'endTime'>,
  date: Date
) {
  if (!assignment.startTime || !assignment.endTime) return null
  const start = dateAtLocalTime(date, assignment.startTime)
  const end = dateAtLocalTime(date, assignment.endTime)
  const startMinutes = timeToMinutes(assignment.startTime)
  const endMinutes = timeToMinutes(assignment.endTime)
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return null
  if (endMinutes <= startMinutes) end.setDate(end.getDate() + 1)
  return { start, end, overnight: endMinutes <= startMinutes }
}

export function isCashierShiftWorkingDay(assignment: Pick<CashierShiftAssignment, 'workingDays'>, date: Date) {
  return assignment.workingDays?.includes(date.getDay()) ?? false
}

export type CashierShiftListStatus = 'available' | CashierShiftOccurrence['status']

/** A persisted occurrence or the one shift that the cashier can start right now. */
export interface CashierShiftListRow {
  key: string
  /** Only required for a not-yet-started, currently available schedule row. */
  assignment?: CashierShiftAssignment
  occurrence?: CashierShiftOccurrence
  scheduledStartAt: string
  scheduledEndAt: string
  assignmentMode: CashierShiftAssignmentMode
  status: CashierShiftListStatus
}

function cashierShiftOccurrenceListStatus(occurrence: CashierShiftOccurrence): CashierShiftOccurrence['status'] {
  return occurrence.status
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function cashierShiftOccurrenceKey(assignmentId: string, scheduledStartAt: string) {
  const scheduledStart = new Date(scheduledStartAt)
  const normalizedStartAt = Number.isNaN(scheduledStart.getTime()) ? scheduledStartAt : scheduledStart.toISOString()
  return `${assignmentId}:${normalizedStartAt}`
}

/**
 * Produces the cashier's real shift history and any currently startable shift.
 * Recurring schedules deliberately do not become speculative past or future
 * rows, as those are not shift occurrences until the cashier starts one.
 */
export function getCashierShiftListRows(input: {
  assignments: CashierShiftAssignment[]
  occurrences: CashierShiftOccurrence[]
  cashierUserId?: string
  now: Date
}): CashierShiftListRow[] {
  if (!input.cashierUserId) return []

  const assignmentById = new Map(
    input.assignments
      .filter((assignment) => assignment.cashierUserId === input.cashierUserId && !assignment.isDeleted)
      .map((assignment) => [assignment.id, assignment])
  )
  const rows = new Map<string, CashierShiftListRow>()

  for (const occurrence of input.occurrences) {
    if (occurrence.cashierUserId !== input.cashierUserId || occurrence.isDeleted) continue
    const assignment = assignmentById.get(occurrence.assignmentId)
    const displayStartAt = occurrence.scheduledStartAt ?? occurrence.startedAt
    const key = occurrence.scheduledStartAt
      ? cashierShiftOccurrenceKey(occurrence.assignmentId, occurrence.scheduledStartAt)
      : `occurrence:${occurrence.id}`
    rows.set(key, {
      key,
      assignment,
      occurrence,
      scheduledStartAt: displayStartAt,
      scheduledEndAt: occurrence.scheduledEndAt ?? occurrence.startedAt,
      assignmentMode: getCashierShiftAssignmentMode(occurrence),
      status: cashierShiftOccurrenceListStatus(occurrence)
    })
  }

  const today = startOfLocalDay(input.now)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const hasGlobalActiveOccurrence = input.occurrences.some(
    (occurrence) =>
      occurrence.cashierUserId === input.cashierUserId &&
      !occurrence.isDeleted &&
      isActiveCashierShiftOccurrence(occurrence)
  )

  for (const assignment of assignmentById.values()) {
    if (!assignment.isActive) continue
    // A cashier has one active occurrence across every mode. Preserve the
    // real occurrence row above, but do not advertise another start target.
    if (hasGlobalActiveOccurrence) continue
    const assignmentMode = getCashierShiftAssignmentMode(assignment)
    if (assignmentMode === 'login_logout') continue
    if (assignmentMode === 'manual') {
      if (!isCashierShiftWorkingDay(assignment, today)) continue
      const key = `manual:${assignment.id}:${today.toDateString()}`
      if (!rows.has(key)) {
        rows.set(key, {
          key,
          assignment,
          // These are display fields only. Manual occurrences themselves never
          // persist a synthetic schedule.
          scheduledStartAt: input.now.toISOString(),
          scheduledEndAt: input.now.toISOString(),
          assignmentMode,
          status: 'available'
        })
      }
      continue
    }
    for (const date of [today, yesterday]) {
      if (!isCashierShiftWorkingDay(assignment, date)) continue
      const bounds = getCashierShiftOccurrenceBounds(assignment, date)
      if (!bounds || input.now < bounds.start || input.now >= bounds.end) continue
      const scheduledStartAt = bounds.start.toISOString()
      const key = cashierShiftOccurrenceKey(assignment.id, scheduledStartAt)
      if (rows.has(key)) continue
      rows.set(key, {
        key,
        assignment,
        scheduledStartAt,
        scheduledEndAt: bounds.end.toISOString(),
        assignmentMode,
        status: 'available'
      })
    }
  }

  const priority: Record<CashierShiftListStatus, number> = {
    active: 0,
    paused: 1,
    available: 2,
    completed: 3,
    terminated: 4
  }
  return [...rows.values()].sort(
    (left, right) =>
      priority[left.status] - priority[right.status] ||
      new Date(left.scheduledStartAt).getTime() - new Date(right.scheduledStartAt).getTime()
  )
}

/** Real occurrences for administrators. Deliberately never expands recurring schedules. */
export function getCashierShiftTeamRows(input: {
  assignments: CashierShiftAssignment[]
  occurrences: CashierShiftOccurrence[]
}): CashierShiftListRow[] {
  const assignmentsById = new Map(input.assignments.map((assignment) => [assignment.id, assignment]))
  const priority: Record<CashierShiftListStatus, number> = {
    active: 0,
    paused: 1,
    completed: 2,
    terminated: 3,
    available: 4
  }
  return input.occurrences
    .filter((occurrence) => !occurrence.isDeleted)
    .map((occurrence) => ({
      key: occurrence.scheduledStartAt
        ? cashierShiftOccurrenceKey(occurrence.assignmentId, occurrence.scheduledStartAt)
        : `occurrence:${occurrence.id}`,
      assignment: assignmentsById.get(occurrence.assignmentId),
      occurrence,
      scheduledStartAt: occurrence.scheduledStartAt ?? occurrence.startedAt,
      scheduledEndAt: occurrence.scheduledEndAt ?? occurrence.startedAt,
      assignmentMode: getCashierShiftAssignmentMode(occurrence),
      status: cashierShiftOccurrenceListStatus(occurrence)
    }))
    .sort(
      (left, right) =>
        priority[left.status] - priority[right.status] ||
        new Date(right.scheduledStartAt).getTime() - new Date(left.scheduledStartAt).getTime()
    )
}

export interface CreateCashierShiftTemplateInput {
  name: string
  startTime: string
  endTime: string
}

export async function createCashierShiftTemplate(workspaceId: string, input: CreateCashierShiftTemplateInput) {
  const name = input.name.trim()
  const startMinutes = timeToMinutes(input.startTime)
  const endMinutes = timeToMinutes(input.endTime)
  if (!name) throw new Error('Enter a shift name.')
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) {
    throw new Error('Enter different valid start and end times.')
  }

  const now = new Date().toISOString()
  const template: CashierShiftTemplate = {
    id: generateId(),
    workspaceId,
    name,
    startTime: input.startTime,
    endTime: input.endTime,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    ...syncMeta(workspaceId, now)
  }
  return persist('cashier_shift_templates', template)
}

export interface CreateCashierShiftAssignmentInput {
  account: PaymentAccount
  cashierUserId: string
  cashierName: string
  assignmentMode?: CashierShiftAssignmentMode
  template?: CashierShiftTemplate | null
  startTime?: string | null
  endTime?: string | null
  workingDays?: number[]
  earlyFinishPolicy?: CashierShiftEarlyFinishPolicy
  earlyFinishOffsetMinutes?: number | null
}

interface ValidatedCashierShiftAssignmentInput {
  assignmentMode: CashierShiftAssignmentMode
  earlyFinishPolicy: CashierShiftEarlyFinishPolicy | null
  earlyFinishOffsetMinutes: number | null
  workingDays: number[] | null
  startTime: string | null
  endTime: string | null
  template: CashierShiftTemplate | null
}

async function validateCashierShiftAssignmentInput(
  workspaceId: string,
  input: CreateCashierShiftAssignmentInput
): Promise<ValidatedCashierShiftAssignmentInput> {
  const assignmentMode = input.assignmentMode ?? 'scheduled'
  if (!CASHIER_SHIFT_ASSIGNMENT_MODES.includes(assignmentMode)) {
    throw new Error(i18n.t('paymentAccounts.errors.assignmentModeInvalid'))
  }
  if (
    input.account.workspaceId !== workspaceId ||
    input.account.accountType !== 'cash_drawer' ||
    !input.account.isActive ||
    input.account.isDeleted
  ) {
    throw new Error('Select an active cash drawer from this workspace.')
  }
  if (!input.cashierUserId || !input.cashierName.trim()) {
    throw new Error('Select a workspace member for this cashier shift.')
  }
  const workingDays = [...new Set(input.workingDays ?? [])].sort((left, right) => left - right)
  if (workingDays.some((day) => day < 0 || day > 6 || !Number.isInteger(day))) {
    throw new Error('Select valid working days.')
  }
  if (
    input.template &&
    (input.template.workspaceId !== workspaceId || input.template.isDeleted || !input.template.isActive)
  ) {
    throw new Error('Select an active shift template from this workspace.')
  }

  const [cashierUser, cashierProfile] = await Promise.all([
    db.users.get(input.cashierUserId),
    db.profiles.get(input.cashierUserId)
  ])
  const isWorkspaceMember =
    (!cashierUser?.isDeleted && cashierUser?.workspaceId === workspaceId) || cashierProfile?.workspaceId === workspaceId
  if (!isWorkspaceMember) throw new Error('Select a workspace member for this cashier shift.')

  if (assignmentMode === 'login_logout') {
    if (
      input.template ||
      input.startTime ||
      input.endTime ||
      workingDays.length ||
      input.earlyFinishPolicy ||
      input.earlyFinishOffsetMinutes != null
    ) {
      throw new Error(i18n.t('paymentAccounts.errors.loginLogoutAssignmentMustBeUnscheduled'))
    }
    return {
      assignmentMode,
      earlyFinishPolicy: null,
      earlyFinishOffsetMinutes: null,
      workingDays: null,
      startTime: null,
      endTime: null,
      template: null
    }
  }

  if (assignmentMode === 'manual') {
    if (
      input.template ||
      input.startTime ||
      input.endTime ||
      input.earlyFinishPolicy ||
      input.earlyFinishOffsetMinutes != null
    ) {
      throw new Error(i18n.t('paymentAccounts.errors.manualAssignmentMustBeUnscheduled'))
    }
    if (!workingDays.length) throw new Error('Select at least one working day.')
    return {
      assignmentMode,
      earlyFinishPolicy: null,
      earlyFinishOffsetMinutes: null,
      workingDays,
      startTime: null,
      endTime: null,
      template: null
    }
  }

  const startMinutes = timeToMinutes(input.startTime ?? '')
  const endMinutes = timeToMinutes(input.endTime ?? '')
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) {
    throw new Error('Enter different valid start and end times.')
  }
  const earlyFinishPolicy = input.earlyFinishPolicy ?? 'scheduled_end'
  if (!CASHIER_SHIFT_EARLY_FINISH_POLICIES.includes(earlyFinishPolicy)) {
    throw new Error(i18n.t('paymentAccounts.errors.earlyFinishPolicyInvalid'))
  }
  const shiftDurationMinutes = endMinutes - startMinutes + (endMinutes <= startMinutes ? 1_440 : 0)
  const earlyFinishOffsetMinutes =
    input.earlyFinishOffsetMinutes == null ? null : Number(input.earlyFinishOffsetMinutes)
  if (earlyFinishPolicy === 'time_before_end') {
    if (
      earlyFinishOffsetMinutes === null ||
      !Number.isInteger(earlyFinishOffsetMinutes) ||
      earlyFinishOffsetMinutes <= 0 ||
      earlyFinishOffsetMinutes >= shiftDurationMinutes
    ) {
      throw new Error(i18n.t('paymentAccounts.errors.earlyFinishOffsetInvalid'))
    }
  } else if (earlyFinishOffsetMinutes !== null) {
    throw new Error(i18n.t('paymentAccounts.errors.earlyFinishOffsetOnlyForTimedRule'))
  }
  if (!workingDays.length) throw new Error('Select at least one working day.')
  return {
    assignmentMode,
    earlyFinishPolicy,
    earlyFinishOffsetMinutes,
    workingDays,
    startTime: input.startTime!,
    endTime: input.endTime!,
    template: input.template ?? null
  }
}

function scheduledAssignmentsOverlap(
  left: Pick<CashierShiftAssignment, 'startTime' | 'endTime' | 'workingDays'>,
  right: Pick<CashierShiftAssignment, 'startTime' | 'endTime' | 'workingDays'>
) {
  if (!left.startTime || !left.endTime || !right.startTime || !right.endTime) return false
  const leftStartMinutes = timeToMinutes(left.startTime)
  const leftEndMinutes = timeToMinutes(left.endTime)
  const rightStartMinutes = timeToMinutes(right.startTime)
  const rightEndMinutes = timeToMinutes(right.endTime)
  if (leftStartMinutes === null || leftEndMinutes === null || rightStartMinutes === null || rightEndMinutes === null)
    return false

  const intervals = (days: number[] | null | undefined, start: number, end: number) =>
    (days ?? []).map((day) => {
      const intervalStart = day * 1_440 + start
      return {
        start: intervalStart,
        end: intervalStart + end - start + (end <= start ? 1_440 : 0)
      }
    })
  const leftIntervals = intervals(left.workingDays, leftStartMinutes, leftEndMinutes)
  const rightIntervals = intervals(right.workingDays, rightStartMinutes, rightEndMinutes)
  return leftIntervals.some((leftInterval) =>
    rightIntervals.some((rightInterval) =>
      [-10_080, 0, 10_080].some(
        (weekOffset) =>
          leftInterval.start < rightInterval.end + weekOffset && rightInterval.start + weekOffset < leftInterval.end
      )
    )
  )
}

/** Reject ambiguous enabled assignments before they reach a device or the server. */
async function assertCashierShiftAssignmentConfiguration(
  workspaceId: string,
  candidate: Pick<
    CashierShiftAssignment,
    'id' | 'cashierUserId' | 'assignmentMode' | 'startTime' | 'endTime' | 'workingDays' | 'isActive' | 'isDeleted'
  >
) {
  if (!candidate.isActive || candidate.isDeleted) return
  const existing = await db.cashier_shift_assignments
    .where('[workspaceId+cashierUserId]')
    .equals([workspaceId, candidate.cashierUserId])
    .toArray()
  const candidateMode = getCashierShiftAssignmentMode(candidate)
  for (const assignment of existing) {
    if (assignment.id === candidate.id || assignment.isDeleted || !assignment.isActive) continue
    const existingMode = getCashierShiftAssignmentMode(assignment)
    if (candidateMode !== 'scheduled' && existingMode !== 'scheduled') {
      throw new Error(i18n.t('paymentAccounts.errors.unscheduledAssignmentConflict'))
    }
    if (
      candidateMode === 'scheduled' &&
      existingMode === 'scheduled' &&
      scheduledAssignmentsOverlap(candidate, assignment)
    ) {
      throw new Error(i18n.t('paymentAccounts.errors.scheduledAssignmentConflict'))
    }
  }
}

export async function isCashierShiftAssignmentLocked(workspaceId: string, assignmentId: string) {
  const occurrence = await db.cashier_shift_occurrences
    .where('assignmentId')
    .equals(assignmentId)
    .and((candidate) => candidate.workspaceId === workspaceId && isActiveCashierShiftOccurrence(candidate))
    .first()
  return Boolean(occurrence)
}

/** The auth layer uses this narrow lookup so unrelated users are never gated. */
export async function getCashierLoginLogoutShiftState(workspaceId: string, cashierUserId: string) {
  const [assignments, occurrences] = await Promise.all([
    db.cashier_shift_assignments.where('[workspaceId+cashierUserId]').equals([workspaceId, cashierUserId]).toArray(),
    db.cashier_shift_occurrences.where('[workspaceId+cashierUserId]').equals([workspaceId, cashierUserId]).toArray()
  ])
  const assignment =
    assignments.find(
      (candidate) =>
        !candidate.isDeleted && candidate.isActive && getCashierShiftAssignmentMode(candidate) === 'login_logout'
    ) ?? null
  if (!assignment) return { assignment: null, activeOccurrence: null }
  const activeOccurrence =
    occurrences.find(
      (candidate) => candidate.assignmentId === assignment.id && isActiveCashierShiftOccurrence(candidate)
    ) ?? null
  return { assignment, activeOccurrence }
}

async function assertCashierShiftAssignmentUnlocked(workspaceId: string, assignmentId: string) {
  if (await isCashierShiftAssignmentLocked(workspaceId, assignmentId)) {
    throw new Error(i18n.t('paymentAccounts.errors.cashierShiftAssignmentLocked'))
  }
}

export async function createCashierShiftAssignment(workspaceId: string, input: CreateCashierShiftAssignmentInput) {
  const validated = await validateCashierShiftAssignmentInput(workspaceId, input)

  const now = new Date().toISOString()
  const assignment: CashierShiftAssignment = {
    id: generateId(),
    workspaceId,
    assignmentMode: validated.assignmentMode,
    templateId: validated.template?.id ?? null,
    templateNameSnapshot: validated.template?.name ?? null,
    accountId: input.account.id,
    accountNameSnapshot: input.account.name,
    cashierUserId: input.cashierUserId,
    cashierNameSnapshot: input.cashierName.trim(),
    startTime: validated.startTime,
    endTime: validated.endTime,
    workingDays: validated.workingDays,
    earlyFinishPolicy: validated.earlyFinishPolicy,
    earlyFinishOffsetMinutes:
      validated.earlyFinishPolicy === 'time_before_end' ? validated.earlyFinishOffsetMinutes : null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    ...syncMeta(workspaceId, now)
  }
  await assertCashierShiftAssignmentConfiguration(workspaceId, assignment)
  return persist('cashier_shift_assignments', assignment)
}

/** Updates the recurring schedule only. Existing occurrences retain their immutable snapshots. */
export async function updateCashierShiftAssignment(
  workspaceId: string,
  assignmentId: string,
  input: CreateCashierShiftAssignmentInput
) {
  const existing = await db.cashier_shift_assignments.get(assignmentId)
  if (!existing || existing.workspaceId !== workspaceId || existing.isDeleted) {
    throw new Error(i18n.t('paymentAccounts.errors.cashierShiftAssignmentUnavailable'))
  }
  await assertCashierShiftAssignmentUnlocked(workspaceId, assignmentId)
  const validated = await validateCashierShiftAssignmentInput(workspaceId, input)
  const now = new Date().toISOString()
  const assignment: CashierShiftAssignment = {
    ...existing,
    assignmentMode: validated.assignmentMode,
    templateId: validated.template?.id ?? null,
    templateNameSnapshot: validated.template?.name ?? null,
    accountId: input.account.id,
    accountNameSnapshot: input.account.name,
    cashierUserId: input.cashierUserId,
    cashierNameSnapshot: input.cashierName.trim(),
    startTime: validated.startTime,
    endTime: validated.endTime,
    workingDays: validated.workingDays,
    earlyFinishPolicy: validated.earlyFinishPolicy,
    earlyFinishOffsetMinutes:
      validated.earlyFinishPolicy === 'time_before_end' ? validated.earlyFinishOffsetMinutes : null,
    updatedAt: now,
    version: existing.version + 1,
    ...syncMeta(workspaceId, now)
  }
  await assertCashierShiftAssignmentConfiguration(workspaceId, assignment)
  return persist('cashier_shift_assignments', assignment, 'update')
}

export interface StartCashierShiftOccurrenceInput {
  assignmentId: string
  cashierUserId: string
  /** Required only for scheduled assignments and calculated in the current device's local time. */
  scheduledStartAt?: string
  /** Login/logout assignments can only be started by the explicit auth gate. */
  source?: 'scheduled' | 'manual' | 'login'
}

export async function startCashierShiftOccurrence(workspaceId: string, input: StartCashierShiftOccurrenceInput) {
  const assignment = await db.cashier_shift_assignments.get(input.assignmentId)
  if (!assignment || assignment.workspaceId !== workspaceId || assignment.isDeleted || !assignment.isActive) {
    throw new Error('This shift assignment is no longer available.')
  }
  if (assignment.cashierUserId !== input.cashierUserId) {
    throw new Error('Only the assigned cashier can start this shift.')
  }
  const assignmentMode = getCashierShiftAssignmentMode(assignment)
  const now = new Date()
  let scheduledStartAt: string | null = null
  let scheduledEndAt: string | null = null
  if (assignmentMode === 'scheduled') {
    if (input.source && input.source !== 'scheduled')
      throw new Error(i18n.t('paymentAccounts.errors.shiftStartModeMismatch'))
    if (!input.scheduledStartAt) throw new Error('This shift occurrence requires its scheduled start time.')
    const scheduledDate = new Date(input.scheduledStartAt)
    const bounds = getCashierShiftOccurrenceBounds(assignment, scheduledDate)
    if (!bounds || !isCashierShiftWorkingDay(assignment, bounds.start)) {
      throw new Error('This shift is not scheduled for that day.')
    }
    if (bounds.start.toISOString() !== input.scheduledStartAt) {
      throw new Error('The shift occurrence no longer matches its assigned schedule.')
    }
    if (now < bounds.start || now >= bounds.end) {
      throw new Error('This shift can only be started during its scheduled time.')
    }
    scheduledStartAt = bounds.start.toISOString()
    scheduledEndAt = bounds.end.toISOString()
  } else if (assignmentMode === 'manual') {
    if (input.source === 'login') throw new Error(i18n.t('paymentAccounts.errors.shiftStartModeMismatch'))
    if (!isCashierShiftWorkingDay(assignment, now)) {
      throw new Error(i18n.t('paymentAccounts.errors.manualShiftNotWorkingDay'))
    }
  } else if (input.source !== 'login') {
    throw new Error(i18n.t('paymentAccounts.errors.loginLogoutShiftRequiresLogin'))
  }

  // Cloud and Hybrid starts must never be queued. The database claim owns the
  // cross-device race; Local Mode owns the equivalent IndexedDB/SQLite claim.
  if (cloudWorkspace(workspaceId) && !isOnline()) {
    throw new Error(i18n.t('paymentAccounts.errors.onlineShiftStartRequired'))
  }

  const createdAt = now.toISOString()
  const occurrence: CashierShiftOccurrence = {
    id: generateId(),
    workspaceId,
    assignmentId: assignment.id,
    assignmentMode,
    templateId: assignment.templateId ?? null,
    templateNameSnapshot: assignment.templateNameSnapshot ?? null,
    accountId: assignment.accountId,
    accountNameSnapshot: assignment.accountNameSnapshot,
    cashierUserId: assignment.cashierUserId,
    cashierNameSnapshot: assignment.cashierNameSnapshot,
    scheduledStartAt,
    scheduledEndAt,
    startedAt: createdAt,
    earlyFinishPolicy: assignmentMode === 'scheduled' ? getEarlyFinishPolicy(assignment) : null,
    earlyFinishOffsetMinutes:
      assignmentMode === 'scheduled' && assignment.earlyFinishPolicy === 'time_before_end'
        ? (assignment.earlyFinishOffsetMinutes ?? null)
        : null,
    earlyFinishRequestStatus: assignmentMode === 'scheduled' ? 'not_requested' : null,
    earlyFinishRequestReason: null,
    earlyFinishRequestedAt: null,
    earlyFinishRequestedBy: null,
    earlyFinishReviewedAt: null,
    earlyFinishReviewedBy: null,
    earlyFinishReviewNote: null,
    status: 'active',
    completedAt: null,
    completedBy: null,
    completionReason: null,
    createdAt,
    updatedAt: createdAt,
    version: 1,
    isDeleted: false,
    ...syncMeta(workspaceId, createdAt)
  }

  // A local claim is atomic in Local Mode. It also preserves the optimistic
  // mirror only after a successful remote claim in Cloud/Hybrid Mode.
  await db.transaction('rw', db.cashier_shift_occurrences, async () => {
    if (assignmentMode === 'scheduled') {
      const existing = await db.cashier_shift_occurrences
        .where('[assignmentId+scheduledStartAt]')
        .equals([assignment.id, scheduledStartAt!])
        .first()
      if (existing && !existing.isDeleted) throw new Error('This shift occurrence has already been started.')
    }

    const activeOccurrence = await db.cashier_shift_occurrences
      .where('[workspaceId+cashierUserId]')
      .equals([workspaceId, input.cashierUserId])
      .and((candidate) => isActiveCashierShiftOccurrence(candidate))
      .first()
    if (activeOccurrence) {
      throw new Error(i18n.t('paymentAccounts.activeShiftMustBeCompleted'))
    }
    if (isLocalWorkspaceMode(workspaceId)) await db.cashier_shift_occurrences.put(occurrence)
  })

  if (isLocalWorkspaceMode(workspaceId)) {
    return persist('cashier_shift_occurrences', occurrence, 'create', {
      localAlreadyPersisted: true
    })
  }

  if (assignmentMode === 'login_logout') {
    const pendingClosure = await db.cashier_shift_occurrences
      .where('[workspaceId+cashierUserId]')
      .equals([workspaceId, input.cashierUserId])
      .and(
        (candidate) =>
          !candidate.isDeleted &&
          getCashierShiftAssignmentMode(candidate) === 'login_logout' &&
          candidate.status === 'completed' &&
          candidate.syncStatus !== 'synced'
      )
      .first()
    if (pendingClosure) throw new Error(i18n.t('paymentAccounts.errors.loginLogoutClosureSyncPending'))
  }

  const client = getSupabaseClientForTable('cashier_shift_occurrences')
  const { data, error } = await client.rpc('claim_cashier_shift_occurrence', {
    p_occurrence: payload(occurrence as unknown as Record<string, unknown>)
  })
  if (error) {
    if (isRemoteUniqueViolation(error)) throw new Error(i18n.t('paymentAccounts.activeShiftMustBeCompleted'))
    throw error
  }
  const claimed = data
    ? {
        ...(toCamelCase(data as Record<string, unknown>) as unknown as CashierShiftOccurrence),
        syncStatus: 'synced' as const,
        lastSyncedAt: new Date().toISOString()
      }
    : {
        ...occurrence,
        syncStatus: 'synced' as const,
        lastSyncedAt: new Date().toISOString()
      }
  await db.cashier_shift_occurrences.put(claimed)
  return claimed
}

export interface CompleteCashierShiftOccurrenceInput {
  occurrenceId: string
  cashierUserId: string
  reason?: string | null
}

/** Complete a finished occurrence without making any balance or ledger changes. */
export async function completeCashierShiftOccurrence(workspaceId: string, input: CompleteCashierShiftOccurrenceInput) {
  const occurrence = await db.cashier_shift_occurrences.get(input.occurrenceId)
  if (!occurrence || occurrence.workspaceId !== workspaceId || occurrence.isDeleted) {
    throw new Error('This shift occurrence is unavailable.')
  }
  if (occurrence.cashierUserId !== input.cashierUserId) {
    throw new Error('Only the assigned cashier can complete this shift.')
  }
  if (occurrence.status === 'completed') return occurrence
  if (occurrence.status !== 'active') {
    throw new Error(i18n.t('paymentAccounts.errors.shiftUnavailable'))
  }

  const assignmentMode = getCashierShiftAssignmentMode(occurrence)
  if (assignmentMode === 'login_logout' && input.reason !== 'logged_out') {
    throw new Error(i18n.t('paymentAccounts.errors.loginLogoutShiftRequiresLogout'))
  }

  const now = new Date()
  const eligibility = getCashierShiftCompletionEligibility(occurrence, now)
  if (!eligibility.canComplete) {
    if (eligibility.requiresApprovalRequest) {
      throw new Error(i18n.t('paymentAccounts.errors.earlyFinishApprovalRequired'))
    }
    if (occurrence.earlyFinishPolicy === 'time_before_end') {
      throw new Error(i18n.t('paymentAccounts.errors.earlyFinishNotAvailableYet'))
    }
    throw new Error(i18n.t('paymentAccounts.errors.earlyFinishNotAllowed'))
  }

  const completionReason =
    assignmentMode === 'login_logout'
      ? 'logged_out'
      : normalizeCashierShiftReason(input.reason, eligibility.requiresReason)

  const completedAt = now.toISOString()
  const completed: CashierShiftOccurrence = {
    ...occurrence,
    status: 'completed',
    completedAt,
    completedBy: input.cashierUserId,
    completionReason,
    updatedAt: completedAt,
    version: occurrence.version + 1,
    ...syncMeta(workspaceId, completedAt)
  }
  return persist('cashier_shift_occurrences', completed, 'update')
}

export interface RequestCashierShiftEarlyFinishInput {
  occurrenceId: string
  cashierUserId: string
  reason: string
}

/** Submit the single auditable early-finish request allowed for an occurrence. */
export async function requestCashierShiftEarlyFinish(workspaceId: string, input: RequestCashierShiftEarlyFinishInput) {
  const occurrence = await db.cashier_shift_occurrences.get(input.occurrenceId)
  if (!occurrence || occurrence.workspaceId !== workspaceId || occurrence.isDeleted || occurrence.status !== 'active') {
    throw new Error(i18n.t('paymentAccounts.errors.shiftUnavailable'))
  }
  if (occurrence.cashierUserId !== input.cashierUserId) {
    throw new Error(i18n.t('paymentAccounts.errors.onlyAssignedCashierCanRequestEarlyFinish'))
  }
  if (getEarlyFinishPolicy(occurrence) !== 'request_approval') {
    throw new Error(i18n.t('paymentAccounts.errors.earlyFinishRequestNotEnabled'))
  }
  if (getCashierShiftAssignmentMode(occurrence) !== 'scheduled' || !occurrence.scheduledEndAt) {
    throw new Error(i18n.t('paymentAccounts.errors.earlyFinishRequestNotEnabled'))
  }
  if (new Date() >= new Date(occurrence.scheduledEndAt)) {
    throw new Error(i18n.t('paymentAccounts.errors.earlyFinishRequestNoLongerNeeded'))
  }
  if (getEarlyFinishRequestStatus(occurrence) !== 'not_requested') {
    throw new Error(i18n.t('paymentAccounts.errors.earlyFinishRequestAlreadyHandled'))
  }

  const requestedAt = new Date().toISOString()
  const requested: CashierShiftOccurrence = {
    ...occurrence,
    earlyFinishRequestStatus: 'requested',
    earlyFinishRequestReason: normalizeCashierShiftReason(input.reason, true),
    earlyFinishRequestedAt: requestedAt,
    earlyFinishRequestedBy: input.cashierUserId,
    updatedAt: requestedAt,
    version: occurrence.version + 1,
    ...syncMeta(workspaceId, requestedAt)
  }
  return persist('cashier_shift_occurrences', requested, 'update')
}

export interface ReviewCashierShiftEarlyFinishRequestInput {
  occurrenceId: string
  reviewerUserId: string
  decision: 'approved' | 'rejected'
  reviewNote?: string | null
}

/** Record an administrator's decision without completing the cashier's shift. */
export async function reviewCashierShiftEarlyFinishRequest(
  workspaceId: string,
  input: ReviewCashierShiftEarlyFinishRequestInput
) {
  const [occurrence, reviewer, reviewerProfile] = await Promise.all([
    db.cashier_shift_occurrences.get(input.occurrenceId),
    db.users.get(input.reviewerUserId),
    db.profiles.get(input.reviewerUserId)
  ])
  if (!occurrence || occurrence.workspaceId !== workspaceId || occurrence.isDeleted || occurrence.status !== 'active') {
    throw new Error(i18n.t('paymentAccounts.errors.shiftUnavailable'))
  }
  const reviewerIsAdmin =
    (reviewer?.workspaceId === workspaceId && reviewer.role === 'admin') ||
    (reviewerProfile?.workspaceId === workspaceId && reviewerProfile.role === 'admin')
  if (!reviewerIsAdmin) throw new Error(i18n.t('paymentAccounts.errors.earlyFinishAdminRequired'))
  if (
    getEarlyFinishPolicy(occurrence) !== 'request_approval' ||
    getEarlyFinishRequestStatus(occurrence) !== 'requested'
  ) {
    throw new Error(i18n.t('paymentAccounts.errors.earlyFinishRequestNotPending'))
  }

  const reviewedAt = new Date().toISOString()
  const reviewed: CashierShiftOccurrence = {
    ...occurrence,
    earlyFinishRequestStatus: input.decision,
    earlyFinishReviewedAt: reviewedAt,
    earlyFinishReviewedBy: input.reviewerUserId,
    earlyFinishReviewNote: normalizeCashierShiftReason(input.reviewNote, false),
    updatedAt: reviewedAt,
    version: occurrence.version + 1,
    ...syncMeta(workspaceId, reviewedAt)
  }
  return persist('cashier_shift_occurrences', reviewed, 'update')
}

function normalizePauseRequestReason(value: string | null | undefined, required: boolean) {
  const reason = value?.trim() || null
  if (required && !reason) throw new Error(i18n.t('paymentAccounts.errors.pauseReasonRequired'))
  if (reason && reason.length > CASHIER_SHIFT_REASON_MAX_LENGTH) {
    throw new Error(i18n.t('paymentAccounts.errors.pauseReasonTooLong'))
  }
  return reason
}

async function assertCashierShiftAdmin(workspaceId: string, userId: string) {
  const [user, profile] = await Promise.all([db.users.get(userId), db.profiles.get(userId)])
  const isAdmin =
    (user?.workspaceId === workspaceId && user.role === 'admin') ||
    (profile?.workspaceId === workspaceId && profile.role === 'admin')
  if (!isAdmin) throw new Error(i18n.t('paymentAccounts.errors.cashierShiftAdminRequired'))
}

async function getOpenCashierShiftPausePeriod(occurrenceId: string) {
  const periods = await db.cashier_shift_pause_periods.where('occurrenceId').equals(occurrenceId).toArray()
  return periods.find((period) => !period.isDeleted && !period.resumedAt) ?? null
}

async function persistPauseTransition(input: {
  occurrence: CashierShiftOccurrence
  period?: CashierShiftPausePeriod
  request?: CashierShiftPauseRequest
}) {
  if (input.request) {
    await persist('cashier_shift_pause_requests', input.request, 'update', {
      localAlreadyPersisted: true
    })
  }
  if (input.period) {
    await persist('cashier_shift_pause_periods', input.period, input.period.version === 1 ? 'create' : 'update', {
      localAlreadyPersisted: true
    })
  }
  return persist('cashier_shift_occurrences', input.occurrence, 'update', {
    localAlreadyPersisted: true
  })
}

export interface RequestCashierShiftPauseInput {
  occurrenceId: string
  cashierUserId: string
  reason: string
  requestedDurationMinutes?: number | null
  requestedResumeAt?: string | null
}

/** Creates a durable request; it has no operational effect until an administrator approves it. */
export async function requestCashierShiftPause(workspaceId: string, input: RequestCashierShiftPauseInput) {
  const reason = normalizePauseRequestReason(input.reason, true)!
  const requestedDurationMinutes =
    input.requestedDurationMinutes == null ? null : Number(input.requestedDurationMinutes)
  const requestedResumeAt = input.requestedResumeAt ? new Date(input.requestedResumeAt) : null
  const hasDuration = requestedDurationMinutes !== null
  const hasResumeTime = requestedResumeAt !== null
  if (
    hasDuration === hasResumeTime ||
    (hasDuration && (!Number.isInteger(requestedDurationMinutes) || requestedDurationMinutes! <= 0)) ||
    (hasResumeTime && Number.isNaN(requestedResumeAt!.getTime()))
  ) {
    throw new Error(i18n.t('paymentAccounts.errors.pauseTimingRequired'))
  }

  const now = new Date()
  if (requestedResumeAt && requestedResumeAt <= now)
    throw new Error(i18n.t('paymentAccounts.errors.pauseResumeTimeInvalid'))

  const requestedAt = now.toISOString()
  const request: CashierShiftPauseRequest = {
    id: generateId(),
    workspaceId,
    occurrenceId: input.occurrenceId,
    cashierUserId: input.cashierUserId,
    reason,
    requestedDurationMinutes,
    requestedResumeAt: requestedResumeAt?.toISOString() ?? null,
    status: 'pending',
    requestedAt,
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    approvedPausePeriodId: null,
    createdAt: requestedAt,
    updatedAt: requestedAt,
    version: 1,
    isDeleted: false,
    ...syncMeta(workspaceId, requestedAt)
  }

  await db.transaction('rw', db.cashier_shift_occurrences, db.cashier_shift_pause_requests, async () => {
    const occurrence = await db.cashier_shift_occurrences.get(input.occurrenceId)
    if (
      !occurrence ||
      occurrence.workspaceId !== workspaceId ||
      occurrence.isDeleted ||
      occurrence.status !== 'active'
    ) {
      throw new Error(i18n.t('paymentAccounts.errors.shiftUnavailable'))
    }
    if (occurrence.cashierUserId !== input.cashierUserId) {
      throw new Error(i18n.t('paymentAccounts.errors.onlyAssignedCashierCanRequestPause'))
    }
    const pending = await db.cashier_shift_pause_requests
      .where('[occurrenceId+status]')
      .equals([input.occurrenceId, 'pending'])
      .first()
    if (pending && !pending.isDeleted) throw new Error(i18n.t('paymentAccounts.errors.pauseRequestAlreadyPending'))
    await db.cashier_shift_pause_requests.put(request)
  })

  return persist('cashier_shift_pause_requests', request, 'create', {
    localAlreadyPersisted: true
  })
}

export interface ReviewCashierShiftPauseRequestInput {
  requestId: string
  reviewerUserId: string
  decision: 'approved' | 'rejected'
  reviewNote?: string | null
}

/** Approving a request starts the pause in the same local transaction as the review. */
export async function reviewCashierShiftPauseRequest(workspaceId: string, input: ReviewCashierShiftPauseRequestInput) {
  await assertCashierShiftAdmin(workspaceId, input.reviewerUserId)
  const reviewedAt = new Date().toISOString()
  const reviewNote = normalizePauseRequestReason(input.reviewNote, false)
  let occurrenceResult: CashierShiftOccurrence | null = null
  let requestResult: CashierShiftPauseRequest | null = null
  let periodResult: CashierShiftPausePeriod | undefined

  await db.transaction(
    'rw',
    db.cashier_shift_occurrences,
    db.cashier_shift_pause_requests,
    db.cashier_shift_pause_periods,
    async () => {
      const request = await db.cashier_shift_pause_requests.get(input.requestId)
      if (!request || request.workspaceId !== workspaceId || request.isDeleted || request.status !== 'pending') {
        throw new Error(i18n.t('paymentAccounts.errors.pauseRequestNotPending'))
      }
      const occurrence = await db.cashier_shift_occurrences.get(request.occurrenceId)
      if (
        !occurrence ||
        occurrence.workspaceId !== workspaceId ||
        occurrence.isDeleted ||
        occurrence.status !== 'active' ||
        occurrence.cashierUserId !== request.cashierUserId
      ) {
        throw new Error(i18n.t('paymentAccounts.errors.shiftUnavailable'))
      }

      const requestUpdate: CashierShiftPauseRequest = {
        ...request,
        status: input.decision,
        reviewedAt,
        reviewedBy: input.reviewerUserId,
        reviewNote,
        updatedAt: reviewedAt,
        version: request.version + 1,
        ...syncMeta(workspaceId, reviewedAt)
      }
      if (input.decision === 'approved') {
        const period: CashierShiftPausePeriod = {
          id: generateId(),
          workspaceId,
          occurrenceId: occurrence.id,
          kind: 'cashier_request',
          startedAt: reviewedAt,
          initiatedBy: input.reviewerUserId,
          note: request.reason,
          pauseRequestId: request.id,
          resumedAt: null,
          resumedBy: null,
          createdAt: reviewedAt,
          updatedAt: reviewedAt,
          version: 1,
          isDeleted: false,
          ...syncMeta(workspaceId, reviewedAt)
        }
        requestUpdate.approvedPausePeriodId = period.id
        const occurrenceUpdate: CashierShiftOccurrence = {
          ...occurrence,
          status: 'paused',
          updatedAt: reviewedAt,
          version: occurrence.version + 1,
          ...syncMeta(workspaceId, reviewedAt)
        }
        await db.cashier_shift_pause_periods.put(period)
        await db.cashier_shift_occurrences.put(occurrenceUpdate)
        occurrenceResult = occurrenceUpdate
        periodResult = period
      } else {
        occurrenceResult = occurrence
      }
      await db.cashier_shift_pause_requests.put(requestUpdate)
      requestResult = requestUpdate
    }
  )

  await persistPauseTransition({
    occurrence: occurrenceResult!,
    request: requestResult!,
    period: periodResult
  })
  return {
    occurrence: occurrenceResult!,
    request: requestResult!,
    period: periodResult ?? null
  }
}

export interface PauseCashierShiftOccurrenceInput {
  occurrenceId: string
  initiatorUserId: string
  kind: Extract<CashierShiftPauseKind, 'admin' | 'emergency'>
  note?: string | null
}

/** Administrator-only direct pause. The kind is retained as audit data. */
export async function pauseCashierShiftOccurrence(workspaceId: string, input: PauseCashierShiftOccurrenceInput) {
  await assertCashierShiftAdmin(workspaceId, input.initiatorUserId)
  const startedAt = new Date().toISOString()
  const note = normalizePauseRequestReason(input.note, false)
  let occurrenceResult: CashierShiftOccurrence | null = null
  let periodResult: CashierShiftPausePeriod | null = null
  await db.transaction('rw', db.cashier_shift_occurrences, db.cashier_shift_pause_periods, async () => {
    const occurrence = await db.cashier_shift_occurrences.get(input.occurrenceId)
    if (
      !occurrence ||
      occurrence.workspaceId !== workspaceId ||
      occurrence.isDeleted ||
      occurrence.status !== 'active'
    ) {
      throw new Error(i18n.t('paymentAccounts.errors.shiftUnavailable'))
    }
    const period: CashierShiftPausePeriod = {
      id: generateId(),
      workspaceId,
      occurrenceId: occurrence.id,
      kind: input.kind,
      startedAt,
      initiatedBy: input.initiatorUserId,
      note,
      pauseRequestId: null,
      resumedAt: null,
      resumedBy: null,
      createdAt: startedAt,
      updatedAt: startedAt,
      version: 1,
      isDeleted: false,
      ...syncMeta(workspaceId, startedAt)
    }
    const occurrenceUpdate: CashierShiftOccurrence = {
      ...occurrence,
      status: 'paused',
      updatedAt: startedAt,
      version: occurrence.version + 1,
      ...syncMeta(workspaceId, startedAt)
    }
    await db.cashier_shift_pause_periods.put(period)
    await db.cashier_shift_occurrences.put(occurrenceUpdate)
    occurrenceResult = occurrenceUpdate
    periodResult = period
  })
  await persistPauseTransition({
    occurrence: occurrenceResult!,
    period: periodResult!
  })
  return { occurrence: occurrenceResult!, period: periodResult! }
}

export interface ResumeCashierShiftOccurrenceInput {
  occurrenceId: string
  resumedByUserId: string
}

export async function resumeCashierShiftOccurrence(workspaceId: string, input: ResumeCashierShiftOccurrenceInput) {
  await assertCashierShiftAdmin(workspaceId, input.resumedByUserId)
  const resumedAt = new Date().toISOString()
  let occurrenceResult: CashierShiftOccurrence | null = null
  let periodResult: CashierShiftPausePeriod | null = null
  await db.transaction('rw', db.cashier_shift_occurrences, db.cashier_shift_pause_periods, async () => {
    const occurrence = await db.cashier_shift_occurrences.get(input.occurrenceId)
    if (
      !occurrence ||
      occurrence.workspaceId !== workspaceId ||
      occurrence.isDeleted ||
      occurrence.status !== 'paused'
    ) {
      throw new Error(i18n.t('paymentAccounts.errors.shiftNotPaused'))
    }
    const openPeriod = await getOpenCashierShiftPausePeriod(occurrence.id)
    if (!openPeriod) throw new Error(i18n.t('paymentAccounts.errors.pausePeriodUnavailable'))
    const periodUpdate: CashierShiftPausePeriod = {
      ...openPeriod,
      resumedAt,
      resumedBy: input.resumedByUserId,
      updatedAt: resumedAt,
      version: openPeriod.version + 1,
      ...syncMeta(workspaceId, resumedAt)
    }
    const occurrenceUpdate: CashierShiftOccurrence = {
      ...occurrence,
      status: 'active',
      updatedAt: resumedAt,
      version: occurrence.version + 1,
      ...syncMeta(workspaceId, resumedAt)
    }
    await db.cashier_shift_pause_periods.put(periodUpdate)
    await db.cashier_shift_occurrences.put(occurrenceUpdate)
    occurrenceResult = occurrenceUpdate
    periodResult = periodUpdate
  })
  await persistPauseTransition({
    occurrence: occurrenceResult!,
    period: periodResult!
  })
  return { occurrence: occurrenceResult!, period: periodResult! }
}

export interface TerminateCashierShiftOccurrenceInput {
  occurrenceId: string
  terminatedByUserId: string
  reason?: string | null
}

/** A terminal administrative close. A live pause interval is closed at the same timestamp. */
export async function terminateCashierShiftOccurrence(
  workspaceId: string,
  input: TerminateCashierShiftOccurrenceInput
) {
  await assertCashierShiftAdmin(workspaceId, input.terminatedByUserId)
  const terminatedAt = new Date().toISOString()
  const terminationReason = normalizePauseRequestReason(input.reason, false)
  let occurrenceResult: CashierShiftOccurrence | null = null
  let periodResult: CashierShiftPausePeriod | undefined
  await db.transaction('rw', db.cashier_shift_occurrences, db.cashier_shift_pause_periods, async () => {
    const occurrence = await db.cashier_shift_occurrences.get(input.occurrenceId)
    if (
      !occurrence ||
      occurrence.workspaceId !== workspaceId ||
      occurrence.isDeleted ||
      (occurrence.status !== 'active' && occurrence.status !== 'paused')
    ) {
      throw new Error(i18n.t('paymentAccounts.errors.shiftCannotBeTerminated'))
    }
    if (occurrence.status === 'paused') {
      const openPeriod = await getOpenCashierShiftPausePeriod(occurrence.id)
      if (!openPeriod) throw new Error(i18n.t('paymentAccounts.errors.pausePeriodUnavailable'))
      const periodUpdate: CashierShiftPausePeriod = {
        ...openPeriod,
        resumedAt: terminatedAt,
        resumedBy: input.terminatedByUserId,
        updatedAt: terminatedAt,
        version: openPeriod.version + 1,
        ...syncMeta(workspaceId, terminatedAt)
      }
      await db.cashier_shift_pause_periods.put(periodUpdate)
      periodResult = periodUpdate
    }
    const occurrenceUpdate: CashierShiftOccurrence = {
      ...occurrence,
      status: 'terminated',
      terminatedAt,
      terminatedBy: input.terminatedByUserId,
      terminationReason,
      updatedAt: terminatedAt,
      version: occurrence.version + 1,
      ...syncMeta(workspaceId, terminatedAt)
    }
    await db.cashier_shift_occurrences.put(occurrenceUpdate)
    occurrenceResult = occurrenceUpdate
  })
  await persistPauseTransition({
    occurrence: occurrenceResult!,
    period: periodResult
  })
  return { occurrence: occurrenceResult!, period: periodResult ?? null }
}

/**
 * Resolves the one occurrence that owns a payment at posting time. This never
 * uses `paidAt`: a backdated payment is still owned by the shift that was
 * actually active when the cashier posted it.
 */
export async function resolveActiveCashierShiftOccurrenceId(
  workspaceId: string,
  input: { cashierUserId?: string | null; accountId?: string | null }
) {
  if (!input.cashierUserId || !input.accountId) return null

  const now = new Date()
  const candidates = await db.cashier_shift_occurrences
    .where('[workspaceId+cashierUserId]')
    .equals([workspaceId, input.cashierUserId])
    .toArray()

  return (
    candidates
      .filter(
        (occurrence) =>
          !occurrence.isDeleted &&
          occurrence.status === 'active' &&
          occurrence.accountId === input.accountId &&
          new Date(occurrence.startedAt) <= now &&
          (getCashierShiftAssignmentMode(occurrence) !== 'scheduled' ||
            !occurrence.scheduledEndAt ||
            now < new Date(occurrence.scheduledEndAt))
      )
      .sort(
        (left, right) =>
          right.startedAt.localeCompare(left.startedAt) ||
          (right.scheduledStartAt ?? right.startedAt).localeCompare(left.scheduledStartAt ?? left.startedAt)
      )[0]?.id ?? null
  )
}

/** The signed effect of a payment transaction on its selected payment account. */
export function getPaymentAccountTransactionDelta(
  transaction: Pick<PaymentTransaction, 'amount' | 'direction' | 'isDeleted' | 'voidId'>
) {
  if (transaction.isDeleted || transaction.voidId) return 0
  const amount = Number(transaction.amount)
  return transaction.direction === 'incoming' ? amount : -amount
}

/**
 * Local mode and queued cloud writes need the same availability decision as the
 * database trigger. Deriving it from payment transactions (rather than the
 * cached balance row) also includes pending work and handles replacements.
 */
export async function assertPaymentAccountTransactionsCanBeAppliedLocally(candidates: PaymentTransaction[]) {
  const accountCandidates = candidates.filter((transaction) => !!transaction.accountId)
  if (!accountCandidates.length) return

  const rowsByWorkspace = new Map<string, PaymentTransaction[]>()
  for (const workspaceId of new Set(accountCandidates.map((transaction) => transaction.workspaceId))) {
    rowsByWorkspace.set(workspaceId, await db.payment_transactions.where('workspaceId').equals(workspaceId).toArray())
  }

  const groupedCandidates = new Map<string, PaymentTransaction[]>()
  for (const transaction of accountCandidates) {
    const key = JSON.stringify([transaction.workspaceId, transaction.accountId, transaction.currency])
    groupedCandidates.set(key, [...(groupedCandidates.get(key) ?? []), transaction])
  }

  for (const group of groupedCandidates.values()) {
    const [transaction] = group
    const account = await db.payment_accounts.get(transaction.accountId!)
    if (!account || account.workspaceId !== transaction.workspaceId || account.isDeleted || !account.isActive) {
      throw new Error('The selected payment account is unavailable.')
    }

    const candidateIds = new Set(group.map((item) => item.id))
    const accountTransactions = (rowsByWorkspace.get(transaction.workspaceId) ?? []).filter(
      (item) => item.accountId === transaction.accountId && item.currency === transaction.currency
    )
    const currentBalance = accountTransactions.reduce(
      (total, item) => total + getPaymentAccountTransactionDelta(item),
      0
    )
    const projectedBalance =
      accountTransactions
        .filter((item) => !candidateIds.has(item.id))
        .reduce((total, item) => total + getPaymentAccountTransactionDelta(item), 0) +
      group.reduce((total, item) => total + getPaymentAccountTransactionDelta(item), 0)

    if (projectedBalance < -PAYMENT_ACCOUNT_BALANCE_EPSILON) {
      throw new Error(getLocalizedInsufficientFundsMessage(currentBalance, transaction.currency, account.name))
    }
  }
}

export async function assertPaymentAccountTransactionCanBeAppliedLocally(transaction: PaymentTransaction) {
  await assertPaymentAccountTransactionsCanBeAppliedLocally([transaction])
}

/**
 * Mirror the authoritative payment transaction into the responsive local cache.
 * Cloud and hybrid workspaces still receive the server-triggered rows on sync;
 * this optimistic mirror prevents account UI from remaining stale meanwhile.
 */
export async function mirrorPaymentAccountTransactionLocally(transaction: PaymentTransaction) {
  if (!transaction.accountId) return
  const now = transaction.updatedAt || new Date().toISOString()
  const projectionSyncMeta =
    transaction.syncStatus === 'synced'
      ? {
          syncStatus: 'synced' as const,
          lastSyncedAt: transaction.lastSyncedAt ?? now
        }
      : syncMeta(transaction.workspaceId, now)
  const delta = getPaymentAccountTransactionDelta(transaction)
  const previousMovement = await db.payment_account_movements.get(transaction.id)
  const previousDelta = Number(previousMovement?.deltaAmount || 0)
  const existingBalance = await db.payment_account_balances
    .where('[accountId+currency]')
    .equals([transaction.accountId, transaction.currency])
    .first()
  const movement: PaymentAccountMovement = {
    id: transaction.id,
    workspaceId: transaction.workspaceId,
    accountId: transaction.accountId,
    paymentTransactionId: transaction.id,
    accountNameSnapshot: transaction.accountNameSnapshot || '',
    direction: transaction.direction,
    amount: transaction.amount,
    deltaAmount: delta,
    currency: transaction.currency,
    occurredAt: transaction.paidAt,
    voidId: transaction.voidId ?? null,
    createdAt: previousMovement?.createdAt ?? transaction.createdAt,
    updatedAt: now,
    version: (previousMovement?.version ?? 0) + 1,
    isDeleted: transaction.isDeleted,
    ...projectionSyncMeta
  }
  const balance: PaymentAccountBalance = {
    id: existingBalance?.id ?? generateId(),
    workspaceId: transaction.workspaceId,
    accountId: transaction.accountId,
    currency: transaction.currency,
    balanceAmount: Number(existingBalance?.balanceAmount || 0) - previousDelta + delta,
    createdAt: existingBalance?.createdAt ?? now,
    updatedAt: now,
    version: (existingBalance?.version ?? 0) + 1,
    isDeleted: false,
    ...projectionSyncMeta
  }
  await db.transaction('rw', db.payment_account_movements, db.payment_account_balances, async () => {
    await db.payment_account_movements.put(movement)
    await db.payment_account_balances.put(balance)
  })
}
