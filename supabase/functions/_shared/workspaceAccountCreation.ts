export interface CreateWorkspaceAccountInput {
    email: string
    name: string
    password: string
    merchant?: { mode: 'join'; code: string } | { mode: 'create'; name: string; phone: string }
    coach?: { agentTypeId: string }
}

export interface WorkspaceAccountCreationAuthorizationInput {
    callerRole: string | null | undefined
    workspaceId: string | null | undefined
    workspaceDataMode: string | null | undefined
    workspaceDeleted: boolean
}

export function buildWorkspaceAccountUserMetadata(name: string, workspaceId: string) {
    return { name, role: 'staff' as const, workspace_id: workspaceId }
}

export function buildWorkspaceAccountProfile(userId: string, name: string, workspaceId: string) {
    return {
        id: userId,
        name,
        role: 'staff' as const,
        workspace_id: workspaceId,
        current_workspace: workspaceId
    }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseCreateWorkspaceAccountInput(body: unknown): CreateWorkspaceAccountInput | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    const values = body as Record<string, unknown>
    if (typeof values.email !== 'string' || typeof values.name !== 'string' || typeof values.password !== 'string') {
        return null
    }

    const email = values.email.trim().toLowerCase()
    const name = values.name.trim()
    if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) return null
    if (!name || name.length > 120 || values.password.length < 8 || values.password.length > 128) return null

    // Only identity fields are returned. Any client-supplied workspace or role
    // is deliberately discarded so the caller cannot choose either value.
    let merchant: CreateWorkspaceAccountInput['merchant']
    let coach: CreateWorkspaceAccountInput['coach']
    if (values.merchant !== undefined) {
        if (!values.merchant || typeof values.merchant !== 'object' || Array.isArray(values.merchant)) return null
        const enrollment = values.merchant as Record<string, unknown>
        if (enrollment.mode === 'join' && typeof enrollment.code === 'string') {
            const code = enrollment.code.trim().replace(/-/g, '').toUpperCase()
            if (!/^[A-Z0-9]{8}$/.test(code)) return null
            merchant = { mode: 'join', code }
        } else if (
            enrollment.mode === 'create'
            && typeof enrollment.name === 'string'
            && enrollment.name.trim().length > 0
            && enrollment.name.trim().length <= 120
            && typeof enrollment.phone === 'string'
            && enrollment.phone.trim().length > 0
            && enrollment.phone.trim().length <= 32
        ) {
            merchant = {
                mode: 'create',
                name: enrollment.name.trim(),
                phone: enrollment.phone.trim()
            }
        } else return null
    }
    if (values.coach !== undefined) {
        if (merchant || !values.coach || typeof values.coach !== 'object' || Array.isArray(values.coach)) return null
        const coachInput = values.coach as Record<string, unknown>
        if (typeof coachInput.agentTypeId !== 'string' || !UUID_PATTERN.test(coachInput.agentTypeId.trim())) return null
        coach = { agentTypeId: coachInput.agentTypeId.trim() }
    }
    return { email, name, password: values.password, ...(merchant ? { merchant } : {}), ...(coach ? { coach } : {}) }
}

export function getWorkspaceAccountCreationAuthorizationError(
    input: WorkspaceAccountCreationAuthorizationInput
) {
    if (input.callerRole !== 'admin' || !input.workspaceId) return 'not_authorized'
    if (
        input.workspaceDeleted
        || (input.workspaceDataMode !== 'cloud' && input.workspaceDataMode !== 'hybrid')
    ) return 'workspace_unavailable'
    return null
}
