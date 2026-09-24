import { createAdminClient } from '../_shared/supabase.ts'
import { corsHeaders, errorResponse, jsonResponse, readJson } from '../_shared/http.ts'
import { resolveWorkspaceUsageOwnerId } from './workspaceUsagePresence.ts'

type VerifyRequest = {
    action: 'verify'
    passkey?: string
}

type ListUsersRequest = {
    action: 'listUsers'
    passkey?: string
}

type ListWorkspacesRequest = {
    action: 'listWorkspaces'
    passkey?: string
}

type DeleteUserRequest = {
    action: 'deleteUser'
    passkey?: string
    targetUserId?: string
}

type UpdateWorkspaceFeaturesRequest = {
    action: 'updateWorkspaceFeatures'
    passkey?: string
    workspaceId?: string
    locked_workspace?: boolean
}

type UpdateWorkspaceSubscriptionRequest = {
    action: 'updateWorkspaceSubscription'
    passkey?: string
    workspaceId?: string
    newExpiry?: string
}

type ListOverridesRequest = {
    action: 'listOverrides'
    passkey?: string
    workspaceId?: string
}

type UpsertOverrideRequest = {
    action: 'upsertOverride'
    passkey?: string
    workspaceId?: string
    type?: string
    key?: string
    value?: string | null
}

type DeleteOverrideRequest = {
    action: 'deleteOverride'
    passkey?: string
    overrideId?: string
}

type ListWorkspaceUsageRequest = {
    action: 'listWorkspaceUsage'
    passkey?: string
}

type UpdateWorkspaceUsageRequest = {
    action: 'updateWorkspaceUsage'
    passkey?: string
    workspaceId?: string
    storageUnits?: string | number | null
    /** Charged plan usage. This is the only editable transfer counter. */
    chargedUsageBytes?: string | number | null
    transferPeriodStart?: string | null
    storageUnitLimit?: string | number | null
    /** Monthly allowance compared with chargedUsageBytes. */
    monthlyChargedUsageLimitBytes?: string | number | null
    /** @deprecated Wire-name alias for the charged-usage allowance. */
    monthlyDataTransferLimitBytes?: string | number | null
    notes?: string | null
}

type RefreshWorkspaceUsageRequest = {
    action: 'refreshWorkspaceUsage'
    passkey?: string
    workspaceId?: string | null
}

type GrantWorkspaceFreeUsageRequest = {
    action: 'grantWorkspaceFreeUsage'
    passkey?: string
    workspaceId?: string
    gbAmount?: string | number
}

type SendWorkspaceAdminMessageRequest = {
    action: 'sendWorkspaceAdminMessage'
    passkey?: string
    workspaceId?: string
    message?: string
}

type ListWorkspacePaymentConfigurationsRequest = {
    action: 'listWorkspacePaymentConfigurations'
    passkey?: string
}

type UpsertWorkspacePaymentConfigurationRequest = {
    action: 'upsertWorkspacePaymentConfiguration'
    passkey?: string
    workspaceId?: string
    subscriptionAmount?: string | number
    isPaymentEnabled?: boolean
    usageEnabled?: boolean
    paygEnabled?: boolean
    gbPerPayment?: string | number
    usageStartDate?: string | null
    renewalDueAt?: string | null
    billingInterval?: 'monthly'
    paygProfileId?: string | null
    paygProfileChangeTiming?: 'next_cycle' | 'immediate'
}

type TerminateWorkspacePaygRequest = {
    action: 'terminateWorkspacePayg'
    passkey?: string
    workspaceId?: string
}

type ActivateWorkspacePrepaidTermRequest = {
    action: 'activateWorkspacePrepaidTerm'
    passkey?: string
    workspaceId?: string
    monthlyListPrice?: string | number
    monthlyAllowanceGb?: string | number
    prepaidAllowanceMode?: 'monthly_reset' | 'term_pool'
    prepaidCycles?: number
    amountPaid?: string | number
    termStartedAt?: string
    replaceExistingTerm?: boolean
    expectedTransactionId?: string | null
}

type GetPaygPricingScheduleRequest = {
    action: 'getPaygPricingSchedule'
    passkey?: string
}

type PublishPaygPricingScheduleRequest = {
    action: 'publishPaygPricingSchedule'
    passkey?: string
    checkpoints?: Array<{ gb?: number; amountIqd?: number }>
}

type ListPaygProfilesRequest = {
    action: 'listPaygProfiles'
    passkey?: string
}

type CreatePaygProfileRequest = {
    action: 'createPaygProfile'
    passkey?: string
    name?: string
    checkpoints?: Array<{ gb?: number; amountIqd?: number }>
}

type ListWorkspacePaymentTransactionsRequest = {
    action: 'listWorkspacePaymentTransactions'
    passkey?: string
    status?: string | null
}

type ReviewWorkspacePaymentTransactionRequest = {
    action: 'reviewWorkspacePaymentTransaction'
    passkey?: string
    transactionId?: string
    decision?: 'approved' | 'rejected'
    reviewerLabel?: string | null
    note?: string | null
    providerPaymentId?: string | null
}

type AdminConsoleRequest =
    | VerifyRequest
    | ListUsersRequest
    | ListWorkspacesRequest
    | DeleteUserRequest
    | UpdateWorkspaceFeaturesRequest
    | UpdateWorkspaceSubscriptionRequest
    | ListOverridesRequest
    | UpsertOverrideRequest
    | DeleteOverrideRequest
    | ListWorkspaceUsageRequest
    | UpdateWorkspaceUsageRequest
    | RefreshWorkspaceUsageRequest
    | GrantWorkspaceFreeUsageRequest
    | SendWorkspaceAdminMessageRequest
    | ListWorkspacePaymentConfigurationsRequest
    | UpsertWorkspacePaymentConfigurationRequest
    | TerminateWorkspacePaygRequest
    | ActivateWorkspacePrepaidTermRequest
    | GetPaygPricingScheduleRequest
    | PublishPaygPricingScheduleRequest
    | ListPaygProfilesRequest
    | CreatePaygProfileRequest
    | ListWorkspacePaymentTransactionsRequest
    | ReviewWorkspacePaymentTransactionRequest

type WorkspaceUsageStatusRow = {
    has_limits?: boolean | null
    workspace_id?: string | null
    transfer_period_start?: string | null
}

type WorkspaceA2cPhoneRow = {
    workspace_id: string
    phone_number: string
}

type AdminPasskeyAccess =
    | { ok: true; response: null }
    | { ok: false; response: Response }

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n
const BYTES_PER_GB = 1_000_000_000n
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAYMENT_TRANSACTION_STATUSES = new Set(['pending', 'approved', 'rejected', 'expired'])

async function getWorkspaceA2cPhones(
    adminClient: ReturnType<typeof createAdminClient>
) {
    const { data, error } = await adminClient.rpc('admin_list_workspace_a2c_phones')

    if (error) {
        throw new Error(error.message)
    }

    return new Map(
        ((data ?? []) as WorkspaceA2cPhoneRow[]).map((row) => [
            String(row.workspace_id),
            row.phone_number
        ])
    )
}

function currentUsagePeriodStart() {
    const now = new Date()
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        .toISOString()
        .slice(0, 10)
}

function normalizeNullableBigint(value: unknown, field: string): { value: string | null; error?: string } {
    if (value === null || value === undefined || value === '') {
        return { value: null }
    }

    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) > POSTGRES_BIGINT_MAX) {
            return { value: null, error: `${field} must be a non-negative integer` }
        }
        return { value: String(value) }
    }

    if (typeof value === 'string') {
        const normalized = value.trim()
        if (!normalized) {
            return { value: null }
        }
        if (!/^\d+$/.test(normalized)) {
            return { value: null, error: `${field} must be a non-negative integer` }
        }
        const parsed = BigInt(normalized)
        if (parsed > POSTGRES_BIGINT_MAX) {
            return { value: null, error: `${field} must fit in a PostgreSQL bigint` }
        }
        return { value: parsed.toString() }
    }

    return { value: null, error: `${field} must be a non-negative integer` }
}

function normalizePaymentDecimal(
    value: unknown,
    field: string,
    options: {
        positive?: boolean
        maximumDecimalPlaces?: number
        maximumWholeDigits?: number
    } = {}
): { value: string; error?: string } {
    const maximumDecimalPlaces = options.maximumDecimalPlaces ?? 3
    const maximumWholeDigits = options.maximumWholeDigits ?? 17
    const normalized = typeof value === 'number'
        ? (Number.isFinite(value) ? String(value) : '')
        : typeof value === 'string'
            ? value.trim()
            : ''
    const decimalPattern = new RegExp(
        `^\\d{1,${maximumWholeDigits}}(?:\\.\\d{1,${maximumDecimalPlaces}})?$`
    )

    if (!decimalPattern.test(normalized)) {
        return {
            value: '0',
            error: `${field} must be a non-negative number with up to ${maximumDecimalPlaces} decimal places`
        }
    }

    const [wholePart, fractionalPart = ''] = normalized.split('.')
    const canonicalFraction = fractionalPart.replace(/0+$/, '')
    const canonical = canonicalFraction
        ? `${BigInt(wholePart).toString()}.${canonicalFraction}`
        : BigInt(wholePart).toString()

    if (options.positive && Number(canonical) <= 0) {
        return { value: canonical, error: `${field} must be greater than zero` }
    }

    return { value: canonical }
}

function normalizeOptionalText(value: unknown, field: string, maxLength: number) {
    if (value === null || value === undefined) return { value: null as string | null }
    if (typeof value !== 'string') return { value: null as string | null, error: `${field} must be text` }

    const normalized = value.trim()
    if (!normalized) return { value: null as string | null }
    if (normalized.length > maxLength) {
        return { value: null as string | null, error: `${field} must be ${maxLength} characters or fewer` }
    }

    return { value: normalized }
}

function resolveNullableBigintAlias(
    value: unknown,
    legacyValue: unknown,
    field: string,
    legacyField: string
): { value: string | null; error?: string } {
    const normalized = normalizeNullableBigint(value, field)
    const normalizedLegacy = normalizeNullableBigint(legacyValue, legacyField)
    const error = normalized.error ?? normalizedLegacy.error

    if (error) {
        return { value: null, error }
    }

    const hasValue = value !== undefined
    const hasLegacyValue = legacyValue !== undefined
    if (hasValue && hasLegacyValue && normalized.value !== normalizedLegacy.value) {
        return { value: null, error: `${field} and ${legacyField} must match when both are provided` }
    }

    return {
        value: hasValue ? normalized.value : normalizedLegacy.value
    }
}

function reconcileChargedUsage(chargedValue: string | null): { chargedValue: string; error?: string } {
    if (chargedValue === null) {
        return { chargedValue: '0', error: 'Monthly charged usage is required' }
    }

    const charged = BigInt(chargedValue)
    if (charged > POSTGRES_BIGINT_MAX) {
        return { chargedValue: '0', error: 'Charged usage is too large to store safely' }
    }

    return { chargedValue: charged.toString() }
}

function normalizePositiveGbToBytes(value: unknown): { value: string; error?: string } {
    const normalized = typeof value === 'number'
        ? (Number.isFinite(value) ? String(value) : '')
        : typeof value === 'string'
            ? value.trim()
            : ''

    if (!/^\d{1,10}(?:\.\d{1,6})?$/.test(normalized)) {
        return { value: '0', error: 'Free usage must be a positive GB value with up to 6 decimal places' }
    }

    const [wholePart, fractionalPart = ''] = normalized.split('.')
    const bytes = (BigInt(wholePart) * BYTES_PER_GB)
        + (fractionalPart
            ? (BigInt(fractionalPart) * BYTES_PER_GB) / (10n ** BigInt(fractionalPart.length))
            : 0n)

    if (bytes <= 0n) {
        return { value: '0', error: 'Free usage must be greater than zero' }
    }

    if (bytes > POSTGRES_BIGINT_MAX) {
        return { value: '0', error: 'Free usage is too large to store safely' }
    }

    return { value: bytes.toString() }
}

function normalizeUsagePeriodStart(value: unknown): { value: string; error?: string } {
    if (value === null || value === undefined || value === '') {
        return { value: currentUsagePeriodStart() }
    }

    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { value: currentUsagePeriodStart(), error: 'Transfer period must be a YYYY-MM-DD date' }
    }

    const parsed = new Date(`${value}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        return { value: currentUsagePeriodStart(), error: 'Transfer period is invalid' }
    }

    return { value }
}

async function isValidAdminPasskey(adminClient: ReturnType<typeof createAdminClient>, passkey: string) {
    const { data, error } = await adminClient
        .from('app_permissions')
        .select('key_value')
        .eq('key_name', 'super_admin_passkey')
        .maybeSingle()

    if (error) {
        throw error
    }

    return passkey === (data?.key_value ?? '')
}

async function requireValidPasskey(
    adminClient: ReturnType<typeof createAdminClient>,
    passkey?: string
): Promise<AdminPasskeyAccess> {
    const normalizedPasskey = passkey?.trim() ?? ''
    if (!normalizedPasskey) {
        return { ok: false, response: errorResponse('Admin passkey is required', 403) }
    }

    const valid = await isValidAdminPasskey(adminClient, normalizedPasskey)
    if (!valid) {
        return { ok: false, response: errorResponse('Unauthorized: Invalid admin passkey', 403) }
    }

    return { ok: true, response: null }
}

async function listUsers(adminClient: ReturnType<typeof createAdminClient>) {
    const { data: authData, error: authError } = await adminClient.auth.admin.listUsers({
        page: 1,
        perPage: 1000
    })

    if (authError) {
        return errorResponse(authError.message, 500)
    }

    const { data: profiles, error: profilesError } = await adminClient
        .from('profiles')
        .select('id, name, role, workspace_id')

    if (profilesError) {
        return errorResponse(profilesError.message, 500)
    }

    const { data: workspaces, error: workspacesError } = await adminClient
        .from('workspaces')
        .select('id, name')

    if (workspacesError) {
        return errorResponse(workspacesError.message, 500)
    }

    const [usageResult, branchResult] = await Promise.all([
        adminClient.from('workspace_usage').select('workspace_id, updated_at'),
        adminClient.from('workspace_branches').select('branch_workspace_id, source_workspace_id')
    ])
    const { data: usageRows, error: usageError } = usageResult

    if (usageError) {
        return errorResponse(usageError.message, 500)
    }

    const { data: branchRows, error: branchError } = branchResult

    if (branchError) {
        return errorResponse(branchError.message, 500)
    }

    let workspaceA2cPhones: Map<string, string>
    try {
        workspaceA2cPhones = await getWorkspaceA2cPhones(adminClient)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load workspace audit phones'
        return errorResponse(message, 500)
    }

    const profilesById = new Map<string, { name?: string | null; role?: string | null; workspace_id?: string | null }>()
    for (const profile of profiles ?? []) {
        profilesById.set(String(profile.id), profile)
    }

    const workspaceNamesById = new Map<string, string>()
    for (const workspace of workspaces ?? []) {
        workspaceNamesById.set(String(workspace.id), String(workspace.name))
    }

    const usageUpdatedAtByWorkspaceId = new Map(
        (usageRows ?? []).map((row) => [String(row.workspace_id), String(row.updated_at)])
    )
    const sourceByBranchId = new Map(
        (branchRows ?? []).map((row) => [String(row.branch_workspace_id), String(row.source_workspace_id)])
    )
    const rows = (authData.users ?? []).map((authUser) => {
        const profile = profilesById.get(authUser.id)
        const workspaceId = profile?.workspace_id ?? null
        return {
            id: authUser.id,
            name: profile?.name ?? String(authUser.user_metadata?.name ?? authUser.email ?? 'Unknown'),
            role: profile?.role ?? String(authUser.user_metadata?.role ?? 'viewer'),
            workspace_id: workspaceId,
            workspace_name: workspaceId ? (workspaceNamesById.get(workspaceId) ?? null) : null,
            workspace_a2c_phone: workspaceId ? (workspaceA2cPhones.get(workspaceId) ?? null) : null,
            created_at: authUser.created_at,
            email: authUser.email ?? null,
            phone: authUser.user_metadata?.phone ?? null,
            last_seen_at: workspaceId
                ? (usageUpdatedAtByWorkspaceId.get(resolveWorkspaceUsageOwnerId(workspaceId, sourceByBranchId)) ?? null)
                : null
        }
    })

    return jsonResponse(rows)
}

async function listWorkspaces(adminClient: ReturnType<typeof createAdminClient>) {
    const { data, error } = await adminClient
        .from('workspaces')
        .select('id, name, code, created_at, data_mode, plan, is_configured, locked_workspace, deleted_at, coordination, logo_url, subscription_expires_at')
        .order('created_at', { ascending: false })

    if (error) {
        return errorResponse(error.message, 500)
    }

    const { data: branchRows, error: branchError } = await adminClient
        .from('workspace_branches')
        .select('source_workspace_id, branch_workspace_id, name, archived_at')

    if (branchError) {
        return errorResponse(branchError.message, 500)
    }

    let workspaceA2cPhones: Map<string, string>
    try {
        workspaceA2cPhones = await getWorkspaceA2cPhones(adminClient)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load workspace audit phones'
        return errorResponse(message, 500)
    }

    const workspaceNamesById = new Map(
        (data ?? []).map((workspace) => [String(workspace.id), String(workspace.name)])
    )
    const branchesByWorkspaceId = new Map(
        (branchRows ?? []).map((branch) => [String(branch.branch_workspace_id), branch])
    )

    return jsonResponse((data ?? []).map((workspace) => {
        const branch = branchesByWorkspaceId.get(String(workspace.id))
        return {
            ...workspace,
            a2c_phone: workspaceA2cPhones.get(String(workspace.id)) ?? null,
            is_branch: Boolean(branch),
            source_workspace_id: branch?.source_workspace_id ?? null,
            source_workspace_name: branch?.source_workspace_id
                ? workspaceNamesById.get(String(branch.source_workspace_id)) ?? null
                : null,
            branch_name: branch?.name ?? null,
            branch_archived_at: branch?.archived_at ?? null
        }
    }))
}

async function deleteUser(adminClient: ReturnType<typeof createAdminClient>, body: DeleteUserRequest) {
    const targetUserId = body.targetUserId?.trim() ?? ''
    if (!targetUserId) {
        return errorResponse('Target user is required')
    }

    const { data: profile, error: profileError } = await adminClient
        .from('profiles')
        .select('role, workspace_id')
        .eq('id', targetUserId)
        .maybeSingle()

    if (profileError) {
        return errorResponse(profileError.message, 500)
    }

    if (profile?.role === 'admin' && profile.workspace_id) {
        const { error: workspaceError } = await adminClient
            .from('workspaces')
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', profile.workspace_id)

        if (workspaceError) {
            return errorResponse(workspaceError.message, 500)
        }
    }

    const { error: deleteProfileError } = await adminClient
        .from('profiles')
        .delete()
        .eq('id', targetUserId)

    if (deleteProfileError) {
        return errorResponse(deleteProfileError.message, 500)
    }

    const { error: deleteUserError } = await adminClient.auth.admin.deleteUser(targetUserId)
    if (deleteUserError) {
        return errorResponse(deleteUserError.message, 500)
    }

    return jsonResponse({ success: true })
}

async function updateWorkspaceFeatures(
    adminClient: ReturnType<typeof createAdminClient>,
    body: UpdateWorkspaceFeaturesRequest
) {
    const workspaceId = body.workspaceId?.trim() ?? ''
    if (!workspaceId) {
        return errorResponse('Workspace is required')
    }

    if (
        typeof body.locked_workspace !== 'boolean'
    ) {
        return errorResponse('Workspace feature payload is invalid')
    }

    const { error: statusError } = await adminClient
        .from('workspaces')
        .update({
            locked_workspace: body.locked_workspace,
            // An explicit platform lock/unlock supersedes every automatic
            // reason marker. Later approvals may then clear only locks that
            // the billing/usage services own, never this deliberate lock.
            usage_limit_locked: false,
            payment_renewal_locked: false,
            subscription_expiry_locked: false
        })
        .eq('id', workspaceId)

    if (statusError) {
        return errorResponse(statusError.message, 500)
    }

    return jsonResponse({ success: true })
}

async function updateWorkspaceSubscription(
    adminClient: ReturnType<typeof createAdminClient>,
    body: UpdateWorkspaceSubscriptionRequest
) {
    const workspaceId = body.workspaceId?.trim() ?? ''
    const newExpiry = body.newExpiry?.trim() ?? ''

    if (!workspaceId) {
        return errorResponse('Workspace is required')
    }

    if (!newExpiry) {
        return errorResponse('New expiry date is required')
    }

    const parsedExpiry = new Date(newExpiry)
    if (Number.isNaN(parsedExpiry.getTime())) {
        return errorResponse('Invalid expiry date')
    }

    const { data: usageStatus, error: usageStatusError } = await adminClient
        .rpc('get_workspace_usage_status', { p_workspace_id: workspaceId })
        .maybeSingle()

    if (usageStatusError) {
        return errorResponse(usageStatusError.message, 500)
    }

    const { data: paymentConfigurations, error: paymentConfigurationError } = await adminClient
        .rpc('admin_list_workspace_payment_configurations')

    if (paymentConfigurationError) {
        return errorResponse(paymentConfigurationError.message, 500)
    }

    const typedUsageStatus = usageStatus as WorkspaceUsageStatusRow | null
    const paymentConfiguration = Array.isArray(paymentConfigurations)
        ? paymentConfigurations.find((value: unknown) => (
            typeof value === 'object'
            && value !== null
            && String((value as Record<string, unknown>).workspace_id ?? '') === workspaceId
        )) as Record<string, unknown> | undefined
        : undefined
    const usageEnabled = Boolean(
        typedUsageStatus?.has_limits
        || paymentConfiguration?.usage_enabled === true
    )
    if (usageEnabled) {
        return errorResponse('Usage-based workspaces use Renewal due. Update that deadline instead of the subscription expiry.', 400)
    }

    const subscriptionExpired = parsedExpiry.getTime() < Date.now()
    const update = {
        subscription_expires_at: parsedExpiry.toISOString(),
        locked_workspace: subscriptionExpired,
        usage_limit_locked: false,
        payment_renewal_locked: false,
        subscription_expiry_locked: subscriptionExpired
    }

    const { error } = await adminClient
        .from('workspaces')
        .update(update)
        .eq('id', workspaceId)

    if (error) {
        return errorResponse(error.message, 500)
    }

    return jsonResponse({ success: true, usageEnabled: false })
}

async function listOverrides(
    adminClient: ReturnType<typeof createAdminClient>,
    body: ListOverridesRequest
) {
    const workspaceId = body.workspaceId?.trim() ?? ''
    if (!workspaceId) return errorResponse('Workspace is required')

    const { data, error } = await adminClient
        .from('workspace_access_overrides')
        .select('id, workspace_id, type, key, value, created_by, created_at')
        .eq('workspace_id', workspaceId)
        .order('type', { ascending: true })

    if (error) return errorResponse(error.message, 500)
    return jsonResponse(data ?? [])
}

async function upsertOverride(
    adminClient: ReturnType<typeof createAdminClient>,
    body: UpsertOverrideRequest
) {
    const workspaceId = body.workspaceId?.trim() ?? ''
    const type = body.type?.trim() ?? ''
    const key = body.key?.trim() ?? ''

    if (!workspaceId || !type || !key) {
        return errorResponse('workspaceId, type, and key are required')
    }

    if (!['module', 'capability', 'currency', 'limit'].includes(type)) {
        return errorResponse('Invalid type. Must be module, capability, currency, or limit')
    }

    const { data, error } = await adminClient
        .from('workspace_access_overrides')
        .upsert({
            workspace_id: workspaceId,
            type,
            key,
            value: body.value ?? null
        }, { onConflict: 'workspace_id,type,key' })
        .select('id, workspace_id, type, key, value, created_by, created_at')
        .maybeSingle()

    if (error) return errorResponse(error.message, 500)
    return jsonResponse(data ?? {})
}

async function deleteOverride(
    adminClient: ReturnType<typeof createAdminClient>,
    body: DeleteOverrideRequest
) {
    const overrideId = body.overrideId?.trim() ?? ''
    if (!overrideId) return errorResponse('overrideId is required')

    const { error } = await adminClient
        .from('workspace_access_overrides')
        .delete()
        .eq('id', overrideId)

    if (error) return errorResponse(error.message, 500)
    return jsonResponse({ success: true })
}

async function getLimitedWorkspaceIds(adminClient: ReturnType<typeof createAdminClient>) {
    const { data, error } = await adminClient
        .from('workspace_usage_limits')
        .select('workspace_id')

    if (error) {
        throw error
    }

    const workspaceIds = (data ?? []).map((row) => String(row.workspace_id))
    if (workspaceIds.length === 0) {
        return []
    }

    const { data: branchRows, error: branchError } = await adminClient
        .from('workspace_branches')
        .select('branch_workspace_id, source_workspace_id')
        .in('branch_workspace_id', workspaceIds)

    if (branchError) {
        throw branchError
    }

    const sourceByBranchId = new Map(
        (branchRows ?? []).map((row) => [String(row.branch_workspace_id), String(row.source_workspace_id)])
    )

    return Array.from(new Set(workspaceIds.map((workspaceId) => sourceByBranchId.get(workspaceId) ?? workspaceId)))
}

async function resolveUsageOwnerWorkspaceId(
    adminClient: ReturnType<typeof createAdminClient>,
    workspaceId: string
) {
    // Use the database's recursive, cycle-safe resolver. A one-hop lookup can
    // leave root usage rows untouched when an admin targets a nested branch.
    const { data, error } = await adminClient.rpc('workspace_usage_owner_id', {
        p_workspace_id: workspaceId
    })

    if (error) {
        throw error
    }

    return data ? String(data) : workspaceId
}

async function syncWorkspaceUsagePeriod(
    adminClient: ReturnType<typeof createAdminClient>,
    limitedWorkspaceIds: string[]
) {
    if (limitedWorkspaceIds.length === 0) {
        const { error: deleteAllError } = await adminClient
            .from('workspace_usage')
            .delete()
            .gte('storage_units', '0')

        if (deleteAllError) {
            throw deleteAllError
        }

        return
    }

    const { error: cleanupError } = await adminClient
        .from('workspace_usage')
        .delete()
        .not('workspace_id', 'in', `(${limitedWorkspaceIds.join(',')})`)

    if (cleanupError) {
        throw cleanupError
    }

    const { error: syncError } = await adminClient.rpc('sync_workspace_usage_periods')
    if (syncError) {
        throw syncError
    }
}

async function listWorkspaceUsage(adminClient: ReturnType<typeof createAdminClient>) {
    try {
        const limitedWorkspaceIds = await getLimitedWorkspaceIds(adminClient)
        await syncWorkspaceUsagePeriod(adminClient, limitedWorkspaceIds)

        if (limitedWorkspaceIds.length === 0) {
            return jsonResponse([])
        }

        const { data: usageRows, error: usageError } = await adminClient
            .from('workspace_usage')
            .select('workspace_id, storage_units, data_transfer_bytes, transfer_period_start, storage_updated_at, transfer_updated_at, updated_at')
            .in('workspace_id', limitedWorkspaceIds)

        if (usageError) {
            return errorResponse(usageError.message, 500)
        }

        const { data: limitRows, error: limitError } = await adminClient
            .from('workspace_usage_limits')
            .select('workspace_id, storage_unit_limit, monthly_data_transfer_limit_bytes, notes, created_at, updated_at')
            .in('workspace_id', limitedWorkspaceIds)

        if (limitError) {
            return errorResponse(limitError.message, 500)
        }

        const usageByWorkspaceId = new Map((usageRows ?? []).map((row) => [String(row.workspace_id), row]))
        const limitsByWorkspaceId = new Map((limitRows ?? []).map((row) => [String(row.workspace_id), row]))
        return jsonResponse(limitedWorkspaceIds.map((workspaceId) => {
            const usage = usageByWorkspaceId.get(workspaceId)
            const limits = limitsByWorkspaceId.get(workspaceId)
            const chargedUsageBytes = String(usage?.data_transfer_bytes ?? 0)
            const monthlyChargedUsageLimitBytes = limits?.monthly_data_transfer_limit_bytes === null
                || limits?.monthly_data_transfer_limit_bytes === undefined
                ? null
                : String(limits.monthly_data_transfer_limit_bytes)

            return {
                workspace_id: workspaceId,
                storage_units: String(usage?.storage_units ?? 0),
                charged_usage_bytes: chargedUsageBytes,
                transfer_period_start: String(usage?.transfer_period_start ?? currentUsagePeriodStart()),
                storage_updated_at: usage?.storage_updated_at ?? null,
                transfer_updated_at: usage?.transfer_updated_at ?? null,
                updated_at: usage?.updated_at ?? null,
                has_limits: Boolean(limits),
                storage_unit_limit: limits?.storage_unit_limit === null || limits?.storage_unit_limit === undefined
                    ? null
                    : String(limits.storage_unit_limit),
                monthly_charged_usage_limit_bytes: monthlyChargedUsageLimitBytes,
                // Deprecated response alias for the charged-usage allowance.
                monthly_data_transfer_limit_bytes: monthlyChargedUsageLimitBytes,
                notes: limits?.notes ?? null,
                limits_created_at: limits?.created_at ?? null,
                limits_updated_at: limits?.updated_at ?? null
            }
        }))
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to list workspace usage'
        return errorResponse(message, 500)
    }
}

async function updateWorkspaceUsage(
    adminClient: ReturnType<typeof createAdminClient>,
    body: UpdateWorkspaceUsageRequest
) {
    const workspaceId = body.workspaceId?.trim() ?? ''
    if (!workspaceId) {
        return errorResponse('Workspace is required')
    }

    const { data: workspace, error: workspaceError } = await adminClient
        .from('workspaces')
        .select('id')
        .eq('id', workspaceId)
        .maybeSingle()

    if (workspaceError) {
        return errorResponse(workspaceError.message, 500)
    }

    if (!workspace) {
        return errorResponse('Workspace not found', 404)
    }

    let usageWorkspaceId = workspaceId
    try {
        usageWorkspaceId = await resolveUsageOwnerWorkspaceId(adminClient, workspaceId)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to resolve usage workspace'
        return errorResponse(message, 500)
    }

    const storageUnits = normalizeNullableBigint(body.storageUnits, 'Storage usage')
    const chargedUsageBytes = normalizeNullableBigint(body.chargedUsageBytes, 'Monthly charged usage')
    const storageUnitLimit = normalizeNullableBigint(body.storageUnitLimit, 'Storage limit')
    const monthlyChargedUsageLimitBytes = resolveNullableBigintAlias(
        body.monthlyChargedUsageLimitBytes,
        body.monthlyDataTransferLimitBytes,
        'Monthly charged usage limit',
        'Deprecated monthlyDataTransferLimitBytes'
    )
    const periodStart = normalizeUsagePeriodStart(body.transferPeriodStart)

    const validationError = storageUnits.error
        ?? chargedUsageBytes.error
        ?? storageUnitLimit.error
        ?? monthlyChargedUsageLimitBytes.error
        ?? periodStart.error

    if (validationError) {
        return errorResponse(validationError)
    }

    if (storageUnits.value === null) {
        return errorResponse('Storage usage counter is required')
    }

    // A manual edit replaces the one charged-total counter. It intentionally
    // does not try to reverse an in-flight request rate.
    const reconciledTransfer = reconcileChargedUsage(chargedUsageBytes.value)
    if (reconciledTransfer.error) {
        return errorResponse(reconciledTransfer.error)
    }

    const now = new Date().toISOString()
    const notes = typeof body.notes === 'string' && body.notes.trim()
        ? body.notes.trim().slice(0, 500)
        : null

    if (storageUnitLimit.value === null && monthlyChargedUsageLimitBytes.value === null) {
        const { error: usageDeleteError } = await adminClient
            .from('workspace_usage')
            .delete()
            .eq('workspace_id', usageWorkspaceId)

        if (usageDeleteError) {
            return errorResponse(usageDeleteError.message, 500)
        }

        const { error } = await adminClient
            .from('workspace_usage_limits')
            .delete()
            .eq('workspace_id', usageWorkspaceId)

        if (error) {
            return errorResponse(error.message, 500)
        }
    } else {
        const { error: limitsError } = await adminClient
            .from('workspace_usage_limits')
            .upsert({
                workspace_id: usageWorkspaceId,
                storage_unit_limit: storageUnitLimit.value,
                // This legacy-named database column stores the CHARGED allowance.
                monthly_data_transfer_limit_bytes: monthlyChargedUsageLimitBytes.value,
                notes
            }, { onConflict: 'workspace_id' })

        if (limitsError) {
            return errorResponse(limitsError.message, 500)
        }

        // The database owns the cycle boundary. This intentionally ignores a
        // stale Admin UI period (for example, a workspace that resets on the
        // 14th rather than the first day of a month).
        const { data: usageStatus, error: usageStatusError } = await adminClient
            .rpc('get_workspace_usage_status', { p_workspace_id: usageWorkspaceId })
            .maybeSingle()

        if (usageStatusError) {
            return errorResponse(usageStatusError.message, 500)
        }

        const typedUsageStatus = usageStatus as WorkspaceUsageStatusRow | null
        const effectivePeriodStart = typeof typedUsageStatus?.transfer_period_start === 'string'
            ? typedUsageStatus.transfer_period_start
            : periodStart.value

        const { error: usageError } = await adminClient
            .from('workspace_usage')
            .upsert({
                workspace_id: usageWorkspaceId,
                storage_units: storageUnits.value,
                // This schema-level name stores the one canonical charged total.
                data_transfer_bytes: reconciledTransfer.chargedValue,
                transfer_period_start: effectivePeriodStart,
                storage_updated_at: now,
                transfer_updated_at: now,
                updated_at: now
            }, { onConflict: 'workspace_id' })

        if (usageError) {
            return errorResponse(usageError.message, 500)
        }
    }

    return jsonResponse({ success: true })
}

async function refreshWorkspaceUsage(
    adminClient: ReturnType<typeof createAdminClient>,
    body: RefreshWorkspaceUsageRequest
) {
    const requestedWorkspaceId = body.workspaceId?.trim() || null
    let workspaceId = requestedWorkspaceId

    if (requestedWorkspaceId) {
        try {
            workspaceId = await resolveUsageOwnerWorkspaceId(adminClient, requestedWorkspaceId)
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to resolve usage workspace'
            return errorResponse(message, 500)
        }
    }

    const { error } = await adminClient.rpc('refresh_workspace_storage_usage', {
        p_workspace_id: workspaceId
    })

    if (error) {
        return errorResponse(error.message, 500)
    }

    try {
        await syncWorkspaceUsagePeriod(adminClient, await getLimitedWorkspaceIds(adminClient))
    } catch (syncError) {
        const message = syncError instanceof Error ? syncError.message : 'Failed to sync usage period'
        return errorResponse(message, 500)
    }

    return jsonResponse({ success: true })
}

async function grantWorkspaceFreeUsage(
    adminClient: ReturnType<typeof createAdminClient>,
    body: GrantWorkspaceFreeUsageRequest
) {
    const workspaceId = body.workspaceId?.trim() ?? ''
    if (!UUID_PATTERN.test(workspaceId)) {
        return errorResponse('A valid workspace is required')
    }

    const { data: billingRows, error: billingError } = await adminClient.rpc(
        'admin_list_workspace_payment_configurations_v2'
    )
    if (billingError) return errorResponse(billingError.message, 400)
    const billingRow = Array.isArray(billingRows)
        ? billingRows.find((row) => String(row.workspace_id) === workspaceId)
        : null
    if (billingRow?.payg_enabled) {
        return errorResponse('Free usage cannot change the authoritative PAYG counter', 400)
    }

    const grantedBytes = normalizePositiveGbToBytes(body.gbAmount)
    if (grantedBytes.error) {
        return errorResponse(grantedBytes.error)
    }

    const { data, error } = await adminClient.rpc('admin_grant_workspace_free_usage', {
        p_workspace_id: workspaceId,
        p_granted_bytes: grantedBytes.value
    })

    if (error) {
        return errorResponse(error.message, 400)
    }

    return jsonResponse(Array.isArray(data) ? data[0] ?? { success: true } : data ?? { success: true })
}

async function sendWorkspaceAdminMessage(
    adminClient: ReturnType<typeof createAdminClient>,
    body: SendWorkspaceAdminMessageRequest
) {
    const workspaceId = body.workspaceId?.trim() ?? ''
    if (!UUID_PATTERN.test(workspaceId)) {
        return errorResponse('A valid workspace is required')
    }

    const message = normalizeOptionalText(body.message, 'Message', 2000)
    if (message.error) {
        return errorResponse(message.error)
    }
    if (!message.value) {
        return errorResponse('Message is required')
    }

    const { data, error } = await adminClient.rpc('admin_send_workspace_message', {
        p_workspace_id: workspaceId,
        p_message: message.value
    })

    if (error) {
        return errorResponse(error.message, 400)
    }

    return jsonResponse(Array.isArray(data) ? data[0] ?? { success: true } : data ?? { success: true })
}

async function listWorkspacePaymentConfigurations(
    adminClient: ReturnType<typeof createAdminClient>
) {
    const { data, error } = await adminClient.rpc('admin_list_workspace_payment_configurations_v2')

    if (error) {
        return errorResponse(error.message, 500)
    }

    try {
        const workspaceA2cPhones = await getWorkspaceA2cPhones(adminClient)
        const rows = Array.isArray(data) ? data as Array<Record<string, unknown>> : []
        return jsonResponse(rows.map((row) => ({
            ...row,
            a2c_phone: workspaceA2cPhones.get(String(row.workspace_id)) ?? null
        })))
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load workspace audit phones'
        return errorResponse(message, 500)
    }
}

async function upsertWorkspacePaymentConfiguration(
    adminClient: ReturnType<typeof createAdminClient>,
    body: UpsertWorkspacePaymentConfigurationRequest
) {
    const workspaceId = body.workspaceId?.trim() ?? ''
    if (!UUID_PATTERN.test(workspaceId)) {
        console.error('upsert error: invalid workspace id')
        return errorResponse('A valid workspace is required')
    }

    if (
        typeof body.isPaymentEnabled !== 'boolean'
        || typeof body.usageEnabled !== 'boolean'
        || typeof body.paygEnabled !== 'boolean'
    ) {
        console.error('upsert error: boolean type check failed (rpc path)')
        return errorResponse('Payments, prepaid usage, and PAYG must be true or false')
    }
    if (body.paygEnabled && body.usageEnabled) {
        return errorResponse('PAYG and prepaid usage are exclusive')
    }
    const paygProfileId = body.paygProfileId?.trim() ?? ''
    if (body.paygEnabled && (!paygProfileId || !UUID_PATTERN.test(paygProfileId))) {
        return errorResponse('A valid PAYG profile is required')
    }
    if (body.paygProfileChangeTiming && body.paygProfileChangeTiming !== 'next_cycle' && body.paygProfileChangeTiming !== 'immediate') {
        return errorResponse('PAYG profile timing must be next_cycle or immediate')
    }
    if ((body.paygEnabled || body.usageEnabled) && !body.renewalDueAt) {
        return errorResponse('Renewal due is required for PAYG and prepaid usage')
    }

    const amount = normalizePaymentDecimal(body.subscriptionAmount, 'Subscription amount', {
        positive: false,
        maximumDecimalPlaces: 3,
        maximumWholeDigits: 17
    })
    if (amount.error) {
        console.error('upsert error: amount validation:', amount.error)
        return errorResponse(amount.error)
    }

    const gbPerPayment = normalizePaymentDecimal(body.gbPerPayment, 'GB per payment', {
        positive: false,
        maximumDecimalPlaces: 6,
        maximumWholeDigits: 8
    })
    if (gbPerPayment.error) {
        console.error('upsert error: gb validation:', gbPerPayment.error)
        return errorResponse(gbPerPayment.error)
    }

    console.log('upsert params:', JSON.stringify({
        p_workspace_id: workspaceId,
        p_subscription_amount: amount.value,
        p_is_payment_enabled: body.isPaymentEnabled,
        p_usage_enabled: body.usageEnabled,
        p_payg_enabled: body.paygEnabled,
        p_payg_profile_id: body.paygEnabled ? paygProfileId : null,
        p_payg_profile_change_timing: body.paygProfileChangeTiming ?? 'next_cycle',
        p_gb_per_payment: gbPerPayment.value,
        p_usage_start_date: body.usageStartDate ?? null,
        p_renewal_due_at: body.renewalDueAt ?? null
    }))

    const rpcParams: Record<string, unknown> = {
        p_workspace_id: workspaceId,
        p_subscription_amount: amount.value,
        p_is_payment_enabled: body.isPaymentEnabled,
        p_usage_enabled: body.usageEnabled,
        p_payg_enabled: body.paygEnabled,
        p_gb_per_payment: gbPerPayment.value,
        p_renewal_due_at: body.renewalDueAt || null,
        p_actor: 'admin-console-passkey',
        p_usage_start_date: body.usageStartDate || null,
        p_payg_profile_id: body.paygEnabled ? paygProfileId : null,
        p_payg_profile_change_timing: body.paygProfileChangeTiming ?? 'next_cycle'
    }

    rpcParams.p_billing_interval = body.billingInterval ?? 'monthly'

    const { data, error } = await adminClient.rpc('admin_upsert_workspace_payment_configuration_v3', rpcParams)

    if (error) {
        console.error('RPC error:', JSON.stringify({ message: error.message, code: error.code, details: error.details, hint: error.hint }))
        return errorResponse(error.message || 'Unknown RPC error', 400, {
            code: error.code,
            details: error.details,
            hint: error.hint
        })
    }

    return jsonResponse(data)
}

async function terminateWorkspacePayg(
    adminClient: ReturnType<typeof createAdminClient>,
    body: TerminateWorkspacePaygRequest
) {
    const workspaceId = body.workspaceId?.trim() ?? ''
    if (!UUID_PATTERN.test(workspaceId)) {
        return errorResponse('A valid workspace is required')
    }

    const { data, error } = await adminClient.rpc('admin_terminate_workspace_payg', {
        p_workspace_id: workspaceId,
        p_actor: 'admin-console-passkey'
    })

    if (error) {
        return errorResponse(error.message || 'Failed to terminate PAYG', 400, {
            code: error.code,
            details: error.details,
            hint: error.hint
        })
    }

    return jsonResponse(data)
}

async function activateWorkspacePrepaidTerm(
    adminClient: ReturnType<typeof createAdminClient>,
    body: ActivateWorkspacePrepaidTermRequest
) {
    const workspaceId = body.workspaceId?.trim() ?? ''
    if (!UUID_PATTERN.test(workspaceId)) {
        return errorResponse('A valid workspace is required')
    }

    const monthlyListPrice = normalizePaymentDecimal(body.monthlyListPrice, 'Monthly list price', {
        positive: true,
        maximumDecimalPlaces: 3,
        maximumWholeDigits: 17
    })
    if (monthlyListPrice.error) return errorResponse(monthlyListPrice.error)

    const monthlyAllowanceGb = normalizePaymentDecimal(body.monthlyAllowanceGb, 'Monthly allowance', {
        positive: true,
        maximumDecimalPlaces: 6,
        maximumWholeDigits: 8
    })
    if (monthlyAllowanceGb.error) return errorResponse(monthlyAllowanceGb.error)

    const amountPaid = normalizePaymentDecimal(body.amountPaid, 'Amount paid', {
        positive: true,
        maximumDecimalPlaces: 3,
        maximumWholeDigits: 17
    })
    if (amountPaid.error) return errorResponse(amountPaid.error)

    const prepaidCycles = body.prepaidCycles
    if (typeof prepaidCycles !== 'number' || !Number.isInteger(prepaidCycles) || prepaidCycles < 1 || prepaidCycles > 120) {
        return errorResponse('Prepaid cycles must be a whole number between 1 and 120')
    }

    const prepaidAllowanceMode = body.prepaidAllowanceMode ?? 'term_pool'
    if (prepaidAllowanceMode !== 'monthly_reset' && prepaidAllowanceMode !== 'term_pool') {
        return errorResponse('Choose a valid prepaid allowance mode')
    }

    const termStartedAt = body.termStartedAt?.trim() ?? ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(termStartedAt) || Number.isNaN(Date.parse(`${termStartedAt}T00:00:00Z`))) {
        return errorResponse('A valid prepaid term start date is required')
    }

    if (body.replaceExistingTerm !== undefined && typeof body.replaceExistingTerm !== 'boolean') {
        return errorResponse('Replace existing term must be true or false')
    }
    const replaceExistingTerm = body.replaceExistingTerm === true
    const expectedTransactionId = body.expectedTransactionId?.trim() || null
    if (replaceExistingTerm && (!expectedTransactionId || !UUID_PATTERN.test(expectedTransactionId))) {
        return errorResponse('The current approved term is required for replacement')
    }

    const { data, error } = await adminClient.rpc('admin_activate_workspace_prepaid_term_v3', {
        p_workspace_id: workspaceId,
        p_monthly_list_price: monthlyListPrice.value,
        p_monthly_allowance_gb: monthlyAllowanceGb.value,
        p_prepaid_cycles: prepaidCycles,
        p_amount_paid: amountPaid.value,
        p_term_started_at: termStartedAt,
        p_prepaid_allowance_mode: prepaidAllowanceMode,
        p_replace_existing_term: replaceExistingTerm,
        p_expected_transaction_id: expectedTransactionId,
        p_actor: 'admin-console-passkey'
    })

    if (error) {
        return errorResponse(error.message || 'Failed to activate prepaid term', 400, {
            code: error.code,
            details: error.details,
            hint: error.hint
        })
    }

    return jsonResponse(data)
}

async function getPaygPricingSchedule(adminClient: ReturnType<typeof createAdminClient>) {
    const { data, error } = await adminClient.rpc('admin_get_payg_pricing_schedule')
    if (error) return errorResponse(error.message, 500)
    return jsonResponse(data)
}

async function publishPaygPricingSchedule(
    adminClient: ReturnType<typeof createAdminClient>,
    body: PublishPaygPricingScheduleRequest
) {
    if (!Array.isArray(body.checkpoints)) return errorResponse('Pricing checkpoints are required')
    const checkpoints = body.checkpoints.map((checkpoint) => ({
        gb: checkpoint.gb,
        amount_iqd: checkpoint.amountIqd
    }))
    const { data, error } = await adminClient.rpc('admin_publish_payg_pricing_schedule', {
        p_checkpoints: checkpoints,
        p_actor: 'admin-console-passkey'
    })
    if (error) return errorResponse(error.message, 400)
    return jsonResponse(data)
}

async function listPaygProfiles(adminClient: ReturnType<typeof createAdminClient>) {
    const { data, error } = await adminClient.rpc('admin_list_payg_profiles')
    if (error) return errorResponse(error.message, 500)
    return jsonResponse(data)
}

async function createPaygProfile(
    adminClient: ReturnType<typeof createAdminClient>,
    body: CreatePaygProfileRequest,
) {
    const name = body.name?.trim() ?? ''
    if (!name) return errorResponse('A PAYG profile name is required')
    if (!Array.isArray(body.checkpoints)) return errorResponse('Pricing checkpoints are required')
    const checkpoints = body.checkpoints.map((checkpoint) => ({
        gb: checkpoint.gb,
        amount_iqd: checkpoint.amountIqd,
    }))
    const { data, error } = await adminClient.rpc('admin_create_payg_profile', {
        p_name: name,
        p_checkpoints: checkpoints,
        p_actor: 'admin-console-passkey',
    })
    if (error) return errorResponse(error.message, 400)
    return jsonResponse(data)
}

async function listWorkspacePaymentTransactions(
    adminClient: ReturnType<typeof createAdminClient>,
    body: ListWorkspacePaymentTransactionsRequest
) {
    const status = body.status?.trim().toLowerCase() || null
    if (status && !PAYMENT_TRANSACTION_STATUSES.has(status)) {
        return errorResponse('Unsupported payment transaction status')
    }

    const { data, error } = await adminClient.rpc('admin_list_workspace_payment_transactions_v2', {
        p_status: status
    })

    if (error) {
        return errorResponse(error.message, 500)
    }

    return jsonResponse(data ?? [])
}

async function reviewWorkspacePaymentTransaction(
    adminClient: ReturnType<typeof createAdminClient>,
    body: ReviewWorkspacePaymentTransactionRequest
) {
    const transactionId = body.transactionId?.trim() ?? ''
    if (!UUID_PATTERN.test(transactionId)) {
        return errorResponse('A valid payment transaction is required')
    }

    if (body.decision !== 'approved' && body.decision !== 'rejected') {
        return errorResponse('Decision must be approved or rejected')
    }

    const reviewerLabel = normalizeOptionalText(body.reviewerLabel, 'Reviewer name', 120)
    if (reviewerLabel.error || !reviewerLabel.value) {
        return errorResponse(reviewerLabel.error ?? 'Reviewer name is required')
    }

    const note = normalizeOptionalText(body.note, 'Review note', 2000)
    if (note.error) {
        return errorResponse(note.error)
    }

    const providerPaymentId = normalizeOptionalText(body.providerPaymentId, 'Provider payment ID', 255)
    if (providerPaymentId.error) {
        return errorResponse(providerPaymentId.error)
    }

    const { data, error } = await adminClient.rpc('admin_review_workspace_payment_transaction_v2', {
        p_transaction_id: transactionId,
        p_decision: body.decision,
        p_note: note.value,
        p_reviewer_label: reviewerLabel.value,
        p_provider_payment_id: providerPaymentId.value
    })

    if (error) {
        console.error('reviewWorkspacePaymentTransaction RPC error:', JSON.stringify({ message: error.message, details: error.details, hint: error.hint, code: error.code }))
        const isConflict = /already|no longer pending|expired/i.test(error.message)
        return errorResponse(error.message, isConflict ? 409 : 400)
    }

    return jsonResponse(data)
}

Deno.serve(async (req) => {
    console.log('admin-console invoked:', req.method, req.url)

    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    if (req.method !== 'POST') {
        return errorResponse('Method not allowed', 405)
    }

    const body = await readJson<AdminConsoleRequest>(req)
    if (!body?.action) {
        return errorResponse('Invalid request body')
    }

    try {
        const adminClient = createAdminClient()

        if (body.action === 'verify') {
            const valid = await isValidAdminPasskey(adminClient, body.passkey?.trim() ?? '')
            return jsonResponse({ valid })
        }

        const access = await requireValidPasskey(adminClient, body.passkey)
        if (!access.ok) {
            return access.response
        }

        if (body.action === 'listUsers') {
            return await listUsers(adminClient)
        }

        if (body.action === 'listWorkspaces') {
            return await listWorkspaces(adminClient)
        }

        if (body.action === 'deleteUser') {
            return await deleteUser(adminClient, body)
        }

        if (body.action === 'updateWorkspaceFeatures') {
            return await updateWorkspaceFeatures(adminClient, body)
        }

        if (body.action === 'updateWorkspaceSubscription') {
            return await updateWorkspaceSubscription(adminClient, body)
        }

        if (body.action === 'listOverrides') {
            return await listOverrides(adminClient, body)
        }

        if (body.action === 'upsertOverride') {
            return await upsertOverride(adminClient, body)
        }

        if (body.action === 'deleteOverride') {
            return await deleteOverride(adminClient, body)
        }

        if (body.action === 'listWorkspaceUsage') {
            return await listWorkspaceUsage(adminClient)
        }

        if (body.action === 'updateWorkspaceUsage') {
            return await updateWorkspaceUsage(adminClient, body)
        }

        if (body.action === 'refreshWorkspaceUsage') {
            return await refreshWorkspaceUsage(adminClient, body)
        }

        if (body.action === 'grantWorkspaceFreeUsage') {
            return await grantWorkspaceFreeUsage(adminClient, body)
        }

        if (body.action === 'sendWorkspaceAdminMessage') {
            return await sendWorkspaceAdminMessage(adminClient, body)
        }

        if (body.action === 'listWorkspacePaymentConfigurations') {
            return await listWorkspacePaymentConfigurations(adminClient)
        }

        if (body.action === 'upsertWorkspacePaymentConfiguration') {
            return await upsertWorkspacePaymentConfiguration(adminClient, body)
        }

        if (body.action === 'terminateWorkspacePayg') {
            return await terminateWorkspacePayg(adminClient, body)
        }

        if (body.action === 'activateWorkspacePrepaidTerm') {
            return await activateWorkspacePrepaidTerm(adminClient, body)
        }

        if (body.action === 'getPaygPricingSchedule') {
            return await getPaygPricingSchedule(adminClient)
        }

        if (body.action === 'publishPaygPricingSchedule') {
            return await publishPaygPricingSchedule(adminClient, body)
        }

        if (body.action === 'listPaygProfiles') {
            return await listPaygProfiles(adminClient)
        }

        if (body.action === 'createPaygProfile') {
            return await createPaygProfile(adminClient, body)
        }

        if (body.action === 'listWorkspacePaymentTransactions') {
            return await listWorkspacePaymentTransactions(adminClient, body)
        }

        if (body.action === 'reviewWorkspacePaymentTransaction') {
            return await reviewWorkspacePaymentTransaction(adminClient, body)
        }

        return errorResponse('Unsupported action', 400)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error'
        return errorResponse(message, 500)
    }
})
