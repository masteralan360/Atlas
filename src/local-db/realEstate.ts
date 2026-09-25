import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { canAccessBusinessPartnerInLocalCache } from './businessPartnerAccess'
import { addToOfflineMutations, fetchTableFromSupabase } from './hooks'
import { getBusinessPartnerByAnyId } from './businessPartners'
import type {
    CurrencyCode,
    ExchangeRateSnapshot,
    InstallmentFrequency,
    InstallmentStatus,
    RealEstateInstallment,
    RealEstatePayment,
    RealEstatePaymentKind,
    RealEstatePropertyType,
    RealEstateTransaction,
    RealEstateTransactionStatus,
    RealEstateTransactionType,
    PaymentTransaction,
    WorkspacePaymentMethod
} from './models'

const TRANSACTIONS_TABLE = 'real_estate_transactions'
const INSTALLMENTS_TABLE = 'real_estate_installments'
const PAYMENTS_TABLE = 'real_estate_payments'

type RealEstateTableName =
    | typeof TRANSACTIONS_TABLE
    | typeof INSTALLMENTS_TABLE
    | typeof PAYMENTS_TABLE

type RealEstateSyncEntity = Record<string, unknown> & {
    id: string
    workspaceId: string
    version: number
}

const tableByName = {
    [TRANSACTIONS_TABLE]: db.real_estate_transactions,
    [INSTALLMENTS_TABLE]: db.real_estate_installments,
    [PAYMENTS_TABLE]: db.real_estate_payments
} as const

function shouldUseCloudBusinessData(workspaceId?: string | null) {
    return !!workspaceId && !isLocalWorkspaceMode(workspaceId)
}

async function canAccessRealEstateTransactionInLocalCache(
    transaction: Pick<RealEstateTransaction, 'workspaceId' | 'buyerBusinessPartnerId' | 'sellerBusinessPartnerId'>
): Promise<boolean> {
    const visible = await Promise.all([
        canAccessBusinessPartnerInLocalCache(transaction.workspaceId, transaction.buyerBusinessPartnerId, 'customer'),
        canAccessBusinessPartnerInLocalCache(transaction.workspaceId, transaction.sellerBusinessPartnerId, 'customer')
    ])
    return visible.every(Boolean)
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

function roundRealEstateAmount(value: number, currency: CurrencyCode) {
    const precision = currency === 'iqd' ? 0 : 2
    const multiplier = 10 ** precision
    return Math.round((Number(value) || 0) * multiplier) / multiplier
}

function normalizeDateKey(value: string) {
    if (!value) {
        return new Date().toISOString().slice(0, 10)
    }

    return value.slice(0, 10)
}

function addInstallmentDate(firstDueDate: string, frequency: InstallmentFrequency, offset: number) {
    const date = new Date(`${normalizeDateKey(firstDueDate)}T00:00:00`)

    if (frequency === 'daily') {
        date.setDate(date.getDate() + offset)
    } else if (frequency === 'weekly') {
        date.setDate(date.getDate() + offset * 7)
    } else if (frequency === 'biweekly') {
        date.setDate(date.getDate() + offset * 14)
    } else {
        date.setMonth(date.getMonth() + offset)
    }

    return date.toISOString().slice(0, 10)
}

function computeInstallmentStatus(dueDate: string, balanceAmount: number): InstallmentStatus {
    if (balanceAmount <= 0) {
        return 'paid'
    }

    return normalizeDateKey(dueDate) < new Date().toISOString().slice(0, 10)
        ? 'overdue'
        : 'unpaid'
}

function computeTransactionStatus(
    balanceAmount: number,
    installments: Array<Pick<RealEstateInstallment, 'balanceAmount' | 'dueDate' | 'status'>>
): RealEstateTransactionStatus {
    if (balanceAmount <= 0) {
        return 'completed'
    }

    const today = new Date().toISOString().slice(0, 10)
    const hasOverdue = installments.some((installment) =>
        installment.balanceAmount > 0 &&
        (installment.status === 'overdue' || normalizeDateKey(installment.dueDate) < today)
    )

    return hasOverdue ? 'overdue' : 'active'
}

function createInstallmentPlan(
    balanceAmount: number,
    currency: CurrencyCode,
    installmentCount: number,
    installmentFrequency: InstallmentFrequency,
    firstDueDate: string
) {
    const safeCount = Math.max(1, Math.trunc(installmentCount || 1))
    const safeBalance = roundRealEstateAmount(Math.max(0, balanceAmount), currency)
    const baseAmount = roundRealEstateAmount(safeBalance / safeCount, currency)
    const plan: Array<{ installmentNo: number; dueDate: string; plannedAmount: number }> = []
    let accumulated = 0

    for (let index = 0; index < safeCount; index += 1) {
        const plannedAmount = index === safeCount - 1
            ? roundRealEstateAmount(safeBalance - accumulated, currency)
            : baseAmount
        accumulated = roundRealEstateAmount(accumulated + plannedAmount, currency)
        plan.push({
            installmentNo: index + 1,
            dueDate: addInstallmentDate(firstDueDate, installmentFrequency, index),
            plannedAmount
        })
    }

    return plan
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

async function markEntitiesSynced(tableName: RealEstateTableName, ids: string[]) {
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

async function queueOfflineUpserts(tableName: RealEstateTableName, entities: RealEstateSyncEntity[]) {
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

async function syncUpsertEntities(tableName: RealEstateTableName, entities: RealEstateSyncEntity[], workspaceId: string) {
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
        console.error(`[RealEstate] Failed to sync ${tableName}:`, error)
        await queueOfflineUpserts(tableName, entities)
    }
}

async function syncSoftDelete(tableName: RealEstateTableName, entityId: string, workspaceId: string) {
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
        console.error(`[RealEstate] Failed to delete ${tableName}:`, error)
        await addToOfflineMutations(tableName, entityId, 'delete', { id: entityId }, workspaceId)
    }
}

async function resolveBusinessPartnerId(partnerId?: string | null) {
    const normalized = typeof partnerId === 'string' ? partnerId.trim() : ''
    if (!normalized) {
        return null
    }

    const partner = await getBusinessPartnerByAnyId(normalized)
    if (!partner || partner.isDeleted || partner.mergedIntoBusinessPartnerId) {
        throw new Error('Business partner not found')
    }

    return partner.id
}

async function generateTransactionNo(workspaceId: string, createdAt: string) {
    const year = createdAt.slice(0, 4)
    const rows = await db.real_estate_transactions.where('workspaceId').equals(workspaceId).toArray()
    const sequence = rows.filter((row) => row.createdAt.startsWith(`${year}-`)).length + 1
    return `RE-${year}-${String(sequence).padStart(5, '0')}`
}

function normalizeOptionalText(value?: string | null) {
    const text = String(value || '').trim()
    return text || null
}

function getActivePaymentTransactionAmount(rows: PaymentTransaction[]) {
    const reversedIds = new Set(
        rows
            .filter((row) => !row.isDeleted && !!row.reversalOfTransactionId)
            .map((row) => row.reversalOfTransactionId as string)
    )

    return rows
        .filter((row) =>
            !row.isDeleted
            && !row.reversalOfTransactionId
            && !reversedIds.has(row.id)
        )
        .reduce((sum, row) => sum + Math.max(0, Number(row.amount || 0)), 0)
}

async function getCommissionPaymentRows(workspaceId: string, transactionId: string) {
    return db.payment_transactions
        .where('[workspaceId+sourceType+sourceRecordId]')
        .equals([workspaceId, 'real_estate_commission', transactionId])
        .toArray()
}

function assertCommissionPaymentMethod(paymentMethod: WorkspacePaymentMethod) {
    if (paymentMethod === 'credit' || paymentMethod === 'loan' || paymentMethod === 'loan_adjustment' || paymentMethod === 'unknown') {
        throw new Error('Select a valid commission payment method')
    }
}

export interface CreateRealEstateTransactionInput {
    transactionType: RealEstateTransactionType
    propertyType?: RealEstatePropertyType | null
    location: string
    landAreaM2?: number
    currency: CurrencyCode
    totalAmount: number
    paidAmount?: number
    profitAmount?: number
    buyerName: string
    buyerBusinessPartnerId?: string | null
    buyerWitnessName?: string | null
    buyerWitnessAddress?: string | null
    buyerWitnessPhone?: string | null
    sellerName: string
    sellerBusinessPartnerId?: string | null
    sellerWitnessName?: string | null
    sellerWitnessAddress?: string | null
    sellerWitnessPhone?: string | null
    isInstallmentBased?: boolean
    installmentCount?: number
    installmentFrequency?: InstallmentFrequency
    firstDueDate?: string
    exchangeRateSnapshot?: ExchangeRateSnapshot[] | null
    notes?: string | null
    createdBy?: string | null
}

export async function createRealEstateTransaction(
    workspaceId: string,
    input: CreateRealEstateTransactionInput
) {
    const now = new Date().toISOString()
    const location = input.location.trim()
    const buyerName = input.buyerName.trim()
    const sellerName = input.sellerName.trim()
    const totalAmount = roundRealEstateAmount(Math.max(0, Number(input.totalAmount || 0)), input.currency)
    const paidAmount = roundRealEstateAmount(Math.max(0, Number(input.paidAmount || 0)), input.currency)
    const profitAmount = roundRealEstateAmount(Number(input.profitAmount || 0), input.currency)

    if (!workspaceId) {
        throw new Error('Workspace is required')
    }
    if (!location) {
        throw new Error('Location is required')
    }
    if (!buyerName || !sellerName) {
        throw new Error('Buyer and seller are required')
    }
    if (totalAmount <= 0) {
        throw new Error('Total amount must be greater than zero')
    }
    if (paidAmount > totalAmount) {
        throw new Error('Paid amount cannot exceed total amount')
    }

    const buyerBusinessPartnerId = await resolveBusinessPartnerId(input.buyerBusinessPartnerId)
    const sellerBusinessPartnerId = await resolveBusinessPartnerId(input.sellerBusinessPartnerId)
    if (buyerBusinessPartnerId && sellerBusinessPartnerId && buyerBusinessPartnerId === sellerBusinessPartnerId) {
        throw new Error('Buyer and seller cannot use the same business partner')
    }

    const transactionId = generateId()
    const transactionNo = await generateTransactionNo(workspaceId, now)
    const balanceAmount = roundRealEstateAmount(totalAmount - paidAmount, input.currency)
    const shouldCreateInstallments = Boolean(input.isInstallmentBased && balanceAmount > 0)
    const installmentFrequency = shouldCreateInstallments
        ? input.installmentFrequency || 'monthly'
        : null
    const firstDueDate = shouldCreateInstallments
        ? normalizeDateKey(input.firstDueDate || now)
        : null

    const installments: RealEstateInstallment[] = shouldCreateInstallments
        ? createInstallmentPlan(
            balanceAmount,
            input.currency,
            input.installmentCount || 1,
            installmentFrequency || 'monthly',
            firstDueDate || now
        ).map((entry) => ({
            id: generateId(),
            workspaceId,
            transactionId,
            installmentNo: entry.installmentNo,
            dueDate: entry.dueDate,
            plannedAmount: entry.plannedAmount,
            paidAmount: 0,
            balanceAmount: entry.plannedAmount,
            status: computeInstallmentStatus(entry.dueDate, entry.plannedAmount),
            paidAt: null,
            createdAt: now,
            updatedAt: now,
            version: 1,
            isDeleted: false,
            ...getSyncMetadata(workspaceId, now)
        }))
        : []

    const nextDueDate = installments.find((item) => item.balanceAmount > 0)?.dueDate || null
    const transaction: RealEstateTransaction = {
        id: transactionId,
        workspaceId,
        transactionNo,
        transactionType: input.transactionType,
        propertyType: input.propertyType ?? null,
        location,
        landAreaM2: Math.max(0, Number(input.landAreaM2 || 0)),
        currency: input.currency,
        totalAmount,
        paidAmount,
        balanceAmount,
        profitAmount,
        buyerName,
        buyerBusinessPartnerId,
        buyerWitnessName: normalizeOptionalText(input.buyerWitnessName),
        buyerWitnessAddress: normalizeOptionalText(input.buyerWitnessAddress),
        buyerWitnessPhone: normalizeOptionalText(input.buyerWitnessPhone),
        sellerName,
        sellerBusinessPartnerId,
        sellerWitnessName: normalizeOptionalText(input.sellerWitnessName),
        sellerWitnessAddress: normalizeOptionalText(input.sellerWitnessAddress),
        sellerWitnessPhone: normalizeOptionalText(input.sellerWitnessPhone),
        isInstallmentBased: shouldCreateInstallments,
        installmentCount: installments.length,
        installmentFrequency,
        firstDueDate,
        nextDueDate,
        status: computeTransactionStatus(balanceAmount, installments),
        exchangeRateSnapshot: input.exchangeRateSnapshot && input.exchangeRateSnapshot.length > 0
            ? input.exchangeRateSnapshot
            : null,
        notes: input.notes?.trim() || null,
        createdBy: input.createdBy || null,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }

    const downPayment: RealEstatePayment | null = paidAmount > 0
        ? {
            id: generateId(),
            workspaceId,
            transactionId,
            installmentId: null,
            amount: paidAmount,
            paymentMethod: 'cash',
            paymentKind: 'down_payment',
            paidAt: now,
            note: 'Initial paid amount',
            createdBy: input.createdBy || null,
            createdAt: now,
            updatedAt: now,
            version: 1,
            isDeleted: false,
            ...getSyncMetadata(workspaceId, now)
        }
        : null

    await db.transaction('rw', [db.real_estate_transactions, db.real_estate_installments, db.real_estate_payments], async () => {
        await db.real_estate_transactions.put(transaction)
        if (installments.length > 0) {
            await db.real_estate_installments.bulkPut(installments)
        }
        if (downPayment) {
            await db.real_estate_payments.put(downPayment)
        }
    })

    await Promise.all([
        syncUpsertEntities(TRANSACTIONS_TABLE, [transaction as unknown as RealEstateSyncEntity], workspaceId),
        syncUpsertEntities(INSTALLMENTS_TABLE, installments as unknown as RealEstateSyncEntity[], workspaceId),
        downPayment
            ? syncUpsertEntities(PAYMENTS_TABLE, [downPayment as unknown as RealEstateSyncEntity], workspaceId)
            : Promise.resolve()
    ])

    const savedTransaction = await db.real_estate_transactions.get(transaction.id)
    return {
        transaction: savedTransaction || transaction,
        installments,
        payment: downPayment
    }
}

export interface RecordRealEstatePaymentInput {
    transactionId: string
    installmentId?: string | null
    amount: number
    paymentMethod: WorkspacePaymentMethod
    paidAt?: string
    note?: string | null
    createdBy?: string | null
    accountId?: string | null
    accountNameSnapshot?: string | null
}

export interface RecordRealEstateCommissionPaymentInput {
    transactionId: string
    amount: number
    paymentMethod: WorkspacePaymentMethod
    paidAt?: string
    counterpartyName?: string | null
    businessPartnerId?: string | null
    note?: string | null
    createdBy?: string | null
    accountId?: string | null
    accountNameSnapshot?: string | null
}

export async function getRealEstateCommissionPaidAmount(workspaceId: string, transactionId: string) {
    const transaction = await db.real_estate_transactions.get(transactionId)
    return roundRealEstateAmount(
        getActivePaymentTransactionAmount(await getCommissionPaymentRows(workspaceId, transactionId)),
        transaction?.currency ?? 'usd'
    )
}

export async function recordRealEstateCommissionPayment(
    workspaceId: string,
    input: RecordRealEstateCommissionPaymentInput
) {
    assertCommissionPaymentMethod(input.paymentMethod)

    const transaction = await db.real_estate_transactions.get(input.transactionId)
    if (!transaction || transaction.isDeleted || transaction.workspaceId !== workspaceId) {
        throw new Error('Real estate transaction not found')
    }

    const amount = roundRealEstateAmount(Math.max(0, Number(input.amount || 0)), transaction.currency)
    if (amount <= 0) {
        throw new Error('Commission amount must be greater than zero')
    }

    const paidAmount = roundRealEstateAmount(
        getActivePaymentTransactionAmount(await getCommissionPaymentRows(workspaceId, transaction.id)),
        transaction.currency
    )
    const remainingAmount = roundRealEstateAmount(Math.max(transaction.profitAmount - paidAmount, 0), transaction.currency)
    if (amount > remainingAmount) {
        throw new Error('Commission amount cannot exceed the remaining commission')
    }

    const requestedBusinessPartnerId = normalizeOptionalText(input.businessPartnerId)
    let businessPartnerId = requestedBusinessPartnerId
        || transaction.buyerBusinessPartnerId
        || transaction.sellerBusinessPartnerId
        || null
    let counterpartyName = normalizeOptionalText(input.counterpartyName)

    if (businessPartnerId) {
        const partner = await db.business_partners.get(businessPartnerId)
        if (!partner || partner.workspaceId !== workspaceId || partner.isDeleted || partner.mergedIntoBusinessPartnerId) {
            if (requestedBusinessPartnerId) {
                throw new Error('Selected business partner is not available')
            }
            businessPartnerId = null
        } else {
            businessPartnerId = partner.id
            counterpartyName = partner.partnerName
        }
    }

    if (!counterpartyName) {
        counterpartyName = transaction.buyerName || transaction.sellerName || null
    }

    const commissionPaymentId = generateId()
    const { appendPaymentTransaction } = await import('./payments')
    return appendPaymentTransaction(workspaceId, {
        sourceModule: 'real_estate',
        sourceType: 'real_estate_commission',
        sourceRecordId: transaction.id,
        sourceSubrecordId: commissionPaymentId,
        direction: 'incoming',
        amount,
        currency: transaction.currency,
        paymentMethod: input.paymentMethod,
        paidAt: input.paidAt || new Date().toISOString(),
        counterpartyName,
        referenceLabel: `${transaction.transactionNo} / Commission`,
        note: input.note?.trim() || null,
        createdBy: input.createdBy || null,
        accountId: input.accountId ?? null,
        accountNameSnapshot: input.accountNameSnapshot ?? null,
        metadata: {
            realEstateTransactionId: transaction.id,
            realEstateCommissionPaymentId: commissionPaymentId,
            transactionType: transaction.transactionType,
            propertyLocation: transaction.location,
            businessPartnerId
        }
    })
}

export async function recordRealEstatePayment(
    workspaceId: string,
    input: RecordRealEstatePaymentInput
) {
    const transaction = await db.real_estate_transactions.get(input.transactionId)
    if (!transaction || transaction.isDeleted || transaction.workspaceId !== workspaceId) {
        throw new Error('Real estate transaction not found')
    }

    const amount = roundRealEstateAmount(Math.max(0, Number(input.amount || 0)), transaction.currency)
    if (amount <= 0) {
        throw new Error('Payment amount must be greater than zero')
    }
    if (amount > transaction.balanceAmount) {
        throw new Error('Payment amount cannot exceed the remaining balance')
    }

    const now = new Date().toISOString()
    const paidAt = input.paidAt ? new Date(input.paidAt).toISOString() : now
    const installmentRows = await db.real_estate_installments
        .where('transactionId')
        .equals(transaction.id)
        .and((item) => !item.isDeleted)
        .sortBy('installmentNo')
    const updatedInstallments = installmentRows.map((item) => ({ ...item }))
    let remaining = amount
    const touchedInstallmentIds = new Set<string>()
    const orderedInstallments = input.installmentId
        ? [
            ...updatedInstallments.filter((item) => item.id === input.installmentId),
            ...updatedInstallments.filter((item) => item.id !== input.installmentId)
        ]
        : updatedInstallments

    for (const installment of orderedInstallments) {
        if (remaining <= 0 || installment.balanceAmount <= 0) {
            continue
        }

        const applied = roundRealEstateAmount(Math.min(remaining, installment.balanceAmount), transaction.currency)
        installment.paidAmount = roundRealEstateAmount(installment.paidAmount + applied, transaction.currency)
        installment.balanceAmount = roundRealEstateAmount(Math.max(installment.balanceAmount - applied, 0), transaction.currency)
        installment.status = installment.balanceAmount <= 0 ? 'paid' : 'partial'
        installment.paidAt = installment.status === 'paid' ? paidAt : installment.paidAt
        installment.updatedAt = now
        installment.version += 1
        installment.syncStatus = 'pending'
        installment.lastSyncedAt = null
        touchedInstallmentIds.add(installment.id)
        remaining = roundRealEstateAmount(remaining - applied, transaction.currency)
    }

    for (const installment of updatedInstallments) {
        if (installment.status === 'paid' || touchedInstallmentIds.has(installment.id)) {
            continue
        }

        installment.status = computeInstallmentStatus(installment.dueDate, installment.balanceAmount)
    }

    const paidAmount = roundRealEstateAmount(transaction.paidAmount + amount, transaction.currency)
    const balanceAmount = roundRealEstateAmount(Math.max(transaction.totalAmount - paidAmount, 0), transaction.currency)
    const nextDueDate = updatedInstallments.find((item) => item.balanceAmount > 0)?.dueDate || null
    const updatedTransaction: RealEstateTransaction = {
        ...transaction,
        paidAmount,
        balanceAmount,
        nextDueDate,
        status: computeTransactionStatus(balanceAmount, updatedInstallments),
        updatedAt: now,
        version: transaction.version + 1,
        syncStatus: 'pending',
        lastSyncedAt: null
    }
    const firstTouchedInstallment = updatedInstallments.find((item) => touchedInstallmentIds.has(item.id)) || null
    const paymentKind: RealEstatePaymentKind = firstTouchedInstallment ? 'installment' : 'manual'
    const payment: RealEstatePayment = {
        id: generateId(),
        workspaceId,
        transactionId: transaction.id,
        installmentId: firstTouchedInstallment?.id ?? null,
        amount,
        paymentMethod: input.paymentMethod,
        paymentKind,
        paidAt,
        note: input.note?.trim() || null,
        createdBy: input.createdBy || null,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }

    await db.transaction('rw', [db.real_estate_transactions, db.real_estate_installments, db.real_estate_payments], async () => {
        await db.real_estate_transactions.put(updatedTransaction)
        if (updatedInstallments.length > 0) {
            await db.real_estate_installments.bulkPut(updatedInstallments)
        }
        await db.real_estate_payments.put(payment)
    })

    // The installment record describes the contract state; the payment
    // transaction is the authoritative incoming-money record and derives any
    // optional payment-account movement.
    const { appendPaymentTransaction } = await import('./payments')
    await appendPaymentTransaction(workspaceId, {
        sourceModule: 'real_estate',
        sourceType: firstTouchedInstallment ? 'real_estate_installment' : 'real_estate_payment',
        sourceRecordId: transaction.id,
        sourceSubrecordId: payment.id,
        direction: 'incoming',
        amount,
        currency: transaction.currency,
        paymentMethod: input.paymentMethod,
        paidAt,
        counterpartyName: transaction.buyerName || transaction.sellerName || null,
        referenceLabel: transaction.transactionNo,
        note: input.note?.trim() || null,
        createdBy: input.createdBy || null,
        accountId: input.accountId ?? null,
        accountNameSnapshot: input.accountNameSnapshot ?? null,
        metadata: {
            realEstateTransactionId: transaction.id,
            realEstatePaymentId: payment.id,
            realEstateInstallmentId: payment.installmentId,
            transactionType: transaction.transactionType,
            propertyLocation: transaction.location
        }
    })

    await Promise.all([
        syncUpsertEntities(TRANSACTIONS_TABLE, [updatedTransaction as unknown as RealEstateSyncEntity], workspaceId),
        syncUpsertEntities(
            INSTALLMENTS_TABLE,
            updatedInstallments.filter((item) => touchedInstallmentIds.has(item.id)) as unknown as RealEstateSyncEntity[],
            workspaceId
        ),
        syncUpsertEntities(PAYMENTS_TABLE, [payment as unknown as RealEstateSyncEntity], workspaceId)
    ])

    return {
        transaction: updatedTransaction,
        installments: updatedInstallments,
        payment
    }
}

export async function deleteRealEstateTransaction(transactionId: string) {
    const transaction = await db.real_estate_transactions.get(transactionId)
    if (!transaction || transaction.isDeleted) {
        return
    }

    const now = new Date().toISOString()
    const installments = await db.real_estate_installments
        .where('transactionId')
        .equals(transactionId)
        .toArray()
    const deletedTransaction: RealEstateTransaction = {
        ...transaction,
        isDeleted: true,
        updatedAt: now,
        version: transaction.version + 1,
        ...getSyncMetadata(transaction.workspaceId, now)
    }
    const deletedInstallments = installments.map((installment) => ({
        ...installment,
        isDeleted: true,
        updatedAt: now,
        version: installment.version + 1,
        ...getSyncMetadata(transaction.workspaceId, now)
    }))

    await db.transaction('rw', [db.real_estate_transactions, db.real_estate_installments], async () => {
        await db.real_estate_transactions.put(deletedTransaction)
        if (deletedInstallments.length > 0) {
            await db.real_estate_installments.bulkPut(deletedInstallments)
        }
    })

    await Promise.all([
        syncSoftDelete(TRANSACTIONS_TABLE, transaction.id, transaction.workspaceId),
        ...deletedInstallments.map((installment) =>
            syncSoftDelete(INSTALLMENTS_TABLE, installment.id, transaction.workspaceId)
        )
    ])
}

export function useRealEstateTransactions(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const transactions = useLiveQuery(
        async () => {
            if (!workspaceId) return []
            const rows = await db.real_estate_transactions
                .where('workspaceId')
                .equals(workspaceId)
                .and((item) => !item.isDeleted)
                .reverse()
                .sortBy('createdAt')
            const visibility = await Promise.all(rows.map(canAccessRealEstateTransactionInLocalCache))
            return rows.filter((_, index) => visibility[index])
        },
        [workspaceId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void Promise.all([
                fetchTableFromSupabase(TRANSACTIONS_TABLE, db.real_estate_transactions, workspaceId),
                fetchTableFromSupabase(INSTALLMENTS_TABLE, db.real_estate_installments, workspaceId),
                fetchTableFromSupabase(PAYMENTS_TABLE, db.real_estate_payments, workspaceId)
            ])
        }
    }, [online, workspaceId])

    return transactions ?? []
}

export function useRealEstateTransaction(transactionId: string | undefined) {
    return useLiveQuery(
        async () => {
            if (!transactionId) return undefined
            const transaction = await db.real_estate_transactions.get(transactionId)
            if (!transaction || transaction.isDeleted) return undefined
            return await canAccessRealEstateTransactionInLocalCache(transaction)
                ? transaction
                : undefined
        },
        [transactionId]
    )
}

export function useRealEstateInstallments(transactionId: string | undefined, workspaceId?: string) {
    const online = useNetworkStatus()

    const installments = useLiveQuery(
        async () => {
            if (!transactionId) return []
            const transaction = await db.real_estate_transactions.get(transactionId)
            if (!transaction || transaction.isDeleted || !await canAccessRealEstateTransactionInLocalCache(transaction)) {
                return []
            }
            return db.real_estate_installments
                .where('transactionId')
                .equals(transactionId)
                .and((item) => !item.isDeleted)
                .sortBy('installmentNo')
        },
        [transactionId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void fetchTableFromSupabase(INSTALLMENTS_TABLE, db.real_estate_installments, workspaceId)
        }
    }, [online, workspaceId])

    return installments ?? []
}

export function useRealEstateWorkspaceInstallments(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const installments = useLiveQuery(
        async () => {
            if (!workspaceId) {
                return []
            }

            const rows = await db.real_estate_installments
                .where('workspaceId')
                .equals(workspaceId)
                .and((item) => !item.isDeleted)
                .toArray()

            const transactionIds = [...new Set(rows.map((installment) => installment.transactionId))]
            const transactions = await db.real_estate_transactions.bulkGet(transactionIds)
            const visibility = await Promise.all(transactions.map((transaction) => (
                transaction && !transaction.isDeleted
                    ? canAccessRealEstateTransactionInLocalCache(transaction)
                    : false
            )))
            const visibleTransactionIds = new Set(transactionIds.filter((_, index) => visibility[index]))

            return rows
                .filter((installment) => visibleTransactionIds.has(installment.transactionId))
                .sort((left, right) =>
                left.dueDate.localeCompare(right.dueDate) ||
                left.installmentNo - right.installmentNo
            )
        },
        [workspaceId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void Promise.all([
                fetchTableFromSupabase(TRANSACTIONS_TABLE, db.real_estate_transactions, workspaceId),
                fetchTableFromSupabase(INSTALLMENTS_TABLE, db.real_estate_installments, workspaceId),
                fetchTableFromSupabase(PAYMENTS_TABLE, db.real_estate_payments, workspaceId)
            ])
        }
    }, [online, workspaceId])

    return installments ?? []
}

export function useRealEstatePayments(transactionId: string | undefined, workspaceId?: string) {
    const online = useNetworkStatus()

    const payments = useLiveQuery(
        async () => {
            if (!transactionId) return []
            const transaction = await db.real_estate_transactions.get(transactionId)
            if (!transaction || transaction.isDeleted || !await canAccessRealEstateTransactionInLocalCache(transaction)) {
                return []
            }
            return db.real_estate_payments
                .where('transactionId')
                .equals(transactionId)
                .and((item) => !item.isDeleted)
                .reverse()
                .sortBy('paidAt')
        },
        [transactionId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void fetchTableFromSupabase(PAYMENTS_TABLE, db.real_estate_payments, workspaceId)
        }
    }, [online, workspaceId])

    return payments ?? []
}
