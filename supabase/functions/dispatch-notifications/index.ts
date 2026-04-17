import { errorResponse, jsonResponse } from '../_shared/http.ts'
import { createAdminClient } from '../_shared/supabase.ts'

const cronSecret = Deno.env.get('NOTIFICATION_CRON_SECRET') ?? ''

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

    const adminClient = createAdminClient()
    const { data, error } = await adminClient.rpc('dispatch_notification_events')

    if (error) {
        console.error('[dispatch-notifications] Failed to dispatch pending events', error)
        return errorResponse(error.message, 500)
    }

    return jsonResponse({ processed: Number(data ?? 0) })
})
