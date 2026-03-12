import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Novu } from 'npm:@novu/api'

const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
const novuApiKeyRaw = Deno.env.get('NOVU_API_KEY') || ''

const novuApiKey = novuApiKeyRaw.startsWith('ApiKey ')
    ? novuApiKeyRaw
    : `ApiKey ${novuApiKeyRaw}`

const novu = new Novu({ secretKey: novuApiKey })

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        if (req.method !== 'POST') {
            return jsonResponse({ error: 'Method not allowed' }, 405)
        }

        if (!supabaseUrl || !supabaseAnonKey || !novuApiKeyRaw) {
            return jsonResponse({ error: 'Missing server configuration' }, 500)
        }

        const authHeader = req.headers.get('authorization') || ''
        if (!authHeader) {
            return jsonResponse({ error: 'Missing authorization' }, 401)
        }

        const supabase = createClient(supabaseUrl, supabaseAnonKey, {
            global: {
                headers: {
                    Authorization: authHeader
                }
            }
        })

        const { data: userData, error: userError } = await supabase.auth.getUser()
        if (userError || !userData?.user) {
            return jsonResponse({ error: userError?.message || 'Unauthorized' }, 401)
        }

        const { token, platform } = await req.json()
        const resolvedToken = typeof token === 'string' ? token.trim() : ''
        if (!resolvedToken) {
            return jsonResponse({ error: 'Missing token' }, 400)
        }

        const user = userData.user
        let workspaceId = (user.user_metadata as any)?.workspace_id as string | undefined

        if (!workspaceId) {
            const { data: profile } = await supabase
                .from('profiles')
                .select('workspace_id')
                .eq('id', user.id)
                .single()
            workspaceId = profile?.workspace_id
        }

        if (!workspaceId) {
            return jsonResponse({ error: 'Missing workspace' }, 400)
        }

        const { error: upsertError } = await supabase
            .schema('notifications')
            .from('device_tokens')
            .upsert(
                {
                    user_id: user.id,
                    workspace_id: workspaceId,
                    platform: platform || 'android',
                    device_token: resolvedToken,
                    updated_at: new Date().toISOString()
                },
                {
                    onConflict: 'user_id,platform,device_token'
                }
            )

        if (upsertError) {
            return jsonResponse({ error: upsertError.message }, 500)
        }

        try {
            await novu.subscribers.create({
                subscriberId: user.id
            })
            await novu.subscribers.credentials.update(
                {
                    providerId: 'fcm',
                    credentials: {
                        deviceTokens: [resolvedToken]
                    }
                },
                user.id
            )

        } catch (novuError: any) {
            return jsonResponse({ error: novuError?.message || String(novuError) }, 500)
        }

        return jsonResponse({ ok: true })
    } catch (error: any) {
        return jsonResponse({ error: error?.message || String(error) }, 500)
    }
})

