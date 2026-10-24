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
    merchant?: { mode: 'join'; code: string } | { mode: 'create'; name: string }
}

export type WorkspaceAccountCreationContext =
    | { type: 'staff' }
    | {
          type: 'postalMerchant'
          organizationMode: 'join' | 'create' | ''
          organizationValue: string
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
    values: WorkspaceAccountCreationFormValues,
): WorkspaceAccountCreationValidationError | null {
    if (!values.name.trim() || values.name.trim().length > 120)
        return 'nameRequired'

    const email = normalizeWorkspaceAccountEmail(values.email)
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) return 'emailInvalid'

    if (values.password.length < 8) return 'passwordTooShort'
    if (values.password.length > 128) return 'passwordTooLong'
    if (values.password !== values.confirmPassword) return 'passwordsMismatch'

    return null
}

export function buildWorkspaceAccountCreationRequest(
    values: WorkspaceAccountCreationFormValues,
    context: WorkspaceAccountCreationContext = { type: 'staff' },
): WorkspaceAccountCreationRequest | null {
    if (validateWorkspaceAccountCreationForm(values)) {
        return null
    }

    const request: WorkspaceAccountCreationRequest = {
        name: values.name.trim(),
        email: normalizeWorkspaceAccountEmail(values.email),
        password: values.password,
    }
    if (context.type === 'postalMerchant') {
        if (context.organizationMode === 'join') {
            const code = context.organizationValue
                .trim()
                .replace(/-/g, '')
                .toUpperCase()
            if (!/^[A-Z0-9]{8}$/.test(code)) return null
            request.merchant = { mode: 'join', code }
        } else if (context.organizationMode === 'create') {
            const name = context.organizationValue.trim()
            if (!name || name.length > 120) return null
            request.merchant = { mode: 'create', name }
        } else {
            return null
        }
    }
    return request
}

export function getWorkspaceAccountCreationErrorKey(code: string | undefined) {
    switch (code) {
        case 'invalid_organization':
            return 'postal.errors.organization'
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
