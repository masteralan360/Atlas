import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toCamelCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { recordWorkspaceDataFetch } from '@/workspace/workspaceDataFreshness'

import { db } from './database'
import { getPaymentAccountTransactionDelta } from './paymentAccounts'
import type {
  ExpenseItem,
  ExpenseSeries,
  FinancialTransactionVoid,
  FinancialVoidCashDeclaration,
  PaymentAccountBalance,
  PaymentAccountMovement,
  PaymentTransaction,
  PaymentTransactionSourceType,
  UserRole,
} from './models'

export interface VoidFinancialTransactionInput {
  reason: string
  cashMovementDeclaration: FinancialVoidCashDeclaration
  voidedBy: string
  voidedByName: string
  actorRole: UserRole
  idempotencyKey?: string
}

export interface VoidFinancialTransactionResult {
  audit: FinancialTransactionVoid
  transactions: PaymentTransaction[]
  expenseItems: ExpenseItem[]
  expenseSeries: ExpenseSeries[]
  movements: PaymentAccountMovement[]
  balances: PaymentAccountBalance[]
}

interface FinancialVoidSourceState {
  sourceUnavailable: boolean
  sourceSnapshot: Record<string, unknown>
  voidSourceRecords: boolean
  expenseItems: ExpenseItem[]
  expenseSeries: ExpenseSeries[]
}

interface FinancialVoidSourceContext {
  workspaceId: string
  root: PaymentTransaction
  requestedTransaction: PaymentTransaction
  transactions: PaymentTransaction[]
  allSourceTransactions: PaymentTransaction[]
}

interface FinancialVoidSourceAdapter {
  sourceModule: PaymentTransaction['sourceModule']
  loadAndValidate: (context: FinancialVoidSourceContext) => Promise<FinancialVoidSourceState>
  apply: (
    state: FinancialVoidSourceState,
    auditId: string,
    now: string,
  ) => FinancialVoidSourceState
}

const BALANCE_EPSILON = 0.000001

function normalizedReason(value: string) {
  return value.trim()
}

function assertVoidInput(input: VoidFinancialTransactionInput) {
  const reason = normalizedReason(input.reason)
  if (reason.length < 10 || reason.length > 1000) {
    throw new Error('The void reason must contain between 10 and 1000 characters.')
  }
  if (input.cashMovementDeclaration !== 'no_money_moved') {
    throw new Error('Confirm that no real money moved before using the void workflow.')
  }
  if (input.actorRole !== 'admin') {
    throw new Error('Only a workspace administrator can void a financial transaction.')
  }
}

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function withSyncedMetadata<T extends { updatedAt: string; syncStatus: string; lastSyncedAt: string | null }>(
  row: T,
  syncedAt: string,
) {
  return {
    ...row,
    syncStatus: 'synced' as const,
    lastSyncedAt: syncedAt,
  }
}

function isSamePaymentSource(left: PaymentTransaction, right: PaymentTransaction) {
  return left.workspaceId === right.workspaceId
    && left.sourceModule === right.sourceModule
    && left.sourceType === right.sourceType
    && left.sourceRecordId === right.sourceRecordId
}

export function getFinancialVoidTransactionChain(
  transactions: PaymentTransaction[],
  requestedTransactionId: string,
) {
  const requested = transactions.find((transaction) => transaction.id === requestedTransactionId)
  if (!requested || requested.isDeleted) {
    throw new Error('Payment transaction not found.')
  }

  const sourceTransactions = transactions.filter(
    (transaction) => !transaction.isDeleted && isSamePaymentSource(transaction, requested),
  )
  const byId = new Map(sourceTransactions.map((transaction) => [transaction.id, transaction]))
  const ancestorIds = new Set<string>()
  let root = requested

  while (root.reversalOfTransactionId) {
    if (ancestorIds.has(root.id)) {
      throw new Error('The payment transaction chain contains a cycle.')
    }
    ancestorIds.add(root.id)
    const parent = byId.get(root.reversalOfTransactionId)
    if (!parent) {
      throw new Error('The payment transaction chain is missing its original entry.')
    }
    root = parent
  }

  const connectedIds = new Set<string>([root.id])
  let changed = true
  while (changed) {
    changed = false
    for (const transaction of sourceTransactions) {
      if (
        transaction.reversalOfTransactionId
        && connectedIds.has(transaction.reversalOfTransactionId)
        && !connectedIds.has(transaction.id)
      ) {
        connectedIds.add(transaction.id)
        changed = true
      }
    }
  }

  if (!connectedIds.has(requested.id)) {
    throw new Error('The selected payment is not connected to its original entry.')
  }

  return {
    requested,
    root,
    transactions: sourceTransactions
      .filter((transaction) => connectedIds.has(transaction.id))
      .sort((left, right) => left.paidAt.localeCompare(right.paidAt) || left.id.localeCompare(right.id)),
  }
}

const expenseVoidAdapter: FinancialVoidSourceAdapter = {
  sourceModule: 'budget',
  async loadAndValidate({ workspaceId, requestedTransaction, transactions, allSourceTransactions }) {
    const item = await db.expense_items.get(requestedTransaction.sourceRecordId)
    if (item && item.workspaceId !== workspaceId) {
      throw new Error('The expense belongs to a different workspace.')
    }
    if (item?.isLocked) {
      throw new Error('Locked expenses cannot be voided.')
    }
    if (item?.voidId) {
      throw new Error('The expense has an invalid void reference.')
    }

    const seriesId = item?.seriesId ?? requestedTransaction.sourceSubrecordId ?? null
    const series = seriesId ? await db.expense_series.get(seriesId) : undefined
    if (series && series.workspaceId !== workspaceId) {
      throw new Error('The expense series belongs to a different workspace.')
    }
    if (series?.voidId) {
      throw new Error('The expense series has an invalid void reference.')
    }

    const sourceUnavailable = !item
    const chainIds = new Set(transactions.map((transaction) => transaction.id))
    const voidSourceRecords = !allSourceTransactions.some(
      (transaction) => !transaction.isDeleted && !transaction.voidId && !chainIds.has(transaction.id),
    )
    return {
      sourceUnavailable,
      sourceSnapshot: sourceUnavailable
        ? snapshot({
            sourceUnavailable: true,
            sourceRecordsVoided: false,
            referenceLabel: requestedTransaction.referenceLabel ?? null,
            counterpartyName: requestedTransaction.counterpartyName ?? null,
            metadata: requestedTransaction.metadata ?? null,
          })
        : snapshot({
            sourceUnavailable: false,
            sourceRecordsVoided: voidSourceRecords,
            expenseItem: item,
            expenseSeries: series ?? null,
          }),
      voidSourceRecords,
      expenseItems: item ? [item] : [],
      expenseSeries: series ? [series] : [],
    }
  },
  apply(state, auditId, now) {
    if (!state.voidSourceRecords) {
      return { ...state, expenseItems: [], expenseSeries: [] }
    }

    const expenseItems = state.expenseItems.map((item) => ({
      ...item,
      voidId: auditId,
      updatedAt: now,
      version: item.version + 1,
      syncStatus: 'synced' as const,
      lastSyncedAt: now,
    }))
    const expenseSeries = state.expenseSeries
      .filter((series) => series.recurrence === 'one_time')
      .map((series) => ({
        ...series,
        voidId: auditId,
        updatedAt: now,
        version: series.version + 1,
        syncStatus: 'synced' as const,
        lastSyncedAt: now,
      }))

    return { ...state, expenseItems, expenseSeries }
  },
}

const FINANCIAL_VOID_SOURCE_ADAPTERS: Partial<Record<PaymentTransactionSourceType, FinancialVoidSourceAdapter>> = {
  expense_item: expenseVoidAdapter,
}

function getSourceAdapter(transaction: PaymentTransaction) {
  const adapter = FINANCIAL_VOID_SOURCE_ADAPTERS[transaction.sourceType]
  if (!adapter || adapter.sourceModule !== transaction.sourceModule) {
    throw new Error('This transaction source does not support voiding yet.')
  }
  return adapter
}

export function isFinancialVoidSourceSupported(
  transaction: Pick<PaymentTransaction, 'sourceModule' | 'sourceType'>,
) {
  const adapter = FINANCIAL_VOID_SOURCE_ADAPTERS[transaction.sourceType]
  return !!adapter && adapter.sourceModule === transaction.sourceModule
}

async function loadExistingSourceState(audit: FinancialTransactionVoid): Promise<FinancialVoidSourceState> {
  if (audit.sourceType !== 'expense_item' || audit.sourceModule !== 'budget') {
    return {
      sourceUnavailable: audit.sourceUnavailable,
      sourceSnapshot: audit.sourceSnapshot,
      voidSourceRecords: false,
      expenseItems: [],
      expenseSeries: [],
    }
  }

  const [item, series] = await Promise.all([
    db.expense_items.get(audit.sourceRecordId),
    audit.sourceSubrecordId ? db.expense_series.get(audit.sourceSubrecordId) : undefined,
  ])
  return {
    sourceUnavailable: audit.sourceUnavailable,
    sourceSnapshot: audit.sourceSnapshot,
    voidSourceRecords: false,
    expenseItems: item?.voidId === audit.id ? [item] : [],
    expenseSeries: series?.voidId === audit.id ? [series] : [],
  }
}

async function getExistingVoidResult(audit: FinancialTransactionVoid): Promise<VoidFinancialTransactionResult> {
  const [transactions, movements, sourceState] = await Promise.all([
    db.payment_transactions.bulkGet(audit.affectedTransactionIds),
    db.payment_account_movements.bulkGet(audit.affectedTransactionIds),
    loadExistingSourceState(audit),
  ])
  const activeTransactions = transactions.filter((row): row is PaymentTransaction => !!row)
  const activeMovements = movements.filter((row): row is PaymentAccountMovement => !!row)
  const balanceKeys = new Set(activeTransactions
    .filter((row) => !!row.accountId)
    .map((row) => `${row.accountId}:${row.currency}`))
  const balances = (await db.payment_account_balances.where('workspaceId').equals(audit.workspaceId).toArray())
    .filter((row) => balanceKeys.has(`${row.accountId}:${row.currency}`))

  return {
    audit,
    transactions: activeTransactions,
    expenseItems: sourceState.expenseItems,
    expenseSeries: sourceState.expenseSeries,
    movements: activeMovements,
    balances,
  }
}

async function voidFinancialTransactionLocally(
  workspaceId: string,
  paymentTransactionId: string,
  input: VoidFinancialTransactionInput,
): Promise<VoidFinancialTransactionResult> {
  return db.transaction(
    'rw',
    [
      db.financial_transaction_voids,
      db.payment_transactions,
      db.expense_items,
      db.expense_series,
      db.payment_account_movements,
      db.payment_account_balances,
    ],
    async () => {
      const idempotencyKey = input.idempotencyKey ?? generateId()
      const existingById = await db.financial_transaction_voids.get(idempotencyKey)
      if (existingById) {
        if (
          existingById.workspaceId !== workspaceId
          || existingById.requestedPaymentTransactionId !== paymentTransactionId
        ) {
          throw new Error('The idempotency key was already used for a different transaction.')
        }
        return getExistingVoidResult(existingById)
      }

      const requested = await db.payment_transactions.get(paymentTransactionId)
      if (!requested || requested.workspaceId !== workspaceId || requested.isDeleted) {
        throw new Error('Payment transaction not found.')
      }
      if (requested.voidId) {
        const existing = await db.financial_transaction_voids.get(requested.voidId)
        if (existing) return getExistingVoidResult(existing)
        throw new Error('This payment has an invalid void reference.')
      }

      const adapter = getSourceAdapter(requested)
      const sourceTransactions = (await db.payment_transactions
        .where('[workspaceId+sourceType+sourceRecordId]')
        .equals([workspaceId, requested.sourceType, requested.sourceRecordId])
        .toArray())
        .filter((transaction) => transaction.sourceModule === requested.sourceModule)
      const chain = getFinancialVoidTransactionChain(sourceTransactions, requested.id)

      if (chain.transactions.some((transaction) => transaction.voidId)) {
        throw new Error('The payment transaction chain is already voided or inconsistent.')
      }
      const existingByRoot = await db.financial_transaction_voids
        .where('rootPaymentTransactionId')
        .equals(chain.root.id)
        .first()
      if (existingByRoot) return getExistingVoidResult(existingByRoot)

      const sourceState = await adapter.loadAndValidate({
        workspaceId,
        root: chain.root,
        requestedTransaction: chain.requested,
        transactions: chain.transactions,
        allSourceTransactions: sourceTransactions,
      })
      const transactionIds = chain.transactions.map((transaction) => transaction.id)
      const movements = (await db.payment_account_movements.bulkGet(transactionIds))
        .filter((row): row is PaymentAccountMovement => !!row)
      const balanceChanges = new Map<string, {
        accountId: string
        currency: PaymentAccountBalance['currency']
        delta: number
      }>()
      for (const transaction of chain.transactions) {
        if (!transaction.accountId) continue
        const key = `${transaction.accountId}:${transaction.currency}`
        const current = balanceChanges.get(key) ?? {
          accountId: transaction.accountId,
          currency: transaction.currency,
          delta: 0,
        }
        current.delta += getPaymentAccountTransactionDelta(transaction)
        balanceChanges.set(key, current)
      }

      const now = new Date().toISOString()
      const currentBalances = await db.payment_account_balances.where('workspaceId').equals(workspaceId).toArray()
      const nextBalances: PaymentAccountBalance[] = []
      for (const change of balanceChanges.values()) {
        const balance = currentBalances.find(
          (row) => row.accountId === change.accountId && row.currency === change.currency && !row.isDeleted,
        )
        const nextAmount = Number(balance?.balanceAmount || 0) - change.delta
        if (nextAmount < -BALANCE_EPSILON) {
          throw new Error('Voiding this transaction would make a payment account balance negative.')
        }
        nextBalances.push({
          ...(balance ?? {
            id: generateId(),
            workspaceId,
            accountId: change.accountId,
            currency: change.currency,
            createdAt: now,
            updatedAt: now,
            version: 0,
            isDeleted: false,
            syncStatus: 'synced' as const,
            lastSyncedAt: now,
          }),
          balanceAmount: Math.abs(nextAmount) <= BALANCE_EPSILON ? 0 : nextAmount,
        })
      }

      const audit: FinancialTransactionVoid = {
        id: idempotencyKey,
        workspaceId,
        rootPaymentTransactionId: chain.root.id,
        requestedPaymentTransactionId: chain.requested.id,
        sourceModule: chain.root.sourceModule,
        sourceType: chain.root.sourceType,
        sourceRecordId: chain.root.sourceRecordId,
        sourceSubrecordId: chain.root.sourceSubrecordId ?? null,
        sourceUnavailable: sourceState.sourceUnavailable,
        affectedTransactionIds: transactionIds,
        reason: normalizedReason(input.reason),
        cashMovementDeclaration: input.cashMovementDeclaration,
        voidedBy: input.voidedBy,
        voidedByNameSnapshot: input.voidedByName.trim() || input.voidedBy,
        voidedAt: now,
        sourceSnapshot: sourceState.sourceSnapshot,
        transactionSnapshots: snapshot(chain.transactions),
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        syncStatus: 'synced',
        lastSyncedAt: now,
      }

      const nextTransactions = chain.transactions.map((transaction) => ({
        ...transaction,
        voidId: audit.id,
        updatedAt: now,
        version: transaction.version + 1,
        syncStatus: 'synced' as const,
        lastSyncedAt: now,
      }))
      const nextMovements = movements.map((movement) => ({
        ...movement,
        voidId: audit.id,
        deltaAmount: 0,
        updatedAt: now,
        version: movement.version + 1,
        syncStatus: 'synced' as const,
        lastSyncedAt: now,
      }))
      const nextSourceState = adapter.apply(sourceState, audit.id, now)
      const syncedBalances = nextBalances.map((balance) => ({
        ...balance,
        updatedAt: now,
        version: balance.version + 1,
        syncStatus: 'synced' as const,
        lastSyncedAt: now,
      }))

      await db.financial_transaction_voids.add(audit)
      await db.payment_transactions.bulkPut(nextTransactions)
      if (nextSourceState.expenseItems.length) await db.expense_items.bulkPut(nextSourceState.expenseItems)
      if (nextSourceState.expenseSeries.length) await db.expense_series.bulkPut(nextSourceState.expenseSeries)
      if (nextMovements.length) await db.payment_account_movements.bulkPut(nextMovements)
      if (syncedBalances.length) await db.payment_account_balances.bulkPut(syncedBalances)

      return {
        audit,
        transactions: nextTransactions,
        expenseItems: nextSourceState.expenseItems,
        expenseSeries: nextSourceState.expenseSeries,
        movements: nextMovements,
        balances: syncedBalances,
      }
    },
  )
}

function mapRemoteRow<T>(row: unknown, syncedAt: string): T {
  return withSyncedMetadata(toCamelCase(row as Record<string, unknown>) as T & {
    updatedAt: string
    syncStatus: string
    lastSyncedAt: string | null
  }, syncedAt) as T
}

async function voidFinancialTransactionInCloud(
  workspaceId: string,
  paymentTransactionId: string,
  input: VoidFinancialTransactionInput,
): Promise<VoidFinancialTransactionResult> {
  if (!isOnline()) {
    throw new Error('Connect to the internet to void a cloud or hybrid financial transaction.')
  }

  const client = getSupabaseClientForTable('payment_transactions')
  const idempotencyKey = input.idempotencyKey ?? generateId()
  const { data, error } = await runSupabaseAction('financial_transaction_voids.create', () =>
    client.rpc('void_financial_transaction', {
      p_workspace_id: workspaceId,
      p_payment_transaction_id: paymentTransactionId,
      p_reason: normalizedReason(input.reason),
      p_cash_movement_declaration: input.cashMovementDeclaration,
      p_idempotency_key: idempotencyKey,
    }),
  )
  if (error) throw normalizeSupabaseActionError(error)

  const payload = data as Record<string, unknown> | null
  if (!payload || !payload.void) throw new Error('The server did not return the completed void transaction.')

  const syncedAt = new Date().toISOString()
  const audit = mapRemoteRow<FinancialTransactionVoid>(payload.void, syncedAt)
  const transactions = ((payload.transactions as unknown[]) ?? [])
    .map((row) => mapRemoteRow<PaymentTransaction>(row, syncedAt))
  const expenseItems = ((payload.expenseItems as unknown[]) ?? [])
    .map((row) => mapRemoteRow<ExpenseItem>(row, syncedAt))
  const expenseSeries = ((payload.expenseSeries as unknown[]) ?? [])
    .map((row) => mapRemoteRow<ExpenseSeries>(row, syncedAt))
  const movements = ((payload.movements as unknown[]) ?? [])
    .map((row) => mapRemoteRow<PaymentAccountMovement>(row, syncedAt))
  const balances = ((payload.balances as unknown[]) ?? [])
    .map((row) => mapRemoteRow<PaymentAccountBalance>(row, syncedAt))

  await db.transaction(
    'rw',
    [
      db.financial_transaction_voids,
      db.payment_transactions,
      db.expense_items,
      db.expense_series,
      db.payment_account_movements,
      db.payment_account_balances,
    ],
    async () => {
      await db.financial_transaction_voids.put(audit)
      if (transactions.length) await db.payment_transactions.bulkPut(transactions)
      if (expenseItems.length) await db.expense_items.bulkPut(expenseItems)
      if (expenseSeries.length) await db.expense_series.bulkPut(expenseSeries)
      if (movements.length) await db.payment_account_movements.bulkPut(movements)
      if (balances.length) await db.payment_account_balances.bulkPut(balances)
    },
  )

  return { audit, transactions, expenseItems, expenseSeries, movements, balances }
}

export async function voidFinancialTransaction(
  workspaceId: string,
  paymentTransactionId: string,
  input: VoidFinancialTransactionInput,
): Promise<VoidFinancialTransactionResult> {
  assertVoidInput(input)
  return isLocalWorkspaceMode(workspaceId)
    ? voidFinancialTransactionLocally(workspaceId, paymentTransactionId, input)
    : voidFinancialTransactionInCloud(workspaceId, paymentTransactionId, input)
}

export function useFinancialTransactionVoids(workspaceId: string | undefined) {
  const online = useNetworkStatus()
  const rows = useLiveQuery(
    () => workspaceId
      ? db.financial_transaction_voids.where('workspaceId').equals(workspaceId).reverse().sortBy('voidedAt')
      : [],
    [workspaceId],
  )

  useEffect(() => {
    if (!online || !workspaceId || isLocalWorkspaceMode(workspaceId)) return
    const client = getSupabaseClientForTable('financial_transaction_voids')
    void runSupabaseAction('financial_transaction_voids.list', () =>
      client
        .from('financial_transaction_voids')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('voided_at', { ascending: false }),
    ).then(async ({ data, error }) => {
      if (error) throw normalizeSupabaseActionError(error)
      const syncedAt = new Date().toISOString()
      const remoteRows = (data ?? []).map((row) => mapRemoteRow<FinancialTransactionVoid>(row, syncedAt))
      await db.transaction('rw', db.financial_transaction_voids, async () => {
        if (remoteRows.length) await db.financial_transaction_voids.bulkPut(remoteRows)
      })
      recordWorkspaceDataFetch(workspaceId, 'supabase', undefined, 'financial_transaction_voids')
    }).catch((error) => {
      console.error('[Financial voids] Failed to hydrate audit records', error)
    })
  }, [online, workspaceId])

  return rows ?? []
}
