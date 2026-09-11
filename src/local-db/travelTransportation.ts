import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toSnakeCase } from '@/lib/utils'
import { isOnline } from '@/lib/network'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { normalizeOrderAdjustments } from '@/lib/orderAdjustments'
import { roundOrderValue } from '@/lib/orderPrecision'

import { db } from './database'
import { addToOfflineMutations, fetchTableFromSupabase } from './hooks'
import type {
    CurrencyCode,
    OrderAdjustment,
    PaymentTransaction,
    TravelBooking,
    TravelBookingStatus,
    TravelPassenger,
    TravelTransportationType,
    WorkspacePaymentMethod
} from './models'
import {
    appendPaymentTransaction,
    assertStandardSettlementPaymentMethod,
    softDeletePaymentTransaction
} from './payments'
import {
    TRAVEL_BOOKING_PAYMENT_EPSILON,
    TRAVEL_BOOKING_PAYMENT_SOURCE_TYPE,
    calculateTravelBookingAmounts,
    calculateTravelBookingPaymentState,
    getActiveTravelBookingPayments
} from './travelTransportationCalculations'

export {
    calculateTravelBookingAmounts,
    calculateTravelBookingPaymentState,
    getActiveTravelBookingPayments
} from './travelTransportationCalculations'

const BOOKINGS_TABLE = 'travel_bookings'
const PASSENGERS_TABLE = 'travel_passengers'
const PAYMENT_SOURCE_TYPE = TRAVEL_BOOKING_PAYMENT_SOURCE_TYPE
const PAYMENT_EPSILON = TRAVEL_BOOKING_PAYMENT_EPSILON

type TravelTableName = typeof BOOKINGS_TABLE | typeof PASSENGERS_TABLE
type TravelSyncEntity = Record<string, unknown> & { id: string; version: number }

const tableByName = {
    [BOOKINGS_TABLE]: db.travel_bookings,
    [PASSENGERS_TABLE]: db.travel_passengers
} as const

function shouldUseCloudBusinessData(workspaceId?: string | null) {
    return Boolean(workspaceId) && !isLocalWorkspaceMode(workspaceId)
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
    return shouldUseCloudBusinessData(workspaceId)
        ? { syncStatus: 'pending' as const, lastSyncedAt: null }
        : { syncStatus: 'synced' as const, lastSyncedAt: timestamp }
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

async function markEntitiesSynced(tableName: TravelTableName, ids: string[]) {
    const syncedAt = new Date().toISOString()
    await Promise.all(ids.map((id) => tableByName[tableName].update(id, {
        syncStatus: 'synced',
        lastSyncedAt: syncedAt
    })))
}

async function queueOfflineUpserts(tableName: TravelTableName, entities: TravelSyncEntity[], workspaceId: string) {
    await Promise.all(entities.map((entity) => addToOfflineMutations(
        tableName,
        entity.id,
        entity.version > 1 ? 'update' : 'create',
        entity,
        workspaceId
    )))
}

async function syncUpsertEntities(tableName: TravelTableName, entities: TravelSyncEntity[], workspaceId: string) {
    if (entities.length === 0 || !shouldUseCloudBusinessData(workspaceId)) return

    if (!isOnline(workspaceId)) {
        await queueOfflineUpserts(tableName, entities, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable(tableName)
        const { error } = await runSupabaseAction(`${tableName}.sync`, () =>
            client.from(tableName).upsert(entities.map(sanitizeSyncPayload), { onConflict: 'id' })
        )
        if (error) throw error
        await markEntitiesSynced(tableName, entities.map((entity) => entity.id))
    } catch (error) {
        console.error(`[Travel & Transportation] Failed to sync ${tableName}:`, error)
        await queueOfflineUpserts(tableName, entities, workspaceId)
    }
}

function normalizeOptionalText(value: string | null | undefined) {
    const normalized = value?.trim()
    return normalized || null
}

function isTransportationType(value: unknown): value is TravelTransportationType {
    return value === 'flight' || value === 'bus'
}

function roundAmount(value: number) {
    return roundOrderValue(Number.isFinite(value) ? value : 0)
}

function normalizePassengers(
    passengers: readonly TravelPassengerInput[],
    workspaceId: string,
    bookingId: string,
    timestamp: string
): TravelPassenger[] {
    if (passengers.length === 0) throw new Error('At least one passenger is required')

    return passengers.map((passenger) => {
        const name = passenger.name.trim()
        const price = roundAmount(Number(passenger.price))
        if (!name) throw new Error('Every passenger requires a name')
        if (!isTransportationType(passenger.transportationType)) throw new Error('Every passenger requires a transportation type')
        if (price <= 0) throw new Error('Every passenger price must be greater than zero')

        return {
            id: passenger.id || generateId(),
            workspaceId,
            bookingId,
            name,
            transportationType: passenger.transportationType,
            price,
            createdAt: timestamp,
            updatedAt: timestamp,
            version: 1,
            isDeleted: false,
            ...getSyncMetadata(workspaceId, timestamp)
        }
    })
}

/**
 * Revenue/Sales reporting receives only the actual profit payment projection.
 * Passenger prices and booking totals intentionally never reach this bridge.
 */
export function toUISaleFromTravelBookingPayment(transaction: PaymentTransaction): any {
    const amount = Math.max(0, Number(transaction.amount || 0))
    const bookingId = typeof transaction.metadata?.travelBookingId === 'string'
        ? transaction.metadata.travelBookingId
        : transaction.sourceRecordId
    const reference = transaction.referenceLabel || `TT-${bookingId.slice(0, 8)}`
    const category = 'Travel & Transportation'
    const productName = 'Booking Profit'

    return {
        id: transaction.id,
        workspace_id: transaction.workspaceId,
        cashier_id: transaction.createdBy || '',
        total_amount: amount,
        settlement_currency: transaction.currency,
        created_at: transaction.paidAt,
        updated_at: transaction.updatedAt,
        origin: 'travel_transportation',
        payment_method: transaction.paymentMethod || 'cash',
        cashier_name: 'Travel & Transportation',
        items: [{
            id: generateId(),
            sale_id: transaction.id,
            product_id: 'travel_booking_profit',
            product_name: productName,
            product_sku: 'TT-PROFIT',
            product_category: category,
            quantity: 1,
            unit_price: amount,
            total_price: amount,
            cost_price: 0,
            converted_cost_price: 0,
            original_currency: transaction.currency,
            original_unit_price: amount,
            converted_unit_price: amount,
            settlement_currency: transaction.currency,
            returned_quantity: 0,
            is_returned: false,
            product: { name: productName, sku: 'TT-PROFIT', category, can_be_returned: false }
        }],
        is_returned: false,
        sequenceId: reference,
        notes: transaction.note || null,
        _isTravelBookingProfit: true,
        _travelBookingId: bookingId,
        _travelBookingPaymentId: transaction.id,
        _transactionNo: reference
    }
}

async function getPaymentRows(workspaceId: string, bookingId: string) {
    return db.payment_transactions
        .where('[workspaceId+sourceType+sourceRecordId]')
        .equals([workspaceId, PAYMENT_SOURCE_TYPE, bookingId])
        .toArray()
}

async function generateBookingNumber(workspaceId: string, timestamp: string) {
    const year = timestamp.slice(0, 4)
    const existing = await db.travel_bookings.where('workspaceId').equals(workspaceId).toArray()
    const sequence = existing.filter((booking) => booking.bookingNumber.startsWith(`TT-${year}-`)).length + 1
    return `TT-${year}-${String(sequence).padStart(5, '0')}`
}

async function syncBookingAndPassengers(booking: TravelBooking, passengers: TravelPassenger[]) {
    await syncUpsertEntities(BOOKINGS_TABLE, [booking as unknown as TravelSyncEntity], booking.workspaceId)
    await syncUpsertEntities(PASSENGERS_TABLE, passengers as unknown as TravelSyncEntity[], booking.workspaceId)
}

export type TravelPassengerInput = {
    id?: string
    name: string
    transportationType: TravelTransportationType
    price: number
}

export type TravelPaymentAccountInput = {
    accountId?: string | null
    accountNameSnapshot?: string | null
}

export interface CreateTravelBookingInput extends TravelPaymentAccountInput {
    passengers: TravelPassengerInput[]
    currency: CurrencyCode
    travelDate?: string | null
    bookingAdjustments?: OrderAdjustment[] | null
    profitAmount?: number
    paymentMethod: WorkspacePaymentMethod
    paidOnSave?: boolean
    notes?: string | null
    createdBy?: string | null
}

export async function createTravelBooking(workspaceId: string, input: CreateTravelBookingInput) {
    if (!workspaceId) throw new Error('Workspace is required')
    assertStandardSettlementPaymentMethod(input.paymentMethod)

    const now = new Date().toISOString()
    const bookingId = generateId()
    const passengers = normalizePassengers(input.passengers, workspaceId, bookingId, now)
    const adjustments = normalizeOrderAdjustments(input.bookingAdjustments, input.currency)
    const { passengerTotal, bookingTotal, adjustedBookingTotal } = calculateTravelBookingAmounts(passengers, adjustments)
    const profitAmount = roundAmount(Math.max(0, Number(input.profitAmount || 0)))
    const paidOnSave = Boolean(input.paidOnSave && profitAmount > PAYMENT_EPSILON)
    const status: TravelBookingStatus = paidOnSave ? 'completed' : 'draft'
    const booking: TravelBooking = {
        id: bookingId,
        workspaceId,
        bookingNumber: await generateBookingNumber(workspaceId, now),
        currency: input.currency,
        travelDate: input.travelDate || null,
        passengerTotal,
        bookingTotal,
        adjustedBookingTotal,
        bookingAdjustments: adjustments.length > 0 ? adjustments : null,
        profitAmount,
        paidProfitAmount: paidOnSave ? profitAmount : 0,
        outstandingProfitAmount: paidOnSave ? 0 : profitAmount,
        paymentMethod: input.paymentMethod,
        status,
        notes: normalizeOptionalText(input.notes),
        createdBy: input.createdBy || null,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }

    let payment: PaymentTransaction | null = null
    try {
        await db.transaction('rw', [db.travel_bookings, db.travel_passengers], async () => {
            await db.travel_bookings.put(booking)
            await db.travel_passengers.bulkPut(passengers)
        })

        if (paidOnSave) {
            const paymentId = generateId()
            payment = await appendPaymentTransaction(workspaceId, {
                id: paymentId,
                idempotent: true,
                sourceModule: 'travel_transportation',
                sourceType: PAYMENT_SOURCE_TYPE,
                sourceRecordId: booking.id,
                sourceSubrecordId: paymentId,
                direction: 'incoming',
                amount: profitAmount,
                currency: booking.currency,
                paymentMethod: input.paymentMethod,
                paidAt: now,
                referenceLabel: booking.bookingNumber,
                note: booking.notes || null,
                createdBy: input.createdBy || null,
                accountId: input.accountId ?? null,
                accountNameSnapshot: input.accountNameSnapshot ?? null,
                metadata: { travelBookingId: booking.id, travelBookingPaymentId: paymentId, paidOnSave: true }
            })
        }

        await syncBookingAndPassengers(booking, passengers)
        return { booking, passengers, payment }
    } catch (error) {
        if (payment) await softDeletePaymentTransaction(payment)
        await db.transaction('rw', [db.travel_bookings, db.travel_passengers], async () => {
            await db.travel_bookings.delete(booking.id)
            await db.travel_passengers.bulkDelete(passengers.map((passenger) => passenger.id))
        })
        throw error
    }
}

export interface UpdateTravelBookingInput {
    passengers: TravelPassengerInput[]
    currency: CurrencyCode
    travelDate?: string | null
    bookingAdjustments?: OrderAdjustment[] | null
    profitAmount?: number
    paymentMethod: WorkspacePaymentMethod
    notes?: string | null
}

export async function updateTravelBooking(bookingId: string, input: UpdateTravelBookingInput) {
    const existing = await db.travel_bookings.get(bookingId)
    if (!existing || existing.isDeleted) throw new Error('Booking not found')
    if (existing.status !== 'draft' && existing.status !== 'booked') throw new Error('Only unpaid Draft and Booked bookings can be edited')

    const currentPayments = await getPaymentRows(existing.workspaceId, existing.id)
    if (getActiveTravelBookingPayments(currentPayments).length > 0) throw new Error('Bookings with recorded payments cannot be edited')
    assertStandardSettlementPaymentMethod(input.paymentMethod)

    const now = new Date().toISOString()
    const normalizedPassengers = normalizePassengers(input.passengers, existing.workspaceId, existing.id, now)
    const adjustments = normalizeOrderAdjustments(input.bookingAdjustments, input.currency)
    const { passengerTotal, bookingTotal, adjustedBookingTotal } = calculateTravelBookingAmounts(normalizedPassengers, adjustments)
    const profitAmount = roundAmount(Math.max(0, Number(input.profitAmount || 0)))
    const existingPassengers = await db.travel_passengers.where('bookingId').equals(existing.id).toArray()
    const existingPassengerById = new Map(existingPassengers.map((passenger) => [passenger.id, passenger]))
    const passengers = normalizedPassengers.map((passenger) => {
        const prior = existingPassengerById.get(passenger.id)
        return prior
            ? {
                ...passenger,
                createdAt: prior.createdAt,
                version: prior.version + 1
            }
            : passenger
    })
    const retainedPassengerIds = new Set(passengers.map((passenger) => passenger.id))
    const deletedPassengers = existingPassengers
        .filter((passenger) => !passenger.isDeleted && !retainedPassengerIds.has(passenger.id))
        .map((passenger) => ({
        ...passenger,
        isDeleted: true,
        updatedAt: now,
        version: passenger.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }))
    const updated: TravelBooking = {
        ...existing,
        currency: input.currency,
        travelDate: input.travelDate || null,
        passengerTotal,
        bookingTotal,
        adjustedBookingTotal,
        bookingAdjustments: adjustments.length > 0 ? adjustments : null,
        profitAmount,
        paidProfitAmount: 0,
        outstandingProfitAmount: profitAmount,
        paymentMethod: input.paymentMethod,
        status: existing.status === 'booked' && profitAmount <= PAYMENT_EPSILON ? 'completed' : existing.status,
        notes: normalizeOptionalText(input.notes),
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    await db.transaction('rw', [db.travel_bookings, db.travel_passengers], async () => {
        await db.travel_bookings.put(updated)
        if (deletedPassengers.length > 0) await db.travel_passengers.bulkPut(deletedPassengers)
        await db.travel_passengers.bulkPut(passengers)
    })
    await syncBookingAndPassengers(updated, [...deletedPassengers, ...passengers])
    return { booking: updated, passengers }
}

export async function bookTravelBooking(bookingId: string) {
    const booking = await db.travel_bookings.get(bookingId)
    if (!booking || booking.isDeleted) throw new Error('Booking not found')
    if (booking.status !== 'draft') throw new Error('Only Draft bookings can be booked')

    const now = new Date().toISOString()
    const status: TravelBookingStatus = booking.profitAmount <= PAYMENT_EPSILON ? 'completed' : 'booked'
    const updated: TravelBooking = {
        ...booking,
        status,
        updatedAt: now,
        version: booking.version + 1,
        ...getSyncMetadata(booking.workspaceId, now)
    }
    await db.travel_bookings.put(updated)
    await syncUpsertEntities(BOOKINGS_TABLE, [updated as unknown as TravelSyncEntity], booking.workspaceId)
    return updated
}

export interface RecordTravelBookingPaymentInput extends TravelPaymentAccountInput {
    bookingId: string
    amount: number
    paymentMethod: WorkspacePaymentMethod
    paidAt?: string
    note?: string | null
    createdBy?: string | null
}

export async function recordTravelBookingPayment(workspaceId: string, input: RecordTravelBookingPaymentInput) {
    const booking = await db.travel_bookings.get(input.bookingId)
    if (!booking || booking.isDeleted || booking.workspaceId !== workspaceId) throw new Error('Booking not found')
    if (booking.status !== 'booked' && booking.status !== 'partially_paid') throw new Error('Only Booked or Partially Paid bookings can receive a payment')

    const amount = roundAmount(Number(input.amount))
    if (amount <= PAYMENT_EPSILON) throw new Error('Payment amount must be greater than zero')
    if (amount > booking.outstandingProfitAmount + PAYMENT_EPSILON) throw new Error('Payment amount cannot exceed Outstanding Profit')
    assertStandardSettlementPaymentMethod(input.paymentMethod)

    const paymentId = generateId()
    const paidAt = input.paidAt ? new Date(input.paidAt).toISOString() : new Date().toISOString()
    const payment = await appendPaymentTransaction(workspaceId, {
        id: paymentId,
        idempotent: true,
        sourceModule: 'travel_transportation',
        sourceType: PAYMENT_SOURCE_TYPE,
        sourceRecordId: booking.id,
        sourceSubrecordId: paymentId,
        direction: 'incoming',
        amount,
        currency: booking.currency,
        paymentMethod: input.paymentMethod,
        paidAt,
        referenceLabel: booking.bookingNumber,
        note: normalizeOptionalText(input.note),
        createdBy: input.createdBy || null,
        accountId: input.accountId ?? null,
        accountNameSnapshot: input.accountNameSnapshot ?? null,
        metadata: { travelBookingId: booking.id, travelBookingPaymentId: paymentId }
    })

    try {
        const paymentState = calculateTravelBookingPaymentState(booking.profitAmount, await getPaymentRows(workspaceId, booking.id))
        const now = new Date().toISOString()
        const updated: TravelBooking = {
            ...booking,
            paidProfitAmount: paymentState.paidProfitAmount,
            outstandingProfitAmount: paymentState.outstandingProfitAmount,
            paymentMethod: input.paymentMethod,
            status: paymentState.paymentStatus,
            updatedAt: now,
            version: booking.version + 1,
            ...getSyncMetadata(workspaceId, now)
        }
        await db.travel_bookings.put(updated)
        await syncUpsertEntities(BOOKINGS_TABLE, [updated as unknown as TravelSyncEntity], workspaceId)
        return { booking: updated, payment }
    } catch (error) {
        await softDeletePaymentTransaction(payment)
        throw error
    }
}

export async function reverseTravelBookingPayment(
    workspaceId: string,
    transactionId: string,
    input: {
        paidAt?: string
        note?: string
        createdBy?: string | null
        amount?: number
        paymentMethod?: PaymentTransaction['paymentMethod']
        accountId?: string | null
        accountNameSnapshot?: string | null
    } = {}
) {
    const payment = await db.payment_transactions.get(transactionId)
    if (!payment || payment.workspaceId !== workspaceId || payment.isDeleted || payment.sourceType !== PAYMENT_SOURCE_TYPE || payment.reversalOfTransactionId) {
        throw new Error('Travel booking payment not found')
    }
    const booking = await db.travel_bookings.get(payment.sourceRecordId)
    if (!booking || booking.isDeleted) throw new Error('Booking not found')

    const reversal = await appendPaymentTransaction(workspaceId, {
        sourceModule: 'travel_transportation',
        sourceType: PAYMENT_SOURCE_TYPE,
        sourceRecordId: booking.id,
        sourceSubrecordId: payment.sourceSubrecordId ?? null,
        direction: 'incoming',
        amount: -Math.abs(input.amount ?? payment.amount),
        currency: payment.currency,
        paymentMethod: input.paymentMethod ?? payment.paymentMethod,
        paidAt: input.paidAt ? new Date(input.paidAt).toISOString() : new Date().toISOString(),
        referenceLabel: booking.bookingNumber,
        note: normalizeOptionalText(input.note) || `Reversal of ${booking.bookingNumber}`,
        createdBy: input.createdBy || null,
        ...(input.accountId === undefined ? {} : {
            accountId: input.accountId,
            accountNameSnapshot: input.accountNameSnapshot ?? null
        }),
        reversalOfTransactionId: payment.id,
        metadata: { ...(payment.metadata || {}), reversal: true }
    })

    try {
        const paymentState = calculateTravelBookingPaymentState(booking.profitAmount, await getPaymentRows(workspaceId, booking.id))
        const now = new Date().toISOString()
        const updated: TravelBooking = {
            ...booking,
            paidProfitAmount: paymentState.paidProfitAmount,
            outstandingProfitAmount: paymentState.outstandingProfitAmount,
            status: paymentState.paymentStatus,
            updatedAt: now,
            version: booking.version + 1,
            ...getSyncMetadata(workspaceId, now)
        }
        await db.travel_bookings.put(updated)
        await syncUpsertEntities(BOOKINGS_TABLE, [updated as unknown as TravelSyncEntity], workspaceId)
        return { booking: updated, reversal }
    } catch (error) {
        await softDeletePaymentTransaction(reversal)
        throw error
    }
}

export async function cancelTravelBooking(bookingId: string) {
    const booking = await db.travel_bookings.get(bookingId)
    if (!booking || booking.isDeleted) throw new Error('Booking not found')
    if (booking.status !== 'booked') throw new Error('Only Booked bookings can be cancelled')
    if (getActiveTravelBookingPayments(await getPaymentRows(booking.workspaceId, booking.id)).length > 0) {
        throw new Error('Reverse all payments before cancelling this booking')
    }

    const now = new Date().toISOString()
    const updated: TravelBooking = {
        ...booking,
        status: 'cancelled',
        updatedAt: now,
        version: booking.version + 1,
        ...getSyncMetadata(booking.workspaceId, now)
    }
    await db.travel_bookings.put(updated)
    await syncUpsertEntities(BOOKINGS_TABLE, [updated as unknown as TravelSyncEntity], booking.workspaceId)
    return updated
}

export async function deleteTravelBooking(bookingId: string) {
    const booking = await db.travel_bookings.get(bookingId)
    if (!booking || booking.isDeleted) return
    if (booking.status !== 'draft') throw new Error('Only Draft bookings can be deleted')

    const now = new Date().toISOString()
    const passengers = await db.travel_passengers.where('bookingId').equals(booking.id).toArray()
    const deletedBooking: TravelBooking = {
        ...booking,
        isDeleted: true,
        updatedAt: now,
        version: booking.version + 1,
        ...getSyncMetadata(booking.workspaceId, now)
    }
    const deletedPassengers = passengers.map((passenger) => ({
        ...passenger,
        isDeleted: true,
        updatedAt: now,
        version: passenger.version + 1,
        ...getSyncMetadata(booking.workspaceId, now)
    }))
    await db.transaction('rw', [db.travel_bookings, db.travel_passengers], async () => {
        await db.travel_bookings.put(deletedBooking)
        if (deletedPassengers.length > 0) await db.travel_passengers.bulkPut(deletedPassengers)
    })
    await syncBookingAndPassengers(deletedBooking, deletedPassengers)
}

export function useTravelBookings(workspaceId: string | undefined) {
    const online = useNetworkStatus()
    const bookings = useLiveQuery(
        () => workspaceId
            ? db.travel_bookings.where('workspaceId').equals(workspaceId)
                .and((booking) => !booking.isDeleted)
                .reverse()
                .sortBy('createdAt')
            : [],
        [workspaceId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void Promise.all([
                fetchTableFromSupabase(BOOKINGS_TABLE, db.travel_bookings, workspaceId),
                fetchTableFromSupabase(PASSENGERS_TABLE, db.travel_passengers, workspaceId)
            ])
        }
    }, [online, workspaceId])

    return bookings ?? []
}

export function useTravelBooking(bookingId: string | undefined) {
    return useLiveQuery(() => bookingId ? db.travel_bookings.get(bookingId) : undefined, [bookingId])
}

export function useTravelPassengers(bookingId: string | undefined, workspaceId?: string) {
    const online = useNetworkStatus()
    const passengers = useLiveQuery(
        () => bookingId
            ? db.travel_passengers.where('bookingId').equals(bookingId)
                .and((passenger) => !passenger.isDeleted)
                .sortBy('createdAt')
            : [],
        [bookingId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void fetchTableFromSupabase(PASSENGERS_TABLE, db.travel_passengers, workspaceId)
        }
    }, [online, workspaceId])

    return passengers ?? []
}

export function useTravelPassengersForWorkspace(workspaceId: string | undefined) {
    const online = useNetworkStatus()
    const passengers = useLiveQuery(
        () => workspaceId
            ? db.travel_passengers.where('workspaceId').equals(workspaceId)
                .and((passenger) => !passenger.isDeleted)
                .toArray()
            : [],
        [workspaceId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void fetchTableFromSupabase(PASSENGERS_TABLE, db.travel_passengers, workspaceId)
        }
    }, [online, workspaceId])

    return passengers ?? []
}

export function useTravelBookingPayments(bookingId: string | undefined, workspaceId: string | undefined) {
    return useLiveQuery(
        () => bookingId && workspaceId
            ? db.payment_transactions
                .where('[workspaceId+sourceType+sourceRecordId]')
                .equals([workspaceId, PAYMENT_SOURCE_TYPE, bookingId])
                .reverse()
                .sortBy('paidAt')
            : [],
        [bookingId, workspaceId]
    ) ?? []
}
