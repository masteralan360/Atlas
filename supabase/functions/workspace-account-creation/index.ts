import { createAdminClient, getAuthenticatedUser } from '../_shared/supabase.ts'
import { corsHeaders, jsonResponse, readJson } from '../_shared/http.ts'
import {
    buildWorkspaceAccountProfile,
    buildWorkspaceAccountUserMetadata,
    getWorkspaceAccountCreationAuthorizationError,
    parseCreateWorkspaceAccountInput
} from '../_shared/workspaceAccountCreation.ts'

type CreateWorkspaceAccountRequest = {
    email?: unknown
    name?: unknown
    password?: unknown
    merchant?: unknown
}

type WorkspaceProfile = {
    role: string | null
    current_workspace: string | null
}

type Workspace = {
    data_mode: string
    deleted_at: string | null
    plan: string
}

function response(code: string, status = 400) {
    return jsonResponse({ code }, { status })
}

function getCreationFailureCode(error: { message?: string; status?: number }) {
    const message = error.message?.toLowerCase() ?? ''
    if (message.includes('member limit')) return 'member_limit_reached'
    if (
        message.includes('already registered')
        || message.includes('already exists')
        || message.includes('duplicate')
    ) return 'duplicate_email'
    if (error.status === 422 && (message.includes('password') || message.includes('weak'))) {
        return 'invalid_password'
    }
    return 'account_creation_failed'
}

async function hasReachedMemberLimit(
    admin: ReturnType<typeof createAdminClient>,
    workspaceId: string,
    plan: string
) {
    const [profilesResult, limitResult] = await Promise.all([
        admin
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', workspaceId),
        admin.rpc('workspace_max_members', {
            p_workspace_id: workspaceId,
            p_plan: plan
        })
    ])

    if (profilesResult.error) throw profilesResult.error
    if (limitResult.error) throw limitResult.error

    const maxMembers = Number(limitResult.data)
    return Number.isFinite(maxMembers) && (profilesResult.count ?? 0) >= maxMembers
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (req.method !== 'POST') return response('request_not_supported', 405)

    const { user } = await getAuthenticatedUser(req)
    if (!user) return response('authentication_required', 401)

    const body = await readJson<CreateWorkspaceAccountRequest>(req)
    const request = parseCreateWorkspaceAccountInput(body)
    if (!request) return response('invalid_request')

    try {
        const admin = createAdminClient()
        const { data: callerProfile, error: callerProfileError } = await admin
            .from('profiles')
            .select('role, current_workspace')
            .eq('id', user.id)
            .maybeSingle()

        if (callerProfileError) throw callerProfileError
        const profile = callerProfile as WorkspaceProfile | null
        const workspaceId = profile?.current_workspace
        if (profile?.role !== 'admin' || !workspaceId) return response('not_authorized', 403)

        const { data: workspace, error: workspaceError } = await admin
            .from('workspaces')
            .select('data_mode, deleted_at, plan')
            .eq('id', workspaceId)
            .maybeSingle()

        if (workspaceError) throw workspaceError
        const activeWorkspace = workspace as Workspace | null
        const authorizationError = getWorkspaceAccountCreationAuthorizationError({
            callerRole: profile.role,
            workspaceId,
            workspaceDataMode: activeWorkspace?.data_mode,
            workspaceDeleted: Boolean(activeWorkspace?.deleted_at)
        })
        if (authorizationError) return response(authorizationError, 403)
        if (!activeWorkspace) return response('workspace_unavailable', 403)

        if (await hasReachedMemberLimit(admin, workspaceId, activeWorkspace.plan)) {
            return response('member_limit_reached', 403)
        }

        if (request.merchant) {
            const { data: grant, error: grantError } = await admin.from('workspace_access_overrides')
                .select('value').eq('workspace_id', workspaceId).eq('type', 'module').eq('key', 'postal_service').maybeSingle()
            if (grantError) throw grantError
            if (grant?.value !== 'grant') return response('not_authorized', 403)
            if (request.merchant.mode === 'join') {
                const { data: organization, error: organizationError } = await admin.from('postal_organizations')
                    .select('id').eq('workspace_id', workspaceId).eq('code', request.merchant.code).maybeSingle()
                if (organizationError) throw organizationError
                if (!organization) return response('invalid_organization')
            }
        }

        const merchantUserId = request.merchant ? crypto.randomUUID() : undefined
        if (merchantUserId) {
            const { error: permitError } = await admin.rpc('postal_prepare_registration', {
                p_user_id: merchantUserId, p_email: request.email,
                p_enrollment: { ...request.merchant, workspace_id: workspaceId, actor_id: user.id }
            })
            if (permitError) throw permitError
        }
        const { data: createdUserData, error: createUserError } = await admin.auth.admin.createUser({
            ...(merchantUserId ? { id: merchantUserId } : {}),
            email: request.email,
            password: request.password,
            email_confirm: true,
            user_metadata: buildWorkspaceAccountUserMetadata(request.name, workspaceId)
        })

        if (createUserError || !createdUserData.user) {
            if (merchantUserId) await admin.rpc('postal_cancel_registration', { p_user_id: merchantUserId })
            if (createUserError) {
                let code = getCreationFailureCode(createUserError)
                if (code === 'account_creation_failed'
                    && await hasReachedMemberLimit(admin, workspaceId, activeWorkspace.plan)) {
                    code = 'member_limit_reached'
                }
                const status = code === 'duplicate_email' ? 409 : code === 'member_limit_reached' ? 403 : 400
                return response(code, status)
            }
            return response('account_creation_failed', 400)
        }

        const createdUser = createdUserData.user
        // Merchant enrollment is committed by the Auth insert trigger, atomically
        // with its profile, membership, organization and permission.
        if (request.merchant) return jsonResponse({ id: createdUser.id, email: request.email })

        const { error: profileError } = await admin
            .from('profiles')
            .upsert(buildWorkspaceAccountProfile(createdUser.id, request.name, workspaceId), { onConflict: 'id' })

        if (profileError) {
            await admin.auth.admin.deleteUser(createdUser.id).catch((cleanupError) => {
                console.error('[workspace-account-creation] Failed to clean up an incomplete account:', cleanupError)
            })
            const code = getCreationFailureCode(profileError)
            const status = code === 'member_limit_reached' ? 403 : 400
            return response(code, status)
        }

        return jsonResponse({ id: createdUser.id, email: request.email })
    } catch (error) {
        console.error('[workspace-account-creation] Request failed:', error)
        return response('account_creation_failed', 503)
    }
})
