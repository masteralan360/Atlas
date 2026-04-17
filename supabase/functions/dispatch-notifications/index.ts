import { Novu } from 'npm:@novu/api'
import { createAdminClient } from '../_shared/supabase.ts'
import { errorResponse, jsonResponse } from '../_shared/http.ts'

type PendingNotificationEvent = {
    id: string
    user_id: string
    entity_type: string
    entity_id: string
    attempt_count: number
    payload: Record<string, unknown>
}

const novuApiKeyRaw = Deno.env.get('NOVU_API_KEY') ?? ''
const workflowBudgetOverdue = Deno.env.get('NOVU_WORKFLOW_BUDGET_OVERDUE') ?? ''
const workflowLoanOverdue = Deno.env.get('NOVU_WORKFLOW_LOAN_OVERDUE') ?? ''
const workflowMarketplacePendingOrder = Deno.env.get('NOVU_WORKFLOW_MARKETPLACE_PENDING_ORDER') ?? ''
const cronSecret = Deno.env.get('NOTIFICATION_CRON_SECRET') ?? ''

const novuApiKey = novuApiKeyRaw.startsWith('ApiKey ')
    ? novuApiKeyRaw
    : `ApiKey ${novuApiKeyRaw}`

function resolveWorkflowId(entityType: string) {
    if (entityType === 'loan_overdue') return workflowLoanOverdue
    if (entityType === 'marketplace_order_pending') return workflowMarketplacePendingOrder
    if (entityType === 'budget_expense' || entityType === 'budget_payroll' || entityType === 'budget_dividend') {
        return workflowBudgetOverdue
    }
    return ''
}

async function markEventStatus(
    adminClient: ReturnType<typeof createAdminClient>,
    eventId: string,
    status: 'sent' | 'failed',
    error?: string | null
) {
    const { error: updateError } = await adminClient.rpc('update_notification_event_status', {
        p_event_id: eventId,
        p_status: status,
        p_error: error ?? null
    })

    if (updateError) {
        console.error('[dispatch-notifications] Failed to update event status', eventId, updateError)
    }
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

    if (!novuApiKeyRaw) {
        return errorResponse('NOVU_API_KEY is not configured', 500)
    }

    const adminClient = createAdminClient()
    const novu = new Novu({ secretKey: novuApiKey })

    const { data, error } = await adminClient.rpc('get_pending_notification_events')
    if (error) {
        console.error('[dispatch-notifications] Failed to load pending events', error)
        return errorResponse(error.message, 500)
    }

    const events = (data ?? []) as PendingNotificationEvent[]
    if (events.length === 0) {
        return jsonResponse({ processed: 0 })
    }

    let processed = 0

    for (const event of events) {
        const workflowId = resolveWorkflowId(event.entity_type)
        if (!workflowId) {
            await markEventStatus(adminClient, event.id, 'failed', `Missing workflow for ${event.entity_type}`)
            processed += 1
            continue
        }

        try {
            await novu.subscribers.create({
                subscriberId: event.user_id
            })

            await novu.trigger({
                workflowId,
                transactionId: event.id,
                to: {
                    subscriberId: event.user_id
                },
                payload: event.payload ?? {}
            })

            await markEventStatus(adminClient, event.id, 'sent')
        } catch (sendError) {
            const message = sendError instanceof Error ? sendError.message : String(sendError)
            console.error('[dispatch-notifications] Failed to send event', event.id, message)
            await markEventStatus(adminClient, event.id, 'failed', message)
        }

        processed += 1
    }

    return jsonResponse({ processed })
})
