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

type CreateBranchRequest = {
    action: 'create-branch'
    name?: string
}

type SwitchBranchRequest = {
    action: 'switch-branch'
    targetWorkspaceId?: string
}

type DeleteBranchRequest = {
    action: 'delete-branch'
    targetWorkspaceId?: string
}

type WorkspaceAccessRequest =
    | CreateWorkspaceRequest
    | JoinWorkspaceRequest
    | KickMemberRequest
    | CreateBranchRequest
    | SwitchBranchRequest
    | DeleteBranchRequest

type AdminClient = ReturnType<typeof createAdminClient>

type CallerProfile = {
    role: string | null
    workspace_id: string | null
}

type WorkspaceMetadataRow = {
    id: string
    name: string
    code: string
    data_mode?: string | null
}

type BranchSourceWorkspace = WorkspaceMetadataRow & {
    pos?: boolean | null
    instant_pos?: boolean | null
    sales_history?: boolean | null
    crm?: boolean | null
    ecommerce?: boolean | null
    travel_agency?: boolean | null
    loans?: boolean | null
    net_revenue?: boolean | null
    budget?: boolean | null
    monthly_comparison?: boolean | null
    team_performance?: boolean | null
    products?: boolean | null
    discounts?: boolean | null
    storages?: boolean | null
    inventory_transfer?: boolean | null
    invoices_history?: boolean | null
    hr?: boolean | null
    members?: boolean | null
    is_configured?: boolean | null
    default_currency?: string | null
    iqd_display_preference?: string | null
    eur_conversion_enabled?: boolean | null
    try_conversion_enabled?: boolean | null
    locked_workspace?: boolean | null
    logo_url?: string | null
    coordination?: string | null
    max_discount_percent?: number | null
    allow_whatsapp?: boolean | null
    kds_enabled?: boolean | null
    print_lang?: string | null
    print_qr?: boolean | null
    receipt_template?: string | null
    a4_template?: string | null
    print_quality?: string | null
    subscription_expires_at?: string | null
    visibility?: string | null
    store_slug?: string | null
    store_description?: string | null
}

const BRANCH_SOURCE_SELECT_COLUMNS = [
    'id',
    'name',
    'code',
    'data_mode',
    'pos',
    'instant_pos',
    'sales_history',
    'crm',
    'ecommerce',
    'travel_agency',
    'loans',
    'net_revenue',
    'budget',
    'monthly_comparison',
    'team_performance',
    'products',
    'discounts',
    'storages',
    'inventory_transfer',
    'invoices_history',
    'hr',
    'members',
    'is_configured',
    'default_currency',
    'iqd_display_preference',
    'eur_conversion_enabled',
    'try_conversion_enabled',
    'locked_workspace',
    'logo_url',
    'coordination',
    'max_discount_percent',
    'allow_whatsapp',
    'kds_enabled',
    'print_lang',
    'print_qr',
    'receipt_template',
    'a4_template',
    'print_quality',
    'subscription_expires_at',
    'visibility',
    'store_slug',
    'store_description'
].join(', ')

function buildWorkspaceMetadata(
    workspace: WorkspaceMetadataRow,
    existingMetadata: Record<string, unknown> = {}
) {
    return {
        ...existingMetadata,
        workspace_id: workspace.id,
        workspace_code: workspace.code,
        workspace_name: workspace.name,
        data_mode: workspace.data_mode ?? 'cloud'
    }
}

async function getCallerProfile(adminClient: AdminClient, userId: string) {
    const { data, error } = await adminClient
        .from('profiles')
        .select('role, workspace_id')
        .eq('id', userId)
        .maybeSingle()

    if (error) {
        throw error
    }

    return data as CallerProfile | null
}

async function requireCallerWorkspace(adminClient: AdminClient, user: User, requireAdmin = false) {
    const profile = await getCallerProfile(adminClient, user.id)
    if (!profile) {
        return { response: errorResponse('Profile not found', 404), profile: null }
    }

    if (!profile.workspace_id) {
        return { response: errorResponse('Caller is not assigned to a workspace', 400), profile: null }
    }

    if (requireAdmin && profile.role !== 'admin') {
        return { response: errorResponse('Unauthorized: Only admins can perform this action', 403), profile: null }
    }

    return { response: null, profile }
}

async function getWorkspaceById(
    adminClient: AdminClient,
    workspaceId: string,
    columns = 'id, name, code, data_mode'
) {
    const { data, error } = await adminClient
        .from('workspaces')
        .select(columns)
        .eq('id', workspaceId)
        .is('deleted_at', null)
        .maybeSingle()

    if (error) {
        throw error
    }

    return data as WorkspaceMetadataRow | null
}

async function updateUserWorkspaceMetadata(
    adminClient: AdminClient,
    userId: string,
    workspace: WorkspaceMetadataRow,
    existingMetadata?: Record<string, unknown>
) {
    let metadata = existingMetadata ?? {}

    if (!existingMetadata) {
        const { data, error } = await adminClient.auth.admin.getUserById(userId)
        if (error || !data.user) {
            throw error ?? new Error('Failed to load user metadata')
        }
        metadata = (data.user.user_metadata ?? {}) as Record<string, unknown>
    }

    const { error } = await adminClient.auth.admin.updateUserById(userId, {
        user_metadata: buildWorkspaceMetadata(workspace, metadata)
    })

    if (error) {
        throw error
    }
}

async function clearUserWorkspaceMetadata(adminClient: AdminClient, userId: string) {
    const { data, error } = await adminClient.auth.admin.getUserById(userId)
    if (error || !data.user) {
        throw error ?? new Error('Failed to load target user')
    }

    const nextMetadata = { ...(data.user.user_metadata ?? {}) } as Record<string, unknown>
    delete nextMetadata.workspace_id
    delete nextMetadata.workspace_code
    delete nextMetadata.workspace_name
    delete nextMetadata.data_mode

    const { error: authError } = await adminClient.auth.admin.updateUserById(userId, {
        user_metadata: nextMetadata
    })

    if (authError) {
        throw authError
    }
}

async function validateCreatePasskey(adminClient: AdminClient, providedPasskey: string) {
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

async function handleCreateWorkspace(adminClient: AdminClient, body: CreateWorkspaceRequest) {
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
    adminClient: AdminClient,
    user: User,
    body: JoinWorkspaceRequest
) {
    const workspaceCode = body.workspaceCode?.trim().toUpperCase() ?? ''
    if (!workspaceCode) {
        return errorResponse('Workspace code is required')
    }

    const { data: joinedWorkspace, error: workspaceError } = await adminClient
        .from('workspaces')
        .select('id, name, code, data_mode')
        .eq('code', workspaceCode)
        .is('deleted_at', null)
        .maybeSingle()

    if (workspaceError) {
        return errorResponse(workspaceError.message, 500)
    }

    if (!joinedWorkspace) {
        return errorResponse('Invalid workspace code', 400)
    }

    const { error: profileError } = await adminClient
        .from('profiles')
        .update({ workspace_id: joinedWorkspace.id })
        .eq('id', user.id)

    if (profileError) {
        return errorResponse(profileError.message, 500)
    }

    try {
        await updateUserWorkspaceMetadata(
            adminClient,
            user.id,
            joinedWorkspace as WorkspaceMetadataRow,
            (user.user_metadata ?? {}) as Record<string, unknown>
        )
    } catch (authError) {
        return errorResponse(
            authError instanceof Error ? authError.message : 'Failed to update auth metadata',
            500
        )
    }

    return jsonResponse({
        workspace_id: joinedWorkspace.id,
        workspace_code: joinedWorkspace.code,
        workspace_name: joinedWorkspace.name,
        data_mode: joinedWorkspace.data_mode ?? 'cloud'
    })
}

async function handleKickMember(
    adminClient: AdminClient,
    user: User,
    body: KickMemberRequest
) {
    const targetUserId = body.targetUserId?.trim() ?? ''
    if (!targetUserId) {
        return errorResponse('Target user is required')
    }

    const callerResult = await requireCallerWorkspace(adminClient, user, true)
    if (callerResult.response || !callerResult.profile) {
        return callerResult.response!
    }

    const callerWorkspaceId = callerResult.profile.workspace_id

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

    try {
        await clearUserWorkspaceMetadata(adminClient, targetUserId)
    } catch (authError) {
        return errorResponse(
            authError instanceof Error ? authError.message : 'Failed to update target user metadata',
            500
        )
    }

    return jsonResponse({ success: true, message: 'Member kicked successfully' })
}

async function handleCreateBranch(
    adminClient: AdminClient,
    user: User,
    body: CreateBranchRequest
) {
    const branchName = body.name?.trim() ?? ''
    if (!branchName) {
        return errorResponse('Branch name is required')
    }

    const callerResult = await requireCallerWorkspace(adminClient, user, true)
    if (callerResult.response || !callerResult.profile) {
        return callerResult.response!
    }

    const sourceWorkspaceId = callerResult.profile.workspace_id!

    const { data: existingBranchRelation, error: existingBranchError } = await adminClient
        .from('workspace_branches')
        .select('id')
        .eq('branch_workspace_id', sourceWorkspaceId)
        .maybeSingle()

    if (existingBranchError) {
        return errorResponse(existingBranchError.message, 500)
    }

    if (existingBranchRelation) {
        return errorResponse('Cannot create branches from a branch workspace.', 400)
    }

    const sourceWorkspace = await getWorkspaceById(
        adminClient,
        sourceWorkspaceId,
        BRANCH_SOURCE_SELECT_COLUMNS
    ) as BranchSourceWorkspace | null

    if (!sourceWorkspace) {
        return errorResponse('Source workspace not found', 404)
    }

    if ((sourceWorkspace.data_mode ?? 'cloud') === 'local') {
        return errorResponse('Branches are unavailable for local workspaces.', 400)
    }

    const branchInsert = {
        name: branchName,
        data_mode: sourceWorkspace.data_mode ?? 'cloud',
        pos: sourceWorkspace.pos ?? true,
        instant_pos: sourceWorkspace.instant_pos ?? true,
        sales_history: sourceWorkspace.sales_history ?? true,
        crm: sourceWorkspace.crm ?? true,
        ecommerce: sourceWorkspace.ecommerce ?? false,
        travel_agency: sourceWorkspace.travel_agency ?? true,
        loans: sourceWorkspace.loans ?? true,
        net_revenue: sourceWorkspace.net_revenue ?? true,
        budget: sourceWorkspace.budget ?? true,
        monthly_comparison: sourceWorkspace.monthly_comparison ?? true,
        team_performance: sourceWorkspace.team_performance ?? true,
        products: sourceWorkspace.products ?? true,
        discounts: sourceWorkspace.discounts ?? true,
        storages: sourceWorkspace.storages ?? true,
        inventory_transfer: sourceWorkspace.inventory_transfer ?? true,
        invoices_history: sourceWorkspace.invoices_history ?? true,
        hr: sourceWorkspace.hr ?? true,
        members: sourceWorkspace.members ?? true,
        is_configured: true,
        default_currency: sourceWorkspace.default_currency ?? 'usd',
        iqd_display_preference: sourceWorkspace.iqd_display_preference ?? 'IQD',
        eur_conversion_enabled: sourceWorkspace.eur_conversion_enabled ?? false,
        try_conversion_enabled: sourceWorkspace.try_conversion_enabled ?? false,
        locked_workspace: false,
        logo_url: sourceWorkspace.logo_url ?? null,
        coordination: sourceWorkspace.coordination ?? null,
        max_discount_percent: sourceWorkspace.max_discount_percent ?? 100,
        allow_whatsapp: sourceWorkspace.allow_whatsapp ?? false,
        kds_enabled: sourceWorkspace.kds_enabled ?? false,
        print_lang: sourceWorkspace.print_lang ?? 'auto',
        print_qr: sourceWorkspace.print_qr ?? false,
        receipt_template: sourceWorkspace.receipt_template ?? 'primary',
        a4_template: sourceWorkspace.a4_template ?? 'primary',
        print_quality: sourceWorkspace.print_quality ?? 'low',
        subscription_expires_at: sourceWorkspace.subscription_expires_at ?? null,
        visibility: 'private',
        store_slug: null,
        store_description: sourceWorkspace.store_description ?? null
    }

    const { data: branchWorkspace, error: branchWorkspaceError } = await adminClient
        .from('workspaces')
        .insert(branchInsert)
        .select('id, name, code, data_mode')
        .single()

    if (branchWorkspaceError || !branchWorkspace) {
        return errorResponse(branchWorkspaceError?.message ?? 'Failed to create branch workspace', 500)
    }

    const { data: branchRelation, error: branchRelationError } = await adminClient
        .from('workspace_branches')
        .insert({
            source_workspace_id: sourceWorkspaceId,
            branch_workspace_id: branchWorkspace.id,
            name: branchName,
            created_by: user.id
        })
        .select('id, source_workspace_id, branch_workspace_id, name, created_at')
        .single()

    if (branchRelationError || !branchRelation) {
        await adminClient.from('workspaces').delete().eq('id', branchWorkspace.id)
        return errorResponse(branchRelationError?.message ?? 'Failed to register branch workspace', 500)
    }

    return jsonResponse({
        ...branchRelation,
        workspace_code: branchWorkspace.code,
        workspace_name: branchWorkspace.name,
        data_mode: branchWorkspace.data_mode ?? 'cloud'
    })
}

async function handleSwitchBranch(
    adminClient: AdminClient,
    user: User,
    body: SwitchBranchRequest
) {
    const targetWorkspaceId = body.targetWorkspaceId?.trim() ?? ''
    if (!targetWorkspaceId) {
        return errorResponse('Target workspace is required')
    }

    const callerResult = await requireCallerWorkspace(adminClient, user)
    if (callerResult.response || !callerResult.profile) {
        return callerResult.response!
    }

    const currentWorkspaceId = callerResult.profile.workspace_id!

    if (currentWorkspaceId === targetWorkspaceId) {
        return errorResponse('You are already on this workspace', 400)
    }

    const { data: forwardRelation, error: forwardRelationError } = await adminClient
        .from('workspace_branches')
        .select('id, source_workspace_id, branch_workspace_id, name')
        .eq('source_workspace_id', currentWorkspaceId)
        .eq('branch_workspace_id', targetWorkspaceId)
        .maybeSingle()

    if (forwardRelationError) {
        return errorResponse(forwardRelationError.message, 500)
    }

    let branchRelation = forwardRelation

    if (!branchRelation) {
        const { data: reverseRelation, error: reverseRelationError } = await adminClient
            .from('workspace_branches')
            .select('id, source_workspace_id, branch_workspace_id, name')
            .eq('branch_workspace_id', currentWorkspaceId)
            .eq('source_workspace_id', targetWorkspaceId)
            .maybeSingle()

        if (reverseRelationError) {
            return errorResponse(reverseRelationError.message, 500)
        }

        branchRelation = reverseRelation
    }

    if (!branchRelation) {
        return errorResponse('Branch switch denied: the target workspace is not linked to your current workspace', 403)
    }

    const targetWorkspace = await getWorkspaceById(adminClient, targetWorkspaceId)
    if (!targetWorkspace) {
        return errorResponse('Target workspace not found', 404)
    }

    const { error: profileError } = await adminClient
        .from('profiles')
        .update({ workspace_id: targetWorkspace.id })
        .eq('id', user.id)

    if (profileError) {
        return errorResponse(profileError.message, 500)
    }

    try {
        await updateUserWorkspaceMetadata(
            adminClient,
            user.id,
            targetWorkspace,
            (user.user_metadata ?? {}) as Record<string, unknown>
        )
    } catch (authError) {
        return errorResponse(
            authError instanceof Error ? authError.message : 'Failed to update auth metadata',
            500
        )
    }

    return jsonResponse({
        workspace_id: targetWorkspace.id,
        workspace_code: targetWorkspace.code,
        workspace_name: targetWorkspace.name,
        data_mode: targetWorkspace.data_mode ?? 'cloud'
    })
}

async function handleDeleteBranch(
    adminClient: AdminClient,
    user: User,
    body: DeleteBranchRequest
) {
    const targetWorkspaceId = body.targetWorkspaceId?.trim() ?? ''
    if (!targetWorkspaceId) {
        return errorResponse('Target workspace is required')
    }

    const callerResult = await requireCallerWorkspace(adminClient, user, true)
    if (callerResult.response || !callerResult.profile) {
        return callerResult.response!
    }

    const sourceWorkspaceId = callerResult.profile.workspace_id!

    const { data: branchRelation, error: branchRelationError } = await adminClient
        .from('workspace_branches')
        .select('id, source_workspace_id, branch_workspace_id, name')
        .eq('source_workspace_id', sourceWorkspaceId)
        .eq('branch_workspace_id', targetWorkspaceId)
        .maybeSingle()

    if (branchRelationError) {
        return errorResponse(branchRelationError.message, 500)
    }

    if (!branchRelation) {
        return errorResponse('Branch not found for the current workspace', 404)
    }

    const sourceWorkspace = await getWorkspaceById(adminClient, sourceWorkspaceId)
    if (!sourceWorkspace) {
        return errorResponse('Source workspace not found', 404)
    }

    const { data: branchProfiles, error: branchProfilesError } = await adminClient
        .from('profiles')
        .select('id')
        .eq('workspace_id', targetWorkspaceId)

    if (branchProfilesError) {
        return errorResponse(branchProfilesError.message, 500)
    }

    const affectedUserIds = (branchProfiles ?? []).map((row) => String(row.id))

    if (affectedUserIds.length > 0) {
        const { error: updateProfilesError } = await adminClient
            .from('profiles')
            .update({ workspace_id: sourceWorkspaceId })
            .in('id', affectedUserIds)

        if (updateProfilesError) {
            return errorResponse(updateProfilesError.message, 500)
        }
    }

    let metadataUpdateFailures = 0
    for (const targetUserId of affectedUserIds) {
        try {
            await updateUserWorkspaceMetadata(adminClient, targetUserId, sourceWorkspace)
        } catch (metadataError) {
            console.error('[workspace-access] Failed to update branch member metadata during delete', {
                targetUserId,
                error: metadataError
            })
            metadataUpdateFailures += 1
        }
    }

    const { error: deleteError } = await adminClient.rpc('delete_branch_cascade', {
        p_source_workspace_id: sourceWorkspaceId,
        p_branch_workspace_id: targetWorkspaceId
    })

    if (deleteError) {
        return errorResponse(deleteError.message, 500)
    }

    return jsonResponse({
        success: true,
        branch_workspace_id: targetWorkspaceId,
        moved_users: affectedUserIds.length,
        metadata_update_failures: metadataUpdateFailures
    })
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

        if (body.action === 'create-branch') {
            return await handleCreateBranch(adminClient, user, body)
        }

        if (body.action === 'switch-branch') {
            return await handleSwitchBranch(adminClient, user, body)
        }

        if (body.action === 'delete-branch') {
            return await handleDeleteBranch(adminClient, user, body)
        }

        return errorResponse('Unsupported action', 400)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error'
        return errorResponse(message, 500)
    }
})
