import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { generateId, toSnakeCase } from '@/lib/utils'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { getPaymentTransactionReversalState } from '@/lib/paymentReversals'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { addToOfflineMutations, fetchTableFromSupabase } from './hooks'
import { appendPaymentTransaction, replacePaymentTransactionForSource } from './payments'
import type {
    ActivityCatalogItem,
    ActivityTransaction,
    ActivityTransactionLine,
    ActivityTransactionStatus,
    CurrencyCode,
    PaymentTransaction,
    WorkspacePaymentMethod
} from './models'

const CATALOG_TABLE = 'activity_catalog'
const TRANSACTIONS_TABLE = 'activity_transactions'
const LINES_TABLE = 'activity_transaction_lines'

type ActivitiesTableName =
    | typeof CATALOG_TABLE
    | typeof TRANSACTIONS_TABLE
    | typeof LINES_TABLE

type ActivitiesEntity = Record<string, unknown> & {
    id: string
    workspaceId: string
    version: number
}

const tableByName = {
    [CATALOG_TABLE]: db.activity_catalog,
    [TRANSACTIONS_TABLE]: db.activity_transactions,
    [LINES_TABLE]: db.activity_transaction_lines
} as const

function shouldUseCloudBusinessData(workspaceId?: string | null) {
    return !!workspaceId && !isLocalWorkspaceMode(workspaceId)
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
    return shouldUseCloudBusinessData(workspaceId)
        ? { syncStatus: 'pending' as const, lastSyncedAt: null }
        : { syncStatus: 'synced' as const, lastSyncedAt: timestamp }
}

function roundAmount(value: number, currency: CurrencyCode) {
    const precision = currency === 'iqd' ? 0 : 2
    const multiplier = 10 ** precision
    return Math.round((Number(value) || 0) * multiplier) / multiplier
}

function normalizeOptionalText(value?: string | null) {
    const text = String(value || '').trim()
    return text || null
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

async function markEntitiesSynced(tableName: ActivitiesTableName, ids: string[]) {
    const table = tableByName[tableName]
    const lastSyncedAt = new Date().toISOString()
    await Promise.all(ids.map((id) => table.update(id, { syncStatus: 'synced', lastSyncedAt } as never)))
}

async function queueUpserts(tableName: ActivitiesTableName, entities: ActivitiesEntity[]) {
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

async function syncUpserts(tableName: ActivitiesTableName, entities: ActivitiesEntity[], workspaceId: string) {
    if (!entities.length || !shouldUseCloudBusinessData(workspaceId)) return

    if (!isOnline(workspaceId)) {
        await queueUpserts(tableName, entities)
        return
    }

    try {
        const client = getSupabaseClientForTable(tableName)
        const { error } = await runSupabaseAction(`${tableName}.sync`, () =>
            client.from(tableName).upsert(entities.map((entity) => sanitizeSyncPayload(entity)))
        ) as any
        if (error) throw error
        await markEntitiesSynced(tableName, entities.map((entity) => entity.id))
    } catch (error) {
        console.error(`[Activities] Failed to sync ${tableName}:`, error)
        await queueUpserts(tableName, entities)
    }
}

async function syncHardDelete(tableName: ActivitiesTableName, entityId: string, workspaceId: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) return

    if (!isOnline(workspaceId)) {
        await addToOfflineMutations(tableName, entityId, 'delete', { id: entityId, hardDelete: true }, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable(tableName)
        const { error } = await runSupabaseAction(`${tableName}.delete`, () =>
            client.from(tableName).delete().eq('id', entityId)
        ) as any
        if (error) throw error
    } catch (error) {
        console.error(`[Activities] Failed to delete ${tableName}:`, error)
        await addToOfflineMutations(tableName, entityId, 'delete', { id: entityId, hardDelete: true }, workspaceId)
    }
}

async function syncPaymentHardDelete(entityId: string, workspaceId: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) return

    if (!isOnline(workspaceId)) {
        await addToOfflineMutations('payment_transactions', entityId, 'delete', { id: entityId, hardDelete: true }, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable('payment_transactions')
        const { error } = await runSupabaseAction('payment_transactions.delete', () =>
            client.from('payment_transactions').delete().eq('id', entityId)
        ) as any
        if (error) throw error
    } catch (error) {
        console.error('[Activities] Failed to delete linked payment transaction:', error)
        await addToOfflineMutations('payment_transactions', entityId, 'delete', { id: entityId, hardDelete: true }, workspaceId)
    }
}

async function generateTransactionNo(workspaceId: string, occurredAt: string) {
    const year = occurredAt.slice(0, 4)
    const count = (await db.activity_transactions.where('workspaceId').equals(workspaceId).toArray())
        .filter((row) => row.occurredAt.startsWith(`${year}-`)).length + 1
    return `ACT-${year}-${String(count).padStart(5, '0')}`
}

async function getCatalogForLines(workspaceId: string, lines: ActivityTransactionLineInput[]) {
    const ids = Array.from(new Set(lines.map((line) => line.activityId)))
    const catalog = await db.activity_catalog.bulkGet(ids)
    const catalogById = new Map(catalog.filter(Boolean).map((item) => [item!.id, item!]))

    for (const line of lines) {
        const item = catalogById.get(line.activityId)
        if (!item || item.workspaceId !== workspaceId || item.isDeleted || !item.isActive) {
            throw new Error('An activity in this transaction is no longer available')
        }
    }

    return catalogById
}

function groupQuantities(lines: Array<Pick<ActivityTransactionLineInput, 'activityId' | 'quantity'>>) {
    return lines.reduce((quantities, line) => {
        quantities.set(line.activityId, (quantities.get(line.activityId) || 0) + Number(line.quantity || 0))
        return quantities
    }, new Map<string, number>())
}

function assertAvailability(catalogById: Map<string, ActivityCatalogItem>, lines: ActivityTransactionLineInput[]) {
    for (const [activityId, requestedQuantity] of groupQuantities(lines)) {
        const activity = catalogById.get(activityId)
        if (!activity || activity.isInfinite) continue
        if (requestedQuantity > Math.max(0, Number(activity.availableQuantity || 0))) {
            throw new Error(`${activity.name} has only ${Math.max(0, Number(activity.availableQuantity || 0))} available`)
        }
    }
}

function assertAvailabilityForUpdate(
    catalogById: Map<string, ActivityCatalogItem>,
    previousLines: ActivityTransactionLine[],
    nextLines: ActivityTransactionLineInput[]
) {
    const previouslyConsumed = groupQuantities(previousLines)
    for (const [activityId, requestedQuantity] of groupQuantities(nextLines)) {
        const activity = catalogById.get(activityId)
        if (!activity || activity.isInfinite) continue

        const availableAfterRestoringThisTransaction = Math.max(0, Number(activity.availableQuantity || 0))
            + (previouslyConsumed.get(activityId) || 0)
        if (requestedQuantity > availableAfterRestoringThisTransaction) {
            throw new Error(`${activity.name} has only ${availableAfterRestoringThisTransaction} available`)
        }
    }
}

async function adjustLocalAvailability(lines: Array<Pick<ActivityTransactionLine, 'activityId' | 'quantity'>>, direction: 'consume' | 'restore') {
    const multiplier = direction === 'consume' ? -1 : 1
    for (const [activityId, quantity] of groupQuantities(lines)) {
        const activity = await db.activity_catalog.get(activityId)
        if (!activity || activity.isInfinite) continue
        await db.activity_catalog.update(activityId, {
            availableQuantity: Math.max(0, Number(activity.availableQuantity || 0) + multiplier * quantity),
            updatedAt: new Date().toISOString()
        })
    }
}

export interface ActivityCatalogInput {
    name: string
    imageUrl?: string | null
    defaultUnitPrice: number
    currency: CurrencyCode
    isInfinite: boolean
    availableQuantity?: number | null
    isActive?: boolean
    createdBy?: string | null
}

export async function saveActivityCatalogItem(workspaceId: string, input: ActivityCatalogInput, itemId?: string) {
    const name = input.name.trim()
    const defaultUnitPrice = roundAmount(Math.max(0, Number(input.defaultUnitPrice || 0)), input.currency)
    const availableQuantity = input.isInfinite ? null : Math.max(0, Number(input.availableQuantity || 0))
    if (!name) throw new Error('Activity name is required')
    if (!input.isInfinite && input.availableQuantity === undefined) throw new Error('Available quantity is required for finite activities')

    const now = new Date().toISOString()
    const existing = itemId ? await db.activity_catalog.get(itemId) : undefined
    if (existing && (existing.workspaceId !== workspaceId || existing.isDeleted)) throw new Error('Activity not found')

    const activity: ActivityCatalogItem = {
        id: existing?.id || generateId(),
        workspaceId,
        name,
        imageUrl: input.imageUrl === undefined
            ? existing?.imageUrl ?? null
            : normalizeOptionalText(input.imageUrl),
        defaultUnitPrice,
        currency: input.currency,
        isInfinite: input.isInfinite,
        availableQuantity,
        isActive: input.isActive ?? existing?.isActive ?? true,
        createdBy: existing?.createdBy ?? input.createdBy ?? null,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        version: existing ? existing.version + 1 : 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }

    await db.activity_catalog.put(activity)
    await syncUpserts(CATALOG_TABLE, [activity as unknown as ActivitiesEntity], workspaceId)
    return activity
}

export async function setActivityCatalogStatus(activityId: string, isActive: boolean) {
    const activity = await db.activity_catalog.get(activityId)
    if (!activity || activity.isDeleted) throw new Error('Activity not found')

    const now = new Date().toISOString()
    const updated = {
        ...activity,
        isActive,
        updatedAt: now,
        version: activity.version + 1,
        ...getSyncMetadata(activity.workspaceId, now)
    }
    await db.activity_catalog.put(updated)
    await syncUpserts(CATALOG_TABLE, [updated as unknown as ActivitiesEntity], activity.workspaceId)
    return updated
}

export interface ActivityTransactionLineInput {
    id?: string
    activityId: string
    quantity: number
    unitPrice: number
}

export interface ActivityTransactionInput {
    name: string
    customerName?: string | null
    occurredAt: string
    currency: CurrencyCode
    paymentMethod: WorkspacePaymentMethod
    notes?: string | null
    lines: ActivityTransactionLineInput[]
    createdBy?: string | null
    /** Optional account context; omitted keeps this as a normal ledger payment. */
    accountId?: string | null
    accountNameSnapshot?: string | null
}

function validateTransactionInput(input: ActivityTransactionInput) {
    if (!input.name.trim()) throw new Error('Transaction name is required')
    if (!input.lines.length) throw new Error('Add at least one activity')
    for (const line of input.lines) {
        if (!line.activityId || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) {
            throw new Error('Every activity line needs a quantity greater than zero')
        }
        if (!Number.isFinite(Number(line.unitPrice)) || Number(line.unitPrice) < 0) {
            throw new Error('Every activity line needs a valid unit price')
        }
    }
}

function buildTransactionLines(
    workspaceId: string,
    transactionId: string,
    input: ActivityTransactionInput,
    catalogById: Map<string, ActivityCatalogItem>,
    existingById: Map<string, ActivityTransactionLine> = new Map()
) {
    const now = new Date().toISOString()
    return input.lines.map((line) => {
        const catalog = catalogById.get(line.activityId)!
        if (catalog.currency !== input.currency) {
            throw new Error(`${catalog.name} must be repriced in the workspace default currency before it can be sold`)
        }
        const existing = line.id ? existingById.get(line.id) : undefined
        const unitPrice = roundAmount(Number(line.unitPrice), input.currency)
        const quantity = Number(line.quantity)
        return {
            id: existing?.id || generateId(),
            workspaceId,
            transactionId,
            activityId: catalog.id,
            activityNameSnapshot: catalog.name,
            catalogUnitPriceSnapshot: catalog.defaultUnitPrice,
            unitPrice,
            priceOverridden: unitPrice !== catalog.defaultUnitPrice,
            quantity,
            lineTotal: roundAmount(unitPrice * quantity, input.currency),
            createdAt: existing?.createdAt || now,
            updatedAt: now,
            version: existing ? existing.version + 1 : 1,
            isDeleted: false,
            ...getSyncMetadata(workspaceId, now)
        } satisfies ActivityTransactionLine
    })
}

function getTotals(lines: ActivityTransactionLine[], currency: CurrencyCode) {
    const total = roundAmount(lines.reduce((sum, line) => sum + line.lineTotal, 0), currency)
    if (total <= 0) throw new Error('Transaction total must be greater than zero')
    return { subtotalAmount: total, totalAmount: total }
}

export async function createActivityTransaction(workspaceId: string, input: ActivityTransactionInput) {
    validateTransactionInput(input)
    const catalogById = await getCatalogForLines(workspaceId, input.lines)
    assertAvailability(catalogById, input.lines)

    const now = new Date().toISOString()
    const transactionId = generateId()
    const lines = buildTransactionLines(workspaceId, transactionId, input, catalogById)
    const totals = getTotals(lines, input.currency)
    const occurredAt = new Date(input.occurredAt || now).toISOString()
    const transaction: ActivityTransaction = {
        id: transactionId,
        workspaceId,
        transactionNo: await generateTransactionNo(workspaceId, occurredAt),
        name: input.name.trim(),
        customerName: normalizeOptionalText(input.customerName),
        occurredAt,
        currency: input.currency,
        paymentMethod: input.paymentMethod,
        ...totals,
        status: 'completed',
        notes: normalizeOptionalText(input.notes),
        createdBy: input.createdBy ?? null,
        cancelledAt: null,
        refundedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }

    await db.transaction('rw', [db.activity_transactions, db.activity_transaction_lines, db.activity_catalog], async () => {
        await db.activity_transactions.put(transaction)
        await db.activity_transaction_lines.bulkPut(lines)
        await adjustLocalAvailability(lines, 'consume')
    })

    // The line rows have a foreign key to their header, so preserve the parent → line
    // order when the device is online as well as when queued for offline sync.
    await syncUpserts(TRANSACTIONS_TABLE, [transaction as unknown as ActivitiesEntity], workspaceId)
    await syncUpserts(LINES_TABLE, lines as unknown as ActivitiesEntity[], workspaceId)
    await appendPaymentTransaction(workspaceId, {
        sourceModule: 'activities',
        sourceType: 'activity_transaction',
        sourceRecordId: transaction.id,
        direction: 'incoming',
        amount: transaction.totalAmount,
        currency: transaction.currency,
        paymentMethod: transaction.paymentMethod,
        paidAt: transaction.occurredAt,
        counterpartyName: transaction.customerName || null,
        referenceLabel: transaction.transactionNo,
        note: transaction.name,
        createdBy: transaction.createdBy ?? null,
        accountId: input.accountId ?? null,
        accountNameSnapshot: input.accountNameSnapshot ?? null,
        metadata: { activityTransactionId: transaction.id, transactionNo: transaction.transactionNo }
    })

    return { transaction, lines }
}

export async function updateActivityTransaction(workspaceId: string, transactionId: string, input: ActivityTransactionInput) {
    validateTransactionInput(input)
    const existing = await db.activity_transactions.get(transactionId)
    if (!existing || existing.workspaceId !== workspaceId || existing.isDeleted || existing.status !== 'completed') {
        throw new Error('Only completed activity transactions can be edited')
    }

    const previousLines = await db.activity_transaction_lines.where('transactionId').equals(transactionId).and((line) => !line.isDeleted).toArray()
    const previousPayment = await db.payment_transactions
        .where('[workspaceId+sourceType+sourceRecordId]')
        .equals([workspaceId, 'activity_transaction', transactionId])
        .and((payment) => !payment.isDeleted && !payment.reversalOfTransactionId)
        .first()
    const catalogById = await getCatalogForLines(workspaceId, input.lines)
    const existingById = new Map(previousLines.map((line) => [line.id, line]))
    const lines = buildTransactionLines(workspaceId, transactionId, input, catalogById, existingById)
    assertAvailabilityForUpdate(catalogById, previousLines, input.lines)
    const totals = getTotals(lines, input.currency)
    const now = new Date().toISOString()
    const transaction: ActivityTransaction = {
        ...existing,
        name: input.name.trim(),
        customerName: normalizeOptionalText(input.customerName),
        occurredAt: new Date(input.occurredAt || now).toISOString(),
        currency: input.currency,
        paymentMethod: input.paymentMethod,
        ...totals,
        notes: normalizeOptionalText(input.notes),
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(workspaceId, now)
    }
    const currentIds = new Set(lines.map((line) => line.id))
    const removedLines = previousLines.filter((line) => !currentIds.has(line.id))

    await db.transaction('rw', [db.activity_transactions, db.activity_transaction_lines, db.activity_catalog], async () => {
        await adjustLocalAvailability(previousLines, 'restore')
        await db.activity_transactions.put(transaction)
        await db.activity_transaction_lines.bulkPut(lines)
        if (removedLines.length) await db.activity_transaction_lines.bulkDelete(removedLines.map((line) => line.id))
        await adjustLocalAvailability(lines, 'consume')
    })

    await Promise.all([
        syncUpserts(TRANSACTIONS_TABLE, [transaction as unknown as ActivitiesEntity], workspaceId),
        syncUpserts(LINES_TABLE, lines as unknown as ActivitiesEntity[], workspaceId),
        ...removedLines.map((line) => syncHardDelete(LINES_TABLE, line.id, workspaceId)),
        replacePaymentTransactionForSource(workspaceId, {
            sourceType: 'activity_transaction',
            sourceRecordId: transaction.id,
            sourceSubrecordId: null
        }, {
            sourceModule: 'activities',
            sourceType: 'activity_transaction',
            sourceRecordId: transaction.id,
            direction: 'incoming',
            amount: transaction.totalAmount,
            currency: transaction.currency,
            paymentMethod: transaction.paymentMethod,
            paidAt: transaction.occurredAt,
            counterpartyName: transaction.customerName || null,
            referenceLabel: transaction.transactionNo,
            note: transaction.name,
            createdBy: transaction.createdBy ?? null,
            // Payment-account assignment is immutable after posting. Editing the
            // activity updates its amount/details while retaining the original account.
            accountId: previousPayment?.accountId ?? null,
            accountNameSnapshot: previousPayment?.accountNameSnapshot ?? null,
            metadata: { activityTransactionId: transaction.id, transactionNo: transaction.transactionNo }
        })
    ])
    return { transaction, lines }
}

/** Updates the transaction note without changing the completed activity sale or its availability. */
export async function updateActivityTransactionNotes(workspaceId: string, transactionId: string, notes: string | null | undefined) {
    const existing = await db.activity_transactions.get(transactionId)
    if (!existing || existing.workspaceId !== workspaceId || existing.isDeleted) {
        throw new Error('Activity transaction not found')
    }

    const now = new Date().toISOString()
    const transaction: ActivityTransaction = {
        ...existing,
        notes: normalizeOptionalText(notes),
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(workspaceId, now)
    }

    await db.activity_transactions.put(transaction)
    await syncUpserts(TRANSACTIONS_TABLE, [transaction as unknown as ActivitiesEntity], workspaceId)
    return transaction
}

export async function reverseActivityTransaction(
    workspaceId: string,
    transactionId: string,
    status: Extract<ActivityTransactionStatus, 'cancelled' | 'refunded'>,
    createdBy?: string | null,
    selection: {
        accountId?: string | null
        accountNameSnapshot?: string | null
        paidAt?: string
        note?: string
        amount?: number
        paymentMethod?: PaymentTransaction['paymentMethod']
    } = {}
) {
    const transaction = await db.activity_transactions.get(transactionId)
    if (!transaction || transaction.workspaceId !== workspaceId || transaction.isDeleted || transaction.status !== 'completed') {
        throw new Error('Only completed activity transactions can be cancelled or refunded')
    }

    const lines = await db.activity_transaction_lines.where('transactionId').equals(transactionId).and((line) => !line.isDeleted).toArray()
    const originalPayment = await db.payment_transactions
        .where('[workspaceId+sourceType+sourceRecordId]')
        .equals([workspaceId, 'activity_transaction', transactionId])
        .and((payment) => !payment.isDeleted && !payment.reversalOfTransactionId)
        .first()
    const relatedPayments = originalPayment
        ? await db.payment_transactions.where('workspaceId').equals(workspaceId).toArray()
        : []
    const reversalState = originalPayment
        ? getPaymentTransactionReversalState(originalPayment, relatedPayments)
        : null
    const reversalAmount = Number(selection.amount ?? reversalState?.remainingAmount ?? 0)
    if (reversalState?.status === 'fully_reversed') {
        throw new Error('This payment has already been fully reversed')
    }
    if (
        originalPayment
        && (!Number.isFinite(reversalAmount)
            || reversalAmount <= 0.000001
            || Math.abs(reversalAmount - (reversalState?.remainingAmount ?? 0)) > 0.000001)
    ) {
        throw new Error('Activity payments can only be reversed for their full remaining amount')
    }
    const now = new Date().toISOString()
    const updated: ActivityTransaction = {
        ...transaction,
        status,
        cancelledAt: status === 'cancelled' ? now : transaction.cancelledAt,
        refundedAt: status === 'refunded' ? now : transaction.refundedAt,
        updatedAt: now,
        version: transaction.version + 1,
        ...getSyncMetadata(workspaceId, now)
    }

    let refundPayment: PaymentTransaction | null = null
    if (originalPayment) {
        // A refund takes money out of the selected account. Post and validate it
        // before restoring inventory or changing the activity's final status.
        refundPayment = await appendPaymentTransaction(workspaceId, {
            sourceModule: 'activities',
            sourceType: 'activity_refund',
            sourceRecordId: transaction.id,
            sourceSubrecordId: originalPayment.id,
            direction: 'outgoing',
            amount: reversalAmount,
            currency: transaction.currency,
            paymentMethod: selection.paymentMethod ?? transaction.paymentMethod,
            paidAt: selection.paidAt ? new Date(selection.paidAt).toISOString() : now,
            counterpartyName: transaction.customerName || null,
            referenceLabel: `${transaction.transactionNo} / ${status === 'cancelled' ? 'Cancellation' : 'Refund'}`,
            note: normalizeOptionalText(selection.note) || transaction.name,
            createdBy: createdBy ?? transaction.createdBy ?? null,
            accountId: selection.accountId === undefined ? originalPayment.accountId ?? null : selection.accountId,
            accountNameSnapshot: selection.accountNameSnapshot === undefined
                ? originalPayment.accountNameSnapshot ?? null
                : selection.accountNameSnapshot,
            reversalOfTransactionId: originalPayment.id,
            metadata: { activityTransactionId: transaction.id, action: status }
        })
    }

    try {
        await db.transaction('rw', [db.activity_transactions, db.activity_catalog], async () => {
            await db.activity_transactions.put(updated)
            await adjustLocalAvailability(lines, 'restore')
        })
    } catch (error) {
        if (refundPayment) {
            try {
                const { softDeletePaymentTransaction } = await import('./payments')
                await softDeletePaymentTransaction(refundPayment)
            } catch (cleanupError) {
                console.error('[Activities] Failed to roll back the refund payment after activity reversal failed:', cleanupError)
            }
        }
        throw error
    }

    await syncUpserts(TRANSACTIONS_TABLE, [updated as unknown as ActivitiesEntity], workspaceId)
    return updated
}

export async function hardDeleteActivityTransaction(workspaceId: string, transactionId: string) {
    const transaction = await db.activity_transactions.get(transactionId)
    if (!transaction || transaction.workspaceId !== workspaceId || transaction.isDeleted) return

    const lines = await db.activity_transaction_lines.where('transactionId').equals(transactionId).toArray()
    const payments = (await db.payment_transactions.where('workspaceId').equals(workspaceId).toArray())
        .filter((payment) => payment.sourceModule === 'activities' && payment.sourceRecordId === transactionId)

    if (payments.some((payment) => payment.accountId)) {
        throw new Error('An activity with a posted payment account movement cannot be permanently deleted. Reverse or refund the payment instead.')
    }

    await db.transaction('rw', [db.activity_transactions, db.activity_transaction_lines, db.activity_catalog, db.payment_transactions], async () => {
        if (transaction.status === 'completed') await adjustLocalAvailability(lines, 'restore')
        await db.activity_transaction_lines.bulkDelete(lines.map((line) => line.id))
        await db.activity_transactions.delete(transaction.id)
        await db.payment_transactions.bulkDelete(payments.map((payment) => payment.id))
    })

    await Promise.all([
        syncHardDelete(TRANSACTIONS_TABLE, transaction.id, workspaceId),
        ...payments.map((payment) => syncPaymentHardDelete(payment.id, workspaceId))
    ])
}

export function useActivityCatalog(workspaceId: string | undefined) {
    const items = useLiveQuery(
        () => workspaceId
            ? db.activity_catalog.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).sortBy('name')
            : [],
        [workspaceId]
    )

    useEffect(() => {
        if (workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void fetchTableFromSupabase(CATALOG_TABLE, db.activity_catalog, workspaceId)
        }
    }, [workspaceId])

    return items ?? []
}

export function useActivityTransactions(workspaceId: string | undefined) {
    const transactions = useLiveQuery(
        async () => workspaceId
            ? (await db.activity_transactions.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray())
                .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
            : [],
        [workspaceId]
    )

    useEffect(() => {
        if (workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void Promise.all([
                fetchTableFromSupabase(TRANSACTIONS_TABLE, db.activity_transactions, workspaceId),
                fetchTableFromSupabase(LINES_TABLE, db.activity_transaction_lines, workspaceId)
            ])
        }
    }, [workspaceId])

    return transactions ?? []
}

export function useActivityTransactionLines(transactionId: string | undefined, workspaceId?: string) {
    const lines = useLiveQuery(
        () => transactionId
            ? db.activity_transaction_lines.where('transactionId').equals(transactionId).and((line) => !line.isDeleted).toArray()
            : [],
        [transactionId]
    )

    useEffect(() => {
        if (workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void fetchTableFromSupabase(LINES_TABLE, db.activity_transaction_lines, workspaceId)
        }
    }, [workspaceId])

    return lines ?? []
}

export function useActivityTransactionLinesForWorkspace(workspaceId: string | undefined) {
    const lines = useLiveQuery(
        () => workspaceId
            ? db.activity_transaction_lines.where('workspaceId').equals(workspaceId).and((line) => !line.isDeleted).toArray()
            : [],
        [workspaceId]
    )

    useEffect(() => {
        if (workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void fetchTableFromSupabase(LINES_TABLE, db.activity_transaction_lines, workspaceId)
        }
    }, [workspaceId])

    return lines ?? []
}

export function toUISaleFromActivityTransaction(
    transaction: ActivityTransaction,
    lines: ActivityTransactionLine[],
    cashierName?: string | null
): any {
    return {
        id: transaction.id,
        invoiceid: transaction.transactionNo,
        workspace_id: transaction.workspaceId,
        cashier_id: transaction.createdBy || '',
        total_amount: transaction.totalAmount,
        settlement_currency: transaction.currency,
        exchange_source: null,
        exchange_rate: null,
        exchange_rate_timestamp: null,
        exchange_rates: null,
        created_at: transaction.occurredAt,
        updated_at: transaction.updatedAt,
        origin: 'activities',
        payment_method: transaction.paymentMethod,
        // "Activities" is the sale source, not the person who processed it.
        // Resolve the staff name at the caller because the activity record only
        // stores the creator's id.
        cashier_name: cashierName?.trim() || 'Staff',
        items: lines.map((line) => ({
            id: line.id,
            sale_id: transaction.id,
            product_id: line.activityId,
            product_name: line.activityNameSnapshot,
            product_sku: 'ACTIVITY',
            product_category: 'Activities',
            quantity: line.quantity,
            unit_price: line.unitPrice,
            total_price: line.lineTotal,
            cost_price: 0,
            converted_cost_price: 0,
            original_currency: transaction.currency,
            original_unit_price: line.unitPrice,
            converted_unit_price: line.unitPrice,
            settlement_currency: transaction.currency,
            returned_quantity: 0,
            is_returned: false,
            product: {
                name: line.activityNameSnapshot,
                sku: 'ACTIVITY',
                category: 'Activities',
                can_be_returned: false
            }
        })),
        is_returned: false,
        notes: transaction.notes || null,
        partyName: transaction.customerName || null,
        _activityTransactionId: transaction.id,
        _transactionNo: transaction.transactionNo
    }
}
