import { createAdminClient, getAuthenticatedUser } from '../_shared/supabase.ts'
import { corsHeaders, errorResponse, jsonResponse, readJson } from '../_shared/http.ts'

type AccountSwitcherRequest = {
    action?: 'list-members' | 'validate-member'
    workspaceId?: string
    userId?: string
}

type WorkspaceProfile = {
    id: string
    name: string | null
    role: string | null
    workspace_id: string | null
    current_workspace: string | null
    profile_url: string | null
}

type AuthUserRecord = {
    id: string
    email?: string | null
    banned_until?: string | null
    deleted_at?: string | null
    email_confirmed_at?: string | null
}

function isActiveAuthUser(user: {
    banned_until?: string | null
    deleted_at?: string | null
    email_confirmed_at?: string | null
}) {
    if (user.deleted_at) return false
    if (!user.email_confirmed_at) return false
    if (!user.banned_until) return true
    const bannedUntil = Date.parse(user.banned_until)
    return Number.isFinite(bannedUntil) && bannedUntil <= Date.now()
}

function toAccount(profile: WorkspaceProfile, authUser: AuthUserRecord) {
    if (!authUser.email || !isActiveAuthUser(authUser)) return null
    return {
        id: profile.id,
        email: authUser.email,
        name: profile.name?.trim() || authUser.email.split('@')[0] || 'User',
        role: profile.role || 'viewer',
        profileUrl: profile.profile_url
    }
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (req.method !== 'POST') return errorResponse('Request method is not supported.', 405)

    const { user, error: authError } = await getAuthenticatedUser(req)
    if (!user) return errorResponse(authError ?? 'Authentication required.', 401)

    const body = await readJson<AccountSwitcherRequest>(req)
    if (!body || (body.action !== 'list-members' && body.action !== 'validate-member')) {
        return errorResponse('Account list is unavailable.', 400)
    }

    try {
        const admin = createAdminClient()
        const { data: callerProfile, error: callerProfileError } = await admin
            .from('profiles')
            .select('workspace_id, current_workspace')
            .eq('id', user.id)
            .maybeSingle()

        if (callerProfileError) throw callerProfileError

        const workspaceId = callerProfile?.current_workspace
        if (!workspaceId || body.workspaceId !== workspaceId) {
            return errorResponse('This workspace is no longer available.', 403)
        }

        const { data: workspace, error: workspaceError } = await admin
            .from('workspaces')
            .select('data_mode')
            .eq('id', workspaceId)
            .maybeSingle()

        if (workspaceError) throw workspaceError
        if (!workspace || (workspace.data_mode !== 'cloud' && workspace.data_mode !== 'hybrid')) {
            return errorResponse('Account switching is unavailable for this workspace.', 403)
        }

        if (body.action === 'validate-member') {
            if (!body.userId) return errorResponse('This account is no longer available in this workspace.', 404)

            const { data: profile, error: profileError } = await admin
                .from('profiles')
                .select('id, name, role, workspace_id, current_workspace, profile_url')
                .eq('id', body.userId)
                .eq('workspace_id', workspaceId)
                .eq('current_workspace', workspaceId)
                .maybeSingle()

            if (profileError) throw profileError
            if (!profile) return errorResponse('This account is no longer available in this workspace.', 404)

            const { data, error } = await admin.auth.admin.getUserById(profile.id)
            if (error && Number(error.status) !== 404) throw error
            if (!data?.user) return errorResponse('This account is no longer available in this workspace.', 404)

            const account = toAccount(profile as WorkspaceProfile, data.user as AuthUserRecord)
            if (!account) return errorResponse('This account is no longer available in this workspace.', 404)
            return jsonResponse({ account })
        }

        const { data: profiles, error: profilesError } = await admin
            .from('profiles')
            .select('id, name, role, workspace_id, current_workspace, profile_url')
            .eq('workspace_id', workspaceId)
            .eq('current_workspace', workspaceId)

        if (profilesError) throw profilesError

        const matchingProfiles = (profiles ?? []) as WorkspaceProfile[]
        const accounts: ReturnType<typeof toAccount>[] = []

        for (let offset = 0; offset < matchingProfiles.length; offset += 25) {
            const profileBatch = matchingProfiles.slice(offset, offset + 25)
            const batchAccounts = await Promise.all(profileBatch.map(async (profile) => {
                const { data, error } = await admin.auth.admin.getUserById(profile.id)
                if (error && Number(error.status) !== 404) throw error
                return data?.user ? toAccount(profile, data.user as AuthUserRecord) : null
            }))
            accounts.push(...batchAccounts)
        }

        const activeAccounts = accounts.filter((account): account is NonNullable<typeof account> => Boolean(account))
            .sort((left, right) => left.name.localeCompare(right.name))

        return jsonResponse({ accounts: activeAccounts })
    } catch (error) {
        console.error('[workspace-account-switcher] Request failed:', error)
        return errorResponse('Account list is temporarily unavailable.', 503)
    }
})
