export interface CreateWorkspaceAccountInput {
    email: string
    name: string
    password: string
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
    return { email, name, password: values.password }
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
