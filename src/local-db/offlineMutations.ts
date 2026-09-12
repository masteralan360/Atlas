import { generateId } from '@/lib/utils'
import { isSchemaMismatchError, isSyncIntegrityError } from '@/sync/syncErrors'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import type { BusinessPartner, DeliveryMerchantProfile, OfflineMutation } from './models'

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

async function queueRedispatchedPostponedVoiceCleanup(
    workspaceId: string,
    mutations: OfflineMutation[]
) {
    const shipmentMutations = mutations.filter((mutation) => (
        mutation.entityType === 'delivery_shipments'
        && mutation.payload.status === 'assigned'
    ))

    for (const mutation of shipmentMutations) {
        const shipment = await db.delivery_shipments.get(mutation.entityId)
        if (!shipment || shipment.isDeleted || shipment.workspaceId !== workspaceId || shipment.status !== 'assigned') continue

        const events = await db.delivery_shipment_events
            .where('[workspaceId+shipmentId]')
            .equals([workspaceId, shipment.id])
            .toArray()
        const postponedEvents = events.filter((event) => (
            !event.isDeleted
            && event.status === 'postponed'
            && typeof event.voiceReasonPath === 'string'
            && event.voiceReasonPath.startsWith(`${workspaceId}/${shipment.id}/postponed/`)
            && event.voiceReasonPath.endsWith('.flac')
        ))
        const paths = [...new Set(postponedEvents.map((event) => event.voiceReasonPath!))]
        if (paths.length === 0) continue

        await addToOfflineMutations(
            'delivery_voice_cleanup',
            shipment.id,
            'delete',
            {
                shipmentId: shipment.id,
                eventIds: postponedEvents.map((event) => event.id),
                paths,
            },
            workspaceId,
        )
    }
}

/**
 * A merchant profile may have been created while a workspace was local, then
 * later be used to create a cloud shipment. When that shipment is explicitly
 * retried, requeue its local prerequisites so the server can receive the
 * profile, shipment, and event in dependency order.
 */
async function requeueDeliveryShipmentParents(
    workspaceId: string,
    mutations: OfflineMutation[]
) {
    const shipmentMutations = mutations.filter(
        (mutation) => mutation.entityType === 'delivery_shipments'
    )
    if (shipmentMutations.length === 0) return

    const profileIds = new Set<string>()
    const partnerIds = new Set<string>()
    for (const mutation of shipmentMutations) {
        const profileId = payloadId(mutation.payload, 'merchantProfileId', 'merchant_profile_id')
        const partnerId = payloadId(mutation.payload, 'merchantBusinessPartnerId', 'merchant_business_partner_id')
        if (profileId) profileIds.add(profileId)
        if (partnerId) partnerIds.add(partnerId)
    }

    const profiles = (await Promise.all(
        [...profileIds].map((profileId) => db.delivery_merchant_profiles.get(profileId))
    )).filter((profile): profile is DeliveryMerchantProfile => (
        !!profile
        && !profile.isDeleted
        && profile.workspaceId === workspaceId
    ))
    for (const profile of profiles) {
        partnerIds.add(profile.businessPartnerId)
    }

    const partners = (await Promise.all(
        [...partnerIds].map((partnerId) => db.business_partners.get(partnerId))
    )).filter((partner): partner is BusinessPartner => (
        !!partner
        && !partner.isDeleted
        && partner.workspaceId === workspaceId
    ))

    await Promise.all([
        ...partners.map((partner) => addToOfflineMutations(
            'business_partners',
            partner.id,
            partner.version > 1 ? 'update' : 'create',
            partner as unknown as Record<string, unknown>,
            workspaceId
        )),
        ...profiles.map((profile) => addToOfflineMutations(
            'delivery_merchant_profiles',
            profile.id,
            profile.version > 1 ? 'update' : 'create',
            profile as unknown as Record<string, unknown>,
            workspaceId
        ))
    ])
}

export async function addToOfflineMutations(
    entityType: OfflineMutation['entityType'],
    entityId: string,
    operation: OfflineMutation['operation'],
    payload: Record<string, unknown>,
    workspaceId: string
): Promise<void> {
    if (
        isLocalWorkspaceMode(workspaceId)
        || LOCAL_ONLY_ENTITY_TYPES.has(entityType)
        || !isCloudInventoryTransactionMutation(entityType, payload)
    ) {
        return
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
                payload: { ...payload, id: entityId },
                createdAt: new Date().toISOString()
            })
            return
        }

        if (operation === 'update' || operation === 'create') {
            await db.offline_mutations.update(existing.id, {
                operation: existing.operation === 'delete' ? 'update' : existing.operation,
                payload: { ...existing.payload, ...payload },
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
        payload,
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
            error: undefined
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
        .filter((mutation) => mutation.workspaceId === workspaceId && isSyncIntegrityError(mutation.error))
        .toArray()

    if (rows.length === 0) return 0

    await requeueDeliveryShipmentParents(workspaceId, rows)
    await queueRedispatchedPostponedVoiceCleanup(workspaceId, rows)
    const unrepairedAssignmentMutationIds = await repairSalesOrderAgentAssignmentWorkspaceMutations(rows)
    const rowsToRetry = rows.filter((mutation) => !unrepairedAssignmentMutationIds.has(mutation.id))

    await db.offline_mutations.bulkUpdate(rowsToRetry.map((mutation) => ({
        key: mutation.id,
        changes: {
            status: 'pending' as const,
            error: undefined
        }
    })))

    return rowsToRetry.length
}
