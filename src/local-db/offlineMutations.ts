import { generateId } from '@/lib/utils'
import { isSchemaMismatchError, isSyncIntegrityError } from '@/sync/syncErrors'
import { getSyncRegistration } from '@/sync/syncRegistry'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { getActiveBusinessUserId } from '@/lib/network'

import {
    durableMutationToOfflineMutation,
    enqueueCloudSyncMutation,
    readAtomicCloudSyncEntityMutation,
    transitionCloudSyncMutation,
    updateCloudSyncMutationPayload,
} from './cloudSyncOutbox'
import { db } from './database'
import { LOCAL_MODE_SQLITE_TABLES } from './localModeSqlite'
import type { BusinessPartner, DeliveryMerchantProfile, OfflineMutation } from './models'

type ProjectedMutationTransition = 'pending' | 'acknowledged' | 'abandoned'

async function promoteLegacyProjectionMutation(mutation: OfflineMutation) {
    const result = await enqueueCloudSyncMutation({
        mutationId: mutation.id,
        workspaceId: mutation.workspaceId,
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        operation: mutation.operation,
        payload: mutation.payload,
        actorId: mutation.actorId,
        aggregateKey: mutation.aggregateKey,
        groupId: mutation.groupId,
        dependencies: mutation.dependencies,
        baseVersion: mutation.baseVersion,
        createdAt: mutation.createdAt,
    })

    if (result.removedMutationIds.length > 0) {
        await db.offline_mutations.bulkDelete(result.removedMutationIds)
    }
    if (result.mutation) {
        await db.offline_mutations.put(durableMutationToOfflineMutation(result.mutation))
    }

    return result.mutation
}

/**
 * Update the durable mutation first, then refresh its disposable Dexie
 * projection. During the compatibility window, a legacy projection-only row
 * is promoted into SQLite before it is edited.
 */
export async function updateOfflineMutationPayload(
    mutation: OfflineMutation,
    payload: Record<string, unknown>,
    options: { workspaceId?: string; resetToPending?: boolean } = {},
): Promise<OfflineMutation | null> {
    const registration = getSyncRegistration(mutation.entityType)
    // `syncing` is a legacy Dexie-only state recovered as pending. Only a
    // durable lease represents an immutable attempt currently in flight.
    const isInFlight = mutation.status === 'leased'
    if (registration.kind === 'command' || isInFlight) {
        if (!isInFlight) {
            await abandonOfflineMutations(
                [mutation],
                'Replaced by a newer immutable command payload.',
            )
        }
        const result = await enqueueCloudSyncMutation({
            mutationId: generateId(),
            workspaceId: options.workspaceId ?? mutation.workspaceId,
            entityType: mutation.entityType,
            entityId: mutation.entityId,
            operation: mutation.operation,
            payload,
            actorId: mutation.actorId,
            aggregateKey: mutation.aggregateKey,
            groupId: mutation.groupId,
            dependencies: isInFlight
                ? [...new Set([...(mutation.dependencies ?? []), mutation.id])]
                : mutation.dependencies,
            baseVersion: mutation.baseVersion,
        })
        if (!result.mutation) {
            throw new Error(`Replacement mutation for ${mutation.id} was not persisted.`)
        }
        const projection = durableMutationToOfflineMutation(result.mutation)
        await db.offline_mutations.put(projection)
        return projection
    }

    const scopedOptions = {
        ...options,
        workspaceId: options.workspaceId ?? mutation.workspaceId,
        userId: mutation.actorId ?? getActiveBusinessUserId(),
    }
    let durable = await updateCloudSyncMutationPayload(mutation.id, payload, scopedOptions)
    if (!durable) {
        const promoted = await promoteLegacyProjectionMutation(mutation)
        if (!promoted) {
            // Derived rows are intentionally not outbox records. Removing this
            // obsolete projection cannot discard a valid durable mutation.
            await db.offline_mutations.delete(mutation.id)
            return null
        }
        durable = await updateCloudSyncMutationPayload(promoted.mutationId, payload, scopedOptions)
        if (promoted.mutationId !== mutation.id) {
            await db.offline_mutations.delete(mutation.id)
        }
    }
    if (!durable) {
        throw new Error(`Durable mutation ${mutation.id} could not be updated.`)
    }
    const projection = durableMutationToOfflineMutation(durable)
    await db.offline_mutations.put(projection)
    return projection
}

async function transitionOfflineMutations(
    mutations: readonly OfflineMutation[],
    disposition: ProjectedMutationTransition,
    reason?: string,
): Promise<void> {
    for (const mutation of mutations) {
        let durable = await transitionCloudSyncMutation(mutation.id, disposition, {
            errorCode: disposition === 'abandoned' ? 'superseded_by_authoritative_write' : null,
            errorMessage: disposition === 'abandoned' ? reason ?? 'Superseded by an authoritative write.' : null,
            workspaceId: mutation.workspaceId,
            userId: mutation.actorId ?? getActiveBusinessUserId(),
        })
        if (!durable) {
            const promoted = await promoteLegacyProjectionMutation(mutation)
            if (!promoted) {
                await db.offline_mutations.delete(mutation.id)
                continue
            }
            durable = await transitionCloudSyncMutation(promoted.mutationId, disposition, {
                errorCode: disposition === 'abandoned' ? 'superseded_by_authoritative_write' : null,
                errorMessage: disposition === 'abandoned' ? reason ?? 'Superseded by an authoritative write.' : null,
                workspaceId: promoted.workspaceId,
                userId: promoted.actorId ?? getActiveBusinessUserId(),
            })
            if (promoted.mutationId !== mutation.id) {
                await db.offline_mutations.delete(mutation.id)
            }
        }
        if (!durable) {
            throw new Error(`Durable mutation ${mutation.id} could not be retired.`)
        }
        await db.offline_mutations.put(durableMutationToOfflineMutation(durable))
    }
}

/** Stop queued mutations from replaying after a newer authoritative write. */
export async function abandonOfflineMutations(
    mutations: readonly OfflineMutation[],
    reason?: string,
): Promise<void> {
    await transitionOfflineMutations(mutations, 'abandoned', reason)
}

/** Record compatibility-path mutations whose command already succeeded remotely. */
export async function acknowledgeOfflineMutations(
    mutations: readonly OfflineMutation[],
): Promise<void> {
    await transitionOfflineMutations(mutations, 'acknowledged')
}

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
        await updateOfflineMutationPayload(mutation, payload, { workspaceId })
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
        || !isCloudInventoryTransactionMutation(entityType, payload)
    ) {
        return
    }

    const registration = getSyncRegistration(entityType)
    const isAtomicallyMirroredEntity = registration.kind === 'entity'
        && (LOCAL_MODE_SQLITE_TABLES as readonly string[]).includes(entityType)
    if (isAtomicallyMirroredEntity) {
        const atomic = await readAtomicCloudSyncEntityMutation(
            workspaceId,
            entityType,
            entityId,
        )
        if (atomic.mutation) {
            await db.offline_mutations.put(durableMutationToOfflineMutation(atomic.mutation))
            return
        }
        if (operation === 'delete' && !atomic.localEntityPresent) {
            const staleProjectionIds = await db.offline_mutations
                .where('entityType')
                .equals(entityType)
                .filter((mutation) => (
                    mutation.workspaceId === workspaceId
                    && mutation.entityId === entityId
                    && mutation.status !== 'acknowledged'
                    && mutation.status !== 'abandoned'
                ))
                .primaryKeys()
            if (staleProjectionIds.length > 0) {
                await db.offline_mutations.bulkDelete(staleProjectionIds as string[])
            }
            return
        }
    }

    // SQLite is the local save boundary. Dexie receives only a projection after
    // the durable entity/outbox transaction has committed.
    const result = await enqueueCloudSyncMutation({
        mutationId: generateId(),
        workspaceId,
        entityType,
        entityId,
        operation,
        payload,
    })

    if (result.removedMutationIds.length > 0) {
        await db.offline_mutations.bulkDelete(result.removedMutationIds)
    }
    if (result.mutation) {
        await db.offline_mutations.put(durableMutationToOfflineMutation(result.mutation))
    }
}

/**
 * Schema mismatches are intentionally excluded from automatic retries. A user
 * can explicitly retry them after the database migration has been deployed.
 */
export async function retrySchemaMismatchMutations(workspaceId: string): Promise<number> {
    const rows = (await Promise.all(
        (['failed', 'rejected'] as const).map((status) => db.offline_mutations
            .where('status')
            .equals(status)
            .filter((mutation) => mutation.workspaceId === workspaceId && isSchemaMismatchError(mutation.error))
            .toArray())
    )).flat()

    if (rows.length === 0) return 0

    await transitionOfflineMutations(rows, 'pending')

    return rows.length
}

/**
 * Requeue deterministic server rejections only after a user explicitly asks
 * to retry. They must never be picked up by background retry loops.
 */
export async function retrySyncIntegrityMutations(workspaceId: string): Promise<number> {
    const rows = (await Promise.all(
        (['failed', 'conflict', 'rejected'] as const).map((status) => db.offline_mutations
            .where('status')
            .equals(status)
            .filter((mutation) => mutation.workspaceId === workspaceId && isSyncIntegrityError(mutation.error))
            .toArray())
    )).flat()

    if (rows.length === 0) return 0

    await requeueDeliveryShipmentParents(workspaceId, rows)
    await queueRedispatchedPostponedVoiceCleanup(workspaceId, rows)
    const unrepairedAssignmentMutationIds = await repairSalesOrderAgentAssignmentWorkspaceMutations(rows)
    const rowsToRetry = rows.filter((mutation) => !unrepairedAssignmentMutationIds.has(mutation.id))

    await transitionOfflineMutations(rowsToRetry, 'pending')

    return rowsToRetry.length
}
