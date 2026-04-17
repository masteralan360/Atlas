import Courier from 'npm:@trycourier/courier'
import { getAuthenticatedUser } from '../_shared/supabase.ts'
import { errorResponse, jsonResponse } from '../_shared/http.ts'

const courierApiKey = Deno.env.get('COURIER_API_KEY') ?? ''
const tokenScopeSuffix = [
    'write:user-tokens',
    'inbox:read:messages',
    'inbox:write:events',
    'read:preferences',
    'write:preferences',
    'read:brands'
].join(' ')

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return jsonResponse({ ok: true })
    }

    if (req.method !== 'POST') {
        return errorResponse('Method not allowed', 405)
    }

    if (!courierApiKey) {
        return errorResponse('COURIER_API_KEY is not configured', 500)
    }

    const { user, error } = await getAuthenticatedUser(req)
    if (error || !user) {
        return errorResponse(error ?? 'Authentication required', 401)
    }

    try {
        const courier = new Courier({ apiKey: courierApiKey })
        const response = await courier.auth.issueToken({
            scope: `user_id:${user.id} ${tokenScopeSuffix}`,
            expires_in: '15 minutes'
        })

        return jsonResponse({
            jwt: response.token,
            userId: user.id,
            expiresIn: '15 minutes'
        })
    } catch (issueError) {
        const message = issueError instanceof Error ? issueError.message : String(issueError)
        console.error('[issue-courier-token] Failed to issue token', message)
        return errorResponse(message, 500)
    }
})
