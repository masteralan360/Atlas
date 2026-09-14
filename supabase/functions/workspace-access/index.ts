import type { User } from 'jsr:@supabase/supabase-js@2'
import { createAdminClient, getAuthenticatedUser } from '../_shared/supabase.ts'
import { corsHeaders, errorResponse, jsonResponse, readJson } from '../_shared/http.ts'
import { getPlanCapabilities, normalizeWorkspacePlan, planHasModule, type PlanModuleKey } from '../../../src/plans/workspacePlans.ts'
import { buildDestinationProductMatchIndex } from './destinationProductMatching.ts'

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

type ArchiveBranchRequest = {
    action: 'archive-branch'
    targetWorkspaceId?: string
}

type RestoreBranchRequest = {
    action: 'restore-branch'
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

type ListInventoryTransferTargetsRequest = {
    action: 'list-inventory-transfer-targets'
}

type ListInventoryTransferSourceProductsRequest = {
    action: 'list-inventory-transfer-source-products'
    sourceWorkspaceId?: string
    sourceStorageId?: string
}

type TransferInventoryBetweenWorkspacesRequest = {
    action: 'transfer-inventory-between-workspaces'
    sourceWorkspaceId?: string
    sourceStorageId?: string
    destinationWorkspaceId?: string
    destinationStorageId?: string
    items?: Array<{
        productId?: string
        quantity?: number
        batchAllocations?: Array<{
            batchId?: string
            quantity?: number
        }>
    }>
}

type ListPermissionCopyWorkspacesRequest = {
    action: 'list-permission-copy-workspaces'
}

type ListWorkspaceMemberPermissionsRequest = {
    action: 'list-workspace-member-permissions'
    workspaceId?: string
}

type CopyMemberPermissionsRequest = {
    action: 'copy-member-permissions'
    sourceWorkspaceId?: string
    sourceMemberId?: string
    targetWorkspaceId?: string
    targetMemberId?: string
}

type WorkspaceAccessRequest =
    | CreateWorkspaceRequest
    | JoinWorkspaceRequest
    | KickMemberRequest
    | CreateBranchRequest
    | SwitchBranchRequest
    | DeleteBranchRequest
    | ArchiveBranchRequest
    | RestoreBranchRequest
    | ListProductCloneTargetsRequest
    | CloneProductsToBranchRequest
    | ListInventoryTransferTargetsRequest
    | ListInventoryTransferSourceProductsRequest
    | TransferInventoryBetweenWorkspacesRequest
    | ListPermissionCopyWorkspacesRequest
    | ListWorkspaceMemberPermissionsRequest
    | CopyMemberPermissionsRequest

type AdminClient = ReturnType<typeof createAdminClient>

type CallerProfile = {
    role: string | null
    workspace_id: string | null
    current_workspace: string | null
}

type SourceCategoryRow = {
    id: string
    name: string
    description?: string | null
}

type SourceProductRow = {
    id: string
    workspace_id?: string | null
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
    storage_name?: string | null
    updated_at?: string | null
    created_at?: string | null
    version?: number | null
    is_deleted?: boolean | null
}

type SourceInventoryRow = {
    id?: string
    workspace_id?: string | null
    product_id: string
    storage_id: string
    quantity?: number | null
    created_at?: string | null
    updated_at?: string | null
    version?: number | null
    is_deleted?: boolean | null
}

type SourceStockBatchRow = {
    id: string
    workspace_id: string
    product_id: string
    storage_id: string
    batch_number: string
    quantity: number
    price?: number | null
    cost_price?: number | null
    currency?: string | null
    expiry_date?: string | null
    manufacturing_date?: string | null
    notes?: string | null
    source_purchase_order_id?: string | null
    source_purchase_order_item_id?: string | null
    created_at?: string | null
    updated_at?: string | null
    version?: number | null
    is_deleted?: boolean | null
}

type PlannedTransferBatchAllocation = {
    sourceBatchId: string
    destinationBatchId?: string
    batchNumber: string
    quantity: number
    price: number
    costPrice: number
    currency: string
    expiryDate: string | null
    manufacturingDate: string | null
}

type SourceProductBarcodeRow = {
    product_id: string
    barcode: string
    label?: string | null
    is_primary?: boolean | null
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

type InventoryTransferTargetRow = ProductCloneTargetRow | {
    workspaceId: string
    workspaceName: string
    workspaceCode?: string
    relationType: 'current'
}

type WorkspaceMetadataRow = {
    id: string
    name: string
    code: string
    data_mode?: string | null
    plan?: string | null
}

type BranchSourceWorkspace = WorkspaceMetadataRow & {
    is_configured?: boolean | null
    default_currency?: string | null
    iqd_display_preference?: string | null
    locked_workspace?: boolean | null
    logo_url?: string | null
    coordination?: string | null
    max_discount_percent?: number | null
    allow_whatsapp?: boolean | null
    print_lang?: string | null
    print_qr?: boolean | null
    receipt_template?: string | null
    a4_template?: string | null
    subscription_expires_at?: string | null
    visibility?: string | null
    store_slug?: string | null
    store_description?: string | null
}

const BRANCH_SOURCE_SELECT_COLUMNS = [
    'id',
    'name',
    'code',
    'plan',
    'data_mode',
    'is_configured',
    'default_currency',
    'iqd_display_preference',
    'locked_workspace',
    'logo_url',
    'coordination',
    'max_discount_percent',
    'allow_whatsapp',
    'print_lang',
    'print_qr',
    'receipt_template',
    'a4_template',
    'subscription_expires_at',
    'visibility',
    'store_slug',
    'store_description'
].join(', ')

async function getCallerProfile(adminClient: AdminClient, userId: string) {
    const { data, error } = await adminClient
        .from('profiles')
        .select('role, workspace_id, current_workspace')
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

    if (!profile.workspace_id || !profile.current_workspace) {
        return { response: errorResponse('Caller is not assigned to a workspace', 400), profile: null }
    }

    if (requireAdmin && profile.role !== 'admin') {
        return { response: errorResponse('Unauthorized: Only admins can perform this action', 403), profile: null }
    }

    return { response: null, profile }
}

function hasInventoryTransferRole(role: string | null | undefined) {
    return role === 'admin' || role === 'staff'
}

async function countWorkspaceMembers(adminClient: AdminClient, workspaceId: string, excludeUserId?: string) {
    let query = adminClient
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)

    if (excludeUserId) {
        query = query.neq('id', excludeUserId)
    }

    const { count, error } = await query
    if (error) {
        throw error
    }

    return count ?? 0
}

async function countWorkspaceBranches(adminClient: AdminClient, sourceWorkspaceId: string) {
    const { count, error } = await adminClient
        .from('workspace_branches')
        .select('id', { count: 'exact', head: true })
        .eq('source_workspace_id', sourceWorkspaceId)
        .is('archived_at', null)

    if (error) {
        throw error
    }

    return count ?? 0
}

async function requireWorkspaceModule(
    adminClient: AdminClient,
    workspaceId: string,
    module: PlanModuleKey,
    message = 'This module is not included in the current workspace plan.'
) {
    const workspace = await getWorkspaceById(adminClient, workspaceId, 'id, name, code, data_mode, plan')
    if (!workspace) {
        return { response: errorResponse('Workspace not found', 404), workspace: null }
    }

    if (!planHasModule(workspace.plan, module)) {
        return { response: errorResponse(message, 403), workspace: null }
    }

    return { response: null, workspace }
}

async function getWorkspaceById(
    adminClient: AdminClient,
    workspaceId: string,
    columns = 'id, name, code, data_mode, plan'
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
        .is('archived_at', null)
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
        .is('archived_at', null)
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

async function getInventoryTransferTargets(
    adminClient: AdminClient,
    currentWorkspaceId: string
) {
    const currentWorkspace = await getWorkspaceById(adminClient, currentWorkspaceId, 'id, name, code')
    if (!currentWorkspace) {
        throw new Error('Current workspace not found')
    }

    const linkedTargets = await getProductCloneTargets(adminClient, currentWorkspaceId)
    return [
        {
            workspaceId: currentWorkspaceId,
            workspaceName: currentWorkspace.name ?? 'Workspace',
            workspaceCode: currentWorkspace.code ?? undefined,
            relationType: 'current' as const
        },
        ...linkedTargets
    ] satisfies InventoryTransferTargetRow[]
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
            plan: 'basic',
            subscription_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            locked_workspace: false
        })
        .select('id, name, code, data_mode, plan')
        .single()

    if (error || !data) {
        return errorResponse(error?.message ?? 'Failed to create workspace', 500)
    }

    return jsonResponse(data)
}

// Demo workspace helpers
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
        .select('id, name, code, data_mode, plan')
        .eq('code', workspaceCode)
        .is('deleted_at', null)
        .maybeSingle()

    if (workspaceError) {
        return errorResponse(workspaceError.message, 500)
    }

    if (!joinedWorkspace) {
        return errorResponse('Invalid workspace code', 400)
    }

    const joinedPlan = getPlanCapabilities(joinedWorkspace.plan)
    const memberCount = await countWorkspaceMembers(adminClient, joinedWorkspace.id, user.id)
    if (memberCount >= joinedPlan.limits.maxMembers) {
        return errorResponse('Workspace member limit reached for current plan', 403)
    }

    const { error: profileError } = await adminClient
        .from('profiles')
        .update({
            workspace_id: joinedWorkspace.id,
            current_workspace: joinedWorkspace.id
        })
        .eq('id', user.id)

    if (profileError) {
        return errorResponse(profileError.message, 500)
    }

    return jsonResponse({
        workspace_id: joinedWorkspace.id,
        source_workspace_id: joinedWorkspace.id,
        current_workspace: joinedWorkspace.id,
        workspace_code: joinedWorkspace.code,
        workspace_name: joinedWorkspace.name,
        workspace_plan: joinedPlan.plan,
        data_mode: joinedWorkspace.data_mode ?? 'hybrid'
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

    const callerWorkspaceId = callerResult.profile.current_workspace

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
        .update({ workspace_id: null, current_workspace: null })
        .eq('id', targetUserId)

    if (profileError) {
        return errorResponse(profileError.message, 500)
    }

    return jsonResponse({ success: true, message: 'Member kicked successfully' })
}

async function handleListPermissionCopyWorkspaces(
    adminClient: AdminClient,
    user: User
) {
    const callerResult = await requireCallerWorkspace(adminClient, user, true)
    if (callerResult.response || !callerResult.profile) {
        return callerResult.response!
    }

    const currentWorkspaceId = callerResult.profile.current_workspace!
    const relatedWorkspaces = await getProductCloneTargets(adminClient, currentWorkspaceId)

    const currentWorkspace = await getWorkspaceById(adminClient, currentWorkspaceId, 'id, name, code')
    const workspaces = [
        ...(currentWorkspace
            ? [{
                workspaceId: currentWorkspace.id,
                workspaceName: currentWorkspace.name ?? 'Workspace',
                workspaceCode: currentWorkspace.code,
                relationType: 'current' as const
            }]
            : []),
        ...relatedWorkspaces
    ]

    return jsonResponse({ workspaces })
}

async function handleListWorkspaceMemberPermissions(
    adminClient: AdminClient,
    user: User,
    body: ListWorkspaceMemberPermissionsRequest
) {
    const workspaceId = body.workspaceId?.trim() ?? ''
    if (!workspaceId) {
        return errorResponse('Workspace is required')
    }

    const callerResult = await requireCallerWorkspace(adminClient, user, true)
    if (callerResult.response || !callerResult.profile) {
        return callerResult.response!
    }

    const currentWorkspaceId = callerResult.profile.current_workspace!
    const accessibleWorkspaces = await getProductCloneTargets(adminClient, currentWorkspaceId)
    const isCurrentWorkspace = workspaceId === currentWorkspaceId
    if (!isCurrentWorkspace && !accessibleWorkspaces.some((target) => target.workspaceId === workspaceId)) {
        return errorResponse('Workspace not accessible from the current workspace', 403)
    }

    const { data: profileRows, error: profileError } = await adminClient
        .from('profiles')
        .select('id, name, role, profile_url')
        .eq('workspace_id', workspaceId)
        .neq('role', 'admin')
        .order('name', { ascending: true })

    if (profileError) {
        return errorResponse(profileError.message, 500)
    }

    const { data: permissionRows, error: permissionError } = await adminClient
        .from('workspace_permissions')
        .select('user_uuid, key')
        .eq('workspace_id', workspaceId)

    if (permissionError) {
        return errorResponse(permissionError.message, 500)
    }

    const keysByUser = new Map<string, string[]>()
    for (const row of permissionRows ?? []) {
        const keys = keysByUser.get(row.user_uuid) ?? []
        keys.push(row.key)
        keysByUser.set(row.user_uuid, keys)
    }

    const members = (profileRows ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        profile_url: row.profile_url ?? null,
        permissionKeys: keysByUser.get(row.id) ?? []
    }))

    return jsonResponse({ members })
}

async function handleCopyMemberPermissions(
    adminClient: AdminClient,
    user: User,
    body: CopyMemberPermissionsRequest
) {
    const sourceWorkspaceId = body.sourceWorkspaceId?.trim() ?? ''
    const sourceMemberId = body.sourceMemberId?.trim() ?? ''
    const targetWorkspaceId = body.targetWorkspaceId?.trim() ?? ''
    const targetMemberId = body.targetMemberId?.trim() ?? ''

    if (!sourceWorkspaceId || !sourceMemberId || !targetWorkspaceId || !targetMemberId) {
        return errorResponse('sourceWorkspaceId, sourceMemberId, targetWorkspaceId and targetMemberId are required')
    }

    const callerResult = await requireCallerWorkspace(adminClient, user, true)
    if (callerResult.response || !callerResult.profile) {
        return callerResult.response!
    }

    const currentWorkspaceId = callerResult.profile.current_workspace!
    if (targetWorkspaceId !== currentWorkspaceId) {
        return errorResponse('Target member must belong to your current workspace', 403)
    }

    const accessibleWorkspaces = await getProductCloneTargets(adminClient, currentWorkspaceId)
    const isCurrentWorkspace = sourceWorkspaceId === currentWorkspaceId
    if (!isCurrentWorkspace && !accessibleWorkspaces.some((target) => target.workspaceId === sourceWorkspaceId)) {
        return errorResponse('Source workspace not accessible from the current workspace', 403)
    }

    const { data: sourceProfile, error: sourceProfileError } = await adminClient
        .from('profiles')
        .select('id, role, workspace_id')
        .eq('id', sourceMemberId)
        .maybeSingle()

    if (sourceProfileError) {
        return errorResponse(sourceProfileError.message, 500)
    }

    if (!sourceProfile || sourceProfile.workspace_id !== sourceWorkspaceId) {
        return errorResponse('Source member not found in the source workspace', 404)
    }

    if (sourceProfile.role === 'admin') {
        return errorResponse('Cannot copy permissions from an admin', 403)
    }

    const { data: targetProfile, error: targetProfileError } = await adminClient
        .from('profiles')
        .select('id, role, workspace_id')
        .eq('id', targetMemberId)
        .maybeSingle()

    if (targetProfileError) {
        return errorResponse(targetProfileError.message, 500)
    }

    if (!targetProfile || targetProfile.workspace_id !== targetWorkspaceId) {
        return errorResponse('Target member not found in the current workspace', 404)
    }

    if (targetProfile.role === 'admin') {
        return errorResponse('Cannot copy permissions to an admin', 403)
    }

    const { data: sourcePermissionRows, error: sourcePermissionError } = await adminClient
        .from('workspace_permissions')
        .select('key, module')
        .eq('workspace_id', sourceWorkspaceId)
        .eq('user_uuid', sourceMemberId)

    if (sourcePermissionError) {
        return errorResponse(sourcePermissionError.message, 500)
    }

    const sourceKeys = new Map<string, string>()
    for (const row of sourcePermissionRows ?? []) {
        sourceKeys.set(String(row.key), String(row.module ?? ''))
    }

    const { data: targetPermissionRows, error: targetPermissionError } = await adminClient
        .from('workspace_permissions')
        .select('key')
        .eq('workspace_id', targetWorkspaceId)
        .eq('user_uuid', targetMemberId)

    if (targetPermissionError) {
        return errorResponse(targetPermissionError.message, 500)
    }

    const targetKeys = new Set((targetPermissionRows ?? []).map((row) => String(row.key)))

    const keysToAdd = [...sourceKeys.keys()].filter((key) => !targetKeys.has(key))
    const keysToRemove = [...targetKeys].filter((key) => !sourceKeys.has(key))

    if (keysToRemove.length > 0) {
        const { error: deleteError } = await adminClient
            .from('workspace_permissions')
            .delete()
            .eq('workspace_id', targetWorkspaceId)
            .eq('user_uuid', targetMemberId)
            .in('key', keysToRemove)

        if (deleteError) {
            return errorResponse(deleteError.message, 500)
        }
    }

    if (keysToAdd.length > 0) {
        const { error: insertError } = await adminClient
            .from('workspace_permissions')
            .insert(keysToAdd.map((key) => ({
                workspace_id: targetWorkspaceId,
                user_uuid: targetMemberId,
                key,
                module: sourceKeys.get(key) ?? ''
            })))

        if (insertError) {
            return errorResponse(insertError.message, 500)
        }
    }

    return jsonResponse({
        success: true,
        added: keysToAdd.length,
        removed: keysToRemove.length
    })
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

    const sourceWorkspaceId = callerResult.profile.current_workspace!

    const { data: existingBranchRelation, error: existingBranchError } = await adminClient
        .from('workspace_branches')
        .select('id')
        .eq('branch_workspace_id', sourceWorkspaceId)
        .is('archived_at', null)
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

    if ((sourceWorkspace.data_mode ?? 'hybrid') === 'local') {
        return errorResponse('Branches are unavailable for local workspaces.', 400)
    }

    const sourcePlan = getPlanCapabilities(sourceWorkspace.plan)
    if (sourcePlan.limits.maxBranches <= 0) {
        return errorResponse('Branches are not included in the current workspace plan.', 403)
    }

    const branchCount = await countWorkspaceBranches(adminClient, sourceWorkspaceId)
    if (branchCount >= sourcePlan.limits.maxBranches) {
        return errorResponse('Workspace branch limit reached for current plan', 403)
    }

    const branchInsert = {
        name: branchName,
        plan: sourcePlan.plan,
        data_mode: sourceWorkspace.data_mode ?? 'hybrid',
        is_configured: true,
        default_currency: sourceWorkspace.default_currency ?? 'iqd',
        iqd_display_preference: sourceWorkspace.iqd_display_preference ?? 'IQD',
        locked_workspace: sourceWorkspace.locked_workspace ?? false,
        logo_url: sourceWorkspace.logo_url ?? null,
        coordination: sourceWorkspace.coordination ?? null,
        max_discount_percent: sourceWorkspace.max_discount_percent ?? 100,
        allow_whatsapp: sourceWorkspace.allow_whatsapp ?? false,
        print_lang: sourceWorkspace.print_lang ?? 'auto',
        print_qr: sourceWorkspace.print_qr ?? false,
        receipt_template: sourceWorkspace.receipt_template ?? 'primary',
        a4_template: sourceWorkspace.a4_template ?? 'professional',
        subscription_expires_at: sourceWorkspace.subscription_expires_at ?? null,
        visibility: 'private',
        store_slug: null,
        store_description: sourceWorkspace.store_description ?? null
    }

    const { data: branchWorkspace, error: branchWorkspaceError } = await adminClient
        .from('workspaces')
        .insert(branchInsert)
        .select('id, name, code, data_mode, plan')
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
        workspace_plan: normalizeWorkspacePlan(branchWorkspace.plan),
        data_mode: branchWorkspace.data_mode ?? 'hybrid'
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

    const sourceWorkspaceId = callerResult.profile.workspace_id!
    const currentWorkspaceId = callerResult.profile.current_workspace!

    if (currentWorkspaceId === targetWorkspaceId) {
        return errorResponse('You are already on this workspace', 400)
    }

    if (targetWorkspaceId !== sourceWorkspaceId) {
        if (currentWorkspaceId !== sourceWorkspaceId) {
            return errorResponse('Return to your source workspace before switching to another branch', 403)
        }

        const { data: branchRelation, error: branchRelationError } = await adminClient
            .from('workspace_branches')
            .select('id')
            .eq('source_workspace_id', sourceWorkspaceId)
            .eq('branch_workspace_id', targetWorkspaceId)
            .is('archived_at', null)
            .maybeSingle()

        if (branchRelationError) {
            return errorResponse(branchRelationError.message, 500)
        }

        if (!branchRelation) {
            return errorResponse('Branch switch denied: the target workspace is not linked to your source workspace', 403)
        }
    }

    const targetWorkspace = await getWorkspaceById(adminClient, targetWorkspaceId)
    if (!targetWorkspace) {
        return errorResponse('Target workspace not found', 404)
    }

    const { error: profileError } = await adminClient
        .from('profiles')
        .update({ current_workspace: targetWorkspace.id })
        .eq('id', user.id)

    if (profileError) {
        console.error('[workspace-access] handleSwitchBranch profile update failed', {
            userId: user.id,
            targetWorkspaceId: targetWorkspace.id,
            error: profileError.message
        })
        const isMemberLimit = profileError.message?.toLowerCase().includes('member limit')
        return errorResponse(profileError.message, isMemberLimit ? 403 : 500)
    }

    return jsonResponse({
        workspace_id: targetWorkspace.id,
        source_workspace_id: sourceWorkspaceId,
        current_workspace: targetWorkspace.id,
        workspace_code: targetWorkspace.code,
        workspace_name: targetWorkspace.name,
        workspace_plan: normalizeWorkspacePlan(targetWorkspace.plan),
        data_mode: targetWorkspace.data_mode ?? 'hybrid'
    })
}

async function handleArchiveBranch(
    adminClient: AdminClient,
    user: User,
    body: DeleteBranchRequest | ArchiveBranchRequest
) {
    const targetWorkspaceId = body.targetWorkspaceId?.trim() ?? ''
    if (!targetWorkspaceId) {
        return errorResponse('Target workspace is required')
    }

    const callerResult = await requireCallerWorkspace(adminClient, user, true)
    if (callerResult.response || !callerResult.profile) {
        return callerResult.response!
    }

    const sourceWorkspaceId = callerResult.profile.current_workspace!

    const { data: branchRelation, error: branchRelationError } = await adminClient
        .from('workspace_branches')
        .select('id, source_workspace_id, branch_workspace_id, name')
        .eq('source_workspace_id', sourceWorkspaceId)
        .eq('branch_workspace_id', targetWorkspaceId)
        .is('archived_at', null)
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

    const { data: archiveResult, error: archiveError } = await adminClient.rpc('archive_branch', {
        p_source_workspace_id: sourceWorkspaceId,
        p_branch_workspace_id: targetWorkspaceId,
        p_archived_by: user.id,
        p_archive_reason: 'Archived from workspace settings'
    })

    if (archiveError) {
        return errorResponse(archiveError.message, 500)
    }

    return jsonResponse(archiveResult ?? {
        success: true,
        branch_workspace_id: targetWorkspaceId
    })
}

async function handleRestoreBranch(
    adminClient: AdminClient,
    user: User,
    body: RestoreBranchRequest
) {
    const targetWorkspaceId = body.targetWorkspaceId?.trim() ?? ''
    if (!targetWorkspaceId) {
        return errorResponse('Target workspace is required')
    }

    const callerResult = await requireCallerWorkspace(adminClient, user, true)
    if (callerResult.response || !callerResult.profile) {
        return callerResult.response!
    }

    const sourceWorkspaceId = callerResult.profile.current_workspace!

    const { data: branchRelation, error: branchRelationError } = await adminClient
        .from('workspace_branches')
        .select('id')
        .eq('source_workspace_id', sourceWorkspaceId)
        .eq('branch_workspace_id', targetWorkspaceId)
        .not('archived_at', 'is', null)
        .maybeSingle()

    if (branchRelationError) {
        return errorResponse(branchRelationError.message, 500)
    }

    if (!branchRelation) {
        return errorResponse('Archived branch not found for the current workspace', 404)
    }

    const sourceWorkspace = await getWorkspaceById(adminClient, sourceWorkspaceId)
    if (!sourceWorkspace) {
        return errorResponse('Source workspace not found', 404)
    }

    const { data: restoreResult, error: restoreError } = await adminClient.rpc('restore_branch', {
        p_source_workspace_id: sourceWorkspaceId,
        p_branch_workspace_id: targetWorkspaceId
    })

    if (restoreError) {
        return errorResponse(restoreError.message, restoreError.code === '42501' ? 403 : 500)
    }

    return jsonResponse(restoreResult ?? {
        success: true,
        branch_workspace_id: targetWorkspaceId
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

    const currentWorkspaceId = callerResult.profile.current_workspace!
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

function buildWorkspaceProductKey(workspaceId: string, productId: string) {
    return `${workspaceId}::${productId}`
}

function buildWorkspaceStorageProductKey(workspaceId: string, productId: string, storageId: string) {
    return `${workspaceId}::${productId}::${storageId}`
}

const QUANTITY_EPSILON = 0.000001

function roundQuantity(value: number) {
    const rounded = Math.round(value * 1_000_000) / 1_000_000
    return Object.is(rounded, -0) ? 0 : rounded
}

function isPositiveQuantity(value: unknown) {
    const quantity = Number(value)
    return Number.isFinite(quantity) && quantity > QUANTITY_EPSILON
}

function normalizeSkuKey(value?: string | null) {
    return value?.trim().toLowerCase() ?? ''
}

function parseTransferQuantity(value: unknown) {
    const quantity = Number(value)
    return isPositiveQuantity(quantity) ? roundQuantity(quantity) : NaN
}

function sortTransferBatches(batches: SourceStockBatchRow[]) {
    return [...batches].sort((left, right) =>
        (left.expiry_date ?? '9999-12-31').localeCompare(right.expiry_date ?? '9999-12-31')
        || (left.manufacturing_date ?? '9999-12-31').localeCompare(right.manufacturing_date ?? '9999-12-31')
        || (left.created_at ?? '').localeCompare(right.created_at ?? '')
        || left.batch_number.localeCompare(right.batch_number)
    )
}

function toPlannedBatchAllocation(
    batch: SourceStockBatchRow,
    quantity: number
): PlannedTransferBatchAllocation {
    return {
        sourceBatchId: batch.id,
        batchNumber: batch.batch_number,
        quantity,
        price: Number(batch.price ?? 0),
        costPrice: Number(batch.cost_price ?? 0),
        currency: String(batch.currency ?? 'usd').toLowerCase(),
        expiryDate: batch.expiry_date ?? null,
        manufacturingDate: batch.manufacturing_date ?? null
    }
}

function planTransferBatchAllocations(input: {
    inventoryQuantity: number
    batches: SourceStockBatchRow[]
    requestedQuantity: number
    selectedBatchAllocations?: Array<{ batchId: string; quantity: number }>
}) {
    const activeBatches = sortTransferBatches(
        input.batches.filter((batch) => !batch.is_deleted && Number(batch.quantity) > QUANTITY_EPSILON)
    )
    const batchQuantity = activeBatches.reduce(
        (sum, batch) => sum + Number(batch.quantity),
        0
    )
    const unbatchedAvailable = roundQuantity(Math.max(input.inventoryQuantity - batchQuantity, 0))

    if (input.selectedBatchAllocations === undefined) {
        const allocations: PlannedTransferBatchAllocation[] = []
        let remaining = input.requestedQuantity

        for (const batch of activeBatches) {
            if (remaining <= QUANTITY_EPSILON) {
                break
            }

            const quantity = Math.min(Number(batch.quantity), remaining)
            if (quantity > QUANTITY_EPSILON) {
                allocations.push(toPlannedBatchAllocation(batch, quantity))
                remaining = roundQuantity(remaining - quantity)
            }
        }

        if (remaining - unbatchedAvailable > QUANTITY_EPSILON) {
            throw new Error('Insufficient regular stock in source storage')
        }

        return {
            allocations,
            unbatchedQuantity: roundQuantity(remaining)
        }
    }

    const selectedByBatchId = new Map<string, number>()
    for (const selection of input.selectedBatchAllocations) {
        selectedByBatchId.set(
            selection.batchId,
            roundQuantity((selectedByBatchId.get(selection.batchId) ?? 0) + selection.quantity)
        )
    }

    const batchesById = new Map(activeBatches.map((batch) => [batch.id, batch] as const))
    const allocations = Array.from(selectedByBatchId.entries()).map(([batchId, quantity]) => {
        const batch = batchesById.get(batchId)
        if (!batch) {
            throw new Error('One or more selected batches are no longer available')
        }

        if (quantity - Number(batch.quantity) > QUANTITY_EPSILON) {
            throw new Error(`Batch ${batch.batch_number} does not have enough stock`)
        }

        return toPlannedBatchAllocation(batch, quantity)
    })
    const selectedBatchQuantity = allocations.reduce(
        (sum, allocation) => sum + allocation.quantity,
        0
    )

    if (selectedBatchQuantity - input.requestedQuantity > QUANTITY_EPSILON) {
        throw new Error('Selected batch quantity exceeds transfer quantity')
    }

    const unbatchedQuantity = roundQuantity(input.requestedQuantity - selectedBatchQuantity)
    if (unbatchedQuantity - unbatchedAvailable > QUANTITY_EPSILON) {
        throw new Error('Insufficient regular stock in source storage')
    }

    return {
        allocations,
        unbatchedQuantity
    }
}

function transferBatchSnapshotsAreCompatible(
    batch: SourceStockBatchRow,
    allocation: PlannedTransferBatchAllocation
) {
    return Number(batch.price ?? 0) === allocation.price
        && Number(batch.cost_price ?? 0) === allocation.costPrice
        && String(batch.currency ?? 'usd').toLowerCase() === allocation.currency
        && (batch.expiry_date ?? null) === allocation.expiryDate
        && (batch.manufacturing_date ?? null) === allocation.manufacturingDate
}

async function handleListInventoryTransferTargets(
    adminClient: AdminClient,
    user: User
) {
    const callerResult = await requireCallerWorkspace(adminClient, user)
    if (callerResult.response || !callerResult.profile) {
        return callerResult.response!
    }

    if (!hasInventoryTransferRole(callerResult.profile.role)) {
        return errorResponse('Unauthorized: Only admins and staff can perform this action', 403)
    }

    const currentWorkspaceId = callerResult.profile.current_workspace!
    const moduleResult = await requireWorkspaceModule(adminClient, currentWorkspaceId, 'inventory_transfer')
    if (moduleResult.response) {
        return moduleResult.response
    }

    const targets = await getInventoryTransferTargets(adminClient, currentWorkspaceId)

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

async function handleListInventoryTransferSourceProducts(
    adminClient: AdminClient,
    user: User,
    body: ListInventoryTransferSourceProductsRequest
) {
    const sourceWorkspaceId = body.sourceWorkspaceId?.trim() ?? ''
    const sourceStorageId = body.sourceStorageId?.trim() ?? ''

    if (!sourceWorkspaceId) {
        return errorResponse('Source workspace is required')
    }

    if (!sourceStorageId) {
        return errorResponse('Source storage is required')
    }

    const callerResult = await requireCallerWorkspace(adminClient, user)
    if (callerResult.response || !callerResult.profile) {
        return callerResult.response!
    }

    if (!hasInventoryTransferRole(callerResult.profile.role)) {
        return errorResponse('Unauthorized: Only admins and staff can perform this action', 403)
    }

    const currentWorkspaceId = callerResult.profile.current_workspace!
    const moduleResult = await requireWorkspaceModule(adminClient, currentWorkspaceId, 'inventory_transfer')
    if (moduleResult.response) {
        return moduleResult.response
    }

    const targets = await getInventoryTransferTargets(adminClient, currentWorkspaceId)
    const allowedWorkspaceIds = new Set(targets.map((target) => target.workspaceId))
    if (!allowedWorkspaceIds.has(sourceWorkspaceId)) {
        return errorResponse('Source workspace is not linked to your current workspace', 403)
    }

    const { data: storageRow, error: storageError } = await adminClient
        .from('storages')
        .select('id, workspace_id, name')
        .eq('workspace_id', sourceWorkspaceId)
        .eq('id', sourceStorageId)
        .eq('is_deleted', false)
        .maybeSingle()

    if (storageError) {
        return errorResponse(storageError.message, 500)
    }

    if (!storageRow) {
        return errorResponse('Source storage not found for the selected workspace', 404)
    }

    const { data: inventoryRows, error: inventoryError } = await adminClient
        .from('inventory')
        .select('id, workspace_id, product_id, storage_id, quantity')
        .eq('workspace_id', sourceWorkspaceId)
        .eq('storage_id', sourceStorageId)
        .eq('is_deleted', false)
        .gt('quantity', 0)

    if (inventoryError) {
        return errorResponse(inventoryError.message, 500)
    }

    const sourceInventoryRows = (inventoryRows ?? []) as SourceInventoryRow[]
    const productIds = Array.from(
        new Set(sourceInventoryRows.map((row) => row.product_id).filter(Boolean))
    )

    if (productIds.length === 0) {
        return jsonResponse({ products: [] })
    }

    const { data: productRows, error: productsError } = await adminClient
        .from('products')
        .select('id, sku, name, unit')
        .eq('workspace_id', sourceWorkspaceId)
        .eq('is_deleted', false)
        .in('id', productIds)

    if (productsError) {
        return errorResponse(productsError.message, 500)
    }

    const productsById = new Map(
        ((productRows ?? []) as SourceProductRow[]).map((product) => [product.id, product] as const)
    )
    const { data: batchRows, error: batchesError } = await adminClient
        .from('stock_batches')
        .select('*')
        .eq('workspace_id', sourceWorkspaceId)
        .eq('storage_id', sourceStorageId)
        .eq('is_deleted', false)
        .gt('quantity', 0)
        .in('product_id', productIds)

    if (batchesError) {
        return errorResponse(batchesError.message, 500)
    }

    const batchesByProductId = new Map<string, SourceStockBatchRow[]>()
    for (const batch of (batchRows ?? []) as SourceStockBatchRow[]) {
        const rows = batchesByProductId.get(batch.product_id) ?? []
        rows.push(batch)
        batchesByProductId.set(batch.product_id, rows)
    }

    const products = sourceInventoryRows
        .map((row) => {
            const product = productsById.get(row.product_id)
            if (!product) {
                return null
            }

            const batches = sortTransferBatches(
                batchesByProductId.get(product.id) ?? []
            )
            const batchQuantity = batches.reduce(
                (sum, batch) => sum + Number(batch.quantity),
                0
            )

            return {
                productId: product.id,
                sku: product.sku,
                name: product.name,
                unit: product.unit ?? 'pcs',
                availableQuantity: Number(row.quantity ?? 0),
                unbatchedQuantity: Math.max(Number(row.quantity ?? 0) - batchQuantity, 0),
                batches: batches.map((batch) => ({
                    id: batch.id,
                    batchNumber: batch.batch_number,
                    quantity: Number(batch.quantity),
                    price: Number(batch.price ?? 0),
                    costPrice: Number(batch.cost_price ?? 0),
                    currency: String(batch.currency ?? 'usd').toLowerCase(),
                    expiryDate: batch.expiry_date ?? null,
                    manufacturingDate: batch.manufacturing_date ?? null
                }))
            }
        })
        .filter((product): product is NonNullable<typeof product> => Boolean(product))
        .sort((left, right) => left.name.localeCompare(right.name))

    return jsonResponse({ products })
}

async function handleTransferInventoryBetweenWorkspaces(
    adminClient: AdminClient,
    user: User,
    body: TransferInventoryBetweenWorkspacesRequest
) {
    const sourceWorkspaceId = body.sourceWorkspaceId?.trim() ?? ''
    const sourceStorageId = body.sourceStorageId?.trim() ?? ''
    const destinationWorkspaceId = body.destinationWorkspaceId?.trim() ?? ''
    const destinationStorageId = body.destinationStorageId?.trim() ?? ''
    const normalizedItems = Array.from(
        new Map(
            (Array.isArray(body.items) ? body.items : [])
                .map((item) => {
                    const productId = item?.productId?.trim() ?? ''
                    const quantity = parseTransferQuantity(item?.quantity)
                    const rawBatchAllocations = Array.isArray(item?.batchAllocations)
                        ? item.batchAllocations
                        : undefined
                    const batchAllocations = rawBatchAllocations
                        ? rawBatchAllocations
                            .map((allocation) => ({
                                batchId: allocation?.batchId?.trim() ?? '',
                                quantity: parseTransferQuantity(allocation?.quantity)
                            }))
                            .filter((allocation) => Boolean(allocation.batchId))
                        : undefined
                    return [
                        productId,
                        {
                            productId,
                            quantity,
                            batchAllocations
                        }
                    ] as const
                })
                .filter(([productId]) => Boolean(productId))
        ).values()
    )

    if (!sourceWorkspaceId) {
        return errorResponse('Source workspace is required')
    }

    if (!sourceStorageId) {
        return errorResponse('Source storage is required')
    }

    if (!destinationWorkspaceId) {
        return errorResponse('Destination workspace is required')
    }

    if (!destinationStorageId) {
        return errorResponse('Destination storage is required')
    }

    if (normalizedItems.length === 0) {
        return errorResponse('At least one product must be selected')
    }

    if (sourceWorkspaceId === destinationWorkspaceId && sourceStorageId === destinationStorageId) {
        return errorResponse('Source and destination storages must be different', 400)
    }

    for (const item of normalizedItems) {
        if (!isPositiveQuantity(item.quantity)) {
            return errorResponse('Transfer quantity must be greater than zero', 400)
        }

        for (const allocation of item.batchAllocations ?? []) {
            if (!isPositiveQuantity(allocation.quantity)) {
                return errorResponse('Batch transfer quantity must be greater than zero', 400)
            }
        }
    }

    const callerResult = await requireCallerWorkspace(adminClient, user)
    if (callerResult.response || !callerResult.profile) {
        return callerResult.response!
    }

    if (!hasInventoryTransferRole(callerResult.profile.role)) {
        return errorResponse('Unauthorized: Only admins and staff can perform this action', 403)
    }

    const currentWorkspaceId = callerResult.profile.current_workspace!
    const moduleResult = await requireWorkspaceModule(adminClient, currentWorkspaceId, 'inventory_transfer')
    if (moduleResult.response) {
        return moduleResult.response
    }

    const targets = await getInventoryTransferTargets(adminClient, currentWorkspaceId)
    const targetMap = new Map(targets.map((target) => [target.workspaceId, target] as const))

    if (!targetMap.has(sourceWorkspaceId)) {
        return errorResponse('Source workspace is not linked to your current workspace', 403)
    }

    if (!targetMap.has(destinationWorkspaceId)) {
        return errorResponse('Destination workspace is not linked to your current workspace', 403)
    }

    const sourceWorkspace = targetMap.get(sourceWorkspaceId)!
    const destinationWorkspace = targetMap.get(destinationWorkspaceId)!

    const { data: storageRows, error: storageRowsError } = await adminClient
        .from('storages')
        .select('id, workspace_id, name')
        .in('id', [sourceStorageId, destinationStorageId])
        .eq('is_deleted', false)

    if (storageRowsError) {
        return errorResponse(storageRowsError.message, 500)
    }

    const sourceStorage = (storageRows ?? []).find((row) =>
        row.id === sourceStorageId && row.workspace_id === sourceWorkspaceId
    )
    const destinationStorage = (storageRows ?? []).find((row) =>
        row.id === destinationStorageId && row.workspace_id === destinationWorkspaceId
    )

    if (!sourceStorage) {
        return errorResponse('Source storage not found for the selected workspace', 404)
    }

    if (!destinationStorage) {
        return errorResponse('Destination storage not found for the selected workspace', 404)
    }

    const sourceProductIds = normalizedItems.map((item) => item.productId)
    const { data: sourceProductRows, error: sourceProductsError } = await adminClient
        .from('products')
        .select('*')
        .eq('workspace_id', sourceWorkspaceId)
        .eq('is_deleted', false)
        .in('id', sourceProductIds)

    if (sourceProductsError) {
        return errorResponse(sourceProductsError.message, 500)
    }

    const sourceProducts = (sourceProductRows ?? []) as SourceProductRow[]
    if (sourceProducts.length !== sourceProductIds.length) {
        return errorResponse('One or more selected products were not found in the source workspace', 404)
    }

    const sourceProductsById = new Map(sourceProducts.map((product) => [product.id, product] as const))
    const quantityBySourceProductId = new Map(normalizedItems.map((item) => [item.productId, item.quantity] as const))
    const previousSourceProducts = sourceProducts.map((product) => ({ ...product }))
    let previousDestinationProducts: SourceProductRow[] = []

    const destinationProductIdBySourceProductId = new Map<string, string>()
    const destinationProductsById = new Map<string, SourceProductRow>()
    const insertedDestinationCategoryIds = new Set<string>()
    const insertedDestinationProductIds = new Set<string>()
    const insertedDestinationProductBarcodeIds = new Set<string>()

    const cleanupInsertedDestinationEntities = async () => {
        if (insertedDestinationProductBarcodeIds.size > 0) {
            await adminClient
                .from('product_barcodes')
                .delete()
                .in('id', Array.from(insertedDestinationProductBarcodeIds))
        }

        if (insertedDestinationProductIds.size > 0) {
            await adminClient
                .from('products')
                .delete()
                .in('id', Array.from(insertedDestinationProductIds))
        }

        if (insertedDestinationCategoryIds.size > 0) {
            await adminClient
                .from('categories')
                .delete()
                .in('id', Array.from(insertedDestinationCategoryIds))
        }
    }

    if (sourceWorkspaceId === destinationWorkspaceId) {
        for (const product of sourceProducts) {
            destinationProductIdBySourceProductId.set(product.id, product.id)
            destinationProductsById.set(product.id, product)
        }
    } else {
        const sourceSkuByProductId = new Map<string, string>()
        const duplicateSourceSkus = new Set<string>()

        for (const product of sourceProducts) {
            const normalizedSku = normalizeSkuKey(product.sku)
            if (!normalizedSku) {
                return errorResponse(`Source product "${product.name}" must have a SKU before it can be transferred to another workspace`, 400)
            }

            if (Array.from(sourceSkuByProductId.values()).includes(normalizedSku)) {
                duplicateSourceSkus.add(normalizedSku)
            }

            sourceSkuByProductId.set(product.id, normalizedSku)
        }

        if (duplicateSourceSkus.size > 0) {
            return errorResponse('Selected source products must have unique SKUs for cross-workspace transfers', 400)
        }

        const { data: destinationProductRows, error: destinationProductsError } = await adminClient
            .from('products')
            .select('*')
            .eq('workspace_id', destinationWorkspaceId)
            .in('sku', sourceProducts.map((product) => product.sku))

        if (destinationProductsError) {
            return errorResponse(destinationProductsError.message, 500)
        }

        const destinationProductRowsList = (destinationProductRows ?? []) as SourceProductRow[]
        previousDestinationProducts = destinationProductRowsList.map((product) => ({ ...product }))

        const {
            productBySku: destinationProductBySku,
            duplicateActiveSkus: duplicateDestinationSkus
        } = buildDestinationProductMatchIndex(destinationProductRowsList)

        if (duplicateDestinationSkus.size > 0) {
            return errorResponse('Destination workspace has duplicate SKUs for one or more selected products', 400)
        }

        const missingSourceProducts = sourceProducts.filter((product) => {
            const normalizedSku = sourceSkuByProductId.get(product.id) ?? ''
            return !destinationProductBySku.has(normalizedSku)
        })

        if (missingSourceProducts.length > 0) {
            const missingSourceProductIds = missingSourceProducts.map((product) => product.id)
            const sourceCategoryIds = Array.from(
                new Set(
                    missingSourceProducts
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

            const sourceCategoryById = new Map(sourceCategories.map((category) => [category.id, category] as const))
            const sourceCategoryNameSet = new Set(
                sourceCategories
                    .map((category) => category.name.trim().toLowerCase())
                    .filter(Boolean)
            )

            const targetCategoryByName = new Map<string, TargetCategoryRow>()
            if (sourceCategoryNameSet.size > 0) {
                const { data: targetCategoryRows, error: targetCategoriesError } = await adminClient
                    .from('categories')
                    .select('id, name')
                    .eq('workspace_id', destinationWorkspaceId)
                    .eq('is_deleted', false)

                if (targetCategoriesError) {
                    return errorResponse(targetCategoriesError.message, 500)
                }

                for (const category of (targetCategoryRows ?? []) as TargetCategoryRow[]) {
                    const normalizedName = category.name.trim().toLowerCase()
                    if (!normalizedName || targetCategoryByName.has(normalizedName)) {
                        continue
                    }
                    targetCategoryByName.set(normalizedName, category)
                }
            }

            const categoryIdMap = new Map<string, string>()
            const categoriesToInsert = sourceCategories.flatMap<Record<string, unknown>>((category) => {
                const normalizedName = category.name.trim().toLowerCase()
                const existingCategory = targetCategoryByName.get(normalizedName)

                if (existingCategory) {
                    categoryIdMap.set(category.id, existingCategory.id)
                    return []
                }

                const id = crypto.randomUUID()
                insertedDestinationCategoryIds.add(id)
                targetCategoryByName.set(normalizedName, { id, name: category.name })
                categoryIdMap.set(category.id, id)

                return [{
                    id,
                    workspace_id: destinationWorkspaceId,
                    name: category.name,
                    description: category.description ?? null,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    version: 1,
                    is_deleted: false
                }]
            })

            if (categoriesToInsert.length > 0) {
                const { error: insertCategoriesError } = await adminClient
                    .from('categories')
                    .insert(categoriesToInsert)

                if (insertCategoriesError) {
                    console.error('[workspace-access] transfer destination category insert failed', insertCategoriesError)
                    await cleanupInsertedDestinationEntities()
                    return errorResponse(insertCategoriesError.message, 500)
                }
            }

            const { data: sourceProductBarcodeRows, error: sourceProductBarcodesError } = await adminClient
                .from('product_barcodes')
                .select('product_id, barcode, label, is_primary')
                .eq('workspace_id', sourceWorkspaceId)
                .eq('is_deleted', false)
                .in('product_id', missingSourceProductIds)

            if (sourceProductBarcodesError) {
                console.error('[workspace-access] transfer source barcode lookup failed', sourceProductBarcodesError)
                await cleanupInsertedDestinationEntities()
                return errorResponse(sourceProductBarcodesError.message, 500)
            }

            const insertedDestinationProducts: SourceProductRow[] = []
            const productIdMap = new Map<string, string>()
            const productInsertTimestamp = new Date().toISOString()

            const productsToInsert = missingSourceProducts.map<Record<string, unknown>>((product) => {
                const insertedProductId = crypto.randomUUID()
                const mappedCategoryId = product.category_id
                    ? categoryIdMap.get(product.category_id) ?? null
                    : null
                const resolvedCategoryName = mappedCategoryId
                    ? sourceCategoryById.get(product.category_id ?? '')?.name ?? product.category ?? null
                    : product.category ?? null

                productIdMap.set(product.id, insertedProductId)
                insertedDestinationProductIds.add(insertedProductId)

                insertedDestinationProducts.push({
                    id: insertedProductId,
                    workspace_id: destinationWorkspaceId,
                    sku: product.sku,
                    name: product.name,
                    description: product.description ?? '',
                    category: resolvedCategoryName,
                    category_id: mappedCategoryId,
                    storage_id: destinationStorageId,
                    price: Number(product.price ?? 0),
                    cost_price: Number(product.cost_price ?? 0),
                    quantity: 0,
                    min_stock_level: Number(product.min_stock_level ?? 0),
                    unit: product.unit ?? 'pcs',
                    currency: product.currency ?? 'usd',
                    image_url: product.image_url ?? null,
                    can_be_returned: product.can_be_returned ?? true,
                    return_rules: product.return_rules ?? null,
                    created_at: productInsertTimestamp,
                    updated_at: productInsertTimestamp,
                    version: 1,
                    is_deleted: false
                })

                const insertedProduct: Record<string, unknown> = {
                    id: insertedProductId,
                    workspace_id: destinationWorkspaceId,
                    sku: product.sku,
                    name: product.name,
                    description: product.description ?? '',
                    category: resolvedCategoryName,
                    category_id: mappedCategoryId,
                    storage_id: destinationStorageId,
                    price: Number(product.price ?? 0),
                    cost_price: Number(product.cost_price ?? 0),
                    quantity: 0,
                    min_stock_level: Number(product.min_stock_level ?? 0),
                    unit: product.unit ?? 'pcs',
                    currency: product.currency ?? 'usd',
                    image_url: product.image_url ?? null,
                    can_be_returned: product.can_be_returned ?? true,
                    return_rules: product.return_rules ?? null,
                    created_at: productInsertTimestamp,
                    updated_at: productInsertTimestamp,
                    version: 1,
                    is_deleted: false
                }

                if (Object.prototype.hasOwnProperty.call(product, 'barcode')) {
                    insertedProduct.barcode = product.barcode ?? null
                }

                return insertedProduct
            })

            const { error: insertProductsError } = await adminClient
                .from('products')
                .insert(productsToInsert)

            if (insertProductsError) {
                console.error('[workspace-access] transfer destination product insert failed', insertProductsError)
                await cleanupInsertedDestinationEntities()
                return errorResponse(insertProductsError.message, 500)
            }

            const productBarcodesToInsert = ((sourceProductBarcodeRows ?? []) as SourceProductBarcodeRow[])
                .flatMap<Record<string, unknown>>((productBarcode) => {
                    const destinationProductId = productIdMap.get(productBarcode.product_id)
                    if (!destinationProductId) {
                        return []
                    }

                    const insertedBarcodeId = crypto.randomUUID()
                    insertedDestinationProductBarcodeIds.add(insertedBarcodeId)
                    return [{
                        id: insertedBarcodeId,
                        workspace_id: destinationWorkspaceId,
                        product_id: destinationProductId,
                        barcode: productBarcode.barcode,
                        label: productBarcode.label ?? null,
                        is_primary: productBarcode.is_primary ?? false,
                        created_at: productInsertTimestamp,
                        updated_at: productInsertTimestamp,
                        version: 1,
                        is_deleted: false
                    }]
                })

            if (productBarcodesToInsert.length > 0) {
                const { error: insertProductBarcodesError } = await adminClient
                    .from('product_barcodes')
                    .insert(productBarcodesToInsert)

                if (insertProductBarcodesError) {
                    console.error('[workspace-access] transfer destination barcode insert failed', insertProductBarcodesError)
                    await cleanupInsertedDestinationEntities()
                    return errorResponse(insertProductBarcodesError.message, 500)
                }
            }

            for (const insertedProduct of insertedDestinationProducts) {
                const normalizedSku = normalizeSkuKey(insertedProduct.sku)
                if (!normalizedSku) {
                    continue
                }
                destinationProductBySku.set(normalizedSku, insertedProduct)
                destinationProductsById.set(insertedProduct.id, insertedProduct)
            }
        }

        for (const product of sourceProducts) {
            const normalizedSku = sourceSkuByProductId.get(product.id) ?? ''
            const destinationProduct = destinationProductBySku.get(normalizedSku)
            if (!destinationProduct) {
                return errorResponse(
                    `Destination workspace is missing product SKU "${product.sku}" for "${product.name}"`,
                    400
                )
            }

            const activeDestinationProduct = destinationProduct.is_deleted === true
                ? { ...destinationProduct, is_deleted: false }
                : destinationProduct

            destinationProductIdBySourceProductId.set(product.id, activeDestinationProduct.id)
            destinationProductsById.set(activeDestinationProduct.id, activeDestinationProduct)
        }
    }

    const destinationProductIds = Array.from(
        new Set(
            sourceProducts.map((product) => destinationProductIdBySourceProductId.get(product.id)).filter((productId): productId is string => Boolean(productId))
        )
    )

    const { data: sourceStorageInventoryRows, error: sourceInventoryError } = await adminClient
        .from('inventory')
        .select('*')
        .eq('workspace_id', sourceWorkspaceId)
        .eq('storage_id', sourceStorageId)
        .eq('is_deleted', false)
        .in('product_id', sourceProductIds)

    if (sourceInventoryError) {
        await cleanupInsertedDestinationEntities()
        return errorResponse(sourceInventoryError.message, 500)
    }

    const sourceInventoryByProductId = new Map(
        ((sourceStorageInventoryRows ?? []) as SourceInventoryRow[])
            .map((row) => [row.product_id, row] as const)
    )

    for (const product of sourceProducts) {
        const sourceRow = sourceInventoryByProductId.get(product.id)
        const availableQuantity = Number(sourceRow?.quantity ?? 0)
        const requestedQuantity = quantityBySourceProductId.get(product.id) ?? 0

        if (requestedQuantity - availableQuantity > QUANTITY_EPSILON) {
            await cleanupInsertedDestinationEntities()
            return errorResponse(`Insufficient inventory for "${product.name}" in the selected source storage`, 400)
        }
    }

    const { data: sourceBatchRows, error: sourceBatchesError } = await adminClient
        .from('stock_batches')
        .select('*')
        .eq('workspace_id', sourceWorkspaceId)
        .eq('storage_id', sourceStorageId)
        .eq('is_deleted', false)
        .gt('quantity', 0)
        .in('product_id', sourceProductIds)

    if (sourceBatchesError) {
        await cleanupInsertedDestinationEntities()
        return errorResponse(sourceBatchesError.message, 500)
    }

    const sourceBatches = (sourceBatchRows ?? []) as SourceStockBatchRow[]
    const sourceBatchesById = new Map(
        sourceBatches.map((batch) => [batch.id, batch] as const)
    )
    const sourceBatchesByProductId = new Map<string, SourceStockBatchRow[]>()
    for (const batch of sourceBatches) {
        const rows = sourceBatchesByProductId.get(batch.product_id) ?? []
        rows.push(batch)
        sourceBatchesByProductId.set(batch.product_id, rows)
    }

    const batchPlansBySourceProductId = new Map<string, {
        allocations: PlannedTransferBatchAllocation[]
        unbatchedQuantity: number
    }>()

    try {
        for (const item of normalizedItems) {
            const sourceRow = sourceInventoryByProductId.get(item.productId)
            batchPlansBySourceProductId.set(
                item.productId,
                planTransferBatchAllocations({
                    inventoryQuantity: Number(sourceRow?.quantity ?? 0),
                    batches: sourceBatchesByProductId.get(item.productId) ?? [],
                    requestedQuantity: item.quantity,
                    selectedBatchAllocations: item.batchAllocations
                })
            )
        }
    } catch (error) {
        await cleanupInsertedDestinationEntities()
        return errorResponse(
            error instanceof Error ? error.message : 'Invalid batch transfer selection',
            400
        )
    }

    const inventoryRowsByWorkspaceId = new Map<string, SourceInventoryRow[]>()
    const productIdsByWorkspaceId = new Map<string, string[]>()

    productIdsByWorkspaceId.set(sourceWorkspaceId, Array.from(new Set(sourceProductIds)))
    productIdsByWorkspaceId.set(
        destinationWorkspaceId,
        Array.from(new Set(destinationProductIds))
    )

    for (const [workspaceId, productIds] of productIdsByWorkspaceId.entries()) {
        const { data: inventoryRows, error: inventoryError } = await adminClient
            .from('inventory')
            .select('*')
            .eq('workspace_id', workspaceId)
            .in('product_id', productIds)

        if (inventoryError) {
            await cleanupInsertedDestinationEntities()
            return errorResponse(inventoryError.message, 500)
        }

        inventoryRowsByWorkspaceId.set(workspaceId, (inventoryRows ?? []) as SourceInventoryRow[])
    }

    const inventoryRowsByPositionKey = new Map<string, SourceInventoryRow>()
    const activeInventoryRowsByWorkspaceProductKey = new Map<string, SourceInventoryRow[]>()

    for (const [workspaceId, inventoryRows] of inventoryRowsByWorkspaceId.entries()) {
        for (const row of inventoryRows) {
            const productKey = buildWorkspaceProductKey(workspaceId, row.product_id)
            const positionKey = buildWorkspaceStorageProductKey(workspaceId, row.product_id, row.storage_id)
            const existingPositionRow = inventoryRowsByPositionKey.get(positionKey)
            if (!existingPositionRow || (existingPositionRow.is_deleted && !row.is_deleted)) {
                inventoryRowsByPositionKey.set(positionKey, row)
            }

            if (!row.is_deleted && Number(row.quantity ?? 0) > 0) {
                const rows = activeInventoryRowsByWorkspaceProductKey.get(productKey) ?? []
                rows.push({ ...row })
                activeInventoryRowsByWorkspaceProductKey.set(productKey, rows)
            }
        }
    }

    const inventoryRowsToUpsert = new Map<string, SourceInventoryRow>()
    const insertedInventoryRowIds = new Set<string>()
    const applyInventoryState = (
        workspaceId: string,
        productId: string,
        storageId: string,
        nextRow: SourceInventoryRow
    ) => {
        const productKey = buildWorkspaceProductKey(workspaceId, productId)
        const currentRows = activeInventoryRowsByWorkspaceProductKey.get(productKey) ?? []
        const remainingRows = currentRows.filter((row) => row.storage_id !== storageId)

        if (!nextRow.is_deleted && Number(nextRow.quantity ?? 0) > 0) {
            remainingRows.push({ ...nextRow })
        }

        activeInventoryRowsByWorkspaceProductKey.set(productKey, remainingRows)
    }

    const { data: destinationBatchRows, error: destinationBatchesError } = await adminClient
        .from('stock_batches')
        .select('*')
        .eq('workspace_id', destinationWorkspaceId)
        .eq('storage_id', destinationStorageId)
        .in('product_id', destinationProductIds)

    if (destinationBatchesError) {
        await cleanupInsertedDestinationEntities()
        return errorResponse(destinationBatchesError.message, 500)
    }

    const destinationBatches = (destinationBatchRows ?? []) as SourceStockBatchRow[]
    const destinationBatchByKey = new Map<string, SourceStockBatchRow>()
    for (const batch of destinationBatches) {
        const key = `${batch.product_id}::${batch.batch_number.trim().toLowerCase()}`
        const existing = destinationBatchByKey.get(key)
        if (!existing || (existing.is_deleted && !batch.is_deleted)) {
            destinationBatchByKey.set(key, batch)
        }
    }
    const stockBatchRowsToUpsert = new Map<string, SourceStockBatchRow>()
    const insertedStockBatchIds = new Set<string>()
    const previousStockBatchRows = Array.from(
        new Map(
            [...sourceBatches, ...destinationBatches].map((batch) => [batch.id, { ...batch }] as const)
        ).values()
    )

    const transferTransactionSeedId = crypto.randomUUID()
    const inventoryTransactionRows: Record<string, unknown>[] = []
    const inventoryTransferTransactionRows: Record<string, unknown>[] = []
    const changedProductKeys = new Set<string>()
    const transactionTimestamp = new Date().toISOString()

    for (const item of normalizedItems) {
        const sourceProduct = sourceProductsById.get(item.productId)
        const destinationProductId = destinationProductIdBySourceProductId.get(item.productId)
        const destinationProduct = destinationProductId
            ? destinationProductsById.get(destinationProductId)
            : null

        if (!sourceProduct || !destinationProductId || !destinationProduct) {
            await cleanupInsertedDestinationEntities()
            return errorResponse('Transfer could not resolve one or more selected products', 400)
        }

        const sourcePositionKey = buildWorkspaceStorageProductKey(sourceWorkspaceId, sourceProduct.id, sourceStorageId)
        const previousSourceRow = inventoryRowsByPositionKey.get(sourcePositionKey)
        const previousSourceQuantity = Number(previousSourceRow?.quantity ?? 0)
        const nextSourceQuantity = roundQuantity(previousSourceQuantity - item.quantity)

        const updatedSourceRow: SourceInventoryRow = previousSourceRow
            ? {
                ...previousSourceRow,
                quantity: roundQuantity(Math.max(nextSourceQuantity, 0)),
                updated_at: transactionTimestamp,
                version: Number(previousSourceRow.version ?? 0) + 1,
                is_deleted: nextSourceQuantity <= QUANTITY_EPSILON
            }
            : {
                id: crypto.randomUUID(),
                workspace_id: sourceWorkspaceId,
                product_id: sourceProduct.id,
                storage_id: sourceStorageId,
                quantity: roundQuantity(Math.max(nextSourceQuantity, 0)),
                created_at: transactionTimestamp,
                updated_at: transactionTimestamp,
                version: 1,
                is_deleted: nextSourceQuantity <= QUANTITY_EPSILON
            }

        if (!previousSourceRow) {
            insertedInventoryRowIds.add(String(updatedSourceRow.id))
        }

        inventoryRowsToUpsert.set(String(updatedSourceRow.id), updatedSourceRow)
        applyInventoryState(sourceWorkspaceId, sourceProduct.id, sourceStorageId, updatedSourceRow)
        changedProductKeys.add(buildWorkspaceProductKey(sourceWorkspaceId, sourceProduct.id))

        const destinationPositionKey = buildWorkspaceStorageProductKey(destinationWorkspaceId, destinationProductId, destinationStorageId)
        const previousDestinationRow = inventoryRowsByPositionKey.get(destinationPositionKey)
        const previousDestinationQuantity = Number(previousDestinationRow?.quantity ?? 0)
        const nextDestinationQuantity = roundQuantity(previousDestinationQuantity + item.quantity)

        const updatedDestinationRow: SourceInventoryRow = previousDestinationRow
            ? {
                ...previousDestinationRow,
                quantity: nextDestinationQuantity,
                updated_at: transactionTimestamp,
                version: Number(previousDestinationRow.version ?? 0) + 1,
                is_deleted: false
            }
            : {
                id: crypto.randomUUID(),
                workspace_id: destinationWorkspaceId,
                product_id: destinationProductId,
                storage_id: destinationStorageId,
                quantity: nextDestinationQuantity,
                created_at: transactionTimestamp,
                updated_at: transactionTimestamp,
                version: 1,
                is_deleted: false
            }

        if (!previousDestinationRow) {
            insertedInventoryRowIds.add(String(updatedDestinationRow.id))
        }

        inventoryRowsToUpsert.set(String(updatedDestinationRow.id), updatedDestinationRow)
        applyInventoryState(destinationWorkspaceId, destinationProductId, destinationStorageId, updatedDestinationRow)
        changedProductKeys.add(buildWorkspaceProductKey(destinationWorkspaceId, destinationProductId))

        const batchPlan = batchPlansBySourceProductId.get(item.productId)
        if (!batchPlan) {
            await cleanupInsertedDestinationEntities()
            return errorResponse('Transfer could not resolve the batch selection', 400)
        }

        for (const allocation of batchPlan.allocations) {
            const sourceBatch = stockBatchRowsToUpsert.get(allocation.sourceBatchId)
                ?? sourceBatchesById.get(allocation.sourceBatchId)
            if (!sourceBatch || sourceBatch.product_id !== sourceProduct.id) {
                await cleanupInsertedDestinationEntities()
                return errorResponse(`Batch ${allocation.batchNumber} is no longer available`, 400)
            }

            const sourceBatchQuantity = Number(sourceBatch.quantity)
            const nextSourceBatchQuantity = roundQuantity(sourceBatchQuantity - allocation.quantity)
            if (nextSourceBatchQuantity < -QUANTITY_EPSILON) {
                await cleanupInsertedDestinationEntities()
                return errorResponse(`Batch ${allocation.batchNumber} does not have enough stock`, 400)
            }

            const updatedSourceBatch: SourceStockBatchRow = {
                ...sourceBatch,
                quantity: roundQuantity(Math.max(nextSourceBatchQuantity, 0)),
                is_deleted: nextSourceBatchQuantity <= QUANTITY_EPSILON,
                updated_at: transactionTimestamp,
                version: Number(sourceBatch.version ?? 0) + 1
            }
            stockBatchRowsToUpsert.set(updatedSourceBatch.id, updatedSourceBatch)

            const destinationBatchKey = `${destinationProductId}::${allocation.batchNumber.trim().toLowerCase()}`
            const existingDestinationBatch = destinationBatchByKey.get(destinationBatchKey)

            if (
                existingDestinationBatch
                && !transferBatchSnapshotsAreCompatible(existingDestinationBatch, allocation)
            ) {
                await cleanupInsertedDestinationEntities()
                return errorResponse(
                    `Destination batch ${allocation.batchNumber} has different pricing or dates`,
                    400
                )
            }

            const destinationBatch: SourceStockBatchRow = existingDestinationBatch
                ? {
                    ...existingDestinationBatch,
                    quantity: roundQuantity(Number(existingDestinationBatch.quantity) + allocation.quantity),
                    is_deleted: false,
                    updated_at: transactionTimestamp,
                    version: Number(existingDestinationBatch.version ?? 0) + 1
                }
                : {
                    id: crypto.randomUUID(),
                    workspace_id: destinationWorkspaceId,
                    product_id: destinationProductId,
                    storage_id: destinationStorageId,
                    batch_number: allocation.batchNumber,
                    quantity: allocation.quantity,
                    price: allocation.price,
                    cost_price: allocation.costPrice,
                    currency: allocation.currency,
                    expiry_date: allocation.expiryDate,
                    manufacturing_date: allocation.manufacturingDate,
                    notes: sourceBatch.notes ?? null,
                    source_purchase_order_id: null,
                    source_purchase_order_item_id: null,
                    created_at: transactionTimestamp,
                    updated_at: transactionTimestamp,
                    version: 1,
                    is_deleted: false
                }

            if (!existingDestinationBatch) {
                insertedStockBatchIds.add(destinationBatch.id)
            }

            destinationBatchByKey.set(destinationBatchKey, destinationBatch)
            stockBatchRowsToUpsert.set(destinationBatch.id, destinationBatch)
            allocation.destinationBatchId = destinationBatch.id
        }

        const operationReferenceId = transferTransactionSeedId

        inventoryTransactionRows.push({
            id: crypto.randomUUID(),
            workspace_id: sourceWorkspaceId,
            product_id: sourceProduct.id,
            storage_id: sourceStorageId,
            transaction_type: 'transfer_out',
            quantity_delta: -item.quantity,
            previous_quantity: previousSourceQuantity,
            new_quantity: roundQuantity(Math.max(nextSourceQuantity, 0)),
            adjustment_reason: null,
            reference_id: operationReferenceId,
            reference_type: 'transfer',
            notes: `Transferred to ${destinationWorkspace.workspaceName} / ${destinationStorage.name}`,
            created_by: user.id,
            created_at: transactionTimestamp,
            updated_at: transactionTimestamp,
            version: 1,
            is_deleted: false
        })

        inventoryTransactionRows.push({
            id: crypto.randomUUID(),
            workspace_id: destinationWorkspaceId,
            product_id: destinationProductId,
            storage_id: destinationStorageId,
            transaction_type: 'transfer_in',
            quantity_delta: item.quantity,
            previous_quantity: previousDestinationQuantity,
            new_quantity: roundQuantity(nextDestinationQuantity),
            adjustment_reason: null,
            reference_id: operationReferenceId,
            reference_type: 'transfer',
            notes: `Transferred from ${sourceWorkspace.workspaceName} / ${sourceStorage.name}`,
            created_by: user.id,
            created_at: transactionTimestamp,
            updated_at: transactionTimestamp,
            version: 1,
            is_deleted: false
        })

        const transferMetadata = {
            source_workspace_id: sourceWorkspaceId,
            destination_workspace_id: destinationWorkspaceId,
            source_workspace_name: sourceWorkspace.workspaceName,
            destination_workspace_name: destinationWorkspace.workspaceName,
            source_storage_name: sourceStorage.name,
            destination_storage_name: destinationStorage.name
        }
        const batchAllocationSnapshot = batchPlan.allocations.map((allocation) => ({
            sourceBatchId: allocation.sourceBatchId,
            destinationBatchId: allocation.destinationBatchId,
            batchNumber: allocation.batchNumber,
            quantity: allocation.quantity,
            price: allocation.price,
            costPrice: allocation.costPrice,
            currency: allocation.currency,
            expiryDate: allocation.expiryDate,
            manufacturingDate: allocation.manufacturingDate
        }))

        if (sourceWorkspaceId === destinationWorkspaceId) {
            inventoryTransferTransactionRows.push({
                id: crypto.randomUUID(),
                workspace_id: sourceWorkspaceId,
                product_id: sourceProduct.id,
                source_storage_id: sourceStorageId,
                destination_storage_id: destinationStorageId,
                quantity: item.quantity,
                batch_allocations: batchAllocationSnapshot,
                transfer_type: 'manual',
                reorder_rule_id: null,
                created_at: transactionTimestamp,
                updated_at: transactionTimestamp,
                version: 1,
                is_deleted: false,
                ...transferMetadata
            })
        } else {
            inventoryTransferTransactionRows.push({
                id: crypto.randomUUID(),
                workspace_id: sourceWorkspaceId,
                product_id: sourceProduct.id,
                source_storage_id: sourceStorageId,
                destination_storage_id: destinationStorageId,
                quantity: item.quantity,
                batch_allocations: batchAllocationSnapshot,
                transfer_type: 'manual',
                reorder_rule_id: null,
                created_at: transactionTimestamp,
                updated_at: transactionTimestamp,
                version: 1,
                is_deleted: false,
                ...transferMetadata
            })
            inventoryTransferTransactionRows.push({
                id: crypto.randomUUID(),
                workspace_id: destinationWorkspaceId,
                product_id: destinationProductId,
                source_storage_id: sourceStorageId,
                destination_storage_id: destinationStorageId,
                quantity: item.quantity,
                batch_allocations: batchAllocationSnapshot,
                transfer_type: 'manual',
                reorder_rule_id: null,
                created_at: transactionTimestamp,
                updated_at: transactionTimestamp,
                version: 1,
                is_deleted: false,
                ...transferMetadata
            })
        }
    }

    const productIdsByWorkspaceKey = new Map<string, SourceProductRow>()
    for (const product of sourceProducts) {
        productIdsByWorkspaceKey.set(buildWorkspaceProductKey(sourceWorkspaceId, product.id), product)
    }
    for (const product of destinationProductsById.values()) {
        productIdsByWorkspaceKey.set(buildWorkspaceProductKey(destinationWorkspaceId, product.id), product)
    }

    const updatedProductsToUpsert: Record<string, unknown>[] = []
    for (const productKey of changedProductKeys) {
        const product = productIdsByWorkspaceKey.get(productKey)
        if (!product) {
            continue
        }

        const activeRows = activeInventoryRowsByWorkspaceProductKey.get(productKey) ?? []
        const totalQuantity = roundQuantity(activeRows.reduce((sum, row) => sum + Number(row.quantity ?? 0), 0))
        const resolvedStorageId = activeRows.length === 1 ? activeRows[0].storage_id : null
        updatedProductsToUpsert.push({
            id: product.id,
            workspace_id: product.workspace_id ?? (productKey.startsWith(`${sourceWorkspaceId}::`) ? sourceWorkspaceId : destinationWorkspaceId),
            sku: product.sku,
            name: product.name,
            description: product.description ?? '',
            category: product.category ?? null,
            category_id: product.category_id ?? null,
            price: Number(product.price ?? 0),
            cost_price: Number(product.cost_price ?? 0),
            quantity: totalQuantity,
            min_stock_level: Number(product.min_stock_level ?? 0),
            unit: product.unit ?? 'pcs',
            currency: product.currency ?? 'usd',
            image_url: product.image_url ?? null,
            can_be_returned: product.can_be_returned ?? true,
            return_rules: product.return_rules ?? null,
            storage_id: resolvedStorageId,
            is_deleted: product.is_deleted ?? false,
            updated_at: transactionTimestamp,
            version: Number(product.version ?? 0) + 1
        })
    }

    const previousInventoryRows = Array.from(inventoryRowsByPositionKey.values()).map((row) => ({ ...row }))
    const inventoryRowsInserted = Array.from(insertedInventoryRowIds)
    const rollbackChanges = async () => {
        if (insertedStockBatchIds.size > 0) {
            await adminClient
                .from('stock_batches')
                .delete()
                .in('id', Array.from(insertedStockBatchIds))
        }

        if (previousStockBatchRows.length > 0) {
            await adminClient
                .from('stock_batches')
                .upsert(previousStockBatchRows)
        }

        if (previousInventoryRows.length > 0) {
            await adminClient
                .from('inventory')
                .upsert(previousInventoryRows)
        }

        if (inventoryRowsInserted.length > 0) {
            await adminClient
                .from('inventory')
                .delete()
                .in('id', inventoryRowsInserted)
        }

        const previousProductsToRestore = sourceWorkspaceId === destinationWorkspaceId
            ? previousSourceProducts
            : [...previousSourceProducts, ...previousDestinationProducts]

        if (previousProductsToRestore.length > 0) {
            await adminClient
                .from('products')
                .upsert(previousProductsToRestore)
        }

        await cleanupInsertedDestinationEntities()
    }

    try {
        if (inventoryRowsToUpsert.size > 0) {
            const { error: inventoryUpsertError } = await adminClient
                .from('inventory')
                .upsert(Array.from(inventoryRowsToUpsert.values()))

            if (inventoryUpsertError) {
                console.error('[workspace-access] transfer inventory upsert failed', inventoryUpsertError)
                await rollbackChanges()
                return errorResponse(inventoryUpsertError.message, 500)
            }
        }

        if (updatedProductsToUpsert.length > 0) {
            const { error: productsUpsertError } = await adminClient
                .from('products')
                .upsert(updatedProductsToUpsert)

            if (productsUpsertError) {
                console.error('[workspace-access] transfer products upsert failed', productsUpsertError)
                await rollbackChanges()
                return errorResponse(productsUpsertError.message, 500)
            }
        }

        if (stockBatchRowsToUpsert.size > 0) {
            const { error: stockBatchesUpsertError } = await adminClient
                .from('stock_batches')
                .upsert(Array.from(stockBatchRowsToUpsert.values()))

            if (stockBatchesUpsertError) {
                console.error('[workspace-access] transfer stock batch upsert failed', stockBatchesUpsertError)
                await rollbackChanges()
                return errorResponse(stockBatchesUpsertError.message, 500)
            }
        }

    } catch (error) {
        console.error('[workspace-access] transfer-inventory-between-workspaces failed', error)
        await rollbackChanges()
        return errorResponse(error instanceof Error ? error.message : 'Failed to transfer inventory', 500)
    }

    return jsonResponse({
        success: true,
        moved_products_count: normalizedItems.length,
        source_workspace_id: sourceWorkspaceId,
        destination_workspace_id: destinationWorkspaceId,
        // The client persists these records locally; this function no longer writes either log table.
        inventory_transaction_records: inventoryTransactionRows,
        inventory_transfer_transaction_records: inventoryTransferTransactionRows
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

    const sourceWorkspaceId = callerResult.profile.current_workspace!
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

    const { data: productBarcodeRows, error: productBarcodesError } = await adminClient
        .from('product_barcodes')
        .select('product_id, barcode, label, is_primary')
        .eq('workspace_id', sourceWorkspaceId)
        .eq('is_deleted', false)
        .in('product_id', sourceProductIds)

    if (productBarcodesError) {
        return errorResponse(productBarcodesError.message, 500)
    }

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

    const sourceProductBarcodes = (productBarcodeRows ?? []) as SourceProductBarcodeRow[]
    const productBarcodesToInsert = sourceProductBarcodes.flatMap<Record<string, unknown>>((productBarcode) => {
        const clonedProductId = productIdMap.get(productBarcode.product_id)
        if (!clonedProductId) {
            return []
        }

        return [{
            id: crypto.randomUUID(),
            workspace_id: targetWorkspaceId,
            product_id: clonedProductId,
            barcode: productBarcode.barcode,
            label: productBarcode.label ?? null,
            is_primary: productBarcode.is_primary ?? false,
            created_at: now,
            updated_at: now,
            version: 1,
            is_deleted: false
        }]
    })

    if (productBarcodesToInsert.length > 0) {
        const { error: insertProductBarcodesError } = await adminClient
            .from('product_barcodes')
            .insert(productBarcodesToInsert)

        if (insertProductBarcodesError) {
            return errorResponse(insertProductBarcodesError.message, 500)
        }
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
        cloned_product_barcodes_count: productBarcodesToInsert.length,
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

        if (body.action === 'delete-branch' || body.action === 'archive-branch') {
            return await handleArchiveBranch(adminClient, user, body)
        }

        if (body.action === 'restore-branch') {
            return await handleRestoreBranch(adminClient, user, body)
        }

        if (body.action === 'list-product-clone-targets') {
            return await handleListProductCloneTargets(adminClient, user)
        }

        if (body.action === 'list-inventory-transfer-targets') {
            return await handleListInventoryTransferTargets(adminClient, user)
        }

        if (body.action === 'list-inventory-transfer-source-products') {
            return await handleListInventoryTransferSourceProducts(adminClient, user, body)
        }

        if (body.action === 'transfer-inventory-between-workspaces') {
            return await handleTransferInventoryBetweenWorkspaces(adminClient, user, body)
        }

        if (body.action === 'clone-products-to-branch') {
            return await handleCloneProductsToBranch(adminClient, user, body)
        }

        if (body.action === 'list-permission-copy-workspaces') {
            return await handleListPermissionCopyWorkspaces(adminClient, user)
        }

        if (body.action === 'list-workspace-member-permissions') {
            return await handleListWorkspaceMemberPermissions(adminClient, user, body)
        }

        if (body.action === 'copy-member-permissions') {
            return await handleCopyMemberPermissions(adminClient, user, body)
        }

        return errorResponse('Unsupported action', 400)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error'
        console.error('[workspace-access] unhandled request failure', {
            action: body.action,
            error
        })
        return errorResponse(message, 500)
    }
})
