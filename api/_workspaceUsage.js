const WORKSPACE_TRANSFER_LIMIT_MESSAGE = 'Workspace monthly data transfer limit exceeded'

function requiredEnv(name) {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`Missing required server environment variable: ${name}`)
    return value
}

export function getSupabaseServerConfig() {
    return {
        supabaseUrl: requiredEnv('SUPABASE_URL').replace(/\/+$/, ''),
        anonKey: requiredEnv('SUPABASE_ANON_KEY'),
        serviceRoleKey: requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
    }
}

export function getBearerToken(req) {
    const value = req.headers.authorization
    return typeof value === 'string' && /^Bearer\s+.+/i.test(value) ? value : null
}

export function responseJson(res, status, payload) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.send(JSON.stringify(payload))
}

export function copyResponseHeaders(res, headers) {
    const allowed = [
        'cache-control',
        'content-disposition',
        'content-language',
        'content-range',
        'content-type',
        'etag',
        'last-modified',
        'location',
        'preference-applied',
        'range',
        'x-request-id'
    ]

    for (const name of allowed) {
        const value = headers.get(name)
        if (value) res.setHeader(name, value)
    }
}

export async function readRawBody(req) {
    const chunks = []
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
}

export function requestHeadersForUpstream(req, body) {
    const headers = new Headers()
    const passThrough = [
        'accept',
        // Supabase uses these PostgREST headers to select non-public schemas
        // such as crm, budget, clinics, and real_estate.
        'accept-profile',
        'accept-language',
        'authorization',
        'cache-control',
        'content-profile',
        'content-type',
        'if-match',
        'if-none-match',
        'prefer',
        'range',
        'x-metadata',
        'x-client-info',
        'x-atlas-image-compressed',
        'x-atlas-image-source',
        'x-atlas-image-profile',
        'x-atlas-image-width',
        'x-atlas-image-height',
        'x-atlas-image-original-bytes',
        'x-upsert'
    ]

    for (const name of passThrough) {
        const value = req.headers[name]
        if (typeof value === 'string' && value) headers.set(name, value)
    }

    if (body.byteLength > 0) headers.set('Content-Length', String(body.byteLength))
    return headers
}

export function queryWithoutPath(req) {
    const url = new URL(req.url || '/', 'https://atlas.invalid')
    url.searchParams.delete('path')
    return url.searchParams
}

export function getRequiredProxyPath(req) {
    const value = Array.isArray(req.query.path) ? req.query.path[0] : req.query.path
    const path = typeof value === 'string' ? value.replace(/^\/+/, '') : ''
    if (!path || path.split('/').some((segment) => segment === '..')) {
        return null
    }
    return path
}

export async function resolveWorkspaceUsage(req) {
    const authorization = getBearerToken(req)
    if (!authorization) return { authorization: null, workspace: null }

    const { supabaseUrl, anonKey } = getSupabaseServerConfig()
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/get_current_workspace_usage_access`, {
        method: 'POST',
        headers: {
            apikey: anonKey,
            Authorization: authorization,
            'Content-Type': 'application/json'
        },
        body: '{}'
    })

    if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Unable to resolve workspace usage (${response.status})${detail ? `: ${detail}` : ''}`)
    }

    const rows = await response.json()
    const workspace = Array.isArray(rows) ? rows[0] : rows
    if (!workspace?.workspace_id) {
        throw new Error('Workspace usage preflight did not identify a workspace')
    }

    return { authorization, workspace }
}

export async function recordWebLiveUsage(workspaceId, measuredBytes, source) {
    if (!workspaceId || !Number.isFinite(measuredBytes) || measuredBytes <= 0) return

    const { supabaseUrl, serviceRoleKey } = getSupabaseServerConfig()
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/record_workspace_data_transfer`, {
        method: 'POST',
        headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            'Content-Type': 'application/json',
            // The meter is a side-effect-only RPC. Avoid returning a usage row
            // for every proxied request.
            Prefer: 'return=minimal'
        },
        body: JSON.stringify({
            p_workspace_id: workspaceId,
            p_bytes: Math.trunc(measuredBytes),
            p_source: source,
            p_channel: 'web_live'
        })
    })

    if (response.ok) return

    const detail = await response.text().catch(() => '')
    const error = new Error(detail || 'Workspace usage could not be recorded')
    error.statusCode = detail.includes(WORKSPACE_TRANSFER_LIMIT_MESSAGE) ? 429 : 502
    throw error
}

export function isWorkspaceUsageLocked(workspace) {
    return workspace?.usage_limit_locked === true
}

export { WORKSPACE_TRANSFER_LIMIT_MESSAGE }
