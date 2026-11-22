import { createAdminClient } from '../_shared/supabase.ts'
import { corsHeaders, errorResponse, jsonResponse } from '../_shared/http.ts'

const WORKSPACE_ID = '903503d2-cb83-49b8-9243-3f175f55b389'
const MAX_REQUEST_BYTES = 32_768

type RequestBody = {
    action?: string
    honeypot?: string
    visit?: Record<string, unknown>
}

function privateJson(payload: unknown, status = 200) {
    return jsonResponse(payload, {
        status,
        headers: { 'Cache-Control': 'no-store' }
    })
}

async function readRequestBody(req: Request): Promise<RequestBody | null> {
    const contentLength = Number(req.headers.get('content-length') ?? 0)
    if (contentLength > MAX_REQUEST_BYTES) return null

    try {
        const rawBody = await req.text()
        if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) return null
        const parsed = JSON.parse(rawBody)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as RequestBody
            : null
    } catch {
        return null
    }
}

function getRequestIp(req: Request) {
    const forwardedIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    return req.headers.get('cf-connecting-ip')?.trim()
        || req.headers.get('x-real-ip')?.trim()
        || forwardedIp
        || 'unknown'
}

async function hashRateLimitKey(ip: string) {
    const input = new TextEncoder().encode(`siva-public-visit:${ip}`)
    const digest = await crypto.subtle.digest('SHA-256', input)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function getConfiguration(adminClient: ReturnType<typeof createAdminClient>) {
    const [workspaceResult, proceduresResult] = await Promise.all([
        adminClient
            .from('workspaces')
            .select('default_currency, iqd_display_preference')
            .eq('id', WORKSPACE_ID)
            .is('deleted_at', null)
            .maybeSingle(),
        adminClient
            .schema('clinics')
            .from('clinical_presets')
            .select('id, name, display_name, consultation_fee, is_active, face_map_areas, sort_order')
            .eq('workspace_id', WORKSPACE_ID)
            .eq('category', 'beauty3_procedure')
            .eq('is_active', true)
            .eq('is_deleted', false)
            .order('sort_order', { ascending: true })
    ])

    if (workspaceResult.error || !workspaceResult.data) throw new Error('Workspace settings are unavailable')
    if (proceduresResult.error) throw new Error('Procedure options are unavailable')

    const workspace = workspaceResult.data
    const currency = String(workspace.default_currency ?? '').toLowerCase()
    const iqdPreference = workspace.iqd_display_preference
    if (!['usd', 'eur', 'iqd', 'try'].includes(currency)) throw new Error('Workspace currency is invalid')

    return privateJson({
        defaultCurrency: currency,
        iqdPreference: iqdPreference === 'د.ع' ? 'د.ع' : 'IQD',
        procedurePresets: (proceduresResult.data ?? []).map((preset) => ({
            id: preset.id,
            name: preset.name,
            displayName: preset.display_name,
            consultationFee: Number(preset.consultation_fee),
            isActive: preset.is_active,
            faceMapAreas: preset.face_map_areas,
        })),
    })
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

    const body = await readRequestBody(req)
    if (!body) return errorResponse('Invalid request body')

    try {
        const adminClient = createAdminClient()
        if (body.action === 'configuration') return await getConfiguration(adminClient)
        if (body.action !== 'submit' || !body.visit || typeof body.visit !== 'object' || Array.isArray(body.visit)) {
            return errorResponse('Invalid request')
        }

        // A filled honeypot is treated as successful so automated submissions get no signal.
        if (typeof body.honeypot === 'string' && body.honeypot.trim()) {
            return privateJson({ ok: true })
        }

        const rateLimitKey = await hashRateLimitKey(getRequestIp(req))
        const rateLimit = await adminClient.rpc('consume_siva_public_visit_rate_limit', {
            p_rate_limit_key: rateLimitKey,
        })
        if (rateLimit.error) throw rateLimit.error
        if (rateLimit.data !== true) {
            return privateJson({ ok: false, error: 'rate_limited' }, 429)
        }

        const result = await adminClient.rpc('create_siva_public_beauty3_visit', {
            p_visit: body.visit,
        })
        if (result.error) throw result.error
        if (typeof result.data !== 'string') throw new Error('Visit was not created')

        return privateJson({ ok: true })
    } catch (error) {
        console.error('[siva-public-visit] Request failed', error)
        return privateJson({ ok: false, error: 'visit_unavailable' }, 500)
    }
})
