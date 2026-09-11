import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { isReportableExpenseItem, isReportablePaymentTransaction } from '@/lib/financialReportability'
import { buildLedgerSettlementIndex } from '@/lib/ledgerSettlement'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'
import type {
  ExpenseItem,
  ExpenseSeries,
  PaymentAccountBalance,
  PaymentAccountMovement,
  PaymentTransaction,
} from './models'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000701'
const ITEM_ID = '00000000-0000-4000-8000-000000000702'
const SERIES_ID = '00000000-0000-4000-8000-000000000703'
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000704'
const BALANCE_ID = '00000000-0000-4000-8000-000000000705'
const ORIGINAL_ID = '00000000-0000-4000-8000-000000000706'
const REVERSAL_ID = '00000000-0000-4000-8000-000000000707'
const SECOND_ROOT_ID = '00000000-0000-4000-8000-000000000708'
const OTHER_MODULE_ROOT_ID = '00000000-0000-4000-8000-000000000709'

let voidFinancialTransaction: typeof import('./financialTransactionVoids').voidFinancialTransaction
let getPaymentAccountTransactionDelta: typeof import('./paymentAccounts').getPaymentAccountTransactionDelta
let reversePaymentTransaction: typeof import('./payments').reversePaymentTransaction

function installBrowserStorage() {
  const rows = new Map<string, string>()
  const storage = {
    get length() { return rows.size },
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
    removeItem: (key: string) => rows.delete(key),
    clear: () => rows.clear(),
    key: (index: number) => Array.from(rows.keys())[index] ?? null,
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
  Object.defineProperty(globalThis.URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' })
  Object.defineProperty(globalThis, 'DOMMatrix', { configurable: true, value: class DOMMatrix {} })
  Object.defineProperty(globalThis, 'ImageData', { configurable: true, value: class ImageData {} })
  Object.defineProperty(globalThis, 'Path2D', { configurable: true, value: class Path2D {} })
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: class Element {} })
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class HTMLElement {} })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: storage,
      sessionStorage: storage,
      URL: globalThis.URL,
      location: { hash: '', origin: 'http://localhost', pathname: '/' },
      addEventListener: () => undefined,
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      visibilityState: 'visible',
      documentElement: { lang: 'en', dir: 'ltr', style: {} },
      head: { appendChild: () => undefined },
      getElementsByTagName: () => [],
      createElement: () => ({ appendChild: () => undefined, setAttribute: () => undefined, style: {} }),
      createTextNode: () => ({}),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  })
}

function syncMeta() {
  return {
    syncStatus: 'synced' as const,
    lastSyncedAt: '2026-09-02T09:00:00.000Z',
    version: 1,
    isDeleted: false,
  }
}

function createExpense(recurrence: ExpenseSeries['recurrence'] = 'one_time') {
  const series: ExpenseSeries = {
    id: SERIES_ID,
    workspaceId: WORKSPACE_ID,
    name: 'Mistaken expense',
    amount: 100,
    currency: 'usd',
    dueDay: 30,
    recurrence,
    startMonth: '2026-08',
    endMonth: null,
    categoryId: null,
    category: null,
    subcategory: null,
    createdAt: '2026-08-30T09:00:00.000Z',
    updatedAt: '2026-08-30T09:00:00.000Z',
    ...syncMeta(),
  }
  const item: ExpenseItem = {
    id: ITEM_ID,
    workspaceId: WORKSPACE_ID,
    seriesId: SERIES_ID,
    month: '2026-08',
    dueDate: '2026-08-30',
    amount: 100,
    currency: 'usd',
    status: 'pending',
    paidAt: null,
    isLocked: false,
    createdAt: '2026-08-30T09:00:00.000Z',
    updatedAt: '2026-09-02T09:00:00.000Z',
    ...syncMeta(),
  }
  return { series, item }
}

function payment(input: {
  id: string
  amount: number
  paidAt: string
  reversalOfTransactionId?: string | null
  direction?: PaymentTransaction['direction']
  sourceModule?: PaymentTransaction['sourceModule']
  sourceType?: PaymentTransaction['sourceType']
  sourceRecordId?: string
}): PaymentTransaction {
  return {
    id: input.id,
    workspaceId: WORKSPACE_ID,
    sourceModule: input.sourceModule ?? 'budget',
    sourceType: input.sourceType ?? 'expense_item',
    sourceRecordId: input.sourceRecordId ?? ITEM_ID,
    sourceSubrecordId: SERIES_ID,
    direction: input.direction ?? 'outgoing',
    amount: input.amount,
    currency: 'usd',
    paymentMethod: 'cash',
    paidAt: input.paidAt,
    referenceLabel: 'Mistaken expense',
    accountId: ACCOUNT_ID,
    accountNameSnapshot: 'Cash',
    reversalOfTransactionId: input.reversalOfTransactionId ?? null,
    metadata: null,
    createdAt: input.paidAt,
    updatedAt: input.paidAt,
    ...syncMeta(),
  }
}

function movement(transaction: PaymentTransaction): PaymentAccountMovement {
  return {
    id: transaction.id,
    workspaceId: WORKSPACE_ID,
    accountId: ACCOUNT_ID,
    paymentTransactionId: transaction.id,
    accountNameSnapshot: 'Cash',
    direction: transaction.direction,
    amount: transaction.amount,
    deltaAmount: getPaymentAccountTransactionDelta(transaction),
    currency: 'usd',
    occurredAt: transaction.paidAt,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
    ...syncMeta(),
  }
}

function balance(amount: number): PaymentAccountBalance {
  return {
    id: BALANCE_ID,
    workspaceId: WORKSPACE_ID,
    accountId: ACCOUNT_ID,
    currency: 'usd',
    balanceAmount: amount,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-09-02T09:00:00.000Z',
    ...syncMeta(),
  }
}

const baseInput = {
  reason: 'This entry was invalid from the beginning.',
  cashMovementDeclaration: 'no_money_moved' as const,
  voidedBy: '00000000-0000-4000-8000-000000000711',
  voidedByName: 'Admin',
  actorRole: 'admin' as const,
}

describe('financial transaction voids', () => {
  beforeAll(async () => {
    installBrowserStorage()
    ;({ voidFinancialTransaction } = await import('./financialTransactionVoids'))
    ;({ getPaymentAccountTransactionDelta } = await import('./paymentAccounts'))
    ;({ reversePaymentTransaction } = await import('./payments'))
  }, 30_000)

  beforeEach(async () => {
    installBrowserStorage()
    await db.delete()
    await db.open()
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'demo' })
  })

  afterEach(() => clearWorkspaceModeSnapshot(WORKSPACE_ID))
  afterAll(async () => { await db.delete() })

  it('voids an August expense and September reversal when the reversal is selected', async () => {
    const { series, item } = createExpense()
    const original = payment({ id: ORIGINAL_ID, amount: 100, paidAt: '2026-08-30T12:00:00.000Z' })
    const reversal = payment({
      id: REVERSAL_ID,
      amount: -100,
      paidAt: '2026-09-02T12:00:00.000Z',
      reversalOfTransactionId: ORIGINAL_ID,
    })
    await db.expense_series.put(series)
    await db.expense_items.put(item)
    await db.payment_transactions.bulkPut([original, reversal])
    await db.payment_account_movements.bulkPut([movement(original), movement(reversal)])
    await db.payment_account_balances.put(balance(500))

    const result = await voidFinancialTransaction(WORKSPACE_ID, REVERSAL_ID, {
      ...baseInput,
      idempotencyKey: '00000000-0000-4000-8000-000000000712',
    })

    expect(result.audit.requestedPaymentTransactionId).toBe(REVERSAL_ID)
    expect(result.transactions.map((row) => row.id)).toEqual([ORIGINAL_ID, REVERSAL_ID])
    expect(result.transactions.every((row) => row.voidId === result.audit.id)).toBe(true)
    expect(result.movements.map((row) => row.deltaAmount)).toEqual([0, 0])
    expect(result.balances[0].balanceAmount).toBe(500)
    expect(isReportableExpenseItem(result.expenseItems[0])).toBe(false)
    expect(result.transactions.every((row) => !isReportablePaymentTransaction(row))).toBe(true)
    expect(buildLedgerSettlementIndex(result.transactions).byTransactionId.size).toBe(0)
    await expect(reversePaymentTransaction(WORKSPACE_ID, ORIGINAL_ID)).rejects.toThrow('Voided')
    expect((await db.expense_series.get(SERIES_ID))?.voidId).toBe(result.audit.id)

    const monthEffects = ['2026-08', '2026-09'].map((month) => result.transactions
      .filter((row) => row.paidAt.startsWith(month))
      .filter(isReportablePaymentTransaction)
      .reduce((sum, row) => sum + getPaymentAccountTransactionDelta(row), 0))
    expect(monthEffects).toEqual([0, 0])
  })

  it('voids surviving payment history after the expense source was hard-deleted', async () => {
    const { series, item } = createExpense()
    const original = payment({ id: ORIGINAL_ID, amount: 100, paidAt: '2026-08-30T12:00:00.000Z' })
    await db.expense_series.put(series)
    await db.expense_items.put(item)
    await db.payment_transactions.put(original)
    await db.payment_account_movements.put(movement(original))
    await db.payment_account_balances.put(balance(400))
    await db.expense_items.delete(ITEM_ID)
    await db.expense_series.delete(SERIES_ID)

    const result = await voidFinancialTransaction(WORKSPACE_ID, ORIGINAL_ID, baseInput)

    expect(result.audit.sourceUnavailable).toBe(true)
    expect(result.audit.sourceSnapshot).toMatchObject({
      sourceUnavailable: true,
      referenceLabel: 'Mistaken expense',
    })
    expect(result.expenseItems).toEqual([])
    expect(result.expenseSeries).toEqual([])
    expect((await db.payment_account_balances.get(BALANCE_ID))?.balanceAmount).toBe(500)
  })

  it('leaves unrelated payment chains for the same source untouched', async () => {
    const { series, item } = createExpense()
    const selected = payment({ id: ORIGINAL_ID, amount: 100, paidAt: '2026-08-30T12:00:00.000Z' })
    const unrelated = payment({ id: SECOND_ROOT_ID, amount: 50, paidAt: '2026-08-30T13:00:00.000Z' })
    const otherModule = payment({
      id: OTHER_MODULE_ROOT_ID,
      amount: 25,
      paidAt: '2026-08-30T14:00:00.000Z',
      sourceModule: 'orders',
    })
    await db.expense_series.put(series)
    await db.expense_items.put(item)
    await db.payment_transactions.bulkPut([selected, unrelated, otherModule])
    await db.payment_account_movements.bulkPut([movement(selected), movement(unrelated)])
    await db.payment_account_balances.put(balance(350))

    const result = await voidFinancialTransaction(WORKSPACE_ID, ORIGINAL_ID, baseInput)

    expect(result.transactions.map((row) => row.id)).toEqual([ORIGINAL_ID])
    expect((await db.payment_transactions.get(SECOND_ROOT_ID))?.voidId).toBeUndefined()
    expect((await db.payment_transactions.get(OTHER_MODULE_ROOT_ID))?.voidId).toBeUndefined()
    expect((await db.payment_account_movements.get(SECOND_ROOT_ID))?.deltaAmount).toBe(-50)
    expect((await db.payment_account_balances.get(BALANCE_ID))?.balanceAmount).toBe(450)
    expect((await db.expense_items.get(ITEM_ID))?.voidId).toBeUndefined()
    expect(result.expenseItems).toEqual([])
  })

  it('keeps a recurring series active while voiding its final mistaken occurrence', async () => {
    const { series, item } = createExpense('monthly')
    const original = payment({ id: ORIGINAL_ID, amount: 100, paidAt: '2026-08-30T12:00:00.000Z' })
    await db.expense_series.put(series)
    await db.expense_items.put(item)
    await db.payment_transactions.put(original)
    await db.payment_account_movements.put(movement(original))
    await db.payment_account_balances.put(balance(400))

    const result = await voidFinancialTransaction(WORKSPACE_ID, ORIGINAL_ID, baseInput)

    expect(result.expenseItems[0].voidId).toBe(result.audit.id)
    expect(result.expenseSeries).toEqual([])
    expect((await db.expense_series.get(SERIES_ID))?.voidId).toBeUndefined()
  })

  it('rejects non-admin, invalid, locked, unsupported, and negative-balance attempts atomically', async () => {
    const { series, item } = createExpense()
    const incoming = payment({
      id: ORIGINAL_ID,
      amount: 100,
      paidAt: '2026-08-30T12:00:00.000Z',
      direction: 'incoming',
    })
    const unsupported = payment({
      id: SECOND_ROOT_ID,
      amount: 10,
      paidAt: '2026-08-30T13:00:00.000Z',
      sourceModule: 'payments',
      sourceType: 'direct_transaction',
      sourceRecordId: SECOND_ROOT_ID,
    })
    await db.expense_series.put(series)
    await db.expense_items.put(item)
    await db.payment_transactions.bulkPut([incoming, unsupported])
    await db.payment_account_movements.put(movement(incoming))
    await db.payment_account_balances.put(balance(50))

    await expect(voidFinancialTransaction(WORKSPACE_ID, ORIGINAL_ID, { ...baseInput, actorRole: 'staff' }))
      .rejects.toThrow('administrator')
    await expect(voidFinancialTransaction(WORKSPACE_ID, ORIGINAL_ID, { ...baseInput, reason: 'short' }))
      .rejects.toThrow('between 10 and 1000')
    await expect(voidFinancialTransaction(WORKSPACE_ID, ORIGINAL_ID, {
      ...baseInput,
      cashMovementDeclaration: 'money_moved' as never,
    })).rejects.toThrow('no real money moved')
    await db.expense_items.update(ITEM_ID, { isLocked: true })
    await expect(voidFinancialTransaction(WORKSPACE_ID, ORIGINAL_ID, baseInput)).rejects.toThrow('Locked')
    await db.expense_items.update(ITEM_ID, { isLocked: false })
    await expect(voidFinancialTransaction(WORKSPACE_ID, SECOND_ROOT_ID, baseInput))
      .rejects.toThrow('does not support')
    await expect(voidFinancialTransaction(WORKSPACE_ID, ORIGINAL_ID, baseInput)).rejects.toThrow('negative')

    expect(await db.financial_transaction_voids.count()).toBe(0)
    expect((await db.payment_transactions.get(ORIGINAL_ID))?.voidId).toBeUndefined()
    expect((await db.payment_account_balances.get(BALANCE_ID))?.balanceAmount).toBe(50)
  })

  it('is idempotent across retries and selecting another entry in the same chain', async () => {
    const { series, item } = createExpense()
    const original = payment({ id: ORIGINAL_ID, amount: 100, paidAt: '2026-08-30T12:00:00.000Z' })
    const reversal = payment({
      id: REVERSAL_ID,
      amount: -100,
      paidAt: '2026-09-02T12:00:00.000Z',
      reversalOfTransactionId: ORIGINAL_ID,
    })
    await db.expense_series.put(series)
    await db.expense_items.put(item)
    await db.payment_transactions.bulkPut([original, reversal])
    await db.payment_account_movements.bulkPut([movement(original), movement(reversal)])
    await db.payment_account_balances.put(balance(500))

    const input = {
      ...baseInput,
      idempotencyKey: '00000000-0000-4000-8000-000000000712',
    }
    const first = await voidFinancialTransaction(WORKSPACE_ID, REVERSAL_ID, input)
    const replay = await voidFinancialTransaction(WORKSPACE_ID, REVERSAL_ID, input)
    const chainReplay = await voidFinancialTransaction(WORKSPACE_ID, ORIGINAL_ID, {
      ...input,
      idempotencyKey: '00000000-0000-4000-8000-000000000713',
    })

    expect(replay.audit.id).toBe(first.audit.id)
    expect(chainReplay.audit.id).toBe(first.audit.id)
    expect(await db.financial_transaction_voids.count()).toBe(1)
    expect((await db.payment_account_balances.get(BALANCE_ID))?.balanceAmount).toBe(500)
  })

  it('clamps sub-cent floating-point residue when restoring an account balance', async () => {
    const { series, item } = createExpense()
    const incoming = payment({
      id: ORIGINAL_ID,
      amount: 0.3000004,
      paidAt: '2026-08-30T12:00:00.000Z',
      direction: 'incoming',
    })
    await db.expense_series.put(series)
    await db.expense_items.put(item)
    await db.payment_transactions.put(incoming)
    await db.payment_account_movements.put(movement(incoming))
    await db.payment_account_balances.put(balance(0.3))

    await voidFinancialTransaction(WORKSPACE_ID, ORIGINAL_ID, baseInput)

    expect((await db.payment_account_balances.get(BALANCE_ID))?.balanceAmount).toBe(0)
  })
})
