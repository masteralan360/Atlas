import { describe, expect, it } from 'vitest'
import {
    buildWorkspaceAccountProfile,
    buildWorkspaceAccountUserMetadata,
    getWorkspaceAccountCreationAuthorizationError,
    parseCreateWorkspaceAccountInput
} from '../../supabase/functions/_shared/workspaceAccountCreation'

describe('workspace account creation server contract', () => {
    it('normalizes credentials but ignores caller-supplied workspace and role', () => {
        expect(parseCreateWorkspaceAccountInput({
            email: ' Member@Example.COM ',
            name: ' Member Name ',
            password: 'secure-pass-123',
            workspaceId: 'attacker-workspace',
            role: 'admin'
        })).toEqual({
            email: 'member@example.com',
            name: 'Member Name',
            password: 'secure-pass-123'
        })
    })

    it('rejects invalid credentials', () => {
        expect(parseCreateWorkspaceAccountInput({ email: 'bad', name: 'A', password: 'secure-pass-123' })).toBeNull()
        expect(parseCreateWorkspaceAccountInput({ email: 'a@b.com', name: 'A', password: 'short' })).toBeNull()
    })
    it('requires exactly one valid organization path for merchant registration', () => {
        const base = { email: 'merchant@example.com', name: 'Merchant', password: 'secure-pass-123' }
        expect(parseCreateWorkspaceAccountInput({ ...base, merchant: {} })).toBeNull()
        expect(parseCreateWorkspaceAccountInput({ ...base, merchant: { mode: 'join', code: 'invalid' } })).toBeNull()
        expect(parseCreateWorkspaceAccountInput({ ...base, merchant: { mode: 'create', name: '  ' } })).toBeNull()
        expect(parseCreateWorkspaceAccountInput({ ...base, merchant: { mode: 'join', code: 'abcd-2345', workspace_id: 'forged' } })?.merchant).toEqual({ mode: 'join', code: 'ABCD2345' })
        expect(parseCreateWorkspaceAccountInput({ ...base, merchant: { mode: 'create', name: ' Shop ' } })?.merchant).toEqual({ mode: 'create', name: 'Shop' })
    })

    it('requires an admin and an active Cloud or Hybrid workspace', () => {
        const valid = {
            callerRole: 'admin',
            workspaceId: 'workspace-1',
            workspaceDataMode: 'cloud',
            workspaceDeleted: false
        }
        expect(getWorkspaceAccountCreationAuthorizationError(valid)).toBeNull()
        expect(getWorkspaceAccountCreationAuthorizationError({ ...valid, callerRole: 'viewer' })).toBe('not_authorized')
        expect(getWorkspaceAccountCreationAuthorizationError({ ...valid, workspaceDataMode: 'local' })).toBe('workspace_unavailable')
        expect(getWorkspaceAccountCreationAuthorizationError({ ...valid, workspaceDeleted: true })).toBe('workspace_unavailable')
        expect(getWorkspaceAccountCreationAuthorizationError({ ...valid, workspaceDataMode: 'hybrid' })).toBeNull()
    })

    it('assigns every newly created account to the verified workspace with staff role', () => {
        const userId = 'user-1'
        const workspaceId = 'verified-workspace'
        expect(buildWorkspaceAccountUserMetadata('Member Name', workspaceId)).toEqual({
            name: 'Member Name',
            role: 'staff',
            workspace_id: workspaceId
        })
        expect(buildWorkspaceAccountProfile(userId, 'Member Name', workspaceId)).toEqual({
            id: userId,
            name: 'Member Name',
            role: 'staff',
            workspace_id: workspaceId,
            current_workspace: workspaceId
        })
    })
})
