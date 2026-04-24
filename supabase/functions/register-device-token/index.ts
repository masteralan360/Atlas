import { corsHeaders, errorResponse, jsonResponse, readJson } from '../_shared/http.ts'
import { normalizeNotificationLanguage } from '../_shared/notificationLocalization.ts'
import { createAdminClient, getAuthenticatedUser } from '../_shared/supabase.ts'

type RegisterDeviceTokenRequest = {
    token?: string
    platform?: string
    language?: string | null
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    if (req.method !== 'POST') {
        return errorResponse('Method not allowed', 405)
    }

    const { user, error: authError } = await getAuthenticatedUser(req)
    if (authError || !user) {
        return errorResponse(authError ?? 'Authentication required', 401)
    }

    const body = await readJson<RegisterDeviceTokenRequest>(req)
    if (!body) {
        return errorResponse('Invalid request body')
    }

    const token = typeof body.token === 'string' ? body.token.trim() : ''
    const platform = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : ''
    const language = normalizeNotificationLanguage(body.language)

    if (!token) {
        return errorResponse('Device token is required')
    }

    if (platform !== 'web' && platform !== 'android') {
        return errorResponse('Unsupported platform', 400, { platform })
    }

    try {
        const adminClient = createAdminClient()
        const { data, error } = await adminClient.rpc('upsert_device_token', {
            p_user_id: user.id,
            p_platform: platform,
            p_device_token: token,
            p_workspace_id: null,
            p_language: language,
        })

        if (error) {
            console.error('[register-device-token] Failed to upsert device token', error)
            return errorResponse(error.message, 500)
        }

        return jsonResponse({
            ok: true,
            deviceTokenId: data,
            platform,
            language,
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[register-device-token] Unexpected failure', message)
        return errorResponse(message, 500)
    }
})
