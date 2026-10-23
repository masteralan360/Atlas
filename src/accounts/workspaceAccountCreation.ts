export interface WorkspaceAccountCreationFormValues {
    name: string
    email: string
    password: string
    confirmPassword: string
}

export interface WorkspaceAccountCreationRequest {
    name: string
    email: string
    password: string
}

export type WorkspaceAccountCreationValidationError =
    | 'nameRequired'
    | 'emailInvalid'
    | 'passwordTooShort'
    | 'passwordTooLong'
    | 'passwordsMismatch'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeWorkspaceAccountEmail(email: string) {
    return email.trim().toLowerCase()
}

export function validateWorkspaceAccountCreationForm(
    values: WorkspaceAccountCreationFormValues
): WorkspaceAccountCreationValidationError | null {
    if (!values.name.trim() || values.name.trim().length > 120) return 'nameRequired'

    const email = normalizeWorkspaceAccountEmail(values.email)
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) return 'emailInvalid'

    if (values.password.length < 8) return 'passwordTooShort'
    if (values.password.length > 128) return 'passwordTooLong'
    if (values.password !== values.confirmPassword) return 'passwordsMismatch'

    return null
}

export function buildWorkspaceAccountCreationRequest(
    values: WorkspaceAccountCreationFormValues
): WorkspaceAccountCreationRequest | null {
    if (validateWorkspaceAccountCreationForm(values)) {
        return null
    }

    return {
        name: values.name.trim(),
        email: normalizeWorkspaceAccountEmail(values.email),
        password: values.password
    }
}

export function getWorkspaceAccountCreationErrorKey(code: string | undefined) {
    switch (code) {
        case 'duplicate_email':
            return 'workspaceAccountCreation.errors.duplicateEmail'
        case 'member_limit_reached':
            return 'workspaceAccountCreation.errors.memberLimit'
        case 'not_authorized':
        case 'authentication_required':
            return 'workspaceAccountCreation.errors.notAuthorized'
        case 'workspace_unavailable':
            return 'workspaceAccountCreation.errors.workspaceUnavailable'
        case 'invalid_request':
            return 'workspaceAccountCreation.errors.invalidRequest'
        case 'invalid_password':
            return 'workspaceAccountCreation.errors.invalidPassword'
        default:
            return 'workspaceAccountCreation.errors.createFailed'
    }
}
