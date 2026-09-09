import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useViewOwnRecordScope, type ViewOwnRecordScope } from '@/permissions/useViewOwnRecordScope'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { canAccessBusinessPartnerInLocalCache } from './businessPartnerPrivacy'
import { db } from './database'
import { addToOfflineMutations, fetchTableFromSupabase } from './hooks'
import { recalculateBusinessPartnerSummary } from './businessPartners'
import {
  appendPaymentTransaction,
  assertStandardSettlementPaymentMethod,
  reversePaymentTransaction,
  softDeletePaymentTransaction
} from './payments'
import type {
  CurrencyCode,
  InstallmentSale,
  InstallmentSaleFrequency,
  InstallmentSaleInstallment,
  InstallmentSalePayment,
  InstallmentSaleStatus,
  InstallmentStatus,
  PaymentTransaction,
  WorkspacePaymentMethod
} from './models'

const SALES_TABLE = 'installment_sales'
const INSTALLMENTS_TABLE = 'installment_sale_installments'
const PAYMENTS_TABLE = 'installment_sale_payments'

type InstallmentSalesTableName = typeof SALES_TABLE | typeof INSTALLMENTS_TABLE | typeof PAYMENTS_TABLE

type SyncEntity = Record<string, unknown> & {
  id: string
  workspaceId: string
  version: number
}

const tableByName = {
  [SALES_TABLE]: db.installment_sales,
  [INSTALLMENTS_TABLE]: db.installment_sale_installments,
  [PAYMENTS_TABLE]: db.installment_sale_payments
} as const

function shouldUseCloudBusinessData(workspaceId?: string | null) {
  return !!workspaceId && !isLocalWorkspaceMode(workspaceId)
}

function getSyncMetadata(workspaceId: string, now: string) {
  return shouldUseCloudBusinessData(workspaceId)
    ? { syncStatus: 'pending' as const, lastSyncedAt: null }
    : { syncStatus: 'synced' as const, lastSyncedAt: now }
}

export function roundInstallmentSaleAmount(value: number, currency: CurrencyCode) {
  const precision = currency === 'iqd' ? 0 : 2
  const factor = 10 ** precision
  return Math.round((Number(value) || 0) * factor) / factor
}

type ParsedInstallmentSaleDueAt = {
  date: Date
  hasTime: boolean
}

function padDueDatePart(value: number) {
  return String(value).padStart(2, '0')
}

function formatDueDateParts(date: Date, hasTime: boolean) {
  const dateKey = `${date.getUTCFullYear()}-${padDueDatePart(date.getUTCMonth() + 1)}-${padDueDatePart(date.getUTCDate())}`
  return hasTime
    ? `${dateKey}T${padDueDatePart(date.getUTCHours())}:${padDueDatePart(date.getUTCMinutes())}:${padDueDatePart(date.getUTCSeconds())}`
    : dateKey
}

function parseInstallmentSaleDueAt(value: string | null | undefined): ParsedInstallmentSaleDueAt | null {
  if (!value) return null
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/)
  if (match) {
    const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue] = match
    const year = Number(yearValue)
    const month = Number(monthValue)
    const day = Number(dayValue)
    const hour = Number(hourValue || 0)
    const minute = Number(minuteValue || 0)
    const second = Number(secondValue || 0)
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day ||
      date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute ||
      date.getUTCSeconds() !== second
    ) {
      return null
    }
    return { date, hasTime: hourValue !== undefined }
  }

  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return null
  return {
    date: new Date(
      Date.UTC(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        date.getSeconds()
      )
    ),
    hasTime: true
  }
}

function normalizeInstallmentSaleDueAt(value: string | null | undefined) {
  const parsed = parseInstallmentSaleDueAt(value)
  if (!parsed) throw new Error('A valid first due date and time is required')
  return formatDueDateParts(parsed.date, parsed.hasTime)
}

function getCurrentLocalDueAtKey(now = new Date()) {
  return `${now.getFullYear()}-${padDueDatePart(now.getMonth() + 1)}-${padDueDatePart(now.getDate())}T${padDueDatePart(now.getHours())}:${padDueDatePart(now.getMinutes())}:${padDueDatePart(now.getSeconds())}`
}

export function addInstallmentSaleDueDate(
  firstDueDate: string | null,
  frequency: InstallmentSaleFrequency,
  index: number
) {
  if (frequency === 'no_frequency') return null
  const firstDueAt = parseInstallmentSaleDueAt(firstDueDate)
  if (!firstDueAt) throw new Error('A valid first due date and time is required')
  const date = new Date(firstDueAt.date)
  if (frequency === 'daily') {
    date.setUTCDate(date.getUTCDate() + index)
  } else if (frequency === 'weekly') {
    date.setUTCDate(date.getUTCDate() + index * 7)
  } else if (frequency === 'biweekly') {
    date.setUTCDate(date.getUTCDate() + index * 14)
  } else {
    const month = date.getUTCMonth() + index
    const year = date.getUTCFullYear() + Math.floor(month / 12)
    const normalizedMonth = ((month % 12) + 12) % 12
    const endOfTargetMonth = new Date(Date.UTC(year, normalizedMonth + 1, 0)).getUTCDate()
    date.setUTCFullYear(year, normalizedMonth, Math.min(date.getUTCDate(), endOfTargetMonth))
  }
  return formatDueDateParts(date, firstDueAt.hasTime)
}

export function isInstallmentSaleDueOverdue(
  dueDate: string | null | undefined,
  nowKey = getCurrentLocalDueAtKey()
) {
  const dueAt = parseInstallmentSaleDueAt(dueDate)
  const nowAt = parseInstallmentSaleDueAt(nowKey)
  if (!dueAt || !nowAt) return false

  // Legacy date-only sales remain due through the whole selected calendar day.
  if (!dueAt.hasTime) {
    return formatDueDateParts(dueAt.date, false) < formatDueDateParts(nowAt.date, false)
  }

  return dueAt.date.valueOf() < nowAt.date.valueOf()
}

export function getInstallmentSaleOverdueDays(
  dueDate: string | null | undefined,
  nowKey = getCurrentLocalDueAtKey()
) {
  const dueAt = parseInstallmentSaleDueAt(dueDate)
  const nowAt = parseInstallmentSaleDueAt(nowKey)
  if (!dueAt || !nowAt || !isInstallmentSaleDueOverdue(dueDate, nowKey)) return 0
  return Math.floor((nowAt.date.valueOf() - dueAt.date.valueOf()) / (24 * 60 * 60 * 1000))
}

/**
 * Open-ended frequency-based sales carry one balance rather than a growing
 * schedule. Their overdue state must therefore be derived from the first due
 * date at display time, even when no payment has been recorded that day.
 */
export function getInstallmentSaleDisplayStatus(
  sale: Pick<
    InstallmentSale,
    | 'status'
    | 'customerBalanceAmount'
    | 'hasInstallmentCount'
    | 'installmentFrequency'
    | 'firstDueDate'
  >,
  nowKey = getCurrentLocalDueAtKey()
): InstallmentSaleStatus {
  if (
    sale.status === 'cancelled' ||
    sale.customerBalanceAmount <= 0 ||
    sale.installmentFrequency === 'no_frequency' ||
    sale.hasInstallmentCount !== false
  ) {
    return sale.status
  }

  return isInstallmentSaleDueOverdue(sale.firstDueDate, nowKey)
    ? 'overdue'
    : sale.status
}

export function buildInstallmentSaleSchedule(
  amount: number,
  currency: CurrencyCode,
  count: number,
  frequency: InstallmentSaleFrequency,
  firstDueDate: string | null,
  hasInstallmentCount = true
) {
  // An open-balance sale deliberately has one internal allocation row. It is
  // never presented as a schedule, but lets payment allocation and reversals
  // continue to use the established, auditable installment-sale flow.
  const safeCount = frequency === 'no_frequency' || !hasInstallmentCount
    ? 1
    : Math.max(1, Math.trunc(Number(count) || 1))
  const safeAmount = roundInstallmentSaleAmount(Math.max(0, amount), currency)
  const base = roundInstallmentSaleAmount(safeAmount / safeCount, currency)
  const rows: Array<{
    installmentNo: number
    dueDate: string | null
    plannedAmount: number
  }> = []
  let accumulated = 0

  for (let index = 0; index < safeCount; index += 1) {
    const plannedAmount =
      index === safeCount - 1 ? roundInstallmentSaleAmount(safeAmount - accumulated, currency) : base
    accumulated = roundInstallmentSaleAmount(accumulated + plannedAmount, currency)
    rows.push({
      installmentNo: index + 1,
      dueDate: addInstallmentSaleDueDate(firstDueDate, frequency, index),
      plannedAmount
    })
  }
  return rows
}

function installmentStatus(dueDate: string | null, balance: number): InstallmentStatus {
  if (balance <= 0) return 'paid'
  return isInstallmentSaleDueOverdue(dueDate) ? 'overdue' : 'unpaid'
}

function saleStatus(
  balance: number,
  installments: Array<Pick<InstallmentSaleInstallment, 'dueDate' | 'balanceAmount'>>
): InstallmentSaleStatus {
  if (balance <= 0) return 'completed'
  return installments.some((row) => row.balanceAmount > 0 && isInstallmentSaleDueOverdue(row.dueDate))
    ? 'overdue'
    : 'active'
}

function sanitizeSyncPayload(entity: Record<string, unknown>) {
  const payload = toSnakeCase(entity)
  delete payload.sync_status
  delete payload.last_synced_at
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key]
  }
  return payload
}

async function queueOfflineUpserts(tableName: InstallmentSalesTableName, entities: SyncEntity[]) {
  await Promise.all(
    entities.map((entity) =>
      addToOfflineMutations(tableName, entity.id, entity.version > 1 ? 'update' : 'create', entity, entity.workspaceId)
    )
  )
}

async function syncUpserts(tableName: InstallmentSalesTableName, entities: SyncEntity[], workspaceId: string) {
  if (!entities.length || !shouldUseCloudBusinessData(workspaceId)) return
  if (!isOnline(workspaceId)) {
    await queueOfflineUpserts(tableName, entities)
    return
  }

  try {
    const client = getSupabaseClientForTable(tableName)
    const { error } = (await runSupabaseAction(`${tableName}.sync`, () =>
      client.from(tableName).upsert(entities.map((entity) => sanitizeSyncPayload(entity)))
    )) as { error: unknown }
    if (error) throw error

    const syncedAt = new Date().toISOString()
    await Promise.all(
      entities.map((entity) =>
        tableByName[tableName].update(entity.id, {
          syncStatus: 'synced',
          lastSyncedAt: syncedAt
        } as never)
      )
    )
  } catch (error) {
    console.error(`[InstallmentSales] Failed to sync ${tableName}:`, error)
    await queueOfflineUpserts(tableName, entities)
  }
}

async function assertPartner(workspaceId: string, partnerId: string) {
  const partner = await db.business_partners.get(partnerId)
  if (!partner || partner.workspaceId !== workspaceId || partner.isDeleted || partner.mergedIntoBusinessPartnerId) {
    throw new Error('Customer business partner is required')
  }
  return partner
}

async function refreshPartnerSummaries(sale: Pick<InstallmentSale, 'workspaceId' | 'customerBusinessPartnerId'>) {
  await recalculateBusinessPartnerSummary(sale.workspaceId, sale.customerBusinessPartnerId)
}

function generateSaleNo(id: string, now: Date) {
  const ymd = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`
  return `IS-${ymd}-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`
}

export interface CreateInstallmentSaleInput {
  customerBusinessPartnerId: string
  description: string
  notes?: string | null
  currency: CurrencyCode
  acquisitionCost: number
  totalSalePrice: number
  downPaymentAmount?: number
  installmentCount: number
  hasInstallmentCount?: boolean
  installmentFrequency: InstallmentSaleFrequency
  firstDueDate?: string | null
  downPaymentMethod?: WorkspacePaymentMethod
  downPaymentAccountId?: string | null
  downPaymentAccountNameSnapshot?: string | null
  createdBy?: string | null
}

export async function createInstallmentSale(workspaceId: string, input: CreateInstallmentSaleInput) {
  const now = new Date().toISOString()
  const customer = await assertPartner(workspaceId, input.customerBusinessPartnerId)

  const description = input.description.trim()
  if (!description) throw new Error('A sale description is required')
  const acquisitionCost = roundInstallmentSaleAmount(input.acquisitionCost, input.currency)
  const totalSalePrice = roundInstallmentSaleAmount(input.totalSalePrice, input.currency)
  const downPaymentAmount = roundInstallmentSaleAmount(input.downPaymentAmount || 0, input.currency)
  if (acquisitionCost <= 0) throw new Error('Acquisition cost must be greater than zero')
  if (totalSalePrice < acquisitionCost) throw new Error('Sale price cannot be less than acquisition cost')
  if (downPaymentAmount < 0 || downPaymentAmount >= totalSalePrice)
    throw new Error('Down payment must be less than the total sale price')
  if (downPaymentAmount > 0) {
    assertStandardSettlementPaymentMethod(input.downPaymentMethod || 'cash')
  }

  const isNoFrequency = input.installmentFrequency === 'no_frequency'
  const hasInstallmentCount = !isNoFrequency && input.hasInstallmentCount !== false
  const firstDueDate = isNoFrequency ? null : normalizeInstallmentSaleDueAt(input.firstDueDate)
  const scheduleAmount = roundInstallmentSaleAmount(totalSalePrice - downPaymentAmount, input.currency)
  const plan = buildInstallmentSaleSchedule(
    scheduleAmount,
    input.currency,
    isNoFrequency || !hasInstallmentCount ? 1 : input.installmentCount,
    input.installmentFrequency,
    firstDueDate,
    hasInstallmentCount
  )
  const id = generateId()
  const installments: InstallmentSaleInstallment[] = plan.map((item) => ({
    id: generateId(),
    workspaceId,
    installmentSaleId: id,
    installmentNo: item.installmentNo,
    dueDate: item.dueDate,
    plannedAmount: item.plannedAmount,
    paidAmount: 0,
    balanceAmount: item.plannedAmount,
    status: installmentStatus(item.dueDate, item.plannedAmount),
    paidAt: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    ...getSyncMetadata(workspaceId, now)
  }))
  const sale: InstallmentSale = {
    id,
    workspaceId,
    saleNo: generateSaleNo(id, new Date(now)),
    customerBusinessPartnerId: customer.id,
    customerNameSnapshot: customer.partnerName,
    description,
    notes: input.notes?.trim() || null,
    currency: input.currency,
    acquisitionCost,
    totalSalePrice,
    grossProfit: roundInstallmentSaleAmount(totalSalePrice - acquisitionCost, input.currency),
    downPaymentAmount,
    customerPaidAmount: downPaymentAmount,
    customerBalanceAmount: scheduleAmount,
    installmentCount: installments.length,
    hasInstallmentCount,
    installmentFrequency: input.installmentFrequency,
    firstDueDate,
    nextDueDate: installments[0]?.dueDate ?? null,
    status: saleStatus(scheduleAmount, installments),
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    createdBy: input.createdBy || null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    ...getSyncMetadata(workspaceId, now)
  }
  const downPayment: InstallmentSalePayment | null =
    downPaymentAmount > 0
      ? {
          id: generateId(),
          workspaceId,
          installmentSaleId: sale.id,
          installmentId: null,
          amount: downPaymentAmount,
          paymentMethod: input.downPaymentMethod || 'cash',
          paidAt: now,
          note: 'Initial down payment',
          createdBy: input.createdBy || null,
          createdAt: now,
          updatedAt: now,
          version: 1,
          isDeleted: false,
          ...getSyncMetadata(workspaceId, now)
        }
      : null

  let paymentTransaction: PaymentTransaction | null = null
  try {
    if (downPayment) {
      paymentTransaction = await appendPaymentTransaction(workspaceId, {
        sourceModule: 'installment_sales',
        sourceType: 'installment_sale_down_payment',
        sourceRecordId: sale.id,
        sourceSubrecordId: downPayment.id,
        direction: 'incoming',
        amount: downPayment.amount,
        currency: sale.currency,
        paymentMethod: downPayment.paymentMethod,
        paidAt: downPayment.paidAt,
        counterpartyName: sale.customerNameSnapshot,
        referenceLabel: sale.saleNo,
        note: downPayment.note,
        createdBy: downPayment.createdBy || null,
        accountId: input.downPaymentAccountId ?? null,
        accountNameSnapshot: input.downPaymentAccountNameSnapshot ?? null,
        metadata: {
          installmentSaleId: sale.id,
          installmentSalePaymentId: downPayment.id,
          businessPartnerId: sale.customerBusinessPartnerId,
          paymentKind: 'down_payment'
        }
      })
    }
    await db.transaction(
      'rw',
      [db.installment_sales, db.installment_sale_installments, db.installment_sale_payments],
      async () => {
        await db.installment_sales.put(sale)
        await db.installment_sale_installments.bulkPut(installments)
        if (downPayment) await db.installment_sale_payments.put(downPayment)
      }
    )
  } catch (error) {
    if (paymentTransaction) await softDeletePaymentTransaction(paymentTransaction).catch(() => undefined)
    throw error
  }

  // Child schedule/payment rows have database foreign keys, so persist their
  // parent before attempting an online sync. Offline modes still queue each
  // write independently for later replay.
  await syncUpserts(SALES_TABLE, [sale as unknown as SyncEntity], workspaceId)
  await Promise.all([
    syncUpserts(INSTALLMENTS_TABLE, installments as unknown as SyncEntity[], workspaceId),
    downPayment ? syncUpserts(PAYMENTS_TABLE, [downPayment as unknown as SyncEntity], workspaceId) : Promise.resolve()
  ])
  await refreshPartnerSummaries(sale)
  return { sale, installments, downPayment }
}

export interface RecordInstallmentSaleCustomerPaymentInput {
  installmentSaleId: string
  installmentId?: string | null
  amount: number
  paymentMethod: WorkspacePaymentMethod
  paidAt?: string
  note?: string | null
  createdBy?: string | null
  accountId?: string | null
  accountNameSnapshot?: string | null
}

export async function recordInstallmentSaleCustomerPayment(
  workspaceId: string,
  input: RecordInstallmentSaleCustomerPaymentInput
) {
  const sale = await db.installment_sales.get(input.installmentSaleId)
  if (!sale || sale.workspaceId !== workspaceId || sale.isDeleted || sale.status === 'cancelled')
    throw new Error('Installment sale not found')
  const amount = roundInstallmentSaleAmount(input.amount, sale.currency)
  if (amount <= 0 || amount > sale.customerBalanceAmount)
    throw new Error('Payment amount cannot exceed the customer balance')
  assertStandardSettlementPaymentMethod(input.paymentMethod)
  const now = new Date().toISOString()
  const paidAt = input.paidAt ? new Date(input.paidAt).toISOString() : now
  const existing = await db.installment_sale_installments
    .where('installmentSaleId')
    .equals(sale.id)
    .and((row) => !row.isDeleted)
    .sortBy('installmentNo')
  const installments = existing.map((row) => ({ ...row }))
  const ordered = input.installmentId
    ? [
        ...installments.filter((row) => row.id === input.installmentId),
        ...installments.filter((row) => row.id !== input.installmentId)
      ]
    : installments
  let remaining = amount
  let firstTouched: InstallmentSaleInstallment | null = null
  const changed = new Set<string>()
  for (const row of ordered) {
    if (remaining <= 0 || row.balanceAmount <= 0) continue
    const applied = roundInstallmentSaleAmount(Math.min(remaining, row.balanceAmount), sale.currency)
    row.paidAmount = roundInstallmentSaleAmount(row.paidAmount + applied, sale.currency)
    row.balanceAmount = roundInstallmentSaleAmount(row.balanceAmount - applied, sale.currency)
    row.status = row.balanceAmount <= 0 ? 'paid' : 'partial'
    row.paidAt = row.status === 'paid' ? paidAt : row.paidAt || null
    row.updatedAt = now
    row.version += 1
    row.syncStatus = 'pending'
    row.lastSyncedAt = null
    firstTouched ||= row
    changed.add(row.id)
    remaining = roundInstallmentSaleAmount(remaining - applied, sale.currency)
  }
  for (const row of installments)
    if (!changed.has(row.id) && row.balanceAmount > 0 && row.status !== 'partial')
      row.status = installmentStatus(row.dueDate, row.balanceAmount)
  const customerPaidAmount = roundInstallmentSaleAmount(sale.customerPaidAmount + amount, sale.currency)
  const customerBalanceAmount = roundInstallmentSaleAmount(
    Math.max(sale.totalSalePrice - customerPaidAmount, 0),
    sale.currency
  )
  const updatedSale: InstallmentSale = {
    ...sale,
    customerPaidAmount,
    customerBalanceAmount,
    nextDueDate: installments.find((row) => row.balanceAmount > 0)?.dueDate || null,
    status: saleStatus(customerBalanceAmount, installments),
    updatedAt: now,
    version: sale.version + 1,
    syncStatus: 'pending',
    lastSyncedAt: null
  }
  const payment: InstallmentSalePayment = {
    id: generateId(),
    workspaceId,
    installmentSaleId: sale.id,
    installmentId: firstTouched?.id ?? null,
    amount,
    paymentMethod: input.paymentMethod,
    paidAt,
    note: input.note?.trim() || null,
    createdBy: input.createdBy || null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    ...getSyncMetadata(workspaceId, now)
  }
  let paymentTransaction: PaymentTransaction | null = null
  try {
    paymentTransaction = await appendPaymentTransaction(workspaceId, {
      sourceModule: 'installment_sales',
      sourceType: 'installment_sale_installment',
      sourceRecordId: sale.id,
      sourceSubrecordId: payment.id,
      direction: 'incoming',
      amount,
      currency: sale.currency,
      paymentMethod: input.paymentMethod,
      paidAt,
      counterpartyName: sale.customerNameSnapshot,
      referenceLabel: sale.saleNo,
      note: payment.note,
      createdBy: payment.createdBy || null,
      accountId: input.accountId ?? null,
      accountNameSnapshot: input.accountNameSnapshot ?? null,
      metadata: {
        installmentSaleId: sale.id,
        installmentSalePaymentId: payment.id,
        installmentSaleInstallmentId: payment.installmentId,
        businessPartnerId: sale.customerBusinessPartnerId,
        paymentKind: 'installment'
      }
    })
    await db.transaction(
      'rw',
      [db.installment_sales, db.installment_sale_installments, db.installment_sale_payments],
      async () => {
        await db.installment_sales.put(updatedSale)
        await db.installment_sale_installments.bulkPut(installments)
        await db.installment_sale_payments.put(payment)
      }
    )
  } catch (error) {
    if (paymentTransaction) await softDeletePaymentTransaction(paymentTransaction).catch(() => undefined)
    throw error
  }
  await Promise.all([
    syncUpserts(SALES_TABLE, [updatedSale as unknown as SyncEntity], workspaceId),
    syncUpserts(
      INSTALLMENTS_TABLE,
      installments.filter((row) => changed.has(row.id)) as unknown as SyncEntity[],
      workspaceId
    ),
    syncUpserts(PAYMENTS_TABLE, [payment as unknown as SyncEntity], workspaceId)
  ])
  await refreshPartnerSummaries(updatedSale)
  return { sale: updatedSale, installments, payment }
}

export async function deleteInstallmentSale(saleId: string) {
  const sale = await db.installment_sales.get(saleId)
  if (!sale || sale.isDeleted) return
  const customerPayments = await db.installment_sale_payments
    .where('installmentSaleId')
    .equals(saleId)
    .and((row) => !row.isDeleted)
    .count()
  if (customerPayments > 0 || sale.downPaymentAmount > 0)
    throw new Error('Sales with financial activity must be cancelled through a reversal')
  const now = new Date().toISOString()
  const installments = await db.installment_sale_installments.where('installmentSaleId').equals(saleId).toArray()
  const deletedSale = {
    ...sale,
    isDeleted: true,
    updatedAt: now,
    version: sale.version + 1,
    ...getSyncMetadata(sale.workspaceId, now)
  }
  const deletedInstallments = installments.map((row) => ({
    ...row,
    isDeleted: true,
    updatedAt: now,
    version: row.version + 1,
    ...getSyncMetadata(sale.workspaceId, now)
  }))
  await db.transaction('rw', [db.installment_sales, db.installment_sale_installments], async () => {
    await db.installment_sales.put(deletedSale)
    await db.installment_sale_installments.bulkPut(deletedInstallments)
  })
  await Promise.all([
    syncUpserts(SALES_TABLE, [deletedSale as unknown as SyncEntity], sale.workspaceId),
    syncUpserts(INSTALLMENTS_TABLE, deletedInstallments as unknown as SyncEntity[], sale.workspaceId)
  ])
  await refreshPartnerSummaries(sale)
}

const INSTALLMENT_SALE_PAYMENT_SOURCE_TYPES = new Set([
  'installment_sale_down_payment',
  'installment_sale_installment'
] as const)

/**
 * Rebuilds derived sale balances from immutable payment transactions. This is
 * intentionally used after a payment reversal rather than mutating a payment
 * row, so account movements and the ledger retain their full audit trail.
 */
export async function rebuildInstallmentSalePaymentState(workspaceId: string, saleId: string) {
  const sale = await db.installment_sales.get(saleId)
  if (!sale || sale.workspaceId !== workspaceId || sale.isDeleted || sale.status === 'cancelled') {
    return null
  }

  const [existingInstallments, transactions] = await Promise.all([
    db.installment_sale_installments
      .where('installmentSaleId')
      .equals(saleId)
      .and((row) => !row.isDeleted)
      .sortBy('installmentNo'),
    db.payment_transactions
      .where('workspaceId')
      .equals(workspaceId)
      .and(
        (transaction) =>
          !transaction.isDeleted &&
          transaction.sourceModule === 'installment_sales' &&
          transaction.sourceRecordId === saleId &&
          INSTALLMENT_SALE_PAYMENT_SOURCE_TYPES.has(
            transaction.sourceType as typeof INSTALLMENT_SALE_PAYMENT_SOURCE_TYPES extends Set<infer T> ? T : never
          )
      )
      .toArray()
  ])

  const sumFor = (sourceType: typeof INSTALLMENT_SALE_PAYMENT_SOURCE_TYPES extends Set<infer T> ? T : never) =>
    roundInstallmentSaleAmount(
      transactions
        .filter((transaction) => transaction.sourceType === sourceType)
        .reduce((sum, transaction) => sum + transaction.amount, 0),
      sale.currency
    )

  const netDownPayment = Math.max(0, sumFor('installment_sale_down_payment'))
  const netInstallmentPayments = Math.max(0, sumFor('installment_sale_installment'))
  const scheduleAmount = roundInstallmentSaleAmount(sale.totalSalePrice - netDownPayment, sale.currency)
  const plan = buildInstallmentSaleSchedule(
    scheduleAmount,
    sale.currency,
    sale.installmentCount,
    sale.installmentFrequency,
    sale.firstDueDate,
    sale.hasInstallmentCount !== false
  )
  const now = new Date().toISOString()
  let remainingPayment = Math.min(netInstallmentPayments, scheduleAmount)
  const installments = plan.map((item, index) => {
    const existing = existingInstallments[index]
    const paidAmount = roundInstallmentSaleAmount(Math.min(remainingPayment, item.plannedAmount), sale.currency)
    const balanceAmount = roundInstallmentSaleAmount(item.plannedAmount - paidAmount, sale.currency)
    remainingPayment = roundInstallmentSaleAmount(remainingPayment - paidAmount, sale.currency)
    const status =
      balanceAmount <= 0 ? 'paid' : paidAmount > 0 ? 'partial' : installmentStatus(item.dueDate, balanceAmount)
    return {
      ...(existing || {
        id: generateId(),
        workspaceId,
        installmentSaleId: sale.id,
        createdAt: now,
        version: 0,
        isDeleted: false
      }),
      installmentNo: item.installmentNo,
      dueDate: item.dueDate,
      plannedAmount: item.plannedAmount,
      paidAmount,
      balanceAmount,
      status,
      paidAt: status === 'paid' ? existing?.paidAt || now : null,
      updatedAt: now,
      version: (existing?.version || 0) + 1,
      ...getSyncMetadata(workspaceId, now)
    } satisfies InstallmentSaleInstallment
  })
  const customerPaidAmount = roundInstallmentSaleAmount(netDownPayment + netInstallmentPayments, sale.currency)
  const customerBalanceAmount = roundInstallmentSaleAmount(
    Math.max(sale.totalSalePrice - customerPaidAmount, 0),
    sale.currency
  )
  const updatedSale: InstallmentSale = {
    ...sale,
    customerPaidAmount,
    customerBalanceAmount,
    nextDueDate: installments.find((row) => row.balanceAmount > 0)?.dueDate || null,
    status: saleStatus(customerBalanceAmount, installments),
    updatedAt: now,
    version: sale.version + 1,
    ...getSyncMetadata(workspaceId, now)
  }

  await db.transaction('rw', [db.installment_sales, db.installment_sale_installments], async () => {
    await db.installment_sales.put(updatedSale)
    await db.installment_sale_installments.bulkPut(installments)
  })
  await Promise.all([
    syncUpserts(SALES_TABLE, [updatedSale as unknown as SyncEntity], workspaceId),
    syncUpserts(INSTALLMENTS_TABLE, installments as unknown as SyncEntity[], workspaceId)
  ])
  await refreshPartnerSummaries(updatedSale)
  return updatedSale
}

export interface CancelInstallmentSaleInput {
  reason: string
  cancelledBy?: string | null
  cancelledAt?: string
}

/** Cancels the complete sale and posts immutable reversals for every payment. */
export async function cancelInstallmentSale(workspaceId: string, saleId: string, input: CancelInstallmentSaleInput) {
  const sale = await db.installment_sales.get(saleId)
  if (!sale || sale.workspaceId !== workspaceId || sale.isDeleted || sale.status === 'cancelled') {
    throw new Error('Installment sale not found')
  }
  const reason = input.reason.trim()
  if (!reason) throw new Error('A cancellation reason is required')

  const transactions = await db.payment_transactions
    .where('workspaceId')
    .equals(workspaceId)
    .and(
      (transaction) =>
        !transaction.isDeleted &&
        transaction.sourceModule === 'installment_sales' &&
        transaction.sourceRecordId === saleId &&
        INSTALLMENT_SALE_PAYMENT_SOURCE_TYPES.has(
          transaction.sourceType as typeof INSTALLMENT_SALE_PAYMENT_SOURCE_TYPES extends Set<infer T> ? T : never
        )
    )
    .toArray()
  const reversedTransactionIds = new Set(
    transactions.map((transaction) => transaction.reversalOfTransactionId).filter((id): id is string => !!id)
  )
  const cancelledAt = input.cancelledAt ? new Date(input.cancelledAt).toISOString() : new Date().toISOString()

  for (const transaction of transactions
    .filter((transaction) => !transaction.reversalOfTransactionId && !reversedTransactionIds.has(transaction.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
    await reversePaymentTransaction(workspaceId, transaction.id, {
      paidAt: cancelledAt,
      note: `${reason} — ${transaction.referenceLabel || sale.saleNo}`,
      createdBy: input.cancelledBy || null
    })
  }

  const installments = await db.installment_sale_installments
    .where('installmentSaleId')
    .equals(saleId)
    .and((row) => !row.isDeleted)
    .toArray()
  const now = new Date().toISOString()
  const cancelledInstallments = installments.map((row) => ({
    ...row,
    paidAmount: 0,
    balanceAmount: 0,
    status: 'cancelled' as const,
    paidAt: null,
    updatedAt: now,
    version: row.version + 1,
    ...getSyncMetadata(workspaceId, now)
  }))
  const cancelledSale: InstallmentSale = {
    ...sale,
    customerPaidAmount: 0,
    customerBalanceAmount: 0,
    nextDueDate: null,
    status: 'cancelled',
    cancelledAt,
    cancelledBy: input.cancelledBy || null,
    cancellationReason: reason,
    updatedAt: now,
    version: sale.version + 1,
    ...getSyncMetadata(workspaceId, now)
  }
  await db.transaction('rw', [db.installment_sales, db.installment_sale_installments], async () => {
    await db.installment_sales.put(cancelledSale)
    await db.installment_sale_installments.bulkPut(cancelledInstallments)
  })
  await Promise.all([
    syncUpserts(SALES_TABLE, [cancelledSale as unknown as SyncEntity], workspaceId),
    syncUpserts(INSTALLMENTS_TABLE, cancelledInstallments as unknown as SyncEntity[], workspaceId)
  ])
  await refreshPartnerSummaries(cancelledSale)
  return cancelledSale
}

async function canAccessSaleInLocalCache(sale: InstallmentSale, viewOwnScope: ViewOwnRecordScope) {
  if (sale.isDeleted) return false
  if (viewOwnScope.isRestricted && sale.createdBy !== viewOwnScope.userId) {
    return false
  }
  return canAccessBusinessPartnerInLocalCache(sale.workspaceId, sale.customerBusinessPartnerId, 'customer')
}

export function useInstallmentSales(workspaceId: string | undefined) {
  const viewOwnScope = useViewOwnRecordScope('installments.view_own')
  const rows = useLiveQuery(async () => {
    if (!workspaceId) return []
    const sales = await db.installment_sales
      .where('workspaceId')
      .equals(workspaceId)
      .and((row) => !row.isDeleted)
      .reverse()
      .sortBy('createdAt')
    const visible = await Promise.all(sales.map((sale) => canAccessSaleInLocalCache(sale, viewOwnScope)))
    return sales.filter((_, index) => visible[index])
  }, [workspaceId, viewOwnScope.isRestricted, viewOwnScope.userId])
  useEffect(() => {
    if (workspaceId && shouldUseCloudBusinessData(workspaceId) && isOnline(workspaceId))
      void Promise.all([
        fetchTableFromSupabase(SALES_TABLE, db.installment_sales, workspaceId),
        fetchTableFromSupabase(INSTALLMENTS_TABLE, db.installment_sale_installments, workspaceId),
        fetchTableFromSupabase(PAYMENTS_TABLE, db.installment_sale_payments, workspaceId)
      ])
  }, [workspaceId, viewOwnScope.isRestricted, viewOwnScope.userId])
  return rows ?? []
}

export function useInstallmentSale(saleId: string | undefined, workspaceId?: string) {
  const viewOwnScope = useViewOwnRecordScope('installments.view_own')
  const sale = useLiveQuery(async () => {
    if (!saleId) return undefined
    const row = await db.installment_sales.get(saleId)
    if (
      !row ||
      (workspaceId && row.workspaceId !== workspaceId) ||
      !(await canAccessSaleInLocalCache(row, viewOwnScope))
    ) {
      return undefined
    }
    return row
  }, [saleId, workspaceId, viewOwnScope.isRestricted, viewOwnScope.userId])

  useEffect(() => {
    if (workspaceId && shouldUseCloudBusinessData(workspaceId) && isOnline(workspaceId)) {
      void Promise.all([
        fetchTableFromSupabase(SALES_TABLE, db.installment_sales, workspaceId),
        fetchTableFromSupabase(INSTALLMENTS_TABLE, db.installment_sale_installments, workspaceId),
        fetchTableFromSupabase(PAYMENTS_TABLE, db.installment_sale_payments, workspaceId)
      ])
    }
  }, [workspaceId])

  return sale
}

export function useInstallmentSaleInstallments(saleId: string | undefined) {
  const viewOwnScope = useViewOwnRecordScope('installments.view_own')
  return (
    useLiveQuery(async () => {
      if (!saleId) return []
      const sale = await db.installment_sales.get(saleId)
      if (!sale || !(await canAccessSaleInLocalCache(sale, viewOwnScope))) {
        return []
      }
      return db.installment_sale_installments
        .where('installmentSaleId')
        .equals(saleId)
        .and((row) => !row.isDeleted)
        .sortBy('installmentNo')
    }, [saleId, viewOwnScope.isRestricted, viewOwnScope.userId]) ?? []
  )
}

export function useInstallmentSalePayments(saleId: string | undefined) {
  const viewOwnScope = useViewOwnRecordScope('installments.view_own')
  return (
    useLiveQuery(async () => {
      if (!saleId) return []
      const sale = await db.installment_sales.get(saleId)
      if (!sale || !(await canAccessSaleInLocalCache(sale, viewOwnScope))) {
        return []
      }
      return db.installment_sale_payments
        .where('installmentSaleId')
        .equals(saleId)
        .and((row) => !row.isDeleted)
        .reverse()
        .sortBy('paidAt')
    }, [saleId, viewOwnScope.isRestricted, viewOwnScope.userId]) ?? []
  )
}

export function useInstallmentSalePaymentTransactions(saleId: string | undefined) {
  const viewOwnScope = useViewOwnRecordScope('installments.view_own')
  return (
    useLiveQuery(async () => {
      if (!saleId) return []
      const sale = await db.installment_sales.get(saleId)
      if (!sale || !(await canAccessSaleInLocalCache(sale, viewOwnScope))) {
        return []
      }
      return db.payment_transactions
        .where('workspaceId')
        .equals(sale.workspaceId)
        .and(
          (row) =>
            !row.isDeleted &&
            row.sourceModule === 'installment_sales' &&
            row.sourceRecordId === saleId &&
            INSTALLMENT_SALE_PAYMENT_SOURCE_TYPES.has(
              row.sourceType as typeof INSTALLMENT_SALE_PAYMENT_SOURCE_TYPES extends Set<infer T> ? T : never
            )
        )
        .reverse()
        .sortBy('paidAt')
    }, [saleId, viewOwnScope.isRestricted, viewOwnScope.userId]) ?? []
  )
}
