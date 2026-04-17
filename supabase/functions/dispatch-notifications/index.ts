import { errorResponse, jsonResponse, readJson } from '../_shared/http.ts'
import { createAdminClient } from '../_shared/supabase.ts'
import {
    type PushNotificationTarget,
    isFirebaseConfigured,
    isStaleRegistrationToken,
    sendFirebasePush,
} from '../_shared/firebase.ts'

const cronSecret = Deno.env.get('NOTIFICATION_CRON_SECRET') ?? ''
const pushBatchLimit = 100

type DispatchRequest = {
    workspace_id?: string | null
}

type PendingPushTarget = PushNotificationTarget

type PushSummary = {
    sent: number
    failed: number
    skipped: number
    staleTokensDeleted: number
}

function groupTargetsByNotification(targets: PendingPushTarget[]) {
    const groups = new Map<string, PendingPushTarget[]>()

    for (const target of targets) {
        const existing = groups.get(target.notification_id)
        if (existing) {
            existing.push(target)
        } else {
            groups.set(target.notification_id, [target])
        }
    }

    return groups
}

async function updatePushStatus(
    adminClient: ReturnType<typeof createAdminClient>,
    notificationId: string,
    status: 'sent' | 'failed' | 'skipped',
    error: string | null = null,
) {
    const { error: rpcError } = await adminClient.rpc('update_notification_push_delivery', {
        p_notification_id: notificationId,
        p_status: status,
        p_error: error,
        p_attempt_delta: 1,
    })

    if (rpcError) {
        console.error('[dispatch-notifications] Failed to update push delivery state', notificationId, rpcError)
    }
}

async function deleteStaleToken(adminClient: ReturnType<typeof createAdminClient>, tokenId: string) {
    const { error } = await adminClient.rpc('delete_device_token', {
        p_token_id: tokenId,
    })

    if (error) {
        console.error('[dispatch-notifications] Failed to delete stale device token', tokenId, error)
        return false
    }

    return true
}

async function deliverPendingPush(
    adminClient: ReturnType<typeof createAdminClient>,
    workspaceId: string | null,
): Promise<PushSummary> {
    const summary: PushSummary = {
        sent: 0,
        failed: 0,
        skipped: 0,
        staleTokensDeleted: 0,
    }

    if (!isFirebaseConfigured()) {
        console.warn('[dispatch-notifications] Firebase push is not configured. Skipping push delivery.')
        return summary
    }

    while (true) {
        const { data, error } = await adminClient.rpc('get_pending_push_notification_targets', {
            p_limit: pushBatchLimit,
            p_workspace_id: workspaceId,
        })

        if (error) {
            throw new Error(`Failed to load pending push targets: ${error.message}`)
        }

        const targets = (data ?? []) as PendingPushTarget[]
        if (targets.length === 0) {
            break
        }

        const grouped = groupTargetsByNotification(targets)

        for (const [notificationId, rows] of grouped.entries()) {
            const tokenRows = rows.filter((row) => row.device_token && row.platform)

            if (tokenRows.length === 0) {
                await updatePushStatus(adminClient, notificationId, 'skipped', 'No registered device tokens')
                summary.skipped += 1
                continue
            }

            let successCount = 0
            const failureMessages: string[] = []

            for (const row of tokenRows) {
                try {
                    await sendFirebasePush(row)
                    successCount += 1
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    failureMessages.push(message)
                    console.error('[dispatch-notifications] Failed to send Firebase push', row.notification_id, row.token_id, message)

                    if (row.token_id && isStaleRegistrationToken(error)) {
                        const deleted = await deleteStaleToken(adminClient, row.token_id)
                        if (deleted) {
                            summary.staleTokensDeleted += 1
                        }
                    }
                }
            }

            if (successCount > 0) {
                await updatePushStatus(adminClient, notificationId, 'sent', null)
                summary.sent += 1
            } else {
                await updatePushStatus(
                    adminClient,
                    notificationId,
                    'failed',
                    failureMessages.join(' | ').slice(0, 1000) || 'Unknown push delivery error',
                )
                summary.failed += 1
            }
        }
    }

    return summary
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return jsonResponse({ ok: true })
    }

    if (req.method !== 'POST') {
        return errorResponse('Method not allowed', 405)
    }

    const incomingSecret = req.headers.get('X-Cron-Secret') ?? req.headers.get('x-cron-secret') ?? ''
    if (!cronSecret || incomingSecret !== cronSecret) {
        return errorResponse('Unauthorized', 401)
    }

    const body = await readJson<DispatchRequest>(req)
    const workspaceId = typeof body?.workspace_id === 'string' && body.workspace_id.trim()
        ? body.workspace_id.trim()
        : null

    const adminClient = createAdminClient()
    const { data, error } = await adminClient.rpc('detect_and_dispatch_notification_events', {
        p_target_workspace_id: workspaceId,
    })

    if (error) {
        console.error('[dispatch-notifications] Failed to detect and dispatch notifications', error)
        return errorResponse(error.message, 500)
    }

    try {
        const pushSummary = await deliverPendingPush(adminClient, workspaceId)
        return jsonResponse({
            processed: Number(data ?? 0),
            push: pushSummary,
            pushConfigured: isFirebaseConfigured(),
        })
    } catch (pushError) {
        const message = pushError instanceof Error ? pushError.message : String(pushError)
        console.error('[dispatch-notifications] Push delivery failed', message)
        return errorResponse(message, 500, {
            processed: Number(data ?? 0),
            pushConfigured: isFirebaseConfigured(),
        })
    }
})
