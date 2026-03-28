export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

export function jsonResponse(payload: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers)
    headers.set('Content-Type', 'application/json')

    for (const [key, value] of Object.entries(corsHeaders)) {
        headers.set(key, value)
    }

    return new Response(JSON.stringify(payload), {
        ...init,
        headers
    })
}

export function errorResponse(message: string, status = 400, extra: Record<string, unknown> = {}) {
    return jsonResponse({ error: message, ...extra }, { status })
}

export async function readJson<T>(req: Request): Promise<T | null> {
    try {
        return await req.json() as T
    } catch {
        return null
    }
}
