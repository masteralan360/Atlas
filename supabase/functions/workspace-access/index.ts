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

type ListProductCloneTargetsRequest = {
    action: 'list-product-clone-targets'
}

type CloneProductsToBranchRequest = {
    action: 'clone-products-to-branch'
    targetWorkspaceId?: string
    targetStorageId?: string
    productIds?: string[]
}

type WorkspaceAccessRequest =
    | CreateWorkspaceRequest
    | JoinWorkspaceRequest
    | KickMemberRequest
    | CreateBranchRequest
    | SwitchBranchRequest
    | DeleteBranchRequest
    | ListProductCloneTargetsRequest
    | CloneProductsToBranchRequest

type AdminClient = ReturnType<typeof createAdminClient>

type CallerProfile = {
    role: string | null
    workspace_id: string | null
}

type SourceCategoryRow = {
    id: string
    name: string
    description?: string | null
}

type SourceProductRow = {
    id: string
    sku: string
    name: string
    description?: string | null
    category?: string | null
    category_id?: string | null
    storage_id?: string | null
    price?: number | null
    cost_price?: number | null
    quantity?: number | null
    min_stock_level?: number | null
    unit?: string | null
    currency?: string | null
    barcode?: string | null
    image_url?: string | null
    can_be_returned?: boolean | null
    return_rules?: string | null
}

type SourceInventoryRow = {
    product_id: string
    storage_id: string
    quantity?: number | null
}

type TargetCategoryRow = {
    id: string
    name: string
}

type TargetStorageRow = {
    id: string
    workspace_id?: string | null
    name: string
    is_primary?: boolean | null
}

type WorkspaceBranchRelationRow = {
    source_workspace_id: string
    branch_workspace_id: string
    name?: string | null
}

type ProductCloneTargetRow = {
    workspaceId: string
    workspaceName: string
    workspaceCode?: string
    relationType: 'source' | 'branch'
}

type WorkspaceMetadataRow = {
    id: string
    name: string
    code: string
    data_mode?: string | null
}

type WorkspaceMetadataOptions = {
    branchSourceWorkspaceId?: string | null
    branchWorkspaceId?: string | null
    branchEntryMode?: 'switch' | 'direct' | null
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
    existingMetadata: Record<string, unknown> = {},
    options: WorkspaceMetadataOptions = {}
) {
    const nextMetadata = {
        ...existingMetadata,
        workspace_id: workspace.id,
        workspace_code: workspace.code,
        workspace_name: workspace.name,
        data_mode: workspace.data_mode ?? 'cloud'
    }

    delete nextMetadata.branch_source_workspace_id
    delete nextMetadata.branch_workspace_id
    delete nextMetadata.branch_entry_mode

    if (options.branchWorkspaceId && options.branchEntryMode) {
        nextMetadata.branch_workspace_id = options.branchWorkspaceId
        nextMetadata.branch_entry_mode = options.branchEntryMode

        if (options.branchSourceWorkspaceId) {
            nextMetadata.branch_source_workspace_id = options.branchSourceWorkspaceId
        }
    }

    return nextMetadata
}

function readBranchEntryMode(metadata: Record<string, unknown> | null | undefined) {
    return typeof metadata?.branch_entry_mode === 'string'
        ? metadata.branch_entry_mode
        : null
}

function hasAnyBranchMetadata(metadata: Record<string, unknown> | null | undefined) {
    return Boolean(
        typeof metadata?.branch_source_workspace_id === 'string'
        || typeof metadata?.branch_workspace_id === 'string'
        || typeof metadata?.branch_entry_mode === 'string'
    )
}

function resolveBranchSwitchOrigin(
    metadata: Record<string, unknown> | null | undefined,
    sourceWorkspaceId: string,
    branchWorkspaceId: string
) {
    const branchSourceWorkspaceId = typeof metadata?.branch_source_workspace_id === 'string'
        ? metadata.branch_source_workspace_id
        : null
    const branchWorkspaceIdFromMetadata = typeof metadata?.branch_workspace_id === 'string'
        ? metadata.branch_workspace_id
        : null
    const branchEntryMode = typeof metadata?.branch_entry_mode === 'string'
        ? metadata.branch_entry_mode
        : null

    return branchEntryMode === 'switch'
        && branchSourceWorkspaceId === sourceWorkspaceId
        && branchWorkspaceIdFromMetadata === branchWorkspaceId
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

async function getProductCloneTargets(
    adminClient: AdminClient,
    currentWorkspaceId: string
) {
    const { data: currentBranchRelation, error: currentBranchRelationError } = await adminClient
        .from('workspace_branches')
        .select('source_workspace_id, branch_workspace_id, name')
        .eq('branch_workspace_id', currentWorkspaceId)
        .maybeSingle()

    if (currentBranchRelationError) {
        throw currentBranchRelationError
    }

    const sourceWorkspaceId = currentBranchRelation?.source_workspace_id ?? currentWorkspaceId
    const isCurrentBranch = Boolean(currentBranchRelation?.source_workspace_id)

    const { data: branchRelations, error: branchRelationsError } = await adminClient
        .from('workspace_branches')
        .select('source_workspace_id, branch_workspace_id, name')
        .eq('source_workspace_id', sourceWorkspaceId)
        .order('created_at', { ascending: true })

    if (branchRelationsError) {
        throw branchRelationsError
    }

    const orderedTargets: Array<{ workspaceId: string; relationType: 'source' | 'branch' }> = []
    const seenWorkspaceIds = new Set<string>()

    if (isCurrentBranch && sourceWorkspaceId !== currentWorkspaceId) {
        orderedTargets.push({
            workspaceId: sourceWorkspaceId,
            relationType: 'source'
        })
        seenWorkspaceIds.add(sourceWorkspaceId)
    }

    for (const relation of (branchRelations ?? []) as WorkspaceBranchRelationRow[]) {
        const branchWorkspaceId = String(relation.branch_workspace_id)
        if (!branchWorkspaceId || branchWorkspaceId === currentWorkspaceId || seenWorkspaceIds.has(branchWorkspaceId)) {
            continue
        }

        orderedTargets.push({
            workspaceId: branchWorkspaceId,
            relationType: 'branch'
        })
        seenWorkspaceIds.add(branchWorkspaceId)
    }

    if (orderedTargets.length === 0) {
        return []
    }

    const { data: workspaceRows, error: workspaceRowsError } = await adminClient
        .from('workspaces')
        .select('id, name, code')
        .in('id', orderedTargets.map((target) => target.workspaceId))
        .is('deleted_at', null)

    if (workspaceRowsError) {
        throw workspaceRowsError
    }

    const workspaceMap = new Map(
        (workspaceRows ?? []).map((workspaceRow) => [
            String(workspaceRow.id),
            {
                name: workspaceRow.name ?? undefined,
                code: workspaceRow.code ?? undefined
            }
        ])
    )

    return orderedTargets.flatMap<ProductCloneTargetRow>((target) => {
        const workspace = workspaceMap.get(target.workspaceId)
        if (!workspace) {
            return []
        }

        return [{
            workspaceId: target.workspaceId,
            workspaceName: workspace.name ?? 'Workspace',
            workspaceCode: workspace.code,
            relationType: target.relationType
        }]
    })
}

async function updateUserWorkspaceMetadata(
    adminClient: AdminClient,
    userId: string,
    workspace: WorkspaceMetadataRow,
    existingMetadata?: Record<string, unknown>,
    options?: WorkspaceMetadataOptions
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
        user_metadata: buildWorkspaceMetadata(workspace, metadata, options)
    })

    if (error) {
        throw error
    }
}

async function clearUserWorkspaceMetadata(
    adminClient: AdminClient,
    userId: string,
    existingMetadata?: Record<string, unknown>
) {
    let nextMetadata = { ...(existingMetadata ?? {}) } as Record<string, unknown>

    if (!existingMetadata) {
        const { data, error } = await adminClient.auth.admin.getUserById(userId)
        if (error || !data.user) {
            throw error ?? new Error('Failed to load target user')
        }

        nextMetadata = { ...(data.user.user_metadata ?? {}) } as Record<string, unknown>
    }

    delete nextMetadata.workspace_id
    delete nextMetadata.workspace_code
    delete nextMetadata.workspace_name
    delete nextMetadata.data_mode
    delete nextMetadata.branch_source_workspace_id
    delete nextMetadata.branch_workspace_id
    delete nextMetadata.branch_entry_mode

    const { error: authError } = await adminClient.auth.admin.updateUserById(userId, {
        user_metadata: nextMetadata
    })

    if (authError) {
        throw authError
    }
}

async function validateCreatePasskey(adminClient: AdminClient, providedPasskey: string) {
    const { data, error } = await adminClient
        .from('keys')
        .select('key_value')
        .eq('key_name', 'admin')
        .maybeSingle()

    if (error) {
        throw error
    }

    return providedPasskey === String(data?.key_value ?? '')
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

    const { data: joinedBranchRelation, error: joinedBranchError } = await adminClient
        .from('workspace_branches')
        .select('source_workspace_id, branch_workspace_id')
        .eq('branch_workspace_id', joinedWorkspace.id)
        .maybeSingle()

    if (joinedBranchError) {
        return errorResponse(joinedBranchError.message, 500)
    }

    try {
        await updateUserWorkspaceMetadata(
            adminClient,
            user.id,
            joinedWorkspace as WorkspaceMetadataRow,
            (user.user_metadata ?? {}) as Record<string, unknown>,
            joinedBranchRelation
                ? {
                    branchWorkspaceId: joinedWorkspace.id,
                    branchEntryMode: 'direct'
                }
                : undefined
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
        data_mode: joinedWorkspace.data_mode ?? 'cloud',
        branch_source_workspace_id: null,
        branch_workspace_id: joinedBranchRelation ? joinedWorkspace.id : null
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
        locked_workspace: sourceWorkspace.locked_workspace ?? false,
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

    const isForwardSwitch = branchRelation.source_workspace_id === currentWorkspaceId
        && branchRelation.branch_workspace_id === targetWorkspaceId
    const isReverseSwitch = branchRelation.branch_workspace_id === currentWorkspaceId
        && branchRelation.source_workspace_id === targetWorkspaceId

    if (!isForwardSwitch && !isReverseSwitch) {
        return errorResponse('Branch switch denied: invalid branch relationship', 403)
    }

    const userMetadata = (user.user_metadata ?? {}) as Record<string, unknown>

    if (isReverseSwitch) {
        const branchEntryMode = readBranchEntryMode(userMetadata)
        const metadataExists = hasAnyBranchMetadata(userMetadata)

        if (
            branchEntryMode === 'direct'
            && typeof userMetadata.branch_workspace_id === 'string'
            && userMetadata.branch_workspace_id === currentWorkspaceId
        ) {
            return errorResponse('Branch switch denied: this branch session did not originate from the source workspace', 403)
        }

        if (branchEntryMode === 'switch') {
            if (!resolveBranchSwitchOrigin(userMetadata, targetWorkspaceId, currentWorkspaceId)) {
                return errorResponse('Branch switch denied: this branch session did not originate from the source workspace', 403)
            }
        } else if (metadataExists) {
            return errorResponse('Branch switch denied: this branch session did not originate from the source workspace', 403)
        }
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
            userMetadata,
            isForwardSwitch
                ? {
                    branchSourceWorkspaceId: currentWorkspaceId,
                    branchWorkspaceId: targetWorkspaceId,
                    branchEntryMode: 'switch'
                }
                : undefined
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
        data_mode: targetWorkspace.data_mode ?? 'cloud',
        branch_source_workspace_id: isForwardSwitch ? currentWorkspaceId : null,
        branch_workspace_id: isForwardSwitch ? targetWorkspaceId : null
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
    const usersReturningToSource: Array<{ id: string; metadata: Record<string, unknown> }> = []
    const usersLosingWorkspace: Array<{ id: string; metadata: Record<string, unknown> }> = []

    for (const targetUserId of affectedUserIds) {
        const { data: authUserResult, error: authUserError } = await adminClient.auth.admin.getUserById(targetUserId)
        if (authUserError || !authUserResult.user) {
            return errorResponse(authUserError?.message ?? 'Failed to load branch member metadata', 500)
        }

        const metadata = { ...(authUserResult.user.user_metadata ?? {}) } as Record<string, unknown>
        if (resolveBranchSwitchOrigin(metadata, sourceWorkspaceId, targetWorkspaceId)) {
            usersReturningToSource.push({ id: targetUserId, metadata })
        } else {
            usersLosingWorkspace.push({ id: targetUserId, metadata })
        }
    }

    if (usersReturningToSource.length > 0) {
        const { error: updateProfilesError } = await adminClient
            .from('profiles')
            .update({ workspace_id: sourceWorkspaceId })
            .in('id', usersReturningToSource.map((userRecord) => userRecord.id))

        if (updateProfilesError) {
            return errorResponse(updateProfilesError.message, 500)
        }
    }

    if (usersLosingWorkspace.length > 0) {
        const { error: clearProfilesError } = await adminClient
            .from('profiles')
            .update({ workspace_id: null })
            .in('id', usersLosingWorkspace.map((userRecord) => userRecord.id))

        if (clearProfilesError) {
            return errorResponse(clearProfilesError.message, 500)
        }
    }

    let metadataUpdateFailures = 0
    for (const targetUser of usersReturningToSource) {
        try {
            await updateUserWorkspaceMetadata(
                adminClient,
                targetUser.id,
                sourceWorkspace,
                targetUser.metadata
            )
        } catch (metadataError) {
            console.error('[workspace-access] Failed to update branch member metadata during delete', {
                targetUserId: targetUser.id,
                error: metadataError
            })
            metadataUpdateFailures += 1
        }
    }

    for (const targetUser of usersLosingWorkspace) {
        try {
            await clearUserWorkspaceMetadata(adminClient, targetUser.id, targetUser.metadata)
        } catch (metadataError) {
            console.error('[workspace-access] Failed to clear branch member metadata during delete', {
                targetUserId: targetUser.id,
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
        returned_to_source: usersReturningToSource.length,
        removed_from_workspace: usersLosingWorkspace.length,
        metadata_update_failures: metadataUpdateFailures
    })
}

async function handleListProductCloneTargets(
    adminClient: AdminClient,
    user: User
) {
    const callerResult = await requireCallerWorkspace(adminClient, user, true)
    if (callerResult.response || !callerResult.profile) {
        return callerResult.response!
    }

    const currentWorkspaceId = callerResult.profile.workspace_id!
    const targets = await getProductCloneTargets(adminClient, currentWorkspaceId)

    if (targets.length === 0) {
        return jsonResponse({ targets: [] })
    }

    const { data: storageRows, error: storageRowsError } = await adminClient
        .from('storages')
        .select('id, workspace_id, name, is_primary')
        .in('workspace_id', targets.map((target) => target.workspaceId))
        .eq('is_deleted', false)
        .order('is_primary', { ascending: false })
        .order('name', { ascending: true })

    if (storageRowsError) {
        return errorResponse(storageRowsError.message, 500)
    }

    const storagesByWorkspaceId = new Map<string, TargetStorageRow[]>()
    for (const storageRow of (storageRows ?? []) as TargetStorageRow[]) {
        const workspaceId = typeof storageRow.workspace_id === 'string'
            ? storageRow.workspace_id
            : null

        if (!workspaceId) {
            continue
        }

        const currentStorages = storagesByWorkspaceId.get(workspaceId) ?? []
        currentStorages.push(storageRow)
        storagesByWorkspaceId.set(workspaceId, currentStorages)
    }

    return jsonResponse({
        targets: targets.map((target) => ({
            ...target,
            storages: (storagesByWorkspaceId.get(target.workspaceId) ?? []).map((storage) => ({
                id: storage.id,
                name: storage.name,
                is_primary: storage.is_primary ?? false
            }))
        }))
    })
}

async function handleCloneProductsToBranch(
    adminClient: AdminClient,
    user: User,
    body: CloneProductsToBranchRequest
) {
    const targetWorkspaceId = body.targetWorkspaceId?.trim() ?? ''
    const targetStorageId = body.targetStorageId?.trim() ?? ''
    const productIds = Array.from(
        new Set(
            (Array.isArray(body.productIds) ? body.productIds : [])
                .map((productId) => productId?.trim())
                .filter((productId): productId is string => Boolean(productId))
        )
    )

    if (!targetWorkspaceId) {
        return errorResponse('Target workspace is required')
    }

    if (!targetStorageId) {
        return errorResponse('Target storage is required')
    }

    if (productIds.length === 0) {
        return errorResponse('At least one product must be selected')
    }

    const callerResult = await requireCallerWorkspace(adminClient, user, true)
    if (callerResult.response || !callerResult.profile) {
        return callerResult.response!
    }

    const sourceWorkspaceId = callerResult.profile.workspace_id!
    if (sourceWorkspaceId === targetWorkspaceId) {
        return errorResponse('Target workspace must be different from the current workspace', 400)
    }

    const cloneTargets = await getProductCloneTargets(adminClient, sourceWorkspaceId)
    const targetCloneWorkspace = cloneTargets.find((target) => target.workspaceId === targetWorkspaceId)
    if (!targetCloneWorkspace) {
        return errorResponse('Target workspace is not linked to your current workspace', 403)
    }

    const { data: targetStorage, error: targetStorageError } = await adminClient
        .from('storages')
        .select('id, workspace_id, name, is_primary')
        .eq('workspace_id', targetWorkspaceId)
        .eq('id', targetStorageId)
        .eq('is_deleted', false)
        .maybeSingle()

    if (targetStorageError) {
        return errorResponse(targetStorageError.message, 500)
    }

    if (!targetStorage) {
        return errorResponse('Target storage not found for the selected workspace', 404)
    }

    const { data: productRows, error: productsError } = await adminClient
        .from('products')
        .select('*')
        .eq('workspace_id', sourceWorkspaceId)
        .eq('is_deleted', false)
        .in('id', productIds)

    if (productsError) {
        return errorResponse(productsError.message, 500)
    }

    const sourceProducts = (productRows ?? []) as SourceProductRow[]
    if (sourceProducts.length === 0) {
        return errorResponse('Selected products were not found', 404)
    }

    const sourceProductIds = sourceProducts.map((product) => product.id)

    const { data: inventoryRows, error: inventoryError } = await adminClient
        .from('inventory')
        .select('product_id, storage_id, quantity')
        .eq('workspace_id', sourceWorkspaceId)
        .eq('is_deleted', false)
        .in('product_id', sourceProductIds)

    if (inventoryError) {
        return errorResponse(inventoryError.message, 500)
    }

    const sourceInventoryRows = (inventoryRows ?? []) as SourceInventoryRow[]
    const inventoryQuantityByProductId = new Map<string, number>()
    for (const inventoryRow of sourceInventoryRows) {
        const nextQuantity = (inventoryQuantityByProductId.get(inventoryRow.product_id) ?? 0) + Number(inventoryRow.quantity ?? 0)
        inventoryQuantityByProductId.set(inventoryRow.product_id, nextQuantity)
    }

    const sourceCategoryIds = Array.from(
        new Set(
            sourceProducts
                .map((product) => product.category_id?.trim())
                .filter((categoryId): categoryId is string => Boolean(categoryId))
        )
    )

    let sourceCategories: SourceCategoryRow[] = []
    if (sourceCategoryIds.length > 0) {
        const { data: categoryRows, error: categoriesError } = await adminClient
            .from('categories')
            .select('id, name, description')
            .eq('workspace_id', sourceWorkspaceId)
            .eq('is_deleted', false)
            .in('id', sourceCategoryIds)

        if (categoriesError) {
            return errorResponse(categoriesError.message, 500)
        }

        sourceCategories = (categoryRows ?? []) as SourceCategoryRow[]
    }

    let targetCategories: TargetCategoryRow[] = []
    if (sourceCategories.length > 0) {
        const { data: targetCategoryRows, error: targetCategoriesError } = await adminClient
            .from('categories')
            .select('id, name')
            .eq('workspace_id', targetWorkspaceId)
            .eq('is_deleted', false)

        if (targetCategoriesError) {
            return errorResponse(targetCategoriesError.message, 500)
        }

        targetCategories = (targetCategoryRows ?? []) as TargetCategoryRow[]
    }

    const now = new Date().toISOString()
    const sourceCategoryById = new Map(sourceCategories.map((category) => [category.id, category]))
    const targetCategoryByName = new Map(targetCategories.map((category) => [category.name.trim().toLowerCase(), category]))
    const categoryIdMap = new Map<string, string>()

    const categoriesToInsert = sourceCategories.flatMap((category) => {
        const normalizedName = category.name.trim().toLowerCase()
        const existingCategory = targetCategoryByName.get(normalizedName)

        if (existingCategory) {
            categoryIdMap.set(category.id, existingCategory.id)
            return []
        }

        const id = crypto.randomUUID()
        targetCategoryByName.set(normalizedName, { id, name: category.name })
        categoryIdMap.set(category.id, id)

        return [{
            id,
            workspace_id: targetWorkspaceId,
            name: category.name,
            description: category.description ?? null,
            created_at: now,
            updated_at: now,
            version: 1,
            is_deleted: false
        }]
    })

    if (categoriesToInsert.length > 0) {
        const { error: insertCategoriesError } = await adminClient
            .from('categories')
            .insert(categoriesToInsert)

        if (insertCategoriesError) {
            return errorResponse(insertCategoriesError.message, 500)
        }
    }

    const productIdMap = new Map<string, string>()
    const productQuantityBySourceId = new Map<string, number>()
    const productsToInsert = sourceProducts.map<Record<string, unknown>>((product) => {
        const clonedProductId = crypto.randomUUID()
        productIdMap.set(product.id, clonedProductId)

        const mappedCategoryId = product.category_id
            ? categoryIdMap.get(product.category_id) ?? null
            : null
        const resolvedCategoryName = mappedCategoryId
            ? targetCategoryByName.get((sourceCategoryById.get(product.category_id ?? '')?.name ?? '').trim().toLowerCase())?.name
            : null
        const clonedQuantity = inventoryQuantityByProductId.has(product.id)
            ? inventoryQuantityByProductId.get(product.id) ?? 0
            : Number(product.quantity ?? 0)

        productQuantityBySourceId.set(product.id, clonedQuantity)

        const clonedProduct: Record<string, unknown> = {
            id: clonedProductId,
            workspace_id: targetWorkspaceId,
            sku: product.sku,
            name: product.name,
            description: product.description ?? '',
            category: resolvedCategoryName ?? product.category ?? null,
            category_id: mappedCategoryId,
            storage_id: targetStorageId,
            price: Number(product.price ?? 0),
            cost_price: Number(product.cost_price ?? 0),
            quantity: clonedQuantity,
            min_stock_level: Number(product.min_stock_level ?? 0),
            unit: product.unit ?? 'pcs',
            currency: product.currency ?? 'usd',
            image_url: product.image_url ?? null,
            can_be_returned: product.can_be_returned ?? true,
            return_rules: product.return_rules ?? null,
            created_at: now,
            updated_at: now,
            version: 1,
            is_deleted: false
        }

        if (Object.prototype.hasOwnProperty.call(product, 'barcode')) {
            clonedProduct.barcode = product.barcode ?? null
        }

        return clonedProduct
    })

    const { error: insertProductsError } = await adminClient
        .from('products')
        .insert(productsToInsert)

    if (insertProductsError) {
        return errorResponse(insertProductsError.message, 500)
    }

    const inventoryToInsert = sourceProducts.flatMap((product) => {
        const clonedProductId = productIdMap.get(product.id)
        const clonedQuantity = productQuantityBySourceId.get(product.id) ?? 0

        if (!clonedProductId || clonedQuantity <= 0) {
            return []
        }

        return [{
            id: crypto.randomUUID(),
            workspace_id: targetWorkspaceId,
            product_id: clonedProductId,
            storage_id: targetStorageId,
            quantity: clonedQuantity,
            created_at: now,
            updated_at: now,
            version: 1,
            is_deleted: false
        }]
    })

    if (inventoryToInsert.length > 0) {
        const { error: insertInventoryError } = await adminClient
            .from('inventory')
            .insert(inventoryToInsert)

        if (insertInventoryError) {
            return errorResponse(insertInventoryError.message, 500)
        }
    }

    return jsonResponse({
        success: true,
        target_workspace_id: targetCloneWorkspace.workspaceId,
        target_storage_id: targetStorage.id,
        cloned_products_count: productsToInsert.length,
        cloned_categories_count: categoriesToInsert.length,
        cloned_inventory_rows_count: inventoryToInsert.length
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

        if (body.action === 'list-product-clone-targets') {
            return await handleListProductCloneTargets(adminClient, user)
        }

        if (body.action === 'clone-products-to-branch') {
            return await handleCloneProductsToBranch(adminClient, user, body)
        }

        return errorResponse('Unsupported action', 400)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error'
        return errorResponse(message, 500)
    }
})
