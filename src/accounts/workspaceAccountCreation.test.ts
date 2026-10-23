import { describe, expect, it } from 'vitest'
import {
    buildWorkspaceAccountCreationRequest,
    getWorkspaceAccountCreationErrorKey,
    validateWorkspaceAccountCreationForm
} from './workspaceAccountCreation'

const validForm = {
    name: ' Samira Hassan ',
    email: ' Samira@Example.COM ',
    password: 'secure-pass-123',
    confirmPassword: 'secure-pass-123'
}

describe('workspace account creation form contract', () => {
    it('validates required identity fields and password confirmation', () => {
        expect(validateWorkspaceAccountCreationForm(validForm)).toBeNull()
        expect(validateWorkspaceAccountCreationForm({ ...validForm, name: ' ' })).toBe('nameRequired')
        expect(validateWorkspaceAccountCreationForm({ ...validForm, email: 'not-an-email' })).toBe('emailInvalid')
        expect(validateWorkspaceAccountCreationForm({ ...validForm, password: 'short', confirmPassword: 'short' })).toBe('passwordTooShort')
        expect(validateWorkspaceAccountCreationForm({ ...validForm, confirmPassword: 'different-password' })).toBe('passwordsMismatch')
    })

    it('normalizes email and sends only the account identity fields', () => {
        expect(buildWorkspaceAccountCreationRequest(validForm)).toEqual({
            name: 'Samira Hassan',
            email: 'samira@example.com',
            password: 'secure-pass-123'
        })
    })

    it('maps server failures to localized UI keys', () => {
        expect(getWorkspaceAccountCreationErrorKey('duplicate_email')).toBe('workspaceAccountCreation.errors.duplicateEmail')
        expect(getWorkspaceAccountCreationErrorKey('member_limit_reached')).toBe('workspaceAccountCreation.errors.memberLimit')
        expect(getWorkspaceAccountCreationErrorKey('invalid_password')).toBe('workspaceAccountCreation.errors.invalidPassword')
        expect(getWorkspaceAccountCreationErrorKey('unknown')).toBe('workspaceAccountCreation.errors.createFailed')
    })
})
