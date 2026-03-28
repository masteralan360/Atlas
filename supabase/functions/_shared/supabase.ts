import { createClient, type User } from 'jsr:@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    throw new Error('Supabase edge function environment is not configured')
}

export function createAdminClient() {
    return createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    })
}

export function createRequestClient(authHeader: string) {
    return createClient(supabaseUrl, supabaseAnonKey, {
        global: {
            headers: {
                Authorization: authHeader
            }
        },
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    })
}

export async function getAuthenticatedUser(req: Request): Promise<{ user: User | null; error: string | null }> {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
        return { user: null, error: 'Missing authorization header' }
    }

    const bearerPrefix = 'Bearer '
    const accessToken = authHeader.startsWith(bearerPrefix)
        ? authHeader.slice(bearerPrefix.length).trim()
        : authHeader.trim()

    if (!accessToken) {
        return { user: null, error: 'Missing access token' }
    }

    const requestClient = createRequestClient(authHeader)
    const { data, error } = await requestClient.auth.getUser(accessToken)

    if (error || !data.user) {
        return { user: null, error: 'Authentication required' }
    }

    return { user: data.user, error: null }
}
