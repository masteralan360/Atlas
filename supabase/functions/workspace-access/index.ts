import type { User } from 'jsr:@supabase/supabase-js@2'
import { createAdminClient, getAuthenticatedUser } from '../_shared/supabase.ts'
import { corsHeaders, errorResponse, jsonResponse, readJson } from '../_shared/http.ts'

type CreateWorkspaceRequest = {
    action: 'create'
    workspaceName?: string
    passkey?: string
}

type JoinWorkspaceRequest = {
    action: 'join'
    workspaceCode?: string
}

type KickMemberRequest = {
    action: 'kick'
    targetUserId?: string
}

type WorkspaceAccessRequest = CreateWorkspaceRequest | JoinWorkspaceRequest | KickMemberRequest

async function validateCreatePasskey(adminClient: ReturnType<typeof createAdminClient>, providedPasskey: string) {
    const { data, error } = await adminClient
        .from('app_permissions')
        .select('key_name, key_value')
        .in('key_name', ['admin_passkey', 'registration_passkey'])

    if (error) {
        throw error
    }

    const passkeys = new Map<string, string>()
    for (const row of data ?? []) {
        passkeys.set(String(row.key_name), String(row.key_value))
    }

    return providedPasskey === passkeys.get('admin_passkey')
        || providedPasskey === passkeys.get('registration_passkey')
}

async function handleCreateWorkspace(adminClient: ReturnType<typeof createAdminClient>, body: CreateWorkspaceRequest) {
    const workspaceName = body.workspaceName?.trim() ?? ''
    const passkey = body.passkey?.trim() ?? ''

    if (!workspaceName) {
        return errorResponse('Workspace name is required')
    }

    if (!passkey) {
        return errorResponse('Passkey is required', 403)
    }

    const isValid = await validateCreatePasskey(adminClient, passkey)
    if (!isValid) {
        return errorResponse('Invalid passkey', 403)
    }

    const { data, error } = await adminClient
        .from('workspaces')
        .insert({
            name: workspaceName,
            subscription_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            locked_workspace: false
        })
        .select('id, name, code')
        .single()

    if (error || !data) {
        return errorResponse(error?.message ?? 'Failed to create workspace', 500)
    }

    return jsonResponse(data)
}

async function handleJoinWorkspace(
    adminClient: ReturnType<typeof createAdminClient>,
    user: User,
    body: JoinWorkspaceRequest
) {
    const workspaceCode = body.workspaceCode?.trim().toUpperCase() ?? ''
    if (!workspaceCode) {
        return errorResponse('Workspace code is required')
    }

    const { data: workspace, error: workspaceError } = await adminClient
        .from('workspaces')
        .select('id, name, code, data_mode')
        .eq('code', workspaceCode)
        .is('deleted_at', null)
        .maybeSingle()

    if (workspaceError) {
        return errorResponse(workspaceError.message, 500)
    }

    if (!workspace) {
        return errorResponse('Invalid workspace code', 400)
    }

    const { error: profileError } = await adminClient
        .from('profiles')
        .update({ workspace_id: workspace.id })
        .eq('id', user.id)

    if (profileError) {
        return errorResponse(profileError.message, 500)
    }

    const { error: authError } = await adminClient.auth.admin.updateUserById(user.id, {
        user_metadata: {
            ...(user.user_metadata ?? {}),
            workspace_id: workspace.id,
            workspace_code: workspace.code,
            workspace_name: workspace.name,
            data_mode: workspace.data_mode ?? 'cloud'
        }
    })

    if (authError) {
        return errorResponse(authError.message, 500)
    }

    return jsonResponse({
        workspace_id: workspace.id,
        workspace_code: workspace.code,
        workspace_name: workspace.name,
        data_mode: workspace.data_mode ?? 'cloud'
    })
}

async function handleKickMember(
    adminClient: ReturnType<typeof createAdminClient>,
    user: User,
    body: KickMemberRequest
) {
    const targetUserId = body.targetUserId?.trim() ?? ''
    if (!targetUserId) {
        return errorResponse('Target user is required')
    }

    const { data: callerProfile, error: callerError } = await adminClient
        .from('profiles')
        .select('role, workspace_id')
        .eq('id', user.id)
        .maybeSingle()

    if (callerError) {
        return errorResponse(callerError.message, 500)
    }

    if (!callerProfile || callerProfile.role !== 'admin') {
        return errorResponse('Unauthorized: Only admins can kick members', 403)
    }

    const callerWorkspaceId = callerProfile.workspace_id
    if (!callerWorkspaceId) {
        return errorResponse('Caller is not assigned to a workspace', 400)
    }

    const { data: targetProfile, error: targetProfileError } = await adminClient
        .from('profiles')
        .select('role, workspace_id')
        .eq('id', targetUserId)
        .maybeSingle()

    if (targetProfileError) {
        return errorResponse(targetProfileError.message, 500)
    }

    if (!targetProfile) {
        return errorResponse('User not found', 404)
    }

    if (targetUserId === user.id) {
        return errorResponse('Cannot kick yourself', 400)
    }

    if (targetProfile.workspace_id !== callerWorkspaceId) {
        return errorResponse('Cannot kick members from other workspaces', 403)
    }

    if (targetProfile.role === 'admin') {
        return errorResponse('Cannot kick other admins', 403)
    }

    const { error: profileError } = await adminClient
        .from('profiles')
        .update({ workspace_id: null })
        .eq('id', targetUserId)

    if (profileError) {
        return errorResponse(profileError.message, 500)
    }

    const { data: targetUserResult, error: targetUserError } = await adminClient.auth.admin.getUserById(targetUserId)
    if (targetUserError || !targetUserResult.user) {
        return errorResponse(targetUserError?.message ?? 'Failed to load target user', 500)
    }

    const nextMetadata = { ...(targetUserResult.user.user_metadata ?? {}) }
    delete nextMetadata.workspace_id
    delete nextMetadata.workspace_code
    delete nextMetadata.workspace_name
    delete nextMetadata.data_mode

    const { error: authError } = await adminClient.auth.admin.updateUserById(targetUserId, {
        user_metadata: nextMetadata
    })

    if (authError) {
        return errorResponse(authError.message, 500)
    }

    return jsonResponse({ success: true, message: 'Member kicked successfully' })
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    if (req.method !== 'POST') {
        return errorResponse('Method not allowed', 405)
    }

    const body = await readJson<WorkspaceAccessRequest>(req)
    if (!body?.action) {
        return errorResponse('Invalid request body')
    }

    const adminClient = createAdminClient()

    try {
        if (body.action === 'create') {
            return await handleCreateWorkspace(adminClient, body)
        }

        const { user, error } = await getAuthenticatedUser(req)
        if (error || !user) {
            return errorResponse(error ?? 'Authentication required', 401)
        }

        if (body.action === 'join') {
            return await handleJoinWorkspace(adminClient, user, body)
        }

        if (body.action === 'kick') {
            return await handleKickMember(adminClient, user, body)
        }

        return errorResponse('Unsupported action', 400)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error'
        return errorResponse(message, 500)
    }
})
