import { STOCK_EFFECT_TABLES, currentStockOperation } from './offlineStockContext'
import { generateId } from '@/lib/utils'
import { isSchemaMismatchError, isSyncIntegrityError } from '@/sync/syncErrors'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import type { OfflineMutation } from './models'

const LOCAL_ONLY_ENTITY_TYPES = new Set<OfflineMutation['entityType']>([
    'inventory_transfer_transactions'
])

function isCloudInventoryTransactionMutation(
    entityType: OfflineMutation['entityType'],
    payload: Record<string, unknown>
) {
    if (entityType !== 'inventory_transactions') {
        return true
    }

    const transactionType = payload.transactionType || payload.transaction_type
    return transactionType === 'stock_adjustment'
}

function payloadId(payload: Record<string, unknown>, camelCase: string, snakeCase: string) {
    const value = payload[camelCase] ?? payload[snakeCase]
    return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Older desktop clients could leave an assignment mutation under the workspace
 * that was active when it was queued, even though its order belongs to another
 * workspace. Supabase correctly rejects that payload. Before an explicit retry,
 * recover it from the local order only when the complete relationship is still
 * valid. This preserves the assignment and never guesses across workspaces.
 */
async function repairSalesOrderAgentAssignmentWorkspaceMutations(
    mutations: OfflineMutation[]
) {
    const unrepairedMutationIds = new Set<string>()
    for (const mutation of mutations) {
        if (
            mutation.entityType !== 'sales_order_agent_assignments'
            || mutation.operation === 'delete'
            || !/sales order must belong to the assignment workspace/i.test(mutation.error ?? '')
        ) {
            continue
        }

        const orderId = payloadId(mutation.payload, 'orderId', 'order_id')
        const agentId = payloadId(mutation.payload, 'agentId', 'agent_id')
        if (!orderId || !agentId) {
            unrepairedMutationIds.add(mutation.id)
            continue
        }

        const [order, agent, assignment] = await Promise.all([
            db.sales_orders.get(orderId),
            db.agents.get(agentId),
            db.sales_order_agent_assignments.get(mutation.entityId),
        ])
        if (
            !order
            || order.isDeleted
            || !agent
            || agent.isDeleted
            || agent.workspaceId !== order.workspaceId
            || (assignment && (
                assignment.isDeleted
                || assignment.orderId !== orderId
                || assignment.agentId !== agentId
            ))
        ) {
            unrepairedMutationIds.add(mutation.id)
            continue
        }

        const workspaceId = order.workspaceId
        const payload = {
            ...mutation.payload,
            workspaceId,
            workspace_id: workspaceId,
            orderId,
            order_id: orderId,
            agentId,
            agent_id: agentId,
        }

        if (assignment) {
            await db.sales_order_agent_assignments.update(assignment.id, {
                workspaceId,
                syncStatus: 'pending',
                lastSyncedAt: null,
            })
        }
        await db.offline_mutations.update(mutation.id, { workspaceId, payload })
    }

    return unrepairedMutationIds
}

/**
 * Older Travel & Transportation queue items can retain the workspace that was
 * active when they were queued, even when the passenger and its booking are a
 * valid pair in the currently selected workspace. Only repair from the local
 * relationship when both records agree; never move a passenger across workspaces.
 */
async function repairTravelPassengerWorkspaceMutations(
    workspaceId: string,
    mutations: OfflineMutation[]
) {
    const unrepairedMutationIds = new Set<string>()
    for (const mutation of mutations) {
        if (
            mutation.entityType !== 'travel_passengers'
            || mutation.operation === 'delete'
            || !/passenger booking must belong to the same active workspace/i.test(mutation.error ?? '')
        ) {
            continue
        }

        const bookingId = payloadId(mutation.payload, 'bookingId', 'booking_id')
        if (!bookingId) {
            unrepairedMutationIds.add(mutation.id)
            continue
        }

        const [passenger, booking] = await Promise.all([
            db.travel_passengers.get(mutation.entityId),
            db.travel_bookings.get(bookingId),
        ])
        const queuedBookingDelete = mutations.some((candidate) => (
            candidate.entityType === 'travel_bookings'
            && candidate.entityId === bookingId
            && candidate.operation === 'delete'
        ))
        if (
            !passenger
            || passenger.isDeleted
            || passenger.bookingId !== bookingId
            || !booking
            || booking.isDeleted
            || booking.id !== bookingId
            || passenger.workspaceId !== booking.workspaceId
            || booking.workspaceId !== workspaceId
            || queuedBookingDelete
        ) {
            unrepairedMutationIds.add(mutation.id)
            continue
        }

        const payload = {
            ...mutation.payload,
            workspaceId,
            workspace_id: workspaceId,
            bookingId,
            booking_id: bookingId,
        }
        await db.travel_passengers.update(passenger.id, {
            workspaceId,
            syncStatus: 'pending',
            lastSyncedAt: null,
        })
        await db.offline_mutations.update(mutation.id, { workspaceId, payload })

        const queuedBookingMutation = mutations.find((candidate) => (
            candidate.entityType === 'travel_bookings'
            && candidate.entityId === booking.id
            && candidate.operation !== 'delete'
        ))
        if (queuedBookingMutation) {
            const bookingPayload = {
                ...queuedBookingMutation.payload,
                workspaceId,
                workspace_id: workspaceId,
            }
            await db.offline_mutations.update(queuedBookingMutation.id, {
                workspaceId,
                payload: bookingPayload,
            })
            queuedBookingMutation.workspaceId = workspaceId
            queuedBookingMutation.payload = bookingPayload
        } else {
            const alreadyPending = await db.offline_mutations
                .where('[entityType+entityId+status]')
                .equals(['travel_bookings', booking.id, 'pending'])
                .first()
            if (alreadyPending) {
                const bookingPayload = {
                    ...alreadyPending.payload,
                    workspaceId,
                    workspace_id: workspaceId,
                }
                await db.offline_mutations.update(alreadyPending.id, {
                    workspaceId,
                    payload: bookingPayload,
                })
            } else {
                await addToOfflineMutations(
                    'travel_bookings',
                    booking.id,
                    booking.version > 1 ? 'update' : 'create',
                    booking as unknown as Record<string, unknown>,
                    workspaceId,
                )
            }
        }
        await db.travel_bookings.update(booking.id, {
            syncStatus: 'pending',
            lastSyncedAt: null,
        })
    }

    return unrepairedMutationIds
}

/**
 * A product UoM cannot sync until its product exists in the same workspace.
 * Offline product creation and UoM edits are normally queued together, but an
 * interrupted or older client can leave only the child mutation behind. On an
 * explicit integrity retry, restore that parent create only when the local
 * product is still an unsynced, non-deleted row in the same workspace. A parent
 * that has since synced needs no repair: retry its child against the server.
 */
async function repairProductUomParentMutations(mutations: OfflineMutation[]) {
    const unrepairedMutationIds = new Set<string>()
    const retryableMutationIds = new Set(mutations.map((mutation) => mutation.id))

    for (const mutation of mutations) {
        if (
            mutation.entityType !== 'product_uoms'
            || mutation.operation === 'delete'
            || !/product uom must belong to a product in the same workspace/i.test(mutation.error ?? '')
        ) {
            continue
        }

        const productId = payloadId(mutation.payload, 'productId', 'product_id')
        if (!productId) {
            unrepairedMutationIds.add(mutation.id)
            continue
        }

        const product = await db.products.get(productId)
        if (
            !product
            || product.isDeleted
            || product.workspaceId !== mutation.workspaceId
        ) {
            unrepairedMutationIds.add(mutation.id)
            continue
        }

        const productMutations = await db.offline_mutations
            .where('entityType')
            .equals('products')
            .filter((candidate) => candidate.entityId === productId)
            .toArray()
        const activeProductMutations = productMutations.filter((candidate) => (
            candidate.status === 'pending'
            || candidate.status === 'syncing'
            || candidate.status === 'failed'
        ))

        // Never move a product or attach its UoMs across workspace boundaries.
        if (activeProductMutations.some((candidate) => candidate.workspaceId !== mutation.workspaceId)) {
            unrepairedMutationIds.add(mutation.id)
            continue
        }

        const sameWorkspaceMutations = activeProductMutations.filter((candidate) => (
            candidate.workspaceId === mutation.workspaceId
        ))
        if (sameWorkspaceMutations.some((candidate) => (
            candidate.status === 'failed' && !retryableMutationIds.has(candidate.id)
        ))) {
            unrepairedMutationIds.add(mutation.id)
            continue
        }

        const retryableParentMutations = sameWorkspaceMutations.filter((candidate) => (
            candidate.status === 'pending'
            || candidate.status === 'syncing'
            || (candidate.status === 'failed' && retryableMutationIds.has(candidate.id))
        ))
        if (retryableParentMutations.length > 0) {
            if (retryableParentMutations.some((candidate) => candidate.operation !== 'create')) {
                unrepairedMutationIds.add(mutation.id)
            }
            continue
        }

        const wasDiscarded = productMutations.some((candidate) => candidate.status === 'discarded')
        if (wasDiscarded) {
            unrepairedMutationIds.add(mutation.id)
            continue
        }

        // A stock operation or another device may have uploaded the parent
        // after this UoM first failed. Keeping the child failed here makes the
        // explicit Retry button a permanent dead end despite a valid parent.
        // Retry only the child; Supabase still verifies its parent/workspace.
        if (product.syncStatus === 'synced' || product.lastSyncedAt != null) continue

        if (product.syncStatus !== 'pending' && product.syncStatus !== 'conflict') {
            unrepairedMutationIds.add(mutation.id)
            continue
        }

        await addToOfflineMutations(
            'products',
            product.id,
            'create',
            product as unknown as Record<string, unknown>,
            mutation.workspaceId,
        )
    }

    return unrepairedMutationIds
}

/**
 * A merchant profile may have been created while a workspace was local, then
 * later be used to create a cloud shipment. When that shipment is explicitly
 * retried, requeue its local prerequisites so the server can receive the
 * profile, shipment, and event in dependency order.
 */

export async function addToOfflineMutations(
    entityType: OfflineMutation['entityType'],
    entityId: string,
    operation: OfflineMutation['operation'],
    payload: Record<string, unknown>,
    workspaceId: string,
    options: { omitFields?: readonly string[] } = {}
): Promise<void> {
    // The enclosing operation owns every captured business effect.
    if (currentStockOperation(workspaceId) && (STOCK_EFFECT_TABLES.has(entityType) || String(entityType) === 'stock_adjustments')) return

    if (
        isLocalWorkspaceMode(workspaceId)
        || LOCAL_ONLY_ENTITY_TYPES.has(entityType)
        || !isCloudInventoryTransactionMutation(entityType, payload)
    ) {
        return
    }

    const queuedPayload = { ...payload }
    for (const field of options.omitFields ?? []) {
        delete queuedPayload[field]
    }

    const existing = await db.offline_mutations
        .where('[entityType+entityId+status]')
        .equals([entityType, entityId, 'pending'])
        .first()

    if (existing) {
        if (operation === 'delete') {
            if (existing.operation === 'create') {
                await db.offline_mutations.delete(existing.id)
                return
            }

            await db.offline_mutations.update(existing.id, {
                operation: 'delete',
                payload: { ...queuedPayload, id: entityId },
                createdAt: new Date().toISOString()
            })
            return
        }

        if (operation === 'update' || operation === 'create') {
            const mergedPayload = { ...existing.payload, ...queuedPayload }
            for (const field of options.omitFields ?? []) {
                delete mergedPayload[field]
            }
            await db.offline_mutations.update(existing.id, {
                operation: existing.operation === 'delete' ? 'update' : existing.operation,
                payload: mergedPayload,
                createdAt: new Date().toISOString()
            })
            return
        }
    }

    await db.offline_mutations.add({
        id: generateId(),
        workspaceId,
        entityType,
        entityId,
        operation,
        payload: queuedPayload,
        createdAt: new Date().toISOString(),
        status: 'pending'
    })
}

/**
 * Schema mismatches are intentionally excluded from automatic retries. A user
 * can explicitly retry them after the database migration has been deployed.
 */
export async function retrySchemaMismatchMutations(workspaceId: string): Promise<number> {
    const rows = await db.offline_mutations
        .where('status')
        .equals('failed')
        .filter((mutation) => mutation.workspaceId === workspaceId && isSchemaMismatchError(mutation.error))
        .toArray()

    if (rows.length === 0) return 0

    await db.offline_mutations.bulkUpdate(rows.map((mutation) => ({
        key: mutation.id,
        changes: {
            status: 'pending' as const,
            error: undefined,
            nextAttemptAt: undefined,
            syncLeaseId: undefined,
            syncLeaseUntil: undefined
        }
    })))

    return rows.length
}

/**
 * Requeue deterministic server rejections only after a user explicitly asks
 * to retry. They must never be picked up by background retry loops.
 */
export async function retrySyncIntegrityMutations(workspaceId: string): Promise<number> {
    const rows = await db.offline_mutations
        .where('status')
        .equals('failed')
        .filter((mutation) => mutation.workspaceId === workspaceId && (isSyncIntegrityError(mutation.error) || mutation.entityType === 'stock_operations'))
        .toArray()

    if (rows.length === 0) return 0

    const unrepairedAssignmentMutationIds = await repairSalesOrderAgentAssignmentWorkspaceMutations(rows)
    const unrepairedTravelPassengerMutationIds = await repairTravelPassengerWorkspaceMutations(workspaceId, rows)
    const unrepairedProductUomMutationIds = await repairProductUomParentMutations(rows)
    const rowsToRetry = rows.filter((mutation) => (
        !unrepairedAssignmentMutationIds.has(mutation.id)
        && !unrepairedTravelPassengerMutationIds.has(mutation.id)
        && !unrepairedProductUomMutationIds.has(mutation.id)
    ))

    await db.offline_mutations.bulkUpdate(rowsToRetry.map((mutation) => ({
        key: mutation.id,
        changes: {
            status: 'pending' as const,
            error: undefined,
            nextAttemptAt: undefined,
            syncLeaseId: undefined,
            syncLeaseUntil: undefined
        }
    })))

    return rowsToRetry.length
}
